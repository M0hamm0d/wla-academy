import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripeEnv } from "@/lib/env";
import { stripe } from "@/features/commerce/checkout";
import { createAdminClient } from "@/lib/supabase/admin";
import { fulfilPaidGift } from "@/features/gifts/fulfil";
import { isWorthRetrying, sendMissionAccessEmail } from "@/lib/email/send";
import { logError, logWarn } from "@/lib/observability/logger";
import { siteUrl } from "@/lib/env";

/**
 * THE ENTITLEMENT BOUNDARY — Tech Spec §40.
 *
 * "The Academy should NOT trust a frontend success message as proof of
 *  payment. The actual payment provider webhook/server verification should
 *  determine whether an entitlement is created."
 *
 * This route is the ONLY path that creates an entitlement with source
 * 'purchase'. The browser cannot create one: `mission_entitlements` has a
 * single RLS policy and it is `for select`.
 *
 * Idempotency is layered, because Stripe retries on any non-2xx and may
 * deliver the same event more than once even after a success:
 *
 *   1. `stripe_events` — the event id is a primary key, so recording it IS
 *      the lock. ONLY a unique violation means "already claimed" (D-112);
 *      any other claim error is the database failing, and is answered 500 so
 *      Stripe delivers again — never 200, which would end retries for a
 *      payment nothing has granted.
 *   2. `unique (child_id, mission_id)` on mission_entitlements — a second
 *      grant is a no-op, and the access email goes only with the grant that
 *      actually inserted the row.
 *
 * A duplicate `checkout.session.completed` is RECONCILED rather than dropped
 * (D-112): it re-runs the same verified, idempotent path. A delivery that
 * already granted changes nothing; one whose earlier attempt failed after
 * claiming — and whose claim could not be released — still grants, instead
 * of being acknowledged forever as a duplicate. The duplicate path never
 * releases a claim: the claim may belong to a delivery still in flight.
 */

/** Postgres unique_violation: the event id is already in the ledger. */
const UNIQUE_VIOLATION = "23505";

export const runtime = "nodejs"; // raw body required for signature verification

export async function POST(request: Request) {
  const env = stripeEnv();

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  // Must be the raw body — parsing it first breaks verification.
  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(
      payload,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    // Never echo the underlying error — it leaks verification detail.
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const admin = createAdminClient();

  /*
   * Claim the event. The primary key makes this the idempotency lock: a
   * duplicate delivery fails the insert with 23505. For any event but a
   * checkout completion that ends it; a completion is reconciled (above).
   *
   * Claiming BEFORE the work (rather than marking after) is deliberate. A
   * crash mid-processing leaves the event claimed but unapplied; the next
   * delivery of it is then reconciled (below), and the unique constraint on
   * entitlements means a double grant cannot happen either way.
   */
  const { error: claimError } = await admin
    .from("stripe_events")
    .insert({ id: event.id, type: event.type });

  let duplicate = false;
  if (claimError) {
    if (claimError.code !== UNIQUE_VIOLATION) {
      // Not "already processed" — the ledger could not be written. Nothing was
      // claimed, so a retry starts clean.
      logError("stripe_event_claim_failed", claimError, { eventId: event.id });
      return NextResponse.json({ error: "Claim failed" }, { status: 500 });
    }
    duplicate = true;
  }

  if (event.type !== "checkout.session.completed") {
    return duplicate
      ? NextResponse.json({ received: true, duplicate: true })
      : NextResponse.json({ received: true });
  }

  const session = event.data.object;

  // Only a genuinely paid session grants access. An unpaid or expired session
  // must never create an entitlement.
  if (session.payment_status !== "paid") {
    return NextResponse.json({ received: true, unpaid: true });
  }
  if (session.mode !== "payment" || !session.id || !session.amount_total || !session.currency) {
    logWarn("stripe_checkout_shape_invalid", { sessionId: session.id });
    return NextResponse.json({ received: true, invalid: true });
  }

  /*
   * Resolve the intended child from OUR record, not from Stripe metadata.
   * The intent row was written server-side before the parent left for
   * Checkout, so it cannot have been influenced by the browser.
   */
  const { data: intent, error: intentError } = await admin
    .from("checkout_intents")
    .select("id, parent_id, child_id, mission_id, amount_minor, currency, checkout_status, paid_at, confirmation_sent_at, consent_wording, early_supply_consent_at")
    .eq("stripe_session_id", session.id)
    .maybeSingle();

  /*
   * A failed LOOKUP is not "no intent". Treated as one, a paid session whose
   * read merely timed out was marked processed and never retried — the family
   * charged, the mission never granted. Release the claim and 500 so Stripe
   * delivers it again, exactly as for a failed entitlement write below.
   */
  if (intentError) {
    logError("stripe_intent_lookup_failed", intentError, {
      sessionId: session.id,
    });
    if (!duplicate) await releaseClaim(admin, event);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }

  if (!intent) {
    // A gift has no child yet, so no intent: it has its own record (D-140).
    const { data: gift, error: giftError } = await admin
      .from("mission_gifts")
      .select("id, purchaser_id, mission_id, amount_minor, currency")
      .eq("stripe_session_id", session.id)
      .maybeSingle();

    if (giftError) {
      logError("stripe_gift_lookup_failed", giftError, { sessionId: session.id });
      if (!duplicate) await releaseClaim(admin, event);
      return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
    }

    if (gift) {
      if (session.client_reference_id !== gift.id || session.metadata?.gift_id !== gift.id ||
          session.metadata?.gift !== "1" || session.metadata?.mission_id !== gift.mission_id ||
          (gift.purchaser_id && session.metadata?.parent_id !== gift.purchaser_id)) {
        logWarn("stripe_gift_association_mismatch", { sessionId: session.id, giftId: gift.id });
        return NextResponse.json({ received: true, mismatch: true });
      }
      if (
        session.amount_total !== gift.amount_minor ||
        session.currency?.toUpperCase() !== gift.currency.toUpperCase()
      ) {
        logError("stripe_amount_mismatch", new Error("amount or currency mismatch"), {
          sessionId: session.id,
          expected: `${gift.amount_minor} ${gift.currency}`,
          received: `${session.amount_total} ${session.currency}`,
        });
        return NextResponse.json({ received: true, mismatch: true });
      }

      try {
        await fulfilPaidGift(
          admin,
          session.id,
          typeof session.payment_intent === "string" ? session.payment_intent : null,
        );
      } catch (error) {
        logError("stripe_gift_fulfil_failed", error, { sessionId: session.id });
        if (!duplicate) await releaseClaim(admin, event);
        return NextResponse.json({ error: "Gift failed" }, { status: 500 });
      }

      const { error: stateError } = await admin.from("mission_gifts")
        .update({ checkout_status: "paid" }).eq("id", gift.id).eq("status", "paid");
      if (stateError) {
        logError("stripe_gift_checkout_state_failed", stateError, { giftId: gift.id });
        if (!duplicate) await releaseClaim(admin, event);
        return NextResponse.json({ error: "Gift state failed" }, { status: 500 });
      }

      return duplicate
        ? NextResponse.json({ received: true, duplicate: true })
        : NextResponse.json({ received: true });
    }

    // OPS-01. Neither a purchase nor a gift: nothing to grant, but visible.
    logWarn("stripe_no_checkout_intent", { sessionId: session.id });
    return NextResponse.json({ received: true, unmatched: true });
  }

  // The family closed their account before the payment arrived: nothing to
  // grant, and the payment is visible to reconcile (refunds are manual, D-20).
  // Checked before the association test, which a closed family's emptied
  // record would otherwise fail as a "mismatch".
  if (!intent.child_id) {
    logError("stripe_paid_for_closed_account", new Error("paid intent has no child"), { sessionId: session.id });
    await admin.from("checkout_intents").update({ checkout_status: "paid" }).eq("id", intent.id);
    return NextResponse.json({ received: true, closed: true });
  }

  if (session.client_reference_id !== intent.id || session.metadata?.checkout_intent_id !== intent.id ||
      session.metadata?.mission_id !== intent.mission_id || session.metadata?.child_id !== intent.child_id ||
      session.metadata?.parent_id !== intent.parent_id) {
    logWarn("stripe_mission_association_mismatch", { sessionId: session.id, intentId: intent.id });
    return NextResponse.json({ received: true, mismatch: true });
  }
  const { data: childOwner, error: ownerError } = await admin.from("child_profiles")
    .select("parent_id").eq("id", intent.child_id).maybeSingle();
  if (ownerError) {
    if (!duplicate) await releaseClaim(admin, event);
    return NextResponse.json({ error: "Ownership lookup failed" }, { status: 500 });
  }
  if (!childOwner || childOwner.parent_id !== intent.parent_id) {
    logError("stripe_intent_ownership_mismatch", new Error("intent parent does not own child"), { sessionId: session.id });
    return NextResponse.json({ received: true, mismatch: true });
  }

  // Reconciliation: what Stripe collected must match what we recorded.
  if (
    session.amount_total !== intent.amount_minor ||
    session.currency?.toUpperCase() !== intent.currency.toUpperCase()
  ) {
    // A reconciliation failure is the one webhook outcome that should always
    // be looked at: it means Stripe collected something other than what we
    // recorded. No entitlement is created.
    logError(
      "stripe_amount_mismatch",
      new Error("amount or currency mismatch"),
      {
        sessionId: session.id,
        expected: `${intent.amount_minor} ${intent.currency}`,
        received: `${session.amount_total} ${session.currency}`,
      },
    );
    return NextResponse.json({ received: true, mismatch: true });
  }

  const childId = intent.child_id;

  // Trusted server client: the purchaser may not have an active session right now.
  // ON CONFLICT DO NOTHING ... RETURNING: `inserted` is empty when the row
  // already existed, so a duplicate or concurrent delivery grants nothing new.
  const { data: inserted, error } = await admin
    .from("mission_entitlements")
    .upsert(
      {
        child_id: childId,
        mission_id: intent.mission_id,
        source: "purchase",
        status: "active",
        stripe_payment_intent_id:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : null,
      },
      { onConflict: "child_id,mission_id", ignoreDuplicates: true },
    )
    .select("id");

  if (error) {
    logError("stripe_entitlement_failed", error, { sessionId: session.id });
    // Release the claim so Stripe's retry can genuinely re-run this. On the
    // duplicate path the claim is not ours, and the retry reconciles anyway.
    if (!duplicate) await releaseClaim(admin, event);
    // 500 so Stripe retries — a dropped entitlement means a paying family
    // cannot reach the mission they bought.
    return NextResponse.json({ error: "Entitlement failed" }, { status: 500 });
  }

  /*
   * The payment is a financial record of its own (D-148): stamped on the
   * intent, so it survives the family closing their account. Conditional, so a
   * repeat changes nothing.
   */
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
  const paidAt = intent.paid_at ?? new Date().toISOString();
  if (!intent.paid_at) {
    const { error: stampError } = await admin
      .from("checkout_intents")
      .update({ paid_at: paidAt, stripe_payment_intent_id: paymentIntentId })
      .eq("id", intent.id)
      .is("paid_at", null);
    if (stampError) {
      logError("stripe_payment_unrecorded", stampError, { sessionId: session.id });
      if (!duplicate) await releaseClaim(admin, event);
      return NextResponse.json({ error: "Record failed" }, { status: 500 });
    }
  }

  // A grant that found a row already there: normally active, but a REVOKED
  // one means a payment for access the family doesn't have (flagged below).
  const active =
    (inserted ?? []).length > 0 ||
    (await flagIfRevoked(admin, childId, intent.mission_id, session.id));

  /*
   * The order confirmation on a durable medium (D-152): sent once, recorded
   * when it leaves. It is required, not a courtesy, so a send that might work
   * next time (provider 5xx or 429, a network error) answers 500 and Stripe's
   * retries become the email's retries — the entitlement and the payment stamp
   * above are idempotent, so a retry repeats nothing else. Email not being
   * configured can't be helped by retrying: logged, and visible in Orders.
   */
  if (active && !intent.confirmation_sent_at) {
    const outcome = await notifyAccessGranted(admin, childId, intent.mission_id, {
      amountMinor: intent.amount_minor,
      currency: intent.currency,
      paidAt,
      consentWording: intent.consent_wording,
      consentRecorded: Boolean(intent.early_supply_consent_at),
    });
    if (outcome.sent) {
      const { error: sentError } = await admin
        .from("checkout_intents")
        .update({ confirmation_sent_at: new Date().toISOString() })
        .eq("id", intent.id);
      if (sentError) logError("stripe_confirmation_unrecorded", sentError, { sessionId: session.id });
    } else if (isWorthRetrying(outcome.reason)) {
      if (!duplicate) await releaseClaim(admin, event);
      return NextResponse.json({ error: "Confirmation not sent" }, { status: 500 });
    }
  }

  const { error: stateError } = await admin.from("checkout_intents")
    .update({ checkout_status: "paid" }).eq("id", intent.id);
  if (stateError) {
    logError("stripe_intent_state_failed", stateError, { intentId: intent.id });
    if (!duplicate) await releaseClaim(admin, event);
    return NextResponse.json({ error: "Purchase state failed" }, { status: 500 });
  }

  return duplicate
    ? NextResponse.json({ received: true, duplicate: true })
    : NextResponse.json({ received: true });
}

/**
 * Give the event back to Stripe's retry. If even this fails, the event stays
 * claimed — and the retry is then reconciled as a duplicate, which still
 * grants. A failed release is logged as an error: the database was failing.
 */
async function releaseClaim(
  admin: ReturnType<typeof createAdminClient>,
  event: Stripe.Event,
): Promise<void> {
  const { error } = await admin.from("stripe_events").delete().eq("id", event.id);
  if (error) {
    logError("stripe_claim_release_failed", error, { eventId: event.id });
  }
}

/**
 * The grant found a row already there. Normally it is active — a duplicate or
 * an earlier grant — and nothing is wrong: returns true. If it is REVOKED, the family has
 * paid for access they still do not have. Revocation is only ever undone
 * explicitly (D-20), so this does not reactivate it; it makes the payment
 * visible so someone can reinstate or refund. Never fails the webhook.
 */
async function flagIfRevoked(
  admin: ReturnType<typeof createAdminClient>,
  childId: string,
  missionId: string,
  sessionId: string,
): Promise<boolean> {
  const { data: existing, error } = await admin
    .from("mission_entitlements")
    .select("status")
    .eq("child_id", childId)
    .eq("mission_id", missionId)
    .maybeSingle();
  if (error) {
    logWarn("stripe_existing_entitlement_unread", { sessionId });
    // Unknown: the confirmation waits for a delivery that can read it.
    return false;
  }
  if (existing && existing.status !== "active") {
    logError(
      "stripe_paid_entitlement_revoked",
      new Error("paid for a mission whose entitlement is revoked"),
      { sessionId },
    );
    return false;
  }
  return Boolean(existing);
}

/**
 * Look up the details the confirmation email needs and send it.
 *
 * Service-role, because the purchaser has no active session at this moment.
 * Never throws; returns how the send went, for the caller to decide.
 */
async function notifyAccessGranted(
  admin: ReturnType<typeof createAdminClient>,
  childId: string,
  missionId: string,
  order: {
    amountMinor: number;
    currency: string;
    paidAt: string;
    consentWording: string | null;
    consentRecorded: boolean;
  },
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const [{ data: child }, { data: mission }] = await Promise.all([
      admin
        .from("child_profiles")
        .select("display_name, parent_id")
        .eq("id", childId)
        .maybeSingle(),
      admin
        .from("missions")
        .select("title, slug")
        .eq("id", missionId)
        .maybeSingle(),
    ]);

    if (!child || !mission) return { sent: false, reason: "not_composed" };

    const { data: parent } = await admin
      .from("profiles")
      .select("email")
      .eq("id", child.parent_id)
      .maybeSingle();

    if (!parent?.email) return { sent: false, reason: "not_composed" };

    let origin: string;
    // No trusted origin configured: like email not configured, not worth a retry.
    try { origin = siteUrl(); } catch { return { sent: false, reason: "not_configured" }; }

    return await sendMissionAccessEmail({
      to: parent.email,
      childName: child.display_name,
      missionTitle: mission.title,
      missionUrl: `${origin}/academy/missions/${mission.slug}`,
      ...order,
    });
  } catch (err) {
    logWarn("stripe_access_email_failed", {
      reason: err instanceof Error ? err.message : "unknown",
    });
    return { sent: false, reason: "exception" };
  }
}

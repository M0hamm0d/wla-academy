import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripeEnv } from "@/lib/env";
import { stripe } from "@/features/commerce/checkout";
import { createAdminClient } from "@/lib/supabase/admin";
import { fulfilPaidGift } from "@/features/gifts/fulfil";
import { sendMissionAccessEmail } from "@/lib/email/send";
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
    .select("id, parent_id, child_id, mission_id, amount_minor, currency, checkout_status")
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
      .select("id, purchaser_id, mission_id, recipient_email, amount_minor, currency, status, link_sent_at, checkout_status, email_delivery_locked_until")
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
          gift,
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

  // Trusted server client: the purchaser may not have an active session right now.
  // ON CONFLICT DO NOTHING ... RETURNING: `inserted` is empty when the row
  // already existed, so a duplicate or concurrent delivery grants nothing new.
  const { data: inserted, error } = await admin
    .from("mission_entitlements")
    .upsert(
      {
        child_id: intent.child_id,
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
   * Confirm access by email (D-27) — only for the delivery that created the
   * entitlement, so a duplicate never sends a second message.
   *
   * Strictly after the entitlement exists, and never able to fail the success
   * path: sendMissionAccessEmail never throws, and a send failure must not
   * turn a completed purchase into a 500 that Stripe retries. The
   * entitlement is the thing that matters; the email is a courtesy.
   */
  if ((inserted ?? []).length > 0) {
    await notifyAccessGranted(admin, intent.child_id, intent.mission_id);
  } else {
    await flagIfRevoked(admin, intent.child_id, intent.mission_id, session.id);
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
 * an earlier grant — and nothing is wrong. If it is REVOKED, the family has
 * paid for access they still do not have. Revocation is only ever undone
 * explicitly (D-20), so this does not reactivate it; it makes the payment
 * visible so someone can reinstate or refund. Never fails the webhook.
 */
async function flagIfRevoked(
  admin: ReturnType<typeof createAdminClient>,
  childId: string,
  missionId: string,
  sessionId: string,
): Promise<void> {
  const { data: existing, error } = await admin
    .from("mission_entitlements")
    .select("status")
    .eq("child_id", childId)
    .eq("mission_id", missionId)
    .maybeSingle();
  if (error) {
    logWarn("stripe_existing_entitlement_unread", { sessionId });
  } else if (existing && existing.status !== "active") {
    logError(
      "stripe_paid_entitlement_revoked",
      new Error("paid for a mission whose entitlement is revoked"),
      { sessionId },
    );
  }
}

/**
 * Look up the details the confirmation email needs and send it.
 *
 * Service-role, because the purchaser has no active session at this moment.
 * Any failure is logged and swallowed — see the call site.
 */
async function notifyAccessGranted(
  admin: ReturnType<typeof createAdminClient>,
  childId: string,
  missionId: string,
): Promise<void> {
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

    if (!child || !mission) return;

    const { data: parent } = await admin
      .from("profiles")
      .select("email")
      .eq("id", child.parent_id)
      .maybeSingle();

    if (!parent?.email) return;

    let origin: string;
    try { origin = siteUrl(); } catch { return; }

    await sendMissionAccessEmail({
      to: parent.email,
      childName: child.display_name,
      missionTitle: mission.title,
      missionUrl: `${origin}/academy/missions/${mission.slug}`,
    });
  } catch (err) {
    // The purchase already succeeded; the email is a courtesy.
    logWarn("stripe_access_email_failed", {
      reason: err instanceof Error ? err.message : "unknown",
    });
  }
}

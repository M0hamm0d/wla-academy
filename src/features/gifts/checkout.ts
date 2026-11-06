import "server-only";

import type Stripe from "stripe";
import { CheckoutError, missionLineItem, stripe } from "@/features/commerce/checkout";
import { logError } from "@/lib/observability/logger";
import { requireParent } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { normaliseGiftEmail } from "./token";

/**
 * Pay for a mission as a gift (D-140).
 *
 * Same Stripe account, same Checkout, same webhook as an ordinary purchase. The
 * differences are that no child is involved and nothing is granted: the webhook
 * turns the pending record into a redeemable gift, and the purchaser gets no
 * entitlement from it.
 *
 * As with a purchase, the browser supplies a mission and an address and nothing
 * else: whether it can be bought, and for how much, is read here.
 */
export async function purchaseGift({
  missionSlug,
  recipientEmail,
  origin,
}: {
  missionSlug: string;
  recipientEmail: string;
  origin: string;
}): Promise<{ kind: "checkout"; url: string } | { kind: "processing" }> {
  const { user, supabase } = await requireParent();

  const { data: mission } = await supabase
    .from("missions")
    .select("*")
    .eq("slug", missionSlug)
    .eq("published", true)
    .maybeSingle();
  if (!mission) {
    throw new CheckoutError("That mission isn't available.", "not_purchasable");
  }
  if (mission.is_free) {
    throw new CheckoutError(
      "This mission is free, so it can't be bought as a gift.",
      "free_mission",
    );
  }
  if (!mission.price_minor || mission.price_minor <= 0) {
    throw new CheckoutError(
      "That mission isn't available to buy right now.",
      "not_purchasable",
    );
  }

  const email = normaliseGiftEmail(recipientEmail);
  const admin = createAdminClient();

  const selected = "id, attempt_key, stripe_session_id, checkout_status, amount_minor, currency, mission_title, mission_description, mission_slug, customer_email, site_origin, created_at";
  const prior = await admin.from("mission_gifts").select(selected)
    .eq("purchaser_id", user.id).eq("mission_id", mission.id).eq("recipient_email", email)
    .eq("status", "pending").in("checkout_status", ["initializing", "open"]).maybeSingle();
  if (prior.error) throw new CheckoutError("We couldn't check your gift payment. Please try again.", "provider");
  let attempt = prior.data;
  const reserved = attempt ? null : await admin.from("mission_gifts").insert({
    mission_id: mission.id, purchaser_id: user.id, recipient_email: email,
    amount_minor: mission.price_minor, currency: mission.currency,
    mission_title: mission.title, mission_description: mission.description,
    mission_slug: mission.slug, customer_email: user.email ?? null, site_origin: origin,
    checkout_status: "initializing",
  }).select(selected).maybeSingle();
  if (reserved) {
    attempt = reserved.data;
    if (reserved.error?.code === "23505") {
      const existing = await admin.from("mission_gifts").select(selected)
        .eq("purchaser_id", user.id).eq("mission_id", mission.id).eq("recipient_email", email)
        .eq("status", "pending").in("checkout_status", ["initializing", "open"]).maybeSingle();
      if (existing.error || !existing.data) throw new CheckoutError("We couldn't check your gift payment. Please try again.", "provider");
      attempt = existing.data;
    } else if (reserved.error || !attempt) {
      logError("gift_record_reserve_failed", reserved.error, { missionId: mission.id });
      throw new CheckoutError("We couldn't start the payment. Please try again.", "provider");
    }
  }
  if (!attempt) throw new CheckoutError("We couldn't start the payment. Please try again.", "provider");

  if (attempt.stripe_session_id) {
    try {
      const prior = await stripe().checkout.sessions.retrieve(attempt.stripe_session_id);
      if (prior.status === "open" && prior.url) return { kind: "checkout", url: prior.url };
      if (prior.status === "complete") return { kind: "processing" };
      if (prior.status === "expired") {
        await admin.from("mission_gifts").update({ checkout_status: "expired" }).eq("id", attempt.id);
        throw new CheckoutError("That gift checkout expired. Please try again.", "provider");
      }
    } catch (error) {
      if (error instanceof CheckoutError) throw error;
      logError("stripe_prior_gift_session_unavailable", error, { giftId: attempt.id });
      throw new CheckoutError("We couldn't check your existing gift payment. Please try again shortly.", "provider");
    }
  }
  if (!attempt.attempt_key) throw new CheckoutError("Your existing gift payment needs review. Please contact support.", "provider");

  if (Date.now() - new Date(attempt.created_at).getTime() > 23 * 60 * 60 * 1000) {
    throw new CheckoutError("Your gift payment is being checked. Please try again later.", "provider");
  }
  const checkoutMission = {
    ...mission,
    title: attempt.mission_title ?? mission.title,
    description: attempt.mission_description ?? mission.description,
    slug: attempt.mission_slug ?? mission.slug,
    price_minor: attempt.amount_minor,
    currency: attempt.currency,
  };
  const checkoutOrigin = attempt.site_origin ?? origin;

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe().checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"], // D-113: a completed session is a paid one.
      line_items: [missionLineItem(checkoutMission)],
      customer_email: attempt.customer_email ?? undefined,
      success_url: `${checkoutOrigin}/gift?purchase=success`,
      cancel_url: `${checkoutOrigin}/purchase/${checkoutMission.slug}?gift=1&cancelled=1`,
      client_reference_id: attempt.id,
      // A convenience only; mission_gifts is the authoritative record. Holds
      // no recipient address: Stripe has no need of it.
      metadata: { gift: "1", gift_id: attempt.id, mission_id: mission.id, parent_id: user.id },
    }, { idempotencyKey: `wla-gift-${attempt.attempt_key}` });
  } catch (error) {
    logError("stripe_gift_checkout_create_failed", error, {
      missionId: mission.id,
    });
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
      await admin.from("mission_gifts").update({ checkout_status: "failed" }).eq("id", attempt.id).eq("checkout_status", "initializing");
    }
    throw new CheckoutError(
      "We couldn't start the payment. Please try again.",
      "provider",
    );
  }

  if (!session.url) {
    throw new CheckoutError("We couldn't start the payment.", "provider");
  }

  if (session.status === "expired") {
    await admin.from("mission_gifts").update({ stripe_session_id: session.id, checkout_status: "expired" }).eq("id", attempt.id);
    throw new CheckoutError("That gift checkout expired. Please try again.", "provider");
  }
  if (session.status === "complete") {
    await admin.from("mission_gifts").update({ stripe_session_id: session.id, checkout_status: "open" }).eq("id", attempt.id);
    return { kind: "processing" };
  }

  const { error: insertError } = await admin.from("mission_gifts")
    .update({ stripe_session_id: session.id, checkout_status: "open" }).eq("id", attempt.id);

  // No record means the webhook couldn't honour the payment, so no payment.
  if (insertError) {
    logError("gift_session_record_update_failed", insertError, { giftId: attempt.id, sessionId: session.id });
    await stripe().checkout.sessions.expire(session.id).catch(() => {});
    await admin.from("mission_gifts").update({ stripe_session_id: session.id, checkout_status: "failed" }).eq("id", attempt.id);
    throw new CheckoutError(
      "We couldn't start the payment. Please try again.",
      "provider",
    );
  }

  return { kind: "checkout", url: session.url };
}

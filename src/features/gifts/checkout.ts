import "server-only";

import type Stripe from "stripe";
import { CheckoutError, missionLineItem, stripe } from "@/features/commerce/checkout";
import { logError } from "@/lib/observability/logger";
import { requireParent } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { CONSENT_REQUIRED_MESSAGE, type CheckoutConsent } from "@/features/commerce/consent";

/**
 * Pay for a mission as a gift (D-140).
 *
 * Same Stripe account, same Checkout, same webhook as an ordinary purchase. The
 * differences are that no child is involved and nothing is granted: the webhook
 * turns the pending record into a redeemable gift with a code, which the
 * purchaser receives and passes on (D-149). WLA asks for no recipient address.
 *
 * As with a purchase, the browser supplies a mission and the two checkout
 * statements and nothing else: whether it can be bought, and for how much, is
 * read here.
 */
export async function purchaseGift({
  missionSlug,
  origin,
  consent,
}: {
  missionSlug: string;
  origin: string;
  consent: CheckoutConsent | null;
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

  if (!consent) {
    throw new CheckoutError(CONSENT_REQUIRED_MESSAGE, "consent_required");
  }

  const admin = createAdminClient();

  /*
   * A double submit or a second tab must not become a second charge. The same
   * rule as an ordinary purchase: an earlier session already paid is waiting
   * for its webhook, and one still open is expired so only the new one can pay.
   * Stripe unreachable: leave it, and carry on.
   */
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: prior } = await admin
    .from("mission_gifts")
    .select("stripe_session_id")
    .eq("purchaser_id", user.id)
    .eq("mission_id", mission.id)
    .eq("status", "pending")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5);

  for (const { stripe_session_id: id } of prior ?? []) {
    try {
      const session = await stripe().checkout.sessions.retrieve(id);
      if (session.status === "complete" && session.payment_status === "paid") {
        return { kind: "processing" };
      }
      if (session.status === "open") await stripe().checkout.sessions.expire(id);
    } catch {
      // Unknown; a duplicate here is a refund, not a lost gift.
    }
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe().checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"], // D-113: a completed session is a paid one.
      line_items: [missionLineItem(mission)],
      customer_email: user.email,
      success_url: `${origin}/gift?purchase=success`,
      cancel_url: `${origin}/purchase/${mission.slug}?gift=1&cancelled=1`,
      // A convenience only; mission_gifts is the authoritative record.
      metadata: { gift: "1", mission_id: mission.id, parent_id: user.id },
    });
  } catch (error) {
    logError("stripe_gift_checkout_create_failed", error, {
      missionId: mission.id,
    });
    throw new CheckoutError(
      "We couldn't start the payment. Please try again.",
      "provider",
    );
  }

  if (!session.url) {
    throw new CheckoutError("We couldn't start the payment.", "provider");
  }

  const { error: insertError } = await admin.from("mission_gifts").insert({
    mission_id: mission.id,
    purchaser_id: user.id,
    stripe_session_id: session.id,
    amount_minor: mission.price_minor,
    currency: mission.currency,
    early_supply_consent_at: consent.earlySupplyConsentAt,
    cancellation_ack_at: consent.cancellationAckAt,
    consent_wording: consent.wording,
  });

  // No record means the webhook couldn't honour the payment, so no payment.
  if (insertError) {
    logError("gift_record_insert_failed", insertError, { missionId: mission.id });
    await stripe().checkout.sessions.expire(session.id).catch(() => {});
    throw new CheckoutError(
      "We couldn't start the payment. Please try again.",
      "provider",
    );
  }

  return { kind: "checkout", url: session.url };
}

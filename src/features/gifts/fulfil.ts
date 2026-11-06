import "server-only";

import { sendGiftCodeEmail, sendGiftEmail } from "@/lib/email/send";
import { logError, logWarn } from "@/lib/observability/logger";
import type { createAdminClient } from "@/lib/supabase/admin";
import { hashGiftToken, newGiftToken } from "./token";
import { siteUrl } from "@/lib/env";

type Admin = ReturnType<typeof createAdminClient>;

/** How often a recipient can ask for the link again, per gift. */
export const LINK_RESEND_INTERVAL_MS = 10 * 60 * 1000;

export type GiftForFulfilment = {
  id: string;
  mission_id: string;
  recipient_email: string;
  amount_minor: number;
  currency: string;
  status: "pending" | "paid" | "redeemed";
  link_sent_at: string | null;
  email_delivery_locked_until?: string | null;
};

function redeemUrl(token: string): string | null {
  let origin: string;
  try { origin = siteUrl(); } catch { return null; }
  return `${origin.replace(/\/$/, "")}/redeem?token=${encodeURIComponent(token)}`;
}

async function missionTitle(admin: Admin, missionId: string): Promise<string | null> {
  const { data } = await admin.from("missions").select("title").eq("id", missionId).maybeSingle();
  return data?.title ?? null;
}

/**
 * The verified webhook confirmed payment: make the gift redeemable and email
 * the link.
 *
 * The status change is conditional on `pending`, so a repeated or concurrent
 * delivery activates nothing new and sends nothing new. Throws only when the
 * database could not be written, so the webhook answers 500 and Stripe retries.
 *
 * A gift already paid whose email never left (the send failed, or the process
 * died after the update) gets a fresh token and another attempt: the old token
 * was never delivered to anyone, so nothing valid is taken away.
 *
 * The email is the only way a recipient learns of the gift, so a send that might
 * work next time also throws, and Stripe's retries become the email's retries. A
 * send that can't work on a retry (email not configured) is logged instead:
 * failing the webhook wouldn't help, and the gift is still paid.
 */
export async function fulfilPaidGift(
  admin: Admin,
  gift: GiftForFulfilment,
  paymentIntentId: string | null,
): Promise<void> {
  if (gift.status === "redeemed") return;
  if (gift.status === "paid" && gift.link_sent_at) return;
  if (gift.email_delivery_locked_until && new Date(gift.email_delivery_locked_until).getTime() > Date.now()) {
    // Keep the Stripe delivery retryable if another webhook worker owns the
    // delivery lease, or if the previous worker died while sending.
    throw new Error("gift_delivery_in_progress");
  }

  const { token, hash } = newGiftToken();

  if (gift.status === "pending") {
    const { data, error } = await admin
      .from("mission_gifts")
      .update({
        status: "paid",
        redeem_token_hash: hash,
        paid_at: new Date().toISOString(),
        stripe_payment_intent_id: paymentIntentId,
        email_delivery_locked_until: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      })
      .eq("id", gift.id)
      .eq("status", "pending")
      .select("id");
    if (error) throw error;
    // Another delivery got there first, and it sends the email.
    if (!data || data.length === 0) return;
  } else {
    let claim = admin
      .from("mission_gifts")
      .update({
        redeem_token_hash: hash,
        confirm_failures: 0,
        email_delivery_locked_until: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      })
      .eq("id", gift.id)
      .eq("status", "paid")
      .is("link_sent_at", null);
    claim = gift.email_delivery_locked_until
      ? claim.lt("email_delivery_locked_until", new Date().toISOString())
      : claim.is("email_delivery_locked_until", null);
    const { data, error } = await claim.select("id");
    if (error) throw error;
    if (!data || data.length === 0) return;
  }

  const delivery = await deliverLink(admin, gift, token);
  if (!delivery.sent) {
    const { error } = await admin.from("mission_gifts").update({ email_delivery_locked_until: null }).eq("id", gift.id).is("link_sent_at", null);
    if (error) logError("gift_email_lease_release_failed", error, { giftId: gift.id });
    if (isWorthRetrying(delivery.reason)) throw new Error("gift_email_retry");
  }
}

function isWorthRetrying(reason: string): boolean {
  return reason === "exception" || reason === "http_429" || /^http_5/.test(reason);
}

/** Send the email and record it. Never throws; the caller decides what a failure means. */
async function deliverLink(
  admin: Admin,
  gift: Pick<GiftForFulfilment, "id" | "mission_id" | "recipient_email">,
  token: string,
): Promise<{ sent: true } | { sent: false; reason: string }> {
  try {
    const url = redeemUrl(token);
    const title = await missionTitle(admin, gift.mission_id);
    if (!url || !title) {
      logError("gift_email_not_composed", new Error("no site URL or mission"), { giftId: gift.id });
      return { sent: false, reason: "not_composed" };
    }
    const { sent, reason } = await sendGiftEmail({
      to: gift.recipient_email,
      missionTitle: title,
      redeemUrl: url,
    });
    if (!sent) {
      logWarn("gift_email_not_sent", { giftId: gift.id, reason: reason ?? "unknown" });
      return { sent: false, reason: reason ?? "unknown" };
    }
    const { error } = await admin
      .from("mission_gifts")
      .update({ link_sent_at: new Date().toISOString(), email_delivery_locked_until: null })
      .eq("id", gift.id);
    if (error) logError("gift_link_sent_unrecorded", error, { giftId: gift.id });
    return { sent: true };
  } catch (error) {
    logError("gift_email_failed", error, { giftId: gift.id });
    return { sent: false, reason: "exception" };
  }
}

/**
 * "Redeem a Gift" from the website: nobody holds a link, only an address.
 *
 * Possessing an address proves nothing, so this reveals nothing: it never says
 * whether a gift exists and just emails a link to that address, which is the
 * proof of ownership. Throttled per gift, because each send replaces the token
 * and anyone can type anyone's address. The throttle is taken with a
 * compare-and-swap on what was read, so simultaneous requests can't all pass it.
 * The token is only replaced once the email has actually gone, so a failed send
 * never invalidates a working link.
 */
export async function emailLinksFor(admin: Admin, email: string): Promise<void> {
  const { data: gifts, error } = await admin
    .from("mission_gifts")
    .select("id, mission_id, recipient_email, link_sent_at")
    .eq("recipient_email", email)
    .eq("status", "paid")
    .limit(10);
  if (error) {
    logError("gift_link_lookup_failed", error);
    return;
  }

  const cutoff = Date.now() - LINK_RESEND_INTERVAL_MS;
  for (const gift of gifts ?? []) {
    if (gift.link_sent_at && new Date(gift.link_sent_at).getTime() > cutoff) continue;

    const reserve = admin
      .from("mission_gifts")
      .update({ link_sent_at: new Date().toISOString() })
      .eq("id", gift.id)
      .eq("status", "paid");
    const { data: reserved, error: reserveError } = await (gift.link_sent_at
      ? reserve.eq("link_sent_at", gift.link_sent_at)
      : reserve.is("link_sent_at", null)
    ).select("id");
    if (reserveError) {
      logError("gift_link_reserve_failed", reserveError, { giftId: gift.id });
      continue;
    }
    if (!reserved || reserved.length === 0) continue;

    const { token } = newGiftToken();
    const delivery = await deliverLink(admin, gift, token);
    if (!delivery.sent) {
      const { error: restoreError } = await admin
        .from("mission_gifts")
        .update({ link_sent_at: gift.link_sent_at })
        .eq("id", gift.id);
      if (restoreError) logError("gift_link_restore_failed", restoreError, { giftId: gift.id });
      continue;
    }
    const { error: rotateError } = await admin
      .from("mission_gifts")
      .update({ redeem_token_hash: hashGiftToken(token), confirm_failures: 0 })
      .eq("id", gift.id)
      .eq("status", "paid");
    if (rotateError) logError("gift_token_rotate_failed", rotateError, { giftId: gift.id });
  }
}

/**
 * "Redeem a Gift" from the website: email a code to that address if a gift waits
 * for it (D-145). The database chooses the oldest paid gift, applies the
 * two-minute limit, and makes the code. No row means nothing to send, and the
 * visitor has already had the same answer either way.
 *
 * A send that fails withdraws the code and gives the limit back, so asking again
 * can work straight away. Never throws: this runs after the response.
 */
export async function emailCodeFor(admin: Admin, email: string): Promise<void> {
  try {
    const { data, error } = await admin.rpc("issue_gift_code", { p_email: email });
    if (error) {
      logError("gift_code_issue_failed", error);
      return;
    }
    const issued = data?.[0];
    if (!issued) return;

    const title = await missionTitle(admin, issued.mission_id);
    const delivery = title
      ? await sendGiftCodeEmail({ to: email, missionTitle: title, code: issued.code })
      : { sent: false, reason: "not_composed" };

    if (!delivery.sent) {
      logWarn("gift_code_not_sent", { giftId: issued.gift_id, reason: delivery.reason ?? "unknown" });
      const { error: withdrawError } = await admin.rpc("withdraw_gift_code", {
        p_gift_id: issued.gift_id,
        p_code: issued.code,
      });
      if (withdrawError) logError("gift_code_withdraw_failed", withdrawError, { giftId: issued.gift_id });
    }
  } catch (error) {
    logError("gift_code_failed", error);
  }
}

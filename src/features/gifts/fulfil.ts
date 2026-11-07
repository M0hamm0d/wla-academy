import "server-only";

import { keysFromEnv, sealCode } from "@/features/child-auth/code-crypto";
import { sendGiftPurchaseEmail } from "@/lib/email/send";
import { logError, logWarn } from "@/lib/observability/logger";
import type { createAdminClient } from "@/lib/supabase/admin";
import { formatGiftCode } from "./schemas";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The verified webhook confirmed payment for a gift (D-149).
 *
 * The database makes the gift redeemable and gives it a code, conditional on
 * `pending` under a row lock, so a repeated or concurrent delivery activates
 * nothing and makes no second code. This returns the code only to the delivery
 * that activated it; the server then keeps the purchaser's encrypted copy and
 * emails them their confirmation with the code.
 *
 * Throws only when the database could not be written, so the webhook answers
 * 500 and Stripe retries. Nothing after activation can lose the gift: if the
 * copy can't be stored (no key) or the email doesn't leave, the purchaser can
 * still get a new code from their account, which replaces this one.
 */
export async function fulfilPaidGift(
  admin: Admin,
  sessionId: string,
  paymentIntentId: string | null,
): Promise<"activated" | "already" | "not_found"> {
  const { data, error } = await admin.rpc("activate_paid_gift", {
    p_session_id: sessionId,
    p_payment_intent: paymentIntentId,
  });
  if (error) throw error;
  const row = data?.[0];
  if (!row || row.outcome !== "activated" || !row.gift_id || !row.code) {
    return row?.outcome === "already" ? "already" : "not_found";
  }

  await keepPurchaserCopy(admin, row.gift_id, row.code);
  await confirmToPurchaser(admin, row.gift_id, row.code);
  return "activated";
}

/**
 * Store the purchaser's encrypted copy of a code (D-143's method, bound to the
 * gift). Never throws: without a key the code can't be shown again, and the
 * purchaser is offered a new one instead.
 */
export async function keepPurchaserCopy(admin: Admin, giftId: string, code: string): Promise<boolean> {
  try {
    const keys = keysFromEnv();
    if (!keys.current) {
      logWarn("gift_code_copy_not_kept", { giftId, reason: "no_key" });
      return false;
    }
    const sealed = sealCode(code, { giftId }, keys);
    const { data, error } = await admin.rpc("store_gift_code_copy", {
      p_gift_id: giftId,
      p_code: code,
      p_ciphertext: sealed,
    });
    if (error || !data) {
      logWarn("gift_code_copy_not_kept", { giftId, reason: error ? "db" : "superseded" });
      return false;
    }
    return true;
  } catch {
    // Never the error itself: it could quote the key's shape.
    logWarn("gift_code_copy_not_kept", { giftId, reason: "seal_failed" });
    return false;
  }
}

/**
 * The order confirmation, on a durable medium (D-152): what was bought, for
 * how much, both checkout statements as agreed, and the gift code. Sent to the
 * PURCHASER only. Recorded on success so a failure is visible.
 */
async function confirmToPurchaser(admin: Admin, giftId: string, code: string): Promise<void> {
  try {
    const { data: gift } = await admin
      .from("mission_gifts")
      .select("id, mission_id, purchaser_id, amount_minor, currency, paid_at, consent_wording, early_supply_consent_at")
      .eq("id", giftId)
      .maybeSingle();
    if (!gift?.purchaser_id) return;
    const [{ data: buyer }, { data: mission }] = await Promise.all([
      admin.from("profiles").select("email").eq("id", gift.purchaser_id).maybeSingle(),
      admin.from("missions").select("title").eq("id", gift.mission_id).maybeSingle(),
    ]);
    if (!buyer?.email || !mission) {
      logWarn("gift_confirmation_not_composed", { giftId });
      return;
    }
    const sent = await sendGiftPurchaseEmail({
      to: buyer.email,
      missionTitle: mission.title,
      code: formatGiftCode(code),
      amountMinor: gift.amount_minor,
      currency: gift.currency,
      paidAt: gift.paid_at ?? new Date().toISOString(),
      consentWording: gift.consent_wording,
      consentRecorded: Boolean(gift.early_supply_consent_at),
    });
    if (!sent.sent) {
      logWarn("gift_confirmation_not_sent", { giftId, reason: sent.reason ?? "unknown" });
      return;
    }
    const { error } = await admin
      .from("mission_gifts")
      .update({ confirmation_sent_at: new Date().toISOString() })
      .eq("id", giftId);
    if (error) logError("gift_confirmation_unrecorded", error, { giftId });
  } catch (error) {
    logError("gift_confirmation_failed", error, { giftId });
  }
}

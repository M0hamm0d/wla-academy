"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { CheckoutError } from "@/features/commerce/checkout";
import { consentFromForm } from "@/features/commerce/consent";
import { setActiveChild } from "@/features/children/active-child";
import type { FormState } from "@/features/auth/schemas";
import { logError } from "@/lib/observability/logger";
import { AccessError, requireOwnedChild, requireParent } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { siteUrl } from "@/lib/env";
import { purchaseGift } from "./checkout";
import { GIFT_CLAIM_COOKIE, GIFT_CLAIM_COOKIE_PATH, GIFT_CLAIM_SECONDS, GIFT_REDEEM_PATH } from "./claim";
import { keepPurchaserCopy } from "./fulfil";
import { confirmGiftCode } from "./redeem";
import { formatGiftCode, giftCodeSchema } from "./schemas";
import { hashGiftToken, looksLikeGiftToken } from "./token";

/**
 * Who is guessing, for the attempt limit only. Vercel supplies x-real-ip at the
 * edge; the first x-forwarded-for entry is the fallback for other hosts. The
 * database keeps an HMAC of it, never the address.
 */
async function requestClient(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return h.get("x-real-ip") || forwarded || "unknown";
}

/** "Give as a gift?" on the purchase page: on to Stripe, granting nothing. */
export async function giftMissionAction(
  missionSlug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  let result: Awaited<ReturnType<typeof purchaseGift>>;
  try {
    result = await purchaseGift({
      missionSlug,
      origin: siteUrl(),
      consent: consentFromForm(formData),
    });
  } catch (error) {
    if (error instanceof CheckoutError) {
      return error.reason === "consent_required"
        ? { fieldErrors: { consent: error.message } }
        : { error: error.message };
    }
    if (error instanceof AccessError) return { error: "Please sign in again to continue." };
    logError("gift_purchase_failed", error, { missionSlug });
    return { error: "We couldn't start the payment. Please try again." };
  }

  // Outside the try: redirect() throws by design.
  if (result.kind === "processing") redirect("/gift?purchase=success");
  redirect(result.url);
}

const CODE_REFUSED = "That code isn't right, or it has already been used. Check it and try again.";
const CODE_LIMITED = "Too many codes have been tried. Please wait 15 minutes and try again.";
/** A wrong code writes to the database. Answer every attempt in about one time. */
const CODE_ANSWER_FLOOR_MS = 400;

/**
 * Redeem a Gift, step one: the code the purchaser shared (D-149). A correct code
 * gives an httpOnly claim cookie (D-142), and the rest of redemption is the same
 * as it always was. No email address is asked for. Every refusal is one message
 * in about one time; failures are counted per client in the database.
 */
export async function confirmGiftCodeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const code = giftCodeSchema.safeParse(formData.get("code") ?? "");
  if (!code.success) {
    return { fieldErrors: { code: code.error.issues[0]?.message ?? "Enter the gift code." } };
  }

  const started = Date.now();
  let check: Awaited<ReturnType<typeof confirmGiftCode>>;
  try {
    check = await confirmGiftCode(code.data, await requestClient());
  } catch (error) {
    logError("gift_code_confirm_failed", error);
    return { error: "We couldn't check that just now. Please try again." };
  }
  const wait = CODE_ANSWER_FLOOR_MS - (Date.now() - started);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  if (check.outcome === "rate_limited") return { error: CODE_LIMITED };
  if (check.outcome !== "matched") return { error: CODE_REFUSED };

  (await cookies()).set(GIFT_CLAIM_COOKIE, check.claim, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: GIFT_CLAIM_COOKIE_PATH,
    maxAge: GIFT_CLAIM_SECONDS,
  });
  redirect(GIFT_REDEEM_PATH);
}

/** Turn a confirmed claim into the chosen child's entitlement. */
export async function redeemGiftAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const jar = await cookies();
  const claim = jar.get(GIFT_CLAIM_COOKIE)?.value;
  if (!looksLikeGiftToken(claim)) {
    return { error: "Please enter the gift code again." };
  }
  const childId = formData.get("childId")?.toString();
  if (!childId) return { error: "Choose who this mission is for." };

  let userId: string;
  try {
    const { user } = await requireParent();
    userId = user.id;
    await requireOwnedChild(childId); // never trust the submitted id
  } catch (error) {
    if (error instanceof AccessError && error.reason === "unauthenticated") redirect("/login?next=%2Fredeem");
    if (error instanceof AccessError) return { error: "Choose who this mission is for." };
    throw error;
  }

  const { data: outcome, error } = await createAdminClient().rpc("redeem_mission_gift", {
    p_claim_hash: hashGiftToken(claim),
    p_child_id: childId,
    p_parent_id: userId,
  });
  if (error) {
    logError("gift_redeem_failed", error);
    return { error: "We couldn't redeem that gift. Please try again." };
  }

  switch (outcome) {
    case "redeemed":
      break;
    case "already_owned":
      return {
        error: "That child already has this mission. Choose another child, or add a profile.",
      };
    case "already_redeemed":
      jar.delete({ name: GIFT_CLAIM_COOKIE, path: GIFT_CLAIM_COOKIE_PATH });
      return { error: "This gift has already been redeemed." };
    case "forbidden":
      return { error: "Choose who this mission is for." };
    case "unavailable":
      return { error: "This mission can't be added for that child. Choose another child." };
    default:
      // The claim no longer leads anywhere (expired, or the code was replaced).
      jar.delete({ name: GIFT_CLAIM_COOKIE, path: GIFT_CLAIM_COOKIE_PATH });
      return { error: "Please enter the gift code again." };
  }

  jar.delete({ name: GIFT_CLAIM_COOKIE, path: GIFT_CLAIM_COOKIE_PATH });
  await setActiveChild(childId).catch(() => {});
  revalidatePath("/academy", "layout");
  redirect("/academy/my-missions?added=1");
}

export type ReissueState = FormState & { giftId?: string; code?: string };

/**
 * The purchaser replaces a gift's code: lost, never shown, or shared with the
 * wrong person. The old code stops working at once. The new code is returned to
 * this page so it can be shown even where no copy can be kept (no key).
 */
export async function reissueGiftCodeAction(
  _prev: ReissueState,
  formData: FormData,
): Promise<ReissueState> {
  const giftId = formData.get("giftId")?.toString() ?? "";
  if (formData.get("confirm") !== "yes") {
    return { giftId, error: "Tick the box to confirm the old code should stop working." };
  }
  let userId: string;
  try {
    ({ user: { id: userId } } = await requireParent());
  } catch (error) {
    if (error instanceof AccessError) return { giftId, error: "Please sign in again to continue." };
    throw error;
  }

  const admin = createAdminClient();
  const { data: code, error } = await admin.rpc("reissue_gift_code", {
    p_gift_id: giftId,
    p_purchaser_id: userId, // re-asserted in the database
  });
  if (error) {
    logError("gift_code_reissue_failed", error, { giftId });
    return { giftId, error: "We couldn't make a new code just now. Please try again." };
  }
  if (!code) return { giftId, error: "This gift can't have a new code: it may have been redeemed." };

  await keepPurchaserCopy(admin, giftId, code);
  revalidatePath("/account");
  revalidatePath("/gift");
  return { giftId, code: formatGiftCode(code), notice: "Here is the new code. The old one no longer works." };
}

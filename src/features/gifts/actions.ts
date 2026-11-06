"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { CheckoutError } from "@/features/commerce/checkout";
import { setActiveChild } from "@/features/children/active-child";
import type { FormState } from "@/features/auth/schemas";
import { logError } from "@/lib/observability/logger";
import { AccessError, requireOwnedChild, requireParent } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { purchaseGift } from "./checkout";
import { GIFT_CLAIM_COOKIE, GIFT_CLAIM_COOKIE_PATH, GIFT_CLAIM_SECONDS, GIFT_REDEEM_PATH } from "./claim";
import { emailCodeFor, emailLinksFor } from "./fulfil";
import { confirmGiftCode, confirmGiftEmail } from "./redeem";
import { confirmEmailSchema, giftCodeSchema, recipientEmailSchema } from "./schemas";
import { hashGiftToken, looksLikeGiftToken, normaliseGiftEmail } from "./token";
import { siteUrl } from "@/lib/env";

async function giftRequestAllowed(email: string, sending: boolean): Promise<boolean> {
  const h = await headers();
  // Vercel supplies x-real-ip at the edge. x-forwarded-for is a fallback for
  // local deployments; only its first (client) address is passed to a hash-only DB bucket.
  const ip = h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const { data, error } = await createAdminClient().rpc("consume_gift_request_limit", {
    p_ip: ip,
    p_email: email,
    p_send: sending,
  });
  if (error) {
    logError("gift_request_rate_limit_failed", error);
    return false;
  }
  return data === true;
}

/** "Give as a gift?" on the purchase page: on to Stripe, granting nothing. */
export async function giftMissionAction(
  missionSlug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = recipientEmailSchema.safeParse(formData.get("recipientEmail") ?? "");
  if (!parsed.success) {
    return { fieldErrors: { recipientEmail: parsed.error.issues[0]?.message ?? "Enter a valid email address." } };
  }

  let result: Awaited<ReturnType<typeof purchaseGift>>;
  try {
    result = await purchaseGift({
      missionSlug,
      recipientEmail: parsed.data,
      origin: siteUrl(),
    });
  } catch (error) {
    if (error instanceof CheckoutError) return { error: error.message };
    if (error instanceof AccessError) return { error: "Please sign in again to continue." };
    logError("gift_purchase_failed", error, { missionSlug });
    return { error: "We couldn't start the payment. Please try again." };
  }

  // Outside the try: redirect() throws by design.
  if (result.kind === "processing") redirect("/gift?purchase=success");
  redirect(result.url);
}

function setClaimCookie(jar: Awaited<ReturnType<typeof cookies>>, claim: string) {
  jar.set(GIFT_CLAIM_COOKIE, claim, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: GIFT_CLAIM_COOKIE_PATH,
    maxAge: GIFT_CLAIM_SECONDS,
  });
}

/** The website's Redeem a Gift, between its two steps. The address stays in the page. */
export type GiftCodeState = FormState & { email?: string };

const CODE_SENT_NOTICE =
  "If a gift was sent to that address, we've emailed it a code. Enter it below.";
const CODE_REFUSED =
  "That code isn't right, or it has expired. Check it, or ask for a new one.";
/** Minimum response time helps reduce timing differences; database limits do the throttling. */
const CODE_ANSWER_FLOOR_MS = 400;

/**
 * Step one of Redeem a Gift (D-145). Always the same answer, so it can't be used
 * to find out who has been given a gift or who has an account. The work runs after
 * the response, so its timing can't tell either. "Send a new code" is this again.
 */
export async function requestGiftCodeAction(
  _prev: GiftCodeState,
  formData: FormData,
): Promise<GiftCodeState> {
  const parsed = confirmEmailSchema.safeParse(formData.get("email") ?? "");
  if (!parsed.success) {
    return { fieldErrors: { email: parsed.error.issues[0]?.message ?? "Enter a valid email address." } };
  }
  const email = normaliseGiftEmail(parsed.data);
  if (await giftRequestAllowed(email, true)) after(() => emailCodeFor(createAdminClient(), email));
  return { email, notice: CODE_SENT_NOTICE };
}

/**
 * Step two: the code. A correct one gives the same claim cookie the emailed link
 * does, and the rest of redemption is shared (D-145). Every refusal is one message
 * in one time, and failures are counted in the database per code.
 */
export async function confirmGiftCodeAction(
  _prev: GiftCodeState,
  formData: FormData,
): Promise<GiftCodeState> {
  const email = confirmEmailSchema.safeParse(formData.get("email") ?? "");
  if (!email.success) return { error: "Please enter your email address again." };
  const kept = { email: normaliseGiftEmail(email.data) };
  if (!(await giftRequestAllowed(kept.email, false))) return { ...kept, error: CODE_REFUSED };

  const code = giftCodeSchema.safeParse(formData.get("code") ?? "");
  if (!code.success) {
    return { ...kept, fieldErrors: { code: code.error.issues[0]?.message ?? "Enter the code." } };
  }

  const started = Date.now();
  let check: Awaited<ReturnType<typeof confirmGiftCode>>;
  try {
    check = await confirmGiftCode(kept.email, code.data);
  } catch (error) {
    logError("gift_code_confirm_failed", error);
    return { ...kept, error: "We couldn't check that just now. Please try again." };
  }
  const wait = CODE_ANSWER_FLOOR_MS - (Date.now() - started);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  if (check.outcome !== "matched") return { ...kept, error: CODE_REFUSED };

  setClaimCookie(await cookies(), check.claim);
  redirect(GIFT_REDEEM_PATH);
}

/**
 * The redemption page's question for the holder of a link: "Confirm your email".
 *
 * With a link, the token and the address must both match. Only then does the
 * browser get a claim cookie (D-142), and the token leaves the URL.
 *
 * Without a link, this emails a new link to that address: the "email me a link
 * instead" choice beside the code form. It always gives the same answer, after
 * which the work runs, with its own ten-minute limit.
 */
export async function confirmGiftEmailAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = confirmEmailSchema.safeParse(formData.get("email") ?? "");
  if (!parsed.success) {
    return { fieldErrors: { email: parsed.error.issues[0]?.message ?? "Enter a valid email address." } };
  }

  const token = formData.get("token")?.toString() ?? "";

  if (!token) {
    const email = normaliseGiftEmail(parsed.data);
    if (await giftRequestAllowed(email, true)) after(() => emailLinksFor(createAdminClient(), email));
    return {
      notice:
        "If a gift was sent to that address, we've emailed it a link to redeem it. Please check your inbox.",
    };
  }

  const normalisedEmail = normaliseGiftEmail(parsed.data);
  if (!(await giftRequestAllowed(normalisedEmail, false))) return { error: "That gift link isn't valid any more. Please try again later." };

  let check: Awaited<ReturnType<typeof confirmGiftEmail>>;
  try {
    check = await confirmGiftEmail(token, normalisedEmail);
  } catch (error) {
    logError("gift_confirm_failed", error);
    return { error: "We couldn't check that just now. Please try again." };
  }

  if (check.outcome === "mismatch") {
    return {
      error:
        "That isn't the email address this gift was sent to. Check the address and try again.",
    };
  }
  if (check.outcome === "already_redeemed") {
    return { error: "This gift has already been redeemed." };
  }
  if (check.outcome === "invalid") {
    return {
      error:
        "This gift link isn't valid any more. Choose Redeem a Gift on our website and enter your email address to get a new one.",
    };
  }

  setClaimCookie(await cookies(), check.claim);
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
    return { error: "Please confirm your email address again." };
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
      // The claim no longer leads anywhere, so don't leave them stuck on it.
      jar.delete({ name: GIFT_CLAIM_COOKIE, path: GIFT_CLAIM_COOKIE_PATH });
      return { error: "Please confirm your email address again." };
  }

  jar.delete({ name: GIFT_CLAIM_COOKIE, path: GIFT_CLAIM_COOKIE_PATH });
  await setActiveChild(childId).catch(() => {});
  revalidatePath("/academy", "layout");
  redirect("/academy/my-missions?added=1");
}

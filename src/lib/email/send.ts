import "server-only";

import { devMailpitUrl, sendToMailpit } from "./dev-mailpit";
import { formatPrice } from "@/lib/utils";

/**
 * TRANSACTIONAL EMAIL — D-27, as amended by D-149 and D-152.
 *
 * Scope is deliberately two messages, both to the person who paid, both the
 * order confirmation the law requires on a durable medium (D-152):
 *
 *   - a mission bought for a child: what was bought, for how much, the two
 *     checkout statements as agreed, and the way in;
 *   - a mission bought as a gift: the same, plus the gift code, which the
 *     purchaser shares with the recipient themselves (D-149).
 *
 * WLA no longer emails a gift's recipient at all: it holds no recipient address.
 *
 * NOT in scope, and not to be added here: marketing, digests, reminders,
 * re-engagement, or notifications of any kind — Architecture §22 defers
 * notifications entirely.
 *
 * CONFIGURATION DEPENDENCY
 * Resend is the approved provider, with RESEND_API_KEY and EMAIL_FROM. Without
 * them nothing is sent, the reason is returned, and the order records no
 * confirmation (`confirmation_sent_at` stays empty, visible in admin Orders).
 *
 * Both variables are read directly from process.env rather than through
 * serverEnv(), because serverEnv() validates its five variables together and
 * email must not become a hard requirement for payments to work.
 */

type Outcome = { sent: boolean; reason?: string };

/** One send, never throwing. Nothing about the recipient or the body is logged. */
async function deliver(to: string, subject: string, text: string, label: string): Promise<Outcome> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  console.info("[email] sender configuration", {
    from: JSON.stringify(from),
  });

  if (!apiKey || !from) {
    const mailpit = devMailpitUrl();
    if (mailpit) return sendToMailpit(mailpit, { to, subject, text });
    // Configuration pending, not an error. No address, no content in logs.
    console.info(`[email] not configured; would send ${label}`);
    return { sent: false, reason: "not_configured" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!response.ok) {
      // console.error(`[email] ${label} send failed`, { status: response.status });
      const errorBody = await response.text();

      console.error(`[email] ${label} send failed`, {
        status: response.status,
        providerResponse: errorBody,
      });
      return { sent: false, reason: `http_${response.status}` };
    }
    return { sent: true };
  } catch {
    // Not the error itself: a network error can quote the request.
    console.error(`[email] ${label} send threw`);
    return { sent: false, reason: "exception" };
  }
}

/** A send that might work next time: the webhook asks Stripe to deliver again. */
export function isWorthRetrying(reason: string | undefined): boolean {
  return reason === "exception" || reason === "http_429" || /^http_5/.test(reason ?? "");
}

type OrderFacts = {
  missionTitle: string;
  amountMinor: number;
  currency: string;
  /** When the payment was confirmed: the contract date. */
  paidAt: string;
  /** The wording recorded with the order (consent.ts), or null for an order placed before it existed. */
  consentWording: string | null;
  consentRecorded: boolean;
};

function orderLines({ missionTitle, amountMinor, currency, paidAt, consentWording, consentRecorded }: OrderFacts): string[] {
  const date = new Date(paidAt).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London",
  });
  const lines = [
    "Your order",
    `  Mission: ${missionTitle}`,
    `  Price paid: ${formatPrice(amountMinor, currency)}`,
    `  Date: ${date}`,
    "  Supplied by: Within Lab Academy",
    "",
  ];
  if (consentRecorded && consentWording) {
    const [, consent, ack] = consentWording.split(" | ");
    lines.push(
      "Before paying, you confirmed:",
      `  - ${consent}`,
      `  - ${ack}`,
      "Access started when your payment was confirmed, so the 14-day right to cancel no longer applies.",
      "",
    );
  }
  const terms = process.env.NEXT_PUBLIC_TERMS_URL;
  if (terms) lines.push(`Our Terms & Conditions: ${terms}`, "");
  return lines;
}

export type MissionAccessEmail = OrderFacts & {
  /** The parent's address. Children never receive email — they have no account. */
  to: string;
  childName: string;
  /** Absolute link to that mission's permanent Mission Home (Architecture §5). */
  missionUrl: string;
};

/**
 * Confirm the order, and that the mission is now available to a child.
 * NEVER throws: the webhook decides what a failure means.
 */
export async function sendMissionAccessEmail(email: MissionAccessEmail): Promise<Outcome> {
  return deliver(
    email.to,
    `Order confirmed: ${email.childName} now has ${email.missionTitle}`,
    renderMissionAccessText(email),
    "mission access",
  );
}

/**
 * Plain text, deliberately. No marketing, no upsell — Architecture §14 keeps
 * completion free of upsell and the same restraint applies here.
 */
function renderMissionAccessText(email: MissionAccessEmail): string {
  return [
    `${email.childName} now has ${email.missionTitle}.`,
    "",
    "It's ready whenever they are. Everything they need is in the Mission Kit,",
    "and there's a short note for you under For Parents.",
    "",
    email.missionUrl,
    "",
    ...orderLines(email),
    "Keep this email as your order confirmation.",
    "",
    "Within Lab Academy",
  ].join("\n");
}

export type GiftPurchaseEmail = OrderFacts & {
  /** The purchaser's own address. Never a recipient's: WLA holds none (D-149). */
  to: string;
  /** XXXX-XXXX-XXXX. A credential: it appears only in the body. */
  code: string;
};

/** The gift code and the order confirmation, to the purchaser. NEVER throws. */
export async function sendGiftPurchaseEmail(email: GiftPurchaseEmail): Promise<Outcome> {
  return deliver(
    email.to,
    `Your gift code for ${email.missionTitle}`,
    renderGiftPurchaseText(email),
    "gift purchase",
  );
}

function renderGiftPurchaseText(email: GiftPurchaseEmail): string {
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  return [
    `Thank you for giving ${email.missionTitle}.`,
    "",
    "Your gift code:",
    "",
    `  ${email.code}`,
    "",
    "Share it with the person you're giving it to, however you like. To redeem it,",
    `they go to ${site ? `${site}/redeem` : "Redeem a Gift"}, enter the code, sign in or create`,
    "an account, and choose their child. The code works once and doesn't expire.",
    "",
    "Keep the code private until you give it: whoever has it can redeem the gift.",
    "You can see it again, or replace it, under Account.",
    "",
    ...orderLines(email),
    "Keep this email as your order confirmation.",
    "",
    "Within Lab Academy",
  ].join("\n");
}

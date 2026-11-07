/**
 * IMMEDIATE SUPPLY OF DIGITAL CONTENT (D-152).
 *
 * A mission is digital content supplied as soon as payment is confirmed. Under
 * the Consumer Contracts Regulations 2013 (reg. 37) the 14-day right to cancel
 * ends when supply begins only if the customer, before paying, expressly
 * consented to supply starting within the cancellation period AND acknowledged
 * that they would lose the right; and the trader then confirms the contract on
 * a durable medium, recording both (reg. 16). This holds that wording in one
 * place: the checkboxes show it, the server records it with the order, and the
 * confirmation email repeats it.
 *
 * Changing either sentence is a change to what customers agree to: bump the
 * version, so every order records exactly what was shown.
 */
export const CONSENT_VERSION = "2026-11-06";

export const EARLY_SUPPLY_CONSENT =
  "I want access to start as soon as my payment is confirmed, within the 14-day cancellation period.";

export const CANCELLATION_ACKNOWLEDGEMENT =
  "I understand that once access starts I lose my right to cancel and get a refund under the 14-day cancellation period.";

/** What is stored with the order: the version and both sentences, as shown. */
export function consentWording(): string {
  return `${CONSENT_VERSION} | ${EARLY_SUPPLY_CONSENT} | ${CANCELLATION_ACKNOWLEDGEMENT}`;
}

export type CheckoutConsent = {
  earlySupplyConsentAt: string;
  cancellationAckAt: string;
  wording: string;
};

/**
 * Read both boxes from a submitted form. Null unless BOTH were ticked: neither
 * is implied by the other, and an unticked box is never assumed.
 */
export function consentFromForm(formData: FormData, now: Date = new Date()): CheckoutConsent | null {
  const consent = formData.get("earlySupplyConsent") === "yes";
  const ack = formData.get("cancellationAcknowledged") === "yes";
  if (!consent || !ack) return null;
  const at = now.toISOString();
  return { earlySupplyConsentAt: at, cancellationAckAt: at, wording: consentWording() };
}

export const CONSENT_REQUIRED_MESSAGE =
  "Please tick both boxes to continue. Access starts as soon as your payment is confirmed.";

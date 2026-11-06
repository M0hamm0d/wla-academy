import { createHash, randomBytes } from "node:crypto";

/**
 * Redemption tokens (D-140).
 *
 * 256 random bits, unguessable and carrying no information. The same shape
 * serves two secrets: the link's token, which travels only in the email to the
 * recipient, and the claim, which travels only in an httpOnly cookie. The
 * database holds only their SHA-256, so a read of the table redeems nothing.
 */
export function newGiftToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashGiftToken(token) };
}

export function hashGiftToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A value that could be a token. Anything else is not worth a query. */
export function looksLikeGiftToken(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** The one rule for comparing addresses; the column stores this form. */
export function normaliseGiftEmail(email: string): string {
  const normalised = email.trim().toLowerCase();
  if (normalised.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised)) {
    throw new Error("Invalid gift email address.");
  }
  return normalised;
}

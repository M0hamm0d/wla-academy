import { createHash, randomBytes } from "node:crypto";

/**
 * Gift claims (D-142, D-149).
 *
 * 256 random bits, unguessable and carrying no information. A claim is issued
 * once a correct gift code has been entered and travels only in an httpOnly
 * cookie. The database holds only its SHA-256, so a read of the table redeems
 * nothing.
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

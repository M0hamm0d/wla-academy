import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * THE ENCRYPTED COPY OF A CHILD'S CODE (D-143).
 *
 * AES-256-GCM, so a changed ciphertext fails rather than decrypting to nonsense.
 * The additional authenticated data names the child and the credential, so a
 * copy moved to another row fails too. Sign-in never touches any of this: it
 * verifies the bcrypt hash in the database.
 *
 * The key is CHILD_CODE_ENCRYPTION_KEY, 32 bytes as base64. It lives in the
 * server's environment and never in the database. During a rotation the old key
 * is CHILD_CODE_ENCRYPTION_KEY_PREVIOUS; each copy names the key that made it.
 * See docs/CHILD-CODE-ENCRYPTION.md.
 *
 * This file imports node:crypto, so it can't reach a client bundle, and it has
 * no app imports, so scripts/rotate-child-code-key.ts can run it directly.
 */

/**
 * What a copy is bound to. A child's code names the child and the credential; a
 * purchaser's copy of a gift code names the gift (D-149). The two never open as
 * each other: the authenticated data starts with a different label.
 */
export type CodeBinding = { childId: string; credentialId: string } | { giftId: string };
export type CodeKeys = { current?: string; previous?: string };

/** The key is missing or isn't 32 bytes. Never carries the key itself. */
export class CodeKeyError extends Error {}
/** This copy can't be opened with the keys held: wrong key, or altered, or moved. */
export class CodeCopyError extends Error {}

const FORMAT = "v1";
const IV_BYTES = 12;

function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new CodeKeyError("The encryption key must be 32 bytes, as base64.");
  return key;
}

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function aad(binding: CodeBinding): Buffer {
  if ("giftId" in binding) return Buffer.from(`wla-gift-code:${FORMAT}:${binding.giftId}`);
  return Buffer.from(`wla-child-code:${FORMAT}:${binding.childId}:${binding.credentialId}`);
}

export function keysFromEnv(env: Record<string, string | undefined> = process.env): CodeKeys {
  return {
    current: env.CHILD_CODE_ENCRYPTION_KEY,
    previous: env.CHILD_CODE_ENCRYPTION_KEY_PREVIOUS,
  };
}

export function sealCode(code: string, binding: CodeBinding, keys: CodeKeys = keysFromEnv()): string {
  const key = parseKey(keys.current);
  if (!key) throw new CodeKeyError("The encryption key is not set.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(binding));
  const body = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return [
    FORMAT,
    keyId(key),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

export function openCode(sealed: string, binding: CodeBinding, keys: CodeKeys = keysFromEnv()): string {
  const [format, kid, iv, tag, body] = sealed.split(".");
  if (format !== FORMAT || !kid || !iv || !tag || !body) throw new CodeCopyError("Unknown format.");
  const key = [parseKey(keys.current), parseKey(keys.previous)].find((k) => k && keyId(k) === kid);
  if (!key) throw new CodeCopyError("No key held for this copy.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new CodeCopyError("This copy doesn't open.");
  }
}

/** Re-encrypt under the current key, for a rotation. Same binding, same code. */
export function resealCode(sealed: string, binding: CodeBinding, keys: CodeKeys = keysFromEnv()): string {
  return sealCode(openCode(sealed, binding, keys), binding, keys);
}

/** Is this copy already under the current key? Lets a rotation be re-run safely. */
export function isUnderCurrentKey(sealed: string, keys: CodeKeys = keysFromEnv()): boolean {
  const key = parseKey(keys.current);
  return Boolean(key) && sealed.split(".")[1] === keyId(key as Buffer);
}

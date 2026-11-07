import { z } from "zod";

/**
 * A gift code (D-149): twelve characters, however it was typed or pasted —
 * with spaces or hyphens, in lower case, or with a full stop after it.
 */
export const GIFT_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{12}$/;

export const giftCodeSchema = z
  .string()
  .max(64, "Enter the twelve-character gift code.")
  .transform((v) => v.replace(/[^A-Za-z0-9]/g, "").toUpperCase())
  .pipe(z.string().regex(GIFT_CODE_PATTERN, "Enter the twelve-character gift code, for example ABCD-EFGH-JKMN."));

/** How a code is shown and shared: three groups of four. */
export function formatGiftCode(code: string): string {
  const c = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return c.length === 12 ? `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}` : c;
}

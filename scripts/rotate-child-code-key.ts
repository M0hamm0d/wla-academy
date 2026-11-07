// Re-encrypt every active child code copy, and every purchaser's gift code
// copy, under the current key (D-143, D-149).
//
//   CHILD_CODE_ENCRYPTION_KEY=<new> CHILD_CODE_ENCRYPTION_KEY_PREVIOUS=<old> \
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/rotate-child-code-key.ts
//
// Safe to run again: a copy already under the new key is left alone, and a
// credential replaced meanwhile fails its compare-and-swap harmlessly. Prints
// counts only. See docs/CHILD-CODE-ENCRYPTION.md.
// @ts-expect-error -- Node runs this file directly, which needs the extension.
import { CodeCopyError, isUnderCurrentKey, keysFromEnv, resealCode } from "../src/features/child-auth/code-crypto.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !service) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
const keys = keysFromEnv();
if (!keys.current) throw new Error("Set CHILD_CODE_ENCRYPTION_KEY to the new key.");

const headers = { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" };

type Counts = { total: number; moved: number; already: number; unreadable: number; failed: number };

/** Re-seal every copy in one table: child codes (D-143), and purchasers' gift codes (D-149). */
async function rotate(
  path: string,
  query: string,
  bindingFor: (row: Record<string, string>) => Parameters<typeof resealCode>[1],
  guard: string,
): Promise<Counts> {
  const table = `${url!.replace(/\/$/, "")}/rest/v1/${path}`;
  const list = await fetch(`${table}?${query}`, { headers });
  if (!list.ok) throw new Error(`Couldn't read the copies in ${path} (HTTP ${list.status}).`);
  const rows = (await list.json()) as Record<string, string>[];
  const c: Counts = { total: rows.length, moved: 0, already: 0, unreadable: 0, failed: 0 };
  for (const row of rows) {
    if (isUnderCurrentKey(row.code_ciphertext, keys)) { c.already++; continue; }
    try {
      const sealed = resealCode(row.code_ciphertext, bindingFor(row), keys);
      const swap = await fetch(
        `${table}?id=eq.${row.id}&code_ciphertext=eq.${encodeURIComponent(row.code_ciphertext)}&${guard}`,
        { method: "PATCH", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify({ code_ciphertext: sealed }) },
      );
      if (swap.ok) c.moved++; else c.failed++;
    } catch (error) {
      if (error instanceof CodeCopyError) c.unreadable++; else c.failed++;
    }
  }
  return c;
}

const children = await rotate(
  "child_access_credentials",
  "select=id,child_id,code_ciphertext&revoked_at=is.null&code_ciphertext=not.is.null",
  (row) => ({ childId: row.child_id, credentialId: row.id }),
  "revoked_at=is.null",
);
const gifts = await rotate(
  "mission_gifts",
  "select=id,code_ciphertext&status=eq.paid&code_ciphertext=not.is.null",
  (row) => ({ giftId: row.id }),
  "status=eq.paid",
);
console.log(JSON.stringify({ children, gifts }));
if (children.failed + children.unreadable + gifts.failed + gifts.unreadable > 0) process.exitCode = 1;

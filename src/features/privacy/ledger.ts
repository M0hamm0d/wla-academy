import "server-only";

import { join } from "node:path";
import { logError, logWarn } from "@/lib/observability/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { appendToLedger, ledgerKeys, LedgerKeyError, type LedgerEvent, type LedgerKeys } from "./ledger-core";

/**
 * SHIPPING THE DELETION LEDGER (S3, D-157).
 *
 * The database records every privacy event in privacy_ledger_outbox, in the
 * same transaction as the change. This copies them, in order, to the ledger
 * outside the database (ledger-core.ts) and records how far it got.
 *
 * Configured by two server variables:
 *   PRIVACY_LEDGER_DIR  where the ledger file lives. It must NOT be anything a
 *                       database restore rolls back: not this database, and not
 *                       Storage in this project (whose records are in it).
 *   PRIVACY_LEDGER_KEY  32 random bytes, base64.
 *
 * Neither set: "unconfigured". Closures proceed as before, and /admin/privacy
 * says plainly that a restore could bring deleted families back (OPEN-30).
 * Only one set, or a bad key: "misconfigured", and closures wait.
 * Both: a closure deletes nothing until its request is in the ledger.
 *
 * A directory is what can be built and tested without a provider WLA hasn't
 * chosen. On a host without a lasting filesystem (Vercel) it is not enough:
 * the sink must be somewhere WLA controls separately. That is a WLA decision.
 */
type Admin = ReturnType<typeof createAdminClient>;

export type LedgerConfig =
  | { state: "unconfigured" }
  | { state: "misconfigured"; reason: "dir_without_key" | "key_without_dir" | "bad_key" }
  | { state: "configured"; file: string; keys: LedgerKeys };

export const LEDGER_FILE = "deletion-ledger.jsonl";

export function ledgerConfig(env: Record<string, string | undefined> = process.env): LedgerConfig {
  const dir = env.PRIVACY_LEDGER_DIR?.trim();
  const key = env.PRIVACY_LEDGER_KEY?.trim();
  if (!dir && !key) return { state: "unconfigured" };
  if (!key) return { state: "misconfigured", reason: "dir_without_key" };
  if (!dir) return { state: "misconfigured", reason: "key_without_dir" };
  try {
    return { state: "configured", file: join(dir, LEDGER_FILE), keys: ledgerKeys(key) };
  } catch (error) {
    if (error instanceof LedgerKeyError) return { state: "misconfigured", reason: "bad_key" };
    throw error;
  }
}

const BATCH = 200;
const MAX_BATCHES = 10;

/**
 * Copy every pending event to the ledger. Safe to repeat and to run anywhere:
 * the file is locked while written, and an event copied twice (a crash between
 * writing and recording) is harmless, because the replay is idempotent.
 */
export async function shipLedger(admin: Admin, config: LedgerConfig = ledgerConfig()): Promise<{ state: LedgerConfig["state"]; shipped: number }> {
  if (config.state !== "configured") return { state: config.state, shipped: 0 };
  let shipped = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { data: rows, error } = await admin.rpc("privacy_ledger_pending", { p_limit: BATCH });
    if (error) throw error;
    if (!rows || rows.length === 0) break;
    const events: LedgerEvent[] = rows.map((r) => ({
      event_id: r.event_id,
      event: r.event,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      created_at: r.created_at,
    }));
    const head = appendToLedger(config.file, events, config.keys);
    const { error: markError } = await admin.rpc("privacy_ledger_mark_shipped", {
      p_event_ids: rows.map((r) => r.event_id),
      p_ledger_seq: head.seq,
      p_chain: head.chain,
    });
    if (markError) throw markError;
    shipped += rows.length;
    if (rows.length < BATCH) break;
  }
  return { state: "configured", shipped };
}

/** For actions that changed a hold or removed a contribution: copy now, never fail the action. */
export async function shipLedgerQuietly(): Promise<void> {
  const config = ledgerConfig();
  if (config.state !== "configured") return;
  try {
    await shipLedger(createAdminClient(), config);
  } catch (error) {
    // Left in the outbox: the next closure, or the scheduled follow-up, copies it.
    logError("deletion_ledger_ship_failed", error);
  }
}

/**
 * May this closure delete anything yet? Only once its request is in the
 * ledger, when there is one. Returns an error code (never content) if not.
 */
export async function ensureRequestLedgered(admin: Admin, deletionId: string, config: LedgerConfig = ledgerConfig()): Promise<{ ok: true } | { ok: false; code: string }> {
  if (config.state === "unconfigured") return { ok: true };
  if (config.state === "misconfigured") {
    logWarn("deletion_ledger_misconfigured", { reason: config.reason });
    return { ok: false, code: "ledger_misconfigured" };
  }
  try {
    await shipLedger(admin, config);
  } catch (error) {
    logError("deletion_ledger_ship_failed", error, { deletionId });
    return { ok: false, code: "ledger_unavailable" };
  }
  const { data, error } = await admin.rpc("privacy_ledger_request_shipped", { p_deletion: deletionId });
  if (error || data !== true) return { ok: false, code: "ledger_unavailable" };
  return { ok: true };
}

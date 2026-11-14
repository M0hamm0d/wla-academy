import "server-only";

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { logError, logWarn } from "@/lib/observability/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { appendToLedger, createLedgerSegment, decodeLedgerSegments, encodeLedgerSegment, ledgerKeys, LedgerKeyError, readLedger, type LedgerEvent, type LedgerKeys } from "./ledger-core";

export const LEDGER_BUCKET = "wla-privacy-ledger";
export const LEDGER_FILE = "deletion-ledger.jsonl";
const PREFIX = "v1/segments";
const BATCH = 200;
const MAX_BATCHES = 10;
const LEASE_SECONDS = 120;
type Admin = ReturnType<typeof createAdminClient>;
export type StorageObject = { name: string; content: string };
export interface LedgerStorage {
  list(): Promise<StorageObject[]>;
  download(path: string): Promise<string>;
  uploadImmutable(path: string, content: string): Promise<"created" | "exists">;
}
export type LedgerConfig =
  | { state: "unconfigured" }
  | { state: "misconfigured"; reason: "missing_url" | "missing_token" | "missing_key" | "bad_key" | "local_not_allowed" | "same_project" | "bad_url" }
  | { state: "configured"; kind: "supabase"; keys: LedgerKeys; storage: LedgerStorage }
  | { state: "configured"; kind: "filesystem"; file: string; keys: LedgerKeys };

export function createSupabaseLedgerStorage(url: string, token: string): LedgerStorage {
  const client = createClient(url, token, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = client.storage.from(LEDGER_BUCKET);
  return {
    async list() {
      const all: StorageObject[] = []; let offset = 0;
      while (true) {
        const { data, error } = await bucket.list(PREFIX, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
        if (error) throw error;
        const page = data ?? [];
        all.push(...page.filter((o) => o.name.endsWith(".json")).map((o) => ({ name: `${PREFIX}/${o.name}`, content: "" })));
        if (page.length < 100) break;
        offset += page.length;
      }
      return all;
    },
    async download(path) {
      const { data, error } = await bucket.download(path);
      if (error || !data) throw error ?? new Error("ledger_object_missing");
      return await data.text();
    },
    async uploadImmutable(path, content) {
      const { error } = await bucket.upload(path, new Blob([content], { type: "application/json" }), { contentType: "application/json", upsert: false });
      if (!error) return "created";
      if (/already exists|duplicate|resource already exists/i.test(`${error.message} ${error.name}`)) return "exists";
      throw error;
    },
  };
}

export function ledgerConfig(env: Record<string, string | undefined> = process.env): LedgerConfig {
  const url = env.PRIVACY_LEDGER_URL?.trim(); const token = env.PRIVACY_LEDGER_TOKEN?.trim(); const key = env.PRIVACY_LEDGER_KEY?.trim();
  const dir = env.PRIVACY_LEDGER_DIR?.trim();
  const production = env.NODE_ENV === "production" || env.VERCEL === "1";
  if (production) {
    if (!url) return { state: "misconfigured", reason: "missing_url" };
    if (!token) return { state: "misconfigured", reason: "missing_token" };
    if (!key) return { state: "misconfigured", reason: "missing_key" };
    try { if (env.NEXT_PUBLIC_SUPABASE_URL && new URL(url).origin === new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin) return { state: "misconfigured", reason: "same_project" }; }
    catch { return { state: "misconfigured", reason: "bad_url" }; }
    try { return { state: "configured", kind: "supabase", keys: ledgerKeys(key), storage: createSupabaseLedgerStorage(url, token) }; }
    catch (e) { return e instanceof LedgerKeyError ? { state: "misconfigured", reason: "bad_key" } : (() => { throw e; })(); }
  }
  if (url || token) {
    if (!url) return { state: "misconfigured", reason: "missing_url" };
    if (!token) return { state: "misconfigured", reason: "missing_token" };
    if (!key) return { state: "misconfigured", reason: "missing_key" };
    try { if (env.NEXT_PUBLIC_SUPABASE_URL && new URL(url).origin === new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin) return { state: "misconfigured", reason: "same_project" }; }
    catch { return { state: "misconfigured", reason: "bad_url" }; }
    try { return { state: "configured", kind: "supabase", keys: ledgerKeys(key), storage: createSupabaseLedgerStorage(url, token) }; }
    catch (e) { return e instanceof LedgerKeyError ? { state: "misconfigured", reason: "bad_key" } : (() => { throw e; })(); }
  }
  if (!dir && !key) return { state: "unconfigured" };
  if (!dir) return { state: "misconfigured", reason: "local_not_allowed" };
  if (!key) return { state: "misconfigured", reason: "missing_key" };
  try { return { state: "configured", kind: "filesystem", file: join(dir, LEDGER_FILE), keys: ledgerKeys(key) }; }
  catch (e) { return e instanceof LedgerKeyError ? { state: "misconfigured", reason: "bad_key" } : (() => { throw e; })(); }
}

async function fetchSegments(storage: LedgerStorage, keys: LedgerKeys, allowEmpty = false) {
  const listed = await storage.list();
  const objects: StorageObject[] = [];
  for (let start = 0; start < listed.length; start += 20) {
    const batch = listed.slice(start, start + 20);
    objects.push(...await Promise.all(batch.map(async (o) => ({ name: o.name, content: o.content || await storage.download(o.name) }))));
  }
  const read = decodeLedgerSegments(objects, keys);
  if (!read.ok && !(allowEmpty && read.reason === "missing")) throw new Error(`ledger_${read.reason}${read.seq ? `_at_${read.seq}` : ""}`);
  const verified = read.ok ? read : { ok: true as const, entries: [], head: { seq: 0, chain: "wla-deletion-ledger-v1" } };
  return { objects, read: verified };
}
function sameEvent(a: LedgerEvent, b: LedgerEvent): boolean {
  return a.event_id === b.event_id && a.event === b.event && a.created_at === b.created_at && JSON.stringify(a.payload) === JSON.stringify(b.payload);
}
function segmentPath(first: number, last: number) { return `${PREFIX}/${String(first).padStart(12, "0")}-${String(last).padStart(12, "0")}.json`; }
type LedgerCheckpoint = { ledger_seq: number; chain: string };
function assertCheckpointExtendsLedger(entries: { seq: number; chain: string }[], checkpoint: LedgerCheckpoint | undefined): void {
  if (!checkpoint) return;
  const atCheckpoint = entries[checkpoint.ledger_seq - 1];
  if (!atCheckpoint || atCheckpoint.seq !== checkpoint.ledger_seq || atCheckpoint.chain !== checkpoint.chain)
    throw new Error("ledger_checkpoint_mismatch");
}

/** Single writer via a fenced lease in the main project; Storage objects are immutable. */
export async function shipLedger(admin: Admin, config: LedgerConfig = ledgerConfig()): Promise<{ state: LedgerConfig["state"]; shipped: number }> {
  if (config.state !== "configured") return { state: config.state, shipped: 0 };
  const owner = randomUUID();
  const lease = await admin.rpc("privacy_ledger_acquire_lease", { p_owner: owner, p_lease_seconds: LEASE_SECONDS });
  if (lease.error) throw lease.error;
  let token = lease.data?.[0]?.fencing_token as number | undefined;
  if (!token) return { state: "configured", shipped: 0 };
  let shipped = 0;
  try {
    if (config.kind === "filesystem") return await shipFilesystem(admin, config, token, owner);
    const { data: checkpointRows, error: checkpointError } = await admin.rpc("privacy_ledger_checkpoint", {});
    if (checkpointError) throw checkpointError;
    let checkpoint = checkpointRows?.[0] as LedgerCheckpoint | undefined;
    const initial = await fetchSegments(config.storage, config.keys, true);
    assertCheckpointExtendsLedger(initial.read.entries, checkpoint);
    for (let batchNo = 0; batchNo < MAX_BATCHES; batchNo++) {
      const { data: rows, error } = await admin.rpc("privacy_ledger_pending", { p_limit: BATCH });
      if (error) throw error;
      if (!rows?.length) {
        if (!checkpoint && initial.read.head.seq > 0) throw new Error("ledger_checkpoint_missing");
        break;
      }
      const events: LedgerEvent[] = rows.map((r) => ({ event_id: r.event_id, event: r.event, payload: (r.payload ?? {}) as Record<string, unknown>, created_at: r.created_at }));
      const { read } = await fetchSegments(config.storage, config.keys, true);
      assertCheckpointExtendsLedger(read.entries, checkpoint);
      const prior = read.head;
      const ids = new Set(read.entries.map((e) => e.event_id));
      const existing = events.map((event) => read.entries.find((entry) => entry.event_id === event.event_id));
      let head = prior;
      if (!checkpoint && prior.seq > 0 && (read.entries.length !== events.length || existing.some((entry) => !entry) || !events.every((event, i) => sameEvent(event, existing[i]!))))
        throw new Error("ledger_checkpoint_missing");
      if (existing.some(Boolean)) {
        if (existing.some((e) => !e) || !events.every((event, i) => sameEvent(event, existing[i]!)))
          throw new Error("ledger_conflicting_retry");
        // Restored outbox rows may already be anywhere in the verified external
        // history. Reuse the full external head; never append those IDs again.
        head = prior;
      } else {
        if (events.some((e) => ids.has(e.event_id))) throw new Error("ledger_event_identity_conflict");
        const segment = createLedgerSegment(prior, events, config.keys);
        const path = segmentPath(segment.first_seq, segment.last_seq); const content = encodeLedgerSegment(segment);
        const result = await config.storage.uploadImmutable(path, content);
        // A collision means a prior worker may have uploaded before crashing. Accept only the same logical batch.
        if (result === "exists") {
          const existingText = await config.storage.download(path);
          const verified = decodeLedgerSegments([{ name: path, content: existingText }], config.keys);
          if (!verified.ok || verified.entries.length !== events.length || !events.every((event, i) => sameEvent(event, verified.entries[i]))) throw new Error("ledger_segment_conflict");
        }
        const after = await fetchSegments(config.storage, config.keys);
        if (after.read.head.seq !== segment.last_seq || after.read.head.chain !== segment.head_chain) {
          const retryBatch = after.read.entries.slice(segment.first_seq - 1, segment.last_seq);
          if (retryBatch.length !== events.length || !events.every((event, i) => sameEvent(event, retryBatch[i]))) throw new Error("ledger_head_conflict");
        }
        head = { seq: segment.last_seq, chain: segment.head_chain };
      }
      const renewed = await admin.rpc("privacy_ledger_acquire_lease", { p_owner: owner, p_lease_seconds: LEASE_SECONDS });
      if (renewed.error) throw renewed.error;
      const renewedToken = renewed.data?.[0]?.fencing_token as number | undefined;
      if (!renewedToken) throw new Error("ledger_lease_lost");
      token = renewedToken;
      // Fenced RPC confirms lease is still current and atomically records checkpoint/outbox status.
      const { error: markError } = await admin.rpc("privacy_ledger_mark_shipped", {
        p_event_ids: rows.map((r) => r.event_id), p_ledger_seq: head.seq, p_chain: head.chain, p_fencing_token: token, p_owner: owner,
      });
      if (markError) throw markError;
      checkpoint = { ledger_seq: head.seq, chain: head.chain };
      shipped += rows.length;
      if (rows.length < BATCH) break;
    }
    return { state: "configured", shipped };
  } finally {
    try { await admin.rpc("privacy_ledger_release_lease", { p_owner: owner, p_fencing_token: token! }); } catch { /* lease expiry safely releases a crashed or unreachable worker */ }
  }
}

async function shipFilesystem(admin: Admin, config: Extract<LedgerConfig, { kind: "filesystem" }>, fencingToken: number, owner: string) {
  let shipped = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { data: rows, error } = await admin.rpc("privacy_ledger_pending", { p_limit: BATCH }); if (error) throw error; if (!rows?.length) break;
    const events = rows.map((r) => ({ event_id: r.event_id, event: r.event, payload: (r.payload ?? {}) as Record<string, unknown>, created_at: r.created_at }));
    let head: { seq: number; chain: string };
    if (existsSync(config.file)) {
      const prior = readLedger(config.file, config.keys);
      if (!prior.ok) throw new Error(`ledger_${prior.reason}`);
      const byId = new Map(prior.entries.map((entry) => [entry.event_id, entry]));
      const already = events.map((event) => byId.get(event.event_id));
      if (already.some(Boolean)) {
        if (already.some((entry) => !entry) || !events.every((event, i) => sameEvent(event, already[i]!))) throw new Error("ledger_conflicting_retry");
        head = prior.head;
      } else head = appendToLedger(config.file, events, config.keys);
    } else head = appendToLedger(config.file, events, config.keys);
    const { error: markError } = await admin.rpc("privacy_ledger_mark_shipped", { p_event_ids: rows.map((r) => r.event_id), p_ledger_seq: head.seq, p_chain: head.chain, p_fencing_token: fencingToken, p_owner: owner });
    if (markError) throw markError; shipped += rows.length; if (rows.length < BATCH) break;
  }
  return { state: "configured" as const, shipped };
}

/** Retrieve and fully verify the external ledger for the restore operator. */
export async function readExternalLedger(config: LedgerConfig = ledgerConfig()) {
  if (config.state !== "configured") throw new Error(`ledger_${config.state}`);
  if (config.kind === "filesystem") { const read = readLedger(config.file, config.keys); if (!read.ok) throw new Error(`ledger_${read.reason}`); return read; }
  return (await fetchSegments(config.storage, config.keys)).read;
}
export async function shipLedgerQuietly(): Promise<void> {
  const config = ledgerConfig(); if (config.state !== "configured") return;
  try { await shipLedger(createAdminClient(), config); } catch (error) { logError("deletion_ledger_ship_failed", error); }
}
export async function ensureRequestLedgered(admin: Admin, deletionId: string, config: LedgerConfig = ledgerConfig()): Promise<{ ok: true } | { ok: false; code: string }> {
  if (config.state === "unconfigured" && process.env.NODE_ENV !== "production") return { ok: true };
  if (config.state !== "configured") { logWarn("deletion_ledger_misconfigured", { reason: config.state === "misconfigured" ? config.reason : "missing_configuration" }); return { ok: false, code: "ledger_misconfigured" }; }
  try { await shipLedger(admin, config); } catch (error) { logError("deletion_ledger_ship_failed", error, { deletionId }); return { ok: false, code: "ledger_unavailable" }; }
  const { data, error } = await admin.rpc("privacy_ledger_request_shipped", { p_deletion: deletionId });
  return error || data !== true ? { ok: false, code: "ledger_unavailable" } : { ok: true };
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));

import { createClient } from "@supabase/supabase-js";
import { ensureRequestLedgered, ledgerConfig, readExternalLedger, shipLedger, LEDGER_BUCKET, createSupabaseLedgerStorage, type LedgerStorage } from "../ledger";
import { decodeLedgerSegments, encodeLedgerSegment, ledgerKeys, createLedgerSegment } from "../ledger-core";

const key = randomBytes(32).toString("base64");
const keys = ledgerKeys(key);
const event = (id: string, name = "closure_requested", outboxSeq?: number) => ({ seq: outboxSeq, event_id: id, event: name, payload: { deletion_id: `del-${id}` }, created_at: "2026-11-07T10:00:00Z" });
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wla-ledger-"));
  vi.mocked(createClient).mockReturnValue({ storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) } } as never);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks(); });

function memoryStorage(opts: { failUpload?: boolean; failDownload?: boolean } = {}) {
  const objects = new Map<string, string>();
  const storage: LedgerStorage = {
    async list() { return [...objects.keys()].map((name) => ({ name, content: "" })); },
    async download(path) { if (opts.failDownload) throw new Error("unavailable"); const value = objects.get(path); if (!value) throw new Error("missing"); return value; },
    async uploadImmutable(path, content) {
      if (opts.failUpload) throw new Error("unavailable");
      if (objects.has(path)) return "exists";
      objects.set(path, content); return "created";
    },
  };
  return { storage, objects };
}
function admin(rows: ReturnType<typeof event>[], opts: { markFails?: number; leaseBusy?: boolean; checkpoint?: { ledger_seq: number; chain: string } } = {}) {
  let markFailures = opts.markFails ?? 0; let token = 0; const ownerTokens = new Map<string, number>();
  let checkpoint = opts.checkpoint;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "privacy_ledger_acquire_lease") {
      if (opts.leaseBusy) return { data: [], error: null };
      const owner = args.p_owner as string;
      if (!ownerTokens.has(owner)) ownerTokens.set(owner, ++token);
      return { data: [{ fencing_token: ownerTokens.get(owner), expires_at: new Date(Date.now() + 120_000).toISOString() }], error: null };
    }
    if (name === "privacy_ledger_release_lease") return { data: true, error: null };
    if (name === "privacy_ledger_checkpoint") return { data: checkpoint ? [checkpoint] : [], error: null };
    if (name === "privacy_ledger_pending") return { data: rows.filter((r) => !(r as typeof r & { shipped?: boolean }).shipped).map((r, i) => ({ ...r, seq: r.seq ?? i + 1 })), error: null };
    if (name === "privacy_ledger_mark_shipped") {
      if (markFailures-- > 0) return { data: null, error: new Error("checkpoint unavailable") };
      for (const row of rows as (typeof rows[number] & { shipped?: boolean })[]) if ((args.p_event_ids as string[]).includes(row.event_id)) row.shipped = true;
      checkpoint = { ledger_seq: args.p_ledger_seq as number, chain: args.p_chain as string };
      return { data: null, error: null };
    }
    if (name === "privacy_ledger_request_shipped") return { data: rows.some((r) => r.event === "closure_requested" && (r.payload as { deletion_id: string }).deletion_id === args.p_deletion && (r as typeof r & { shipped?: boolean }).shipped), error: null };
    return { data: null, error: null };
  });
  return { rpc } as never as Parameters<typeof shipLedger>[0] & { rpc: typeof rpc };
}
function config(storage: LedgerStorage) { return { state: "configured", kind: "supabase", keys, storage } as const; }

describe("configuration", () => {
  it("keeps local filesystem support outside production and requires all production credentials", () => {
    expect(ledgerConfig({})).toEqual({ state: "unconfigured" });
    expect(ledgerConfig({ PRIVACY_LEDGER_DIR: dir })).toMatchObject({ state: "misconfigured", reason: "missing_key" });
    expect(ledgerConfig({ PRIVACY_LEDGER_KEY: key })).toMatchObject({ state: "misconfigured" });
    expect(ledgerConfig({ PRIVACY_LEDGER_DIR: dir, PRIVACY_LEDGER_KEY: key })).toMatchObject({ state: "configured", kind: "filesystem", file: join(dir, "deletion-ledger.jsonl") });
    expect(ledgerConfig({ NODE_ENV: "production", PRIVACY_LEDGER_KEY: key })).toMatchObject({ state: "misconfigured", reason: "missing_url" });
    expect(ledgerConfig({ NODE_ENV: "production", PRIVACY_LEDGER_URL: "https://external.supabase.co", PRIVACY_LEDGER_TOKEN: "token", PRIVACY_LEDGER_KEY: key })).toMatchObject({ state: "configured", kind: "supabase" });
    expect(ledgerConfig({ VERCEL: "1", PRIVACY_LEDGER_DIR: dir, PRIVACY_LEDGER_KEY: key })).toMatchObject({ state: "misconfigured", reason: "missing_url" });
    expect(ledgerConfig({ NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://main.supabase.co", PRIVACY_LEDGER_URL: "https://main.supabase.co", PRIVACY_LEDGER_TOKEN: "token", PRIVACY_LEDGER_KEY: key })).toMatchObject({ state: "misconfigured", reason: "same_project" });
  });

  it("does not allow an unconfigured ledger to pass the deletion gate in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const a = admin([]);
    expect(await ensureRequestLedgered(a, "d1", ledgerConfig({ NODE_ENV: "production" }))).toEqual({ ok: false, code: "ledger_misconfigured" });
    expect(a.rpc).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

describe("separate-project Storage adapter", () => {
  it("targets the private bucket and uses non-overwriting upload", async () => {
    const calls: unknown[][] = [];
    const bucket = {
      list: vi.fn(async () => ({ data: [], error: null })),
      download: vi.fn(async () => ({ data: new Blob(["ok"]), error: null })),
      upload: vi.fn(async (...args: unknown[]) => { calls.push(args); return { data: {}, error: null }; }),
    };
    vi.mocked(createClient).mockReturnValue({ storage: { from: (name: string) => { expect(name).toBe(LEDGER_BUCKET); return bucket; } } } as never);
    const adapter = createSupabaseLedgerStorage("https://second.supabase.co", "server-token");
    await adapter.uploadImmutable("v1/segments/a.json", "encrypted");
    expect(bucket.upload.mock.calls[0][2]).toMatchObject({ upsert: false, contentType: "application/json" });
    expect(calls).toHaveLength(1);
  });

  it("uploads and retrieves a verified encrypted segment", async () => {
    const { storage } = memoryStorage(); const ev = event("e1");
    const segment = createLedgerSegment({ seq: 0, chain: "wla-deletion-ledger-v1" }, [ev], keys);
    await storage.uploadImmutable("v1/segments/000000000001-000000000001.json", encodeLedgerSegment(segment));
    const listed = await storage.list();
    const content = await storage.download(listed[0].name);
    const parsed = decodeLedgerSegments([{ name: listed[0].name, content }], keys);
    expect(parsed.ok && parsed.entries.map((e) => e.event_id)).toEqual(["e1"]);
  });

  it("recovery retrieves the full ledger through the configured second-project adapter", async () => {
    const { storage } = memoryStorage();
    const segment = createLedgerSegment({ seq: 0, chain: "wla-deletion-ledger-v1" }, [event("restore-e1")], keys);
    await storage.uploadImmutable("v1/segments/000000000001-000000000001.json", encodeLedgerSegment(segment));
    const read = await readExternalLedger(config(storage));
    expect(read.entries[0]).toMatchObject({ event_id: "restore-e1", seq: 1 });
  });

  it("fails closed on an inaccessible bucket", async () => {
    const a = admin([event("e1")]); const storage = memoryStorage({ failUpload: true }).storage;
    expect(await ensureRequestLedgered(a, "del-e1", config(storage))).toEqual({ ok: false, code: "ledger_unavailable" });
    expect(a.rpc.mock.calls.some((c) => c[0] === "privacy_ledger_mark_shipped")).toBe(false);
  });
});

describe("shipping retries and lease fencing", () => {
  const initialFive = () => [
    event("req-1", "closure_requested", 41), event("req-2", "closure_requested", 77),
    event("done-1", "closure_completed", 105), event("done-2", "closure_completed", 220),
    event("board-1", "board_removed", 999),
  ];

  it("starts an empty bucket at external sequence 1 and ships all five pending events", async () => {
    const rows = initialFive(); const a = admin(rows); const { storage, objects } = memoryStorage();
    expect(await storage.list()).toEqual([]);
    expect(await shipLedger(a, config(storage))).toEqual({ state: "configured", shipped: 5 });
    expect(objects.size).toBe(1);
    const read = decodeLedgerSegments([...objects].map(([name, content]) => ({ name, content })), keys);
    expect(read.ok && read.entries.map((e) => [e.seq, e.event])).toEqual([
      [1, "closure_requested"], [2, "closure_requested"], [3, "closure_completed"], [4, "closure_completed"], [5, "board_removed"],
    ]);
    const checkpointCall = a.rpc.mock.calls.find((call) => call[0] === "privacy_ledger_mark_shipped")?.[1] as Record<string, unknown>;
    expect(checkpointCall).toMatchObject({ p_ledger_seq: 5, p_fencing_token: 1 });
    expect(checkpointCall.p_event_ids).toEqual(rows.map((r) => r.event_id));
    expect(a.rpc.mock.calls.filter((call) => call[0] === "privacy_ledger_pending")).toHaveLength(1);
  });

  it("retries the five events after upload succeeds and checkpoint fails, without a second segment", async () => {
    const rows = initialFive(); const a = admin(rows, { markFails: 1 }); const { storage, objects } = memoryStorage();
    await expect(shipLedger(a, config(storage))).rejects.toThrow("checkpoint unavailable");
    expect(objects.size).toBe(1);
    expect(await shipLedger(a, config(storage))).toEqual({ state: "configured", shipped: 5 });
    expect(objects.size).toBe(1);
    const read = decodeLedgerSegments([...objects].map(([name, content]) => ({ name, content })), keys);
    expect(read.ok && read.entries.map((entry) => entry.event_id)).toEqual(rows.map((row) => row.event_id));
    expect(new Set(read.ok ? read.entries.map((entry) => entry.event_id) : []).size).toBe(5);
    const marks = a.rpc.mock.calls.filter((call) => call[0] === "privacy_ledger_mark_shipped");
    expect(marks).toHaveLength(2);
    expect(marks[1][1]).toMatchObject({ p_ledger_seq: 5, p_chain: read.ok ? read.head.chain : "" });
  });

  it("fails closed when the external history exists without a matching database checkpoint or retry batch", async () => {
    const { storage } = memoryStorage();
    const foreign = createLedgerSegment({ seq: 0, chain: "wla-deletion-ledger-v1" }, [event("foreign")], keys);
    await storage.uploadImmutable("v1/segments/000000000001-000000000001.json", encodeLedgerSegment(foreign));
    const a = admin([event("pending")]);
    await expect(shipLedger(a, config(storage))).rejects.toThrow("ledger_checkpoint_missing");
    expect(a.rpc.mock.calls.some((call) => call[0] === "privacy_ledger_mark_shipped")).toBe(false);
  });

  it("fails closed when the database checkpoint does not match the external chain", async () => {
    const a = admin([event("pending")], { checkpoint: { ledger_seq: 1, chain: "wrong-chain" } });
    await expect(shipLedger(a, config(memoryStorage().storage))).rejects.toThrow("ledger_checkpoint_mismatch");
    expect(a.rpc.mock.calls.some((call) => call[0] === "privacy_ledger_mark_shipped")).toBe(false);
  });

  it("copies pending events in sequence, verifies storage, then records the checkpoint", async () => {
    const a = admin([event("e1"), event("e2", "hold_placed")]); const { storage, objects } = memoryStorage();
    expect(await shipLedger(a, config(storage))).toEqual({ state: "configured", shipped: 2 });
    expect(objects.size).toBe(1);
    expect(a.rpc.mock.calls.find((c) => c[0] === "privacy_ledger_mark_shipped")?.[1]).toMatchObject({ p_ledger_seq: 2, p_fencing_token: 1 });
  });

  it("recovers when upload succeeded but checkpoint failed, without adding logical duplicates", async () => {
    const rows = [event("e1"), event("e2")]; const a = admin(rows, { markFails: 1 }); const { storage, objects } = memoryStorage();
    await expect(shipLedger(a, config(storage))).rejects.toThrow("checkpoint unavailable");
    expect(objects.size).toBe(1);
    expect(await shipLedger(a, config(storage))).toEqual({ state: "configured", shipped: 2 });
    const read = decodeLedgerSegments([...objects].map(([name, content]) => ({ name, content })), keys);
    expect(read.ok && read.entries.map((x) => x.event_id)).toEqual(["e1", "e2"]);
  });

  it("marks restored outbox retries already present at non-adjacent external positions without duplicating them", async () => {
    const rows = [event("e1"), event("e2")]; const { storage, objects } = memoryStorage();
    const first = createLedgerSegment({ seq: 0, chain: "wla-deletion-ledger-v1" }, [rows[0]], keys);
    const middle = createLedgerSegment({ seq: 1, chain: first.head_chain }, [event("intervening")], keys);
    const last = createLedgerSegment({ seq: 2, chain: middle.head_chain }, [rows[1]], keys);
    const a = admin(rows, { checkpoint: { ledger_seq: 3, chain: last.head_chain } });
    await storage.uploadImmutable("v1/segments/000000000001-000000000001.json", encodeLedgerSegment(first));
    await storage.uploadImmutable("v1/segments/000000000002-000000000002.json", encodeLedgerSegment(middle));
    await storage.uploadImmutable("v1/segments/000000000003-000000000003.json", encodeLedgerSegment(last));
    expect(await shipLedger(a, config(storage))).toEqual({ state: "configured", shipped: 2 });
    expect(objects.size).toBe(3);
    expect(a.rpc.mock.calls.find((c) => c[0] === "privacy_ledger_mark_shipped")?.[1]).toMatchObject({ p_ledger_seq: 3 });
  });

  it("allows only one simultaneous worker to acquire the distributed lease", async () => {
    const busyAdmin = admin([event("e1")], { leaseBusy: true }); const activeAdmin = admin([event("e1")]);
    const { storage } = memoryStorage();
    const results = await Promise.all([shipLedger(activeAdmin, config(storage)), shipLedger(busyAdmin, config(storage))]);
    expect(results.map((r) => r.shipped).sort()).toEqual([0, 1]);
    expect(busyAdmin.rpc.mock.calls.some((c) => c[0] === "privacy_ledger_mark_shipped")).toBe(false);
  });

  it("retries after an expired worker lease using a new fencing token and existing object", async () => {
    const rows = [event("e1")]; const a = admin(rows, { markFails: 1 }); const { storage, objects } = memoryStorage();
    await expect(shipLedger(a, config(storage))).rejects.toThrow("checkpoint unavailable");
    await shipLedger(a, config(storage));
    const marks = a.rpc.mock.calls.filter((c) => c[0] === "privacy_ledger_mark_shipped");
    expect(marks.map((c) => (c[1] as Record<string, number>).p_fencing_token)).toEqual([1, 2]);
    expect(objects.size).toBe(1);
  });

  it("gates closure until the request event is shipped", async () => {
    const a = admin([event("e1")]); const { storage } = memoryStorage();
    expect(await ensureRequestLedgered(a, "del-e1", config(storage))).toEqual({ ok: true });
  });
});

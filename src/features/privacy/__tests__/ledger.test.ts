import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { ensureRequestLedgered, ledgerConfig, shipLedger, LEDGER_FILE } from "../ledger";
import { ledgerKeys, readLedger } from "../ledger-core";

/*
 * Shipping the outbox to the ledger, and the rule that a closure deletes
 * nothing until its request is there (D-157).
 */
let dir: string;
const key = randomBytes(32).toString("base64");

function admin(outbox: { event_id: string; event: string; payload: object; created_at: string; shipped?: boolean }[]) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "privacy_ledger_pending") {
      return { data: outbox.filter((r) => !r.shipped).map((r, i) => ({ seq: i + 1, ...r })), error: null };
    }
    if (name === "privacy_ledger_mark_shipped") {
      for (const r of outbox) if ((args.p_event_ids as string[]).includes(r.event_id)) r.shipped = true;
      return { data: null, error: null };
    }
    if (name === "privacy_ledger_request_shipped") {
      const shipped = outbox.some((r) => r.shipped && r.event === "closure_requested" && (r.payload as { deletion_id: string }).deletion_id === args.p_deletion);
      return { data: shipped, error: null };
    }
    return { data: null, error: null };
  });
  return { rpc } as never as Parameters<typeof shipLedger>[0] & { rpc: typeof rpc };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wla-ledger-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ledger configuration", () => {
  it("is unconfigured with neither setting, and misconfigured with one or a bad key", () => {
    expect(ledgerConfig({})).toEqual({ state: "unconfigured" });
    expect(ledgerConfig({ PRIVACY_LEDGER_DIR: dir })).toMatchObject({ state: "misconfigured", reason: "dir_without_key" });
    expect(ledgerConfig({ PRIVACY_LEDGER_KEY: key })).toMatchObject({ state: "misconfigured", reason: "key_without_dir" });
    expect(ledgerConfig({ PRIVACY_LEDGER_DIR: dir, PRIVACY_LEDGER_KEY: "short" })).toMatchObject({ state: "misconfigured", reason: "bad_key" });
    expect(ledgerConfig({ PRIVACY_LEDGER_DIR: dir, PRIVACY_LEDGER_KEY: key })).toMatchObject({ state: "configured", file: join(dir, LEDGER_FILE) });
  });
});

describe("shipping and the gate", () => {
  it("copies every pending event to the ledger, in order, and records the head", async () => {
    const config = ledgerConfig({ PRIVACY_LEDGER_DIR: dir, PRIVACY_LEDGER_KEY: key });
    const a = admin([
      { event_id: "e1", event: "hold_placed", payload: { hold_id: "h1" }, created_at: "2026-11-07T10:00:00Z" },
      { event_id: "e2", event: "closure_requested", payload: { deletion_id: "del-1" }, created_at: "2026-11-07T10:01:00Z" },
    ]);
    expect(await shipLedger(a, config)).toEqual({ state: "configured", shipped: 2 });
    const read = readLedger(join(dir, LEDGER_FILE), ledgerKeys(key));
    expect(read.ok && read.entries.map((e) => e.event_id)).toEqual(["e1", "e2"]);
    const mark = a.rpc.mock.calls.find((c) => c[0] === "privacy_ledger_mark_shipped")?.[1] as Record<string, unknown>;
    expect(mark.p_ledger_seq).toBe(2);
    expect(read.ok && mark.p_chain).toBe(read.ok ? read.head.chain : null);
  });

  it("a closure may proceed once its request is in the ledger", async () => {
    const config = ledgerConfig({ PRIVACY_LEDGER_DIR: dir, PRIVACY_LEDGER_KEY: key });
    const a = admin([{ event_id: "e1", event: "closure_requested", payload: { deletion_id: "del-1" }, created_at: "2026-11-07T10:00:00Z" }]);
    expect(await ensureRequestLedgered(a, "del-1", config)).toEqual({ ok: true });
  });

  it("deletes nothing when the ledger can't be written", async () => {
    // A directory that doesn't exist: the append fails.
    const config = ledgerConfig({ PRIVACY_LEDGER_DIR: join(dir, "missing", "deeper"), PRIVACY_LEDGER_KEY: key });
    const a = admin([{ event_id: "e1", event: "closure_requested", payload: { deletion_id: "del-1" }, created_at: "2026-11-07T10:00:00Z" }]);
    expect(await ensureRequestLedgered(a, "del-1", config)).toEqual({ ok: false, code: "ledger_unavailable" });
  });

  it("deletes nothing when the ledger is set up wrongly", async () => {
    const a = admin([]);
    expect(await ensureRequestLedgered(a, "del-1", ledgerConfig({ PRIVACY_LEDGER_DIR: dir }))).toEqual({ ok: false, code: "ledger_misconfigured" });
    expect(a.rpc).not.toHaveBeenCalled();
  });

  it("without a ledger at all, proceeds as before (and /admin/privacy says so)", async () => {
    const a = admin([]);
    expect(await ensureRequestLedgered(a, "del-1", ledgerConfig({}))).toEqual({ ok: true });
    expect(await shipLedger(a, ledgerConfig({}))).toEqual({ state: "unconfigured", shipped: 0 });
    expect(a.rpc).not.toHaveBeenCalled();
  });
});

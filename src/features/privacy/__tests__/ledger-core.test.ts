import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendToLedger, ledgerKeys, LedgerKeyError, readLedger, type LedgerEvent } from "../ledger-core";

/*
 * The ledger outside the database (D-157): what survives a restore must also
 * resist being edited, reordered, cut short or read without the key.
 */
let dir: string;
let file: string;
const key = randomBytes(32).toString("base64");
const keys = ledgerKeys(key);
const ev = (n: number, event = "closure_requested"): LedgerEvent => ({
  event_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  event,
  payload: { deletion_id: `d${n}`, child_ids: [`c${n}`] },
  created_at: new Date(2026, 10, n).toISOString(),
});
const lines = () => readFileSync(file, "utf8").split("\n").filter(Boolean);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wla-ledger-"));
  file = join(dir, "deletion-ledger.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the deletion ledger", () => {
  it("returns every event, in order, after several appends", () => {
    appendToLedger(file, [ev(1), ev(2, "hold_placed")], keys);
    const head = appendToLedger(file, [ev(3, "closure_completed")], keys);
    const read = readLedger(file, keys);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries.map((e) => [e.seq, e.event, e.payload.deletion_id])).toEqual([
      [1, "closure_requested", "d1"],
      [2, "hold_placed", "d2"],
      [3, "closure_completed", "d3"],
    ]);
    expect(read.head).toEqual(head);
    expect(read.entries[2].chain).toBe(head.chain);
  });

  it("can't be read without the key: nothing of the event is in the file", () => {
    appendToLedger(file, [ev(7)], keys);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("d7");
    expect(text).not.toContain("closure_requested");
    expect(readLedger(file, ledgerKeys(randomBytes(32).toString("base64")))).toEqual({ ok: false, reason: "chain_mismatch", seq: 1 });
  });

  it("detects an edited entry", () => {
    appendToLedger(file, [ev(1), ev(2), ev(3)], keys);
    const l = lines();
    const second = JSON.parse(l[1]);
    second.sealed = Buffer.from("tampered").toString("base64") + second.sealed.slice(12);
    l[1] = JSON.stringify(second);
    writeFileSync(file, `${l.join("\n")}\n`);
    expect(readLedger(file, keys)).toEqual({ ok: false, reason: "chain_mismatch", seq: 2 });
  });

  it("detects a removed or reordered entry", () => {
    appendToLedger(file, [ev(1), ev(2), ev(3)], keys);
    const l = lines();
    writeFileSync(file, `${[l[0], l[2]].join("\n")}\n`);
    expect(readLedger(file, keys)).toMatchObject({ ok: false, reason: "sequence_gap" });
    writeFileSync(file, `${[l[0], l[2], l[1]].join("\n")}\n`);
    expect(readLedger(file, keys)).toMatchObject({ ok: false, reason: "sequence_gap" });
  });

  it("detects an entry rewritten with a matching chain but a swapped body", () => {
    appendToLedger(file, [ev(1), ev(2)], keys);
    const l = lines().map((x) => JSON.parse(x));
    // Same position, chain recomputed by someone without the key can't match;
    // a body moved from another position fails decryption (position is bound in).
    l[1].sealed = l[0].sealed;
    writeFileSync(file, `${l.map((x) => JSON.stringify(x)).join("\n")}\n`);
    expect(readLedger(file, keys)).toMatchObject({ ok: false, reason: "chain_mismatch", seq: 2 });
  });

  it("a ledger cut short is still a valid chain: the database's recorded head catches it", () => {
    appendToLedger(file, [ev(1), ev(2), ev(3)], keys);
    const full = readLedger(file, keys);
    writeFileSync(file, `${lines().slice(0, 2).join("\n")}\n`);
    const cut = readLedger(file, keys);
    expect(cut.ok).toBe(true);
    // privacy_ledger_replay compares the head the database recorded (seq 3 and
    // its chain) with the entry at that seq: there is none, so it refuses.
    if (full.ok && cut.ok) expect(cut.entries.find((e) => e.seq === full.head.seq)).toBeUndefined();
  });

  it("is missing, or empty: never treated as 'nothing to reapply'", () => {
    expect(readLedger(file, keys)).toEqual({ ok: false, reason: "missing" });
    writeFileSync(file, "");
    expect(readLedger(file, keys)).toEqual({ ok: false, reason: "empty" });
  });

  it("won't extend a ledger whose last line is damaged", () => {
    appendToLedger(file, [ev(1)], keys);
    writeFileSync(file, `${lines()[0]}\n{"broken":`);
    expect(() => appendToLedger(file, [ev(2)], keys)).toThrow("ledger_damaged");
  });

  it("refuses a key that isn't 32 bytes", () => {
    expect(() => ledgerKeys(undefined)).toThrow(LedgerKeyError);
    expect(() => ledgerKeys(randomBytes(16).toString("base64"))).toThrow(LedgerKeyError);
  });
});

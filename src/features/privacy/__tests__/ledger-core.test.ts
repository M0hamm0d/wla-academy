import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendToLedger, createLedgerSegment, decodeLedgerSegments, encodeLedgerSegment, ledgerKeys, LedgerKeyError, legacyFileSegments, readLedger, type LedgerEvent } from "../ledger-core";

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
  it("imports an existing JSONL history without changing encrypted entries or its checkpoint chain", () => {
    appendToLedger(file, [ev(21), ev(22), ev(23)], keys);
    const original = readLedger(file, keys);
    const segments = legacyFileSegments(file, keys, 2);
    const imported = decodeLedgerSegments(segments.map((segment) => ({
      name: `v1/segments/${String(segment.first_seq).padStart(12, "0")}-${String(segment.last_seq).padStart(12, "0")}.json`,
      content: encodeLedgerSegment(segment),
    })), keys);
    expect(imported).toEqual(original);
    expect(segments[0].lines).toEqual(readFileSync(file, "utf8").trim().split("\n").slice(0, 2));
  });

  it("validates immutable segments across boundaries and preserves the existing encryption format", () => {
    const first = createLedgerSegment({ seq: 0, chain: "wla-deletion-ledger-v1" }, [ev(1), ev(2)], keys);
    const second = createLedgerSegment({ seq: first.last_seq, chain: first.head_chain }, [ev(3)], keys);
    const read = decodeLedgerSegments([
      { name: "v1/segments/000000000003-000000000003.json", content: encodeLedgerSegment(second) },
      { name: "v1/segments/000000000001-000000000002.json", content: encodeLedgerSegment(first) },
    ], keys);
    expect(read.ok && read.entries.map((entry) => [entry.seq, entry.event_id])).toEqual([[1, ev(1).event_id], [2, ev(2).event_id], [3, ev(3).event_id]]);
  });

  it("detects a missing or corrupted immutable segment", () => {
    const first = createLedgerSegment({ seq: 0, chain: "wla-deletion-ledger-v1" }, [ev(1)], keys);
    const second = createLedgerSegment({ seq: 1, chain: first.head_chain }, [ev(2)], keys);
    expect(decodeLedgerSegments([{ name: "v1/segments/000000000002-000000000002.json", content: encodeLedgerSegment(second) }], keys)).toMatchObject({ ok: false, reason: "segment_gap" });
    expect(decodeLedgerSegments([{ name: "v1/segments/000000000001-000000000001.json", content: "not-json" }], keys)).toMatchObject({ ok: false, reason: "malformed_line" });
    const corrupt = { ...second, head_chain: "0".repeat(64) };
    expect(decodeLedgerSegments([{ name: "v1/segments/000000000001-000000000001.json", content: encodeLedgerSegment(first) }, { name: "v1/segments/000000000002-000000000002.json", content: encodeLedgerSegment(corrupt) }], keys)).toMatchObject({ ok: false, reason: "chain_mismatch" });
  });

  it("rejects duplicate event identities across segments and a wrong key", () => {
    const one = ev(1); const first = createLedgerSegment({ seq: 0, chain: "wla-deletion-ledger-v1" }, [one], keys);
    const duplicate = createLedgerSegment({ seq: 1, chain: first.head_chain }, [one], keys);
    expect(decodeLedgerSegments([{ name: "v1/segments/000000000001-000000000001.json", content: encodeLedgerSegment(first) }, { name: "v1/segments/000000000002-000000000002.json", content: encodeLedgerSegment(duplicate) }], keys)).toMatchObject({ ok: false, reason: "duplicate_event" });
    expect(decodeLedgerSegments([{ name: "v1/segments/000000000001-000000000001.json", content: encodeLedgerSegment(first) }], ledgerKeys(randomBytes(32).toString("base64")))).toMatchObject({ ok: false, reason: "chain_mismatch" });
  });

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
    expect(text).not.toContain('"deletion_id":"d7"');
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

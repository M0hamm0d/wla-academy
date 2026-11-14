/** Encrypted append-only privacy ledger primitives (AES-GCM + HKDF + HMAC). */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeSync, readSync } from "node:fs";

export type LedgerEvent = { event_id: string; event: string; payload: Record<string, unknown>; created_at: string };
export type LedgerEntry = LedgerEvent & { seq: number; chain: string };
export type LedgerKeys = { enc: Buffer; mac: Buffer };
export type LedgerRead = { ok: true; entries: LedgerEntry[]; head: { seq: number; chain: string } } | { ok: false; reason: LedgerProblem; seq?: number };
export type LedgerProblem = "missing" | "empty" | "malformed_line" | "sequence_gap" | "chain_mismatch" | "decrypt_failed" | "duplicate_event" | "segment_gap";
export type LedgerSegment = { format: 1; first_seq: number; last_seq: number; previous_chain: string; head_chain: string; lines: string[] };
const GENESIS = "wla-deletion-ledger-v1";
export class LedgerKeyError extends Error {}
export function ledgerKeys(base64: string | undefined): LedgerKeys {
  const master = Buffer.from(base64 ?? "", "base64");
  if (master.length !== 32) throw new LedgerKeyError("PRIVACY_LEDGER_KEY must be 32 bytes, base64");
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", master, "wla-ledger", info, 32));
  return { enc: derive("encrypt"), mac: derive("sign") };
}
function chainOf(keys: LedgerKeys, prev: string, seq: number, at: string, sealed: string): string {
  return createHmac("sha256", keys.mac).update(`${prev}|${seq}|${at}|${sealed}`).digest("hex");
}
function seal(keys: LedgerKeys, seq: number, event: LedgerEvent): string {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", keys.enc, iv);
  cipher.setAAD(Buffer.from(`${GENESIS}|${seq}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(event), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
function open(keys: LedgerKeys, seq: number, sealed: string): LedgerEvent {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length < 28) throw new Error("invalid_sealed_entry");
  const decipher = createDecipheriv("aes-256-gcm", keys.enc, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${GENESIS}|${seq}`)); decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as LedgerEvent;
}
type Line = { v: 1; seq: number; at: string; sealed: string; chain: string };
function parseLine(text: string): Line | null {
  try { const l = JSON.parse(text) as Line; return l.v === 1 && Number.isSafeInteger(l.seq) && typeof l.at === "string" && typeof l.sealed === "string" && typeof l.chain === "string" ? l : null; } catch { return null; }
}
function checkedEntries(lines: string[], keys: LedgerKeys, startSeq = 1, previous = GENESIS): LedgerRead {
  if (!lines.length) return { ok: false, reason: "empty" };
  const entries: LedgerEntry[] = []; const ids = new Set<string>(); let chain = previous;
  for (let i = 0; i < lines.length; i++) {
    const l = parseLine(lines[i]); if (!l) return { ok: false, reason: "malformed_line", seq: startSeq + i };
    const expectedSeq = startSeq + i;
    if (l.seq !== expectedSeq) return { ok: false, reason: "sequence_gap", seq: expectedSeq };
    if (chainOf(keys, chain, l.seq, l.at, l.sealed) !== l.chain) return { ok: false, reason: "chain_mismatch", seq: l.seq };
    let event: LedgerEvent; try { event = open(keys, l.seq, l.sealed); } catch { return { ok: false, reason: "decrypt_failed", seq: l.seq }; }
    if (!event || typeof event.event_id !== "string" || ids.has(event.event_id)) return { ok: false, reason: "duplicate_event", seq: l.seq };
    ids.add(event.event_id); entries.push({ ...event, seq: l.seq, chain: l.chain }); chain = l.chain;
  }
  return { ok: true, entries, head: { seq: entries[entries.length - 1].seq, chain } };
}

/** Build an immutable segment without a temporary or persistent filesystem. */
export function createLedgerSegment(previous: { seq: number; chain: string }, events: LedgerEvent[], keys: LedgerKeys): LedgerSegment {
  if (!events.length) throw new Error("ledger_empty_segment");
  const lines: string[] = []; let seq = previous.seq; let chain = previous.chain;
  for (const event of events) {
    seq += 1; const at = new Date().toISOString(); const sealed = seal(keys, seq, event);
    chain = chainOf(keys, chain, seq, at, sealed); lines.push(JSON.stringify({ v: 1, seq, at, sealed, chain } satisfies Line));
  }
  return { format: 1, first_seq: previous.seq + 1, last_seq: seq, previous_chain: previous.chain, head_chain: chain, lines };
}
export function encodeLedgerSegment(segment: LedgerSegment): string { return JSON.stringify(segment); }
export function decodeLedgerSegments(objects: { name: string; content: string }[], keys: LedgerKeys): LedgerRead {
  if (!objects.length) return { ok: false, reason: "missing" };
  const segments = [...objects].sort((a,b) => a.name.localeCompare(b.name));
  const all: LedgerEntry[] = []; let seq = 0; let chain = GENESIS; const ids = new Set<string>();
  for (const object of segments) {
    let s: LedgerSegment;
    try { s = JSON.parse(object.content) as LedgerSegment; } catch { return { ok: false, reason: "malformed_line", seq: seq + 1 }; }
    const namedRange = /^v1\/segments\/(\d{12})-(\d{12})\.json$/.exec(object.name);
    if (!namedRange || Number(namedRange[1]) !== s.first_seq || Number(namedRange[2]) !== s.last_seq || s.format !== 1 || !Array.isArray(s.lines) || s.first_seq !== seq + 1 || s.previous_chain !== chain || s.last_seq !== seq + s.lines.length)
      return { ok: false, reason: "segment_gap", seq: seq + 1 };
    const read = checkedEntries(s.lines, keys, s.first_seq, chain);
    if (!read.ok) return read;
    if (read.head.seq !== s.last_seq || read.head.chain !== s.head_chain) return { ok: false, reason: "chain_mismatch", seq: s.last_seq };
    for (const entry of read.entries) { if (ids.has(entry.event_id)) return { ok: false, reason: "duplicate_event", seq: entry.seq }; ids.add(entry.event_id); all.push(entry); }
    seq = read.head.seq; chain = read.head.chain;
  }
  return { ok: true, entries: all, head: { seq, chain } };
}

/** Convert the existing JSONL file into segment envelopes without changing any
    encrypted line, sequence, event identity, or historical chain hash. */
export function legacyFileSegments(path: string, keys: LedgerKeys, batchSize = 200): LedgerSegment[] {
  const read = readLedger(path, keys);
  if (!read.ok) throw new Error(`ledger_${read.reason}${read.seq ? `_at_${read.seq}` : ""}`);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const segments: LedgerSegment[] = []; let previous = GENESIS;
  for (let start = 0; start < lines.length; start += batchSize) {
    const part = lines.slice(start, start + batchSize); const first = parseLine(part[0]); const last = parseLine(part[part.length - 1]);
    if (!first || !last) throw new Error("ledger_malformed_line");
    segments.push({ format: 1, first_seq: first.seq, last_seq: last.seq, previous_chain: previous, head_chain: last.chain, lines: part });
    previous = last.chain;
  }
  return segments;
}

/** Local development/simulation support. Not used by production Storage shipping. */
function lastLine(path: string): string | null {
  const size = statSync(path).size; if (!size) return null; const fd = openSync(path, "r");
  try { let chunk = 4096; while (true) { const len = Math.min(chunk, size); const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, size - len); const text = buf.toString("utf8").replace(/\n+$/, ""); const i = text.lastIndexOf("\n"); if (i >= 0 || len === size) return i >= 0 ? text.slice(i + 1) : text; chunk *= 4; } } finally { closeSync(fd); }
}
function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`; const deadline = Date.now() + 10_000; let fd: number | null = null;
  while (fd === null) { try { fd = openSync(lock, "wx"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; try { if (Date.now() - statSync(lock).mtimeMs > 60_000) unlinkSync(lock); } catch {} if (Date.now() > deadline) throw new Error("ledger_locked"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } }
  try { return fn(); } finally { closeSync(fd); try { unlinkSync(lock); } catch {} }
}
export function appendToLedger(path: string, events: LedgerEvent[], keys: LedgerKeys): { seq: number; chain: string } {
  return withLock(path, () => {
    let prior = { seq: 0, chain: GENESIS };
    if (existsSync(path)) { const last = lastLine(path); if (last !== null) { const l = parseLine(last); if (!l) throw new Error("ledger_damaged"); prior = { seq: l.seq, chain: l.chain }; } }
    if (!events.length) return prior;
    const segment = createLedgerSegment(prior, events, keys); const fd = openSync(path, "a", 0o600);
    try { writeSync(fd, `${segment.lines.join("\n")}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    return { seq: segment.last_seq, chain: segment.head_chain };
  });
}
export function readLedger(path: string, keys: LedgerKeys): LedgerRead {
  if (!existsSync(path)) return { ok: false, reason: "missing" };
  return checkedEntries(readFileSync(path, "utf8").split("\n").filter(Boolean), keys);
}

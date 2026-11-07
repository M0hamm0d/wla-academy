/**
 * THE DELETION LEDGER, OUTSIDE THE DATABASE (S3, D-157).
 *
 * An append-only file, one JSON line per event. Each line holds:
 *   seq     1, 2, 3 … with no gaps
 *   at      when it was appended
 *   sealed  the event (ids and dates only), AES-256-GCM encrypted, its position
 *           bound in as associated data, so a line can't be moved or swapped
 *   chain   HMAC-SHA256 over the previous line's chain, seq, at and sealed
 *
 * So the file can't be read without the key, and any edit, reordering, removal
 * or insertion breaks the chain from that line on. Removing lines from the END
 * leaves a valid shorter chain: that is caught by comparing with the head the
 * database recorded (privacy_ledger_replay), which is why both exist.
 *
 * The key is PRIVACY_LEDGER_KEY (32 random bytes, base64). Two keys are derived
 * from it, one to encrypt and one to sign. It lives in the server's environment
 * and the restore operator's, never in the database.
 *
 * No app imports, so scripts/privacy-ledger.ts can run this file directly.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeSync, readSync } from "node:fs";

export type LedgerEvent = {
  event_id: string;
  event: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type LedgerEntry = LedgerEvent & { seq: number; chain: string };

export type LedgerKeys = { enc: Buffer; mac: Buffer };

export type LedgerRead =
  | { ok: true; entries: LedgerEntry[]; head: { seq: number; chain: string } }
  | { ok: false; reason: LedgerProblem; seq?: number };

export type LedgerProblem =
  | "missing"
  | "empty"
  | "malformed_line"
  | "sequence_gap"
  | "chain_mismatch"
  | "decrypt_failed";

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
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.enc, iv);
  cipher.setAAD(Buffer.from(`${GENESIS}|${seq}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(event), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function open(keys: LedgerKeys, seq: number, sealed: string): LedgerEvent {
  const raw = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", keys.enc, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${GENESIS}|${seq}`));
  decipher.setAuthTag(raw.subarray(12, 28));
  const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  return JSON.parse(text) as LedgerEvent;
}

type Line = { v: 1; seq: number; at: string; sealed: string; chain: string };

function parseLine(text: string): Line | null {
  try {
    const l = JSON.parse(text) as Line;
    if (l.v !== 1 || !Number.isInteger(l.seq) || typeof l.at !== "string" || typeof l.sealed !== "string" || typeof l.chain !== "string") return null;
    return l;
  } catch {
    return null;
  }
}

/** The last line of the file, read from its end. */
function lastLine(path: string): string | null {
  const size = statSync(path).size;
  if (size === 0) return null;
  const fd = openSync(path, "r");
  try {
    let chunk = 4096;
    while (true) {
      const len = Math.min(chunk, size);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const text = buf.toString("utf8").replace(/\n+$/, "");
      const i = text.lastIndexOf("\n");
      if (i >= 0 || len === size) return i >= 0 ? text.slice(i + 1) : text;
      chunk *= 4;
    }
  } finally {
    closeSync(fd);
  }
}

/** One writer at a time: a lock file beside the ledger, broken if stale. */
function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 10_000;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lock, "wx");
    } catch (error) {
      // Only another writer's lock is waited for; a missing directory isn't.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) unlinkSync(lock);
      } catch {}
      if (Date.now() > deadline) throw new Error("ledger_locked");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {}
  }
}

/**
 * Append events, in order. Returns where the ledger has then reached, which
 * the caller records in the database as its head. Refuses to write after a
 * last line it can't parse: a damaged ledger is investigated, not extended.
 */
export function appendToLedger(path: string, events: LedgerEvent[], keys: LedgerKeys): { seq: number; chain: string } {
  return withLock(path, () => {
    let seq = 0;
    let chain = GENESIS;
    if (existsSync(path)) {
      const last = lastLine(path);
      if (last !== null) {
        const l = parseLine(last);
        if (!l) throw new Error("ledger_damaged");
        seq = l.seq;
        chain = l.chain;
      }
    }
    if (events.length === 0) return { seq, chain };
    const fd = openSync(path, "a", 0o600);
    try {
      for (const event of events) {
        seq += 1;
        const at = new Date().toISOString();
        const sealed = seal(keys, seq, event);
        chain = chainOf(keys, chain, seq, at, sealed);
        const line: Line = { v: 1, seq, at, sealed, chain };
        writeSync(fd, `${JSON.stringify(line)}\n`);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { seq, chain };
  });
}

/**
 * Read and verify the whole ledger: sequence, chain and every entry's
 * encryption. Any fault fails the whole read, naming the first bad line.
 */
export function readLedger(path: string, keys: LedgerKeys): LedgerRead {
  if (!existsSync(path)) return { ok: false, reason: "missing" };
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: false, reason: "empty" };
  const entries: LedgerEntry[] = [];
  let chain = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const l = parseLine(lines[i]);
    if (!l) return { ok: false, reason: "malformed_line", seq: i + 1 };
    if (l.seq !== i + 1) return { ok: false, reason: "sequence_gap", seq: i + 1 };
    const expected = chainOf(keys, chain, l.seq, l.at, l.sealed);
    if (expected !== l.chain) return { ok: false, reason: "chain_mismatch", seq: l.seq };
    let event: LedgerEvent;
    try {
      event = open(keys, l.seq, l.sealed);
    } catch {
      return { ok: false, reason: "decrypt_failed", seq: l.seq };
    }
    entries.push({ ...event, seq: l.seq, chain: l.chain });
    chain = l.chain;
  }
  return { ok: true, entries, head: { seq: entries.length, chain } };
}

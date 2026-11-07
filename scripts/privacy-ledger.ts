/**
 * The restore operator's tool for the deletion ledger (S3, D-157).
 *
 *   PRIVACY_LEDGER_KEY=… node scripts/privacy-ledger.ts verify <ledger-file> --out <events.json>
 *       Reads and verifies the whole ledger: sequence, chain and every entry.
 *       On success writes the events, in order, for privacy_ledger_replay().
 *       On ANY fault prints why, writes nothing and exits 1: deletion status is
 *       then unknown, and the restored database must not be reopened.
 *
 *   PRIVACY_LEDGER_KEY=… node scripts/privacy-ledger.ts append <ledger-file> --events <outbox.json>
 *       Appends outbox rows ([{event_id, event, payload, created_at}], as the
 *       restored database's privacy_ledger_pending() returns them) and prints
 *       the new head {seq, chain, event_ids} for privacy_ledger_mark_shipped().
 *       For the procedure's step "copy what the backup hadn't shipped yet", and
 *       for the isolated restore simulation. The server ships the same way.
 *
 * Prints counts, sequence numbers and reasons only: never a family's or child's
 * id, never the key. (append prints the random ids of the events it copied.)
 * See docs/PRIVACY-OPERATIONS.md §3.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
// @ts-expect-error -- Node runs this file directly, which needs the extension.
import { appendToLedger, ledgerKeys, readLedger, type LedgerEvent } from "../src/features/privacy/ledger-core.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, events: { type: "string" } },
});
const [command, file] = positionals;

function fail(message: string): never {
  console.error(`LEDGER INVALID: ${message}`);
  console.error("Deletion status is unknown. Do not reopen the restored database to users.");
  process.exit(1);
}

let keys;
try {
  keys = ledgerKeys(process.env.PRIVACY_LEDGER_KEY);
} catch {
  fail("PRIVACY_LEDGER_KEY is missing or not 32 bytes of base64");
}
if (!file || (command !== "verify" && command !== "append")) {
  console.error("usage: node scripts/privacy-ledger.ts verify <ledger-file> --out <events.json>");
  console.error("       node scripts/privacy-ledger.ts append <ledger-file> --events <outbox.json>");
  process.exit(2);
}

if (command === "verify") {
  if (!values.out) fail("--out is required");
  const read = readLedger(file, keys);
  if (!read.ok) fail(`${read.reason}${read.seq ? ` at entry ${read.seq}` : ""}`);
  writeFileSync(values.out, JSON.stringify(read.entries), { mode: 0o600 });
  const counts = read.entries.reduce<Record<string, number>>((c, e) => ({ ...c, [e.event]: (c[e.event] ?? 0) + 1 }), {});
  console.log(`LEDGER OK: ${read.entries.length} entries, chain intact to entry ${read.head.seq}`);
  console.log(`  ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}`);
} else {
  if (!values.events) fail("--events is required");
  const rows = JSON.parse(readFileSync(values.events, "utf8")) as LedgerEvent[] | null;
  const events = (rows ?? []).map((r) => ({ event_id: r.event_id, event: r.event, payload: r.payload, created_at: r.created_at }));
  const head = appendToLedger(file, events, keys);
  console.log(JSON.stringify({ seq: head.seq, chain: head.chain, event_ids: events.map((e) => e.event_id) }));
}

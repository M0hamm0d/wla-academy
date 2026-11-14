/**
 * Restore and migration CLI for the second-project Supabase Storage ledger.
 *
 *   node scripts/privacy-ledger.ts verify [--out <events.json>]
 *   node scripts/privacy-ledger.ts import-local <existing-ledger.jsonl>
 *   node scripts/privacy-ledger.ts restore
 *   node scripts/privacy-ledger.ts verify-restore
 *
 * Production verification and recovery retrieve the ledger directly from the
 * private bucket. The local-file commands exist only for migration and tests.
 * Counts and failure reasons are printed; the encryption key is never printed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
// @ts-expect-error -- Node runs this file directly, which needs the extension.
import { appendToLedger, decodeLedgerSegments, encodeLedgerSegment, ledgerKeys, legacyFileSegments, readLedger, type LedgerEvent, type LedgerKeys } from "../src/features/privacy/ledger-core.ts";

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

async function readExternal() {
  const url = process.env.PRIVACY_LEDGER_URL;
  const token = process.env.PRIVACY_LEDGER_TOKEN;
  if (!url || !token) fail("PRIVACY_LEDGER_URL and PRIVACY_LEDGER_TOKEN are required to retrieve the external ledger");
  const client = createClient(url, token, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = client.storage.from("wla-privacy-ledger");
  const paths: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await bucket.list("v1/segments", { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
    if (error) fail(`external ledger listing failed (${error.message})`);
    const page = data ?? [];
    paths.push(...page.filter((o) => o.name.endsWith(".json")).map((o) => `v1/segments/${o.name}`));
    if (page.length < 100) break;
  }
  const objects = await Promise.all(paths.map(async (name) => {
    const { data, error } = await bucket.download(name);
    if (error || !data) fail(`external ledger download failed (${error?.message ?? "missing object"})`);
    return { name, content: await data.text() };
  }));
  const read = decodeLedgerSegments(objects, keys);
  if (!read.ok) fail(`${read.reason}${read.seq ? ` at entry ${read.seq}` : ""}`);
  return read;
}

let keys: LedgerKeys;
try {
  keys = ledgerKeys(process.env.PRIVACY_LEDGER_KEY);
} catch {
  fail("PRIVACY_LEDGER_KEY is missing or not 32 bytes of base64");
}
if ((command !== "verify" && command !== "append" && command !== "restore" && command !== "verify-restore" && command !== "import-local") || ((command === "append" || command === "import-local") && !file)) {
  console.error("usage: node scripts/privacy-ledger.ts verify [--out <events.json>]");
  console.error("       node scripts/privacy-ledger.ts import-local <existing-ledger.jsonl>");
  console.error("       node scripts/privacy-ledger.ts restore");
  console.error("       node scripts/privacy-ledger.ts verify-restore");
  console.error("       node scripts/privacy-ledger.ts append <ledger-file> --events <outbox.json>");
  process.exit(2);
}

if (command === "verify") {
  const read = process.env.PRIVACY_LEDGER_URL || process.env.PRIVACY_LEDGER_TOKEN
    ? await readExternal()
    : process.env.PRIVACY_LEDGER_DIR
      ? readLedger(join(process.env.PRIVACY_LEDGER_DIR, "deletion-ledger.jsonl"), keys)
      : fail("configure the second-project URL/token, or PRIVACY_LEDGER_DIR for a local simulation");
  if (!read.ok) fail(`${read.reason}${read.seq ? ` at entry ${read.seq}` : ""}`);
  if (values.out) writeFileSync(values.out, JSON.stringify(read.entries), { mode: 0o600 });
  const counts = read.entries.reduce<Record<string, number>>((c, e) => ({ ...c, [e.event]: (c[e.event] ?? 0) + 1 }), {});
  console.log(`LEDGER OK: ${read.entries.length} entries, chain intact to entry ${read.head.seq}`);
  console.log(`  ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}`);
} else if (command === "append") {
  if (!values.events) fail("--events is required");
  const rows = JSON.parse(readFileSync(values.events, "utf8")) as LedgerEvent[] | null;
  const events = (rows ?? []).map((r) => ({ event_id: r.event_id, event: r.event, payload: r.payload, created_at: r.created_at }));
  const head = appendToLedger(file, events, keys);
  console.log(JSON.stringify({ seq: head.seq, chain: head.chain, event_ids: events.map((e) => e.event_id) }));
} else if (command === "import-local") {
  const ledgerUrl = process.env.PRIVACY_LEDGER_URL;
  const ledgerToken = process.env.PRIVACY_LEDGER_TOKEN;
  const mainUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ledgerUrl || !ledgerToken || !mainUrl || !serviceKey) fail("import requires both projects' URLs/tokens and PRIVACY_LEDGER_KEY");
  if (new URL(ledgerUrl).origin === new URL(mainUrl).origin) fail("PRIVACY_LEDGER_URL must point to a separate Supabase project");
  const source = readLedger(file, keys);
  if (!source.ok) fail(`source ledger ${source.reason}${source.seq ? ` at entry ${source.seq}` : ""}`);
  const main = createClient(mainUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const owner = randomUUID();
  const lease = await main.rpc("privacy_ledger_acquire_lease", { p_owner: owner, p_lease_seconds: 120 });
  if (lease.error || !lease.data?.[0]?.fencing_token) fail(`could not acquire main-project writer lease (${lease.error?.message ?? "busy"})`);
  let fencingToken = lease.data[0].fencing_token;
  try {
  const { data: checkpoint, error: checkpointError } = await main.from("privacy_ledger_head").select("ledger_seq,chain").eq("id", true).maybeSingle();
  if (checkpointError) fail(`main checkpoint could not be read (${checkpointError.message})`);
  if (checkpoint && (checkpoint.ledger_seq > source.head.seq || source.entries[checkpoint.ledger_seq - 1]?.chain !== checkpoint.chain))
    fail("source ledger does not contain the main database checkpoint; keep production closed and investigate");
  const external = createClient(ledgerUrl, ledgerToken, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = external.storage.from("wla-privacy-ledger");
  const segments = legacyFileSegments(file, keys);
  for (const segment of segments) {
    const renewed = await main.rpc("privacy_ledger_acquire_lease", { p_owner: owner, p_lease_seconds: 120 });
    if (renewed.error || !renewed.data?.[0]?.fencing_token) fail(`main-project writer lease expired during import (${renewed.error?.message ?? "lease lost"})`);
    fencingToken = renewed.data[0].fencing_token;
    const path = `v1/segments/${String(segment.first_seq).padStart(12, "0")}-${String(segment.last_seq).padStart(12, "0")}.json`;
    const content = encodeLedgerSegment(segment);
    const { error } = await bucket.upload(path, new Blob([content], { type: "application/json" }), { contentType: "application/json", upsert: false });
    if (error) {
      if (!/already exists|duplicate|resource already exists/i.test(`${error.message} ${error.name}`)) fail(`segment upload failed (${error.message})`);
      const { data, error: downloadError } = await bucket.download(path);
      if (downloadError || !data || await data.text() !== content) fail("an existing destination segment conflicts with the source ledger");
    }
  }
  const imported = await readExternal();
  if (imported.head.seq !== source.head.seq || imported.head.chain !== source.head.chain || imported.entries.length !== source.entries.length)
    fail("destination Storage does not exactly match the source ledger");
  console.log(`IMPORT VERIFIED: ${imported.entries.length} existing encrypted entries; chain matches main checkpoint`);
  console.log("The source JSONL file was not changed. Keep it as a protected recovery copy until the production restore drill passes.");
  } finally {
    await main.rpc("privacy_ledger_release_lease", { p_owner: owner, p_fencing_token: fencingToken });
  }
} else {
  const mainUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!mainUrl || !serviceKey) fail("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for main database recovery");
  if (!process.env.PRIVACY_LEDGER_URL || !process.env.PRIVACY_LEDGER_TOKEN) fail("restore requires the second-project PRIVACY_LEDGER_URL and PRIVACY_LEDGER_TOKEN");
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin === new URL(process.env.PRIVACY_LEDGER_URL).origin)
    fail("PRIVACY_LEDGER_URL must point to a separate Supabase project");
  const read = await readExternal();
  const db = createClient(mainUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  if (command === "restore") {
    const { data, error } = await db.rpc("privacy_ledger_replay", { p_events: read.entries });
    if (error) fail(`database replay refused (${error.code ?? error.message})`);
    console.log(`LEDGER REPLAYED: ${read.entries.length} verified entries`);
    console.log(JSON.stringify(data));
    console.log("Do not reopen. Run the normal privacy closure follow-up until no work remains, then run verify-restore.");
  } else {
    const { data, error } = await db.rpc("privacy_restore_verify", { p_events: read.entries });
    if (error) fail(`restore verification failed (${error.code ?? error.message})`);
    const problems = data ?? [];
    if (problems.length) fail(`restore verification found ${problems.length} problem(s)`);
    console.log(`RESTORE VERIFIED: ${read.entries.length} entries; no outstanding privacy problems`);
  }
}

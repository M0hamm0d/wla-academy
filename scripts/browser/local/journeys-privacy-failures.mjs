// What happens when a closure does NOT finish (D-148): what the parent is told,
// what they can still reach, what WLA sees on Privacy, and whether Retry is
// safe to press again and again; plus holds being renewed and released, and
// the admin gift view showing no code. In Chrome against `next dev` and the
// local stack. A failure is forced with a temporary trigger that refuses to
// delete this run's "Fail…" children only; it is dropped before cleanup.
import { ENV, PASSWORD, SUPABASE, RUN, addChildPage, browser, childId, chk, cleanup, closeAll, ensureAccount, made, section, signIn, sleep, sql, summary, tokenFor } from "./driver.mjs";

const SERVICE = { apikey: ENV.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}` };
const MISSION = sql(`select id from missions where slug='six-names'`);
const upload = async (path, body) => {
  const res = await fetch(`${SUPABASE}/storage/v1/object/mission-evidence/${path}`, { method: "POST", headers: { ...SERVICE, "Content-Type": "text/plain", "x-upsert": "true" }, body });
  if (!res.ok) throw new Error(`upload ${path}: HTTP ${res.status}`);
};
const stored = async (path) => (await fetch(`${SUPABASE}/storage/v1/object/mission-evidence/${path}`, { headers: SERVICE })).status === 200;
async function seedChild(id, words) {
  sql(`insert into mission_evidence (child_id, mission_id, type, title, description, storage_path)
       values ('${id}','${MISSION}','digital','${words} plan','${words} wrote this','${id}/${MISSION}/plan.txt')`);
  await upload(`${id}/${MISSION}/plan.txt`, `${words}'s file`);
}
const ledger = (subject) => sql(`select status||'|'||step||'|'||attempts||'|'||coalesce(last_error,'') from privacy_deletions where subject_id='${subject}' order by requested_at desc limit 1`);
const rpcAs = async (token, fn, args) => {
  const res = await fetch(`${SUPABASE}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  return { status: res.status, body: await res.text() };
};
const readAs = async (token, path) => {
  const res = await fetch(`${SUPABASE}/rest/v1/${path}`, { headers: { apikey: ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
  return res.json();
};
const forceFailures = () => sql(`
  create or replace function public.e2e_${RUN}_refuse_delete() returns trigger language plpgsql as $f$
  begin
    if old.display_name like 'Fail%' and exists (select 1 from auth.users u where u.id = old.parent_id and u.email like 'e2e-${RUN}-%') then
      raise exception 'e2e_forced_failure';
    end if;
    return old;
  end $f$;
  create trigger e2e_${RUN}_refuse_delete before delete on child_profiles for each row execute function public.e2e_${RUN}_refuse_delete();`);
const stopFailures = () => sql(`drop trigger if exists e2e_${RUN}_refuse_delete on child_profiles; drop function if exists public.e2e_${RUN}_refuse_delete();`);
const savedWork = (b, query = "") => b.eval(`fetch('/account/saved-work${query}').then(r => r.status)`);
/** ensureAccount, then make sure the session took before going on. */
async function account(b, who, next) {
  const email = await ensureAccount(b, who, next);
  for (let i = 0; i < 3; i++) {
    await b.goto("/account");
    if (!/\/login/.test(await b.path())) return email;
    await sleep(2000);
    await signIn(b, email, "/account");
  }
  throw new Error(`${who} could not sign in`);
}
/** Poll the database until a condition holds: a server action may still be compiling. */
async function until(fn, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(500); }
  return fn();
}
const iso = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

const parent = await browser("parent");
const closer = await browser("closer");
const adminB = await browser("admin");
try {
  section("Only an administrator reaches Privacy");
  const parentEmail = await account(parent, "parent");
  const parentToken = await tokenFor(parentEmail);
  await parent.goto("/admin/privacy");
  chk("a parent is not shown the Privacy page", !/Closures and deletions/.test(await parent.text()));
  chk("nor can a parent call its functions directly", (await rpcAs(parentToken, "admin_privacy_deletions", {})).status >= 400 && (await rpcAs(parentToken, "admin_place_hold", { p_subject_type: "security_logs", p_subject_id: null, p_reason: "nope", p_review_by: null })).status >= 400);
  const adminEmail = await account(adminB, "admin", "/academy/my-missions");
  sql(`update profiles set is_admin=true where id=(select id from auth.users where email='${adminEmail}')`);

  section("A child's deletion that fails part-way");
  await addChildPage(parent, "Fay");
  await addChildPage(parent, "Gus");
  const fay = childId(parentEmail, "Fay");
  const gus = childId(parentEmail, "Gus");
  await seedChild(fay, "Fay");
  await seedChild(gus, "Gus");
  // Fay is renamed after her code exists: the trigger only refuses "Fail…" names.
  sql(`update child_profiles set display_name='Failfay' where id='${fay}'`);
  forceFailures();
  await parent.goto("/account/children");
  await parent.click(/^remove$/i, { nth: 0 });
  await parent.waitText(/Remove Failfay.s profile\?/);
  await parent.click(/^remove profile$/i);
  await parent.waitUrl(/removal=/, 30000);
  const removalUrl = await parent.path();
  chk("the parent is not told it's done", !/removal=removed/.test(removalUrl) && !/has been removed, with its progress/.test(await parent.text()), removalUrl);
  chk("the profile is no longer in their account", !/Failfay/.test(await parent.text()));
  chk("its saved work can no longer be reached", (await savedWork(parent, `?child=${fay}`)) === 404);
  const reissue = await rpcAs(parentToken, "issue_child_access_code", { p_child_id: fay });
  chk("no new access code can be made for it", reissue.status >= 400, reissue.status);
  chk("nor is it readable from the database as the parent", (await readAs(parentToken, `child_profiles?id=eq.${fay}&select=id`)).length === 0);
  chk("the brother's profile is untouched and usable", /Gus/.test(await parent.text()) && (await savedWork(parent, `?child=${gus}`)) === 200);
  chk("recorded as failed, at the data step, with an error code", ledger(fay) === "failed|data|1|db_P0001", ledger(fay));
  made.deletions.add(sql(`select id from privacy_deletions where subject_id='${fay}'`));

  await adminB.goto("/admin/privacy");
  await adminB.waitText(/Closures and deletions/);
  const adminText = await adminB.text();
  chk("Privacy says the deletion ledger outside the database isn't set up, and what that risks", /Deletion ledger outside the database/.test(adminText) && /Not set up/.test(adminText) && /restored from an older backup/.test(adminText));
  chk("Privacy shows it as failed and open, with its error", /1 open/.test(adminText) && /Failed — will retry/.test(adminText) && /db_P0001/.test(adminText));
  await adminB.click(/^retry$/i);
  await sleep(1500);
  await adminB.goto("/admin/privacy");
  await adminB.click(/^retry$/i);
  await sleep(1500);
  chk("Retry, pressed twice while the fault remains, records each attempt and nothing else", ledger(fay) === "failed|data|3|db_P0001", ledger(fay));
  chk("Fay's file went at the first step, and Gus's is still there", !(await stored(`${fay}/${MISSION}/plan.txt`)) && (await stored(`${gus}/${MISSION}/plan.txt`)) && sql(`select count(*) from mission_evidence where child_id='${gus}'`) === "1");
  stopFailures();
  await adminB.goto("/admin/privacy");
  await adminB.click(/^retry$/i);
  const t0 = Date.now();
  await until(() => ledger(fay).startsWith("completed"));
  console.log(`  (finished ${((Date.now() - t0) / 1000).toFixed(1)}s after Retry)`);
  chk("once the fault is gone, Retry finishes it", ledger(fay).startsWith("completed|done") && !sql(`select 1 from child_profiles where id='${fay}'`), ledger(fay));
  await adminB.goto("/admin/privacy");
  chk("a completed row offers no Retry, and nothing is open", !(await adminB.has(/^retry$/i)) && /\(0 open\)/.test(await adminB.text()));

  section("A child's deletion under a hold");
  await adminB.fill("input[name=subjectId]", gus);
  await adminB.eval(`document.querySelector('#hold-type').value='child_profile'`);
  await adminB.fill("input[name=reason]", `E2E ${RUN}: records needed for a complaint`);
  await adminB.click(/^place hold$/i);
  await adminB.waitText(/Hold placed/);
  await parent.goto("/account/children");
  await parent.click(/^remove$/i, { nth: 0 });
  await parent.waitText(/Remove Gus.s profile\?/);
  await parent.click(/^remove profile$/i);
  await parent.waitUrl(/removal=/, 30000);
  chk("the parent is told WLA must keep its records for now", /removal=held/.test(await parent.path()) && /legal reason/.test(await parent.text()));
  chk("the profile is no longer in their account", !/\bGus\b/.test(await parent.text()) && (await savedWork(parent, `?child=${gus}`)) === 404);
  chk("but nothing of it is deleted", Boolean(sql(`select 1 from child_profiles where id='${gus}'`)) && (await stored(`${gus}/${MISSION}/plan.txt`)) && ledger(gus).startsWith("held"));
  made.deletions.add(sql(`select id from privacy_deletions where subject_id='${gus}'`));
  await adminB.goto("/admin/privacy");
  chk("Privacy shows it as held, with no Retry offered", /Held/.test(await adminB.text()) && !(await adminB.has(/^retry$/i)));
  await adminB.click(/^release$/i);
  await sleep(800);
  await adminB.goto("/admin/privacy");
  await adminB.click(/^retry everything open$/i);
  await sleep(2000);
  chk("released and retried, it is deleted", !sql(`select 1 from child_profiles where id='${gus}'`) && !(await stored(`${gus}/${MISSION}/plan.txt`)) && ledger(gus).startsWith("completed"), ledger(gus));

  section("An account closure that fails part-way");
  const closerEmail = await account(closer, "closer");
  const closerId = sql(`select id from auth.users where email='${closerEmail}'`);
  await addChildPage(closer, "Fern");
  const fern = childId(closerEmail, "Fern");
  await seedChild(fern, "Fern");
  sql(`update child_profiles set display_name='Failfern' where id='${fern}'`);
  forceFailures();
  await closer.goto("/account/close");
  await closer.waitText(/What closing deletes/);
  await closer.click(/I understand that my account/i, { selector: "label" });
  await closer.fill("input[name=password]", PASSWORD);
  await closer.click(/^close my account$/i);
  await closer.waitUrl(/account-closed/, 45000);
  chk("the page is the unfinished one", /state=pending/.test(await closer.path()), await closer.path());
  const closedText = await closer.text();
  chk("the parent is told it isn't finished yet, not that it's deleted", /finishing deleting/.test(closedText) && !/have been deleted/.test(closedText));
  chk("the account can't be used meanwhile", sql(`select (banned_until > now())::text from auth.users where id='${closerId}'`) === "true");
  chk("recorded as failed", ledger(closerId).startsWith("failed|data|1"), ledger(closerId));
  made.deletions.add(sql(`select id from privacy_deletions where subject_id='${closerId}'`));
  stopFailures();
  await adminB.goto("/admin/privacy");
  await adminB.click(/^retry everything open$/i);
  await sleep(2500);
  chk("retried once the fault is gone, the account and child are deleted", ledger(closerId).startsWith("completed|done") && !sql(`select 1 from auth.users where id='${closerId}'`) && !sql(`select 1 from child_profiles where id='${fern}'`), ledger(closerId));

  section("An account closure under a hold");
  const heldEmail = await account(closer, "held");
  const heldId = sql(`select id from auth.users where email='${heldEmail}'`);
  await addChildPage(closer, "Hal");
  const hal = childId(heldEmail, "Hal");
  sql(`insert into retention_holds (subject_type, subject_id, reason, review_by) values ('parent_account','${heldId}','E2E ${RUN}: chargeback', current_date + 30)`);
  await closer.goto("/account/close");
  await closer.waitText(/What closing deletes/);
  await closer.click(/I understand that my account/i, { selector: "label" });
  await closer.fill("input[name=password]", PASSWORD);
  await closer.click(/^close my account$/i);
  await closer.waitUrl(/account-closed/, 45000);
  const heldText = await closer.text();
  chk("the parent is told the records are kept for now, not that they're deleted or will be in 30 days", /state=held/.test(await closer.path()) && /legal reason/.test(heldText) && !/have been deleted|within 30 days/.test(heldText));
  chk("nothing is deleted, and the child is out of reach", Boolean(sql(`select 1 from child_profiles where id='${hal}' and closing_at is not null`)) && ledger(heldId).startsWith("held"));
  made.deletions.add(sql(`select id from privacy_deletions where subject_id='${heldId}'`));
  sql(`delete from retention_holds where reason='E2E ${RUN}: chargeback'`);

  section("Holds: review dates, renewal and release");
  await adminB.goto("/admin/privacy");
  await adminB.eval(`document.querySelector('#hold-type').value='security_logs'`);
  await adminB.fill("input[name=reason]", `E2E ${RUN}: investigation`);
  await adminB.fill("input[name=reviewBy]", iso(400));
  await adminB.click(/^place hold$/i);
  const refused = await adminB.waitText(/review date must be within a year/);
  chk("a review date more than a year away is refused", refused && sql(`select count(*) from retention_holds where reason='E2E ${RUN}: investigation'`) === "0");
  // The form is cleared after each submission, as React does: enter it again.
  await adminB.goto("/admin/privacy");
  await adminB.eval(`document.querySelector('#hold-type').value='security_logs'`);
  await adminB.fill("input[name=reason]", `E2E ${RUN}: investigation`);
  await adminB.click(/^place hold$/i);
  chk("placed without a date", await adminB.waitText(/Hold placed/));
  chk("without a date, it is due for review in a year", sql(`select (review_by = current_date + 365)::text from retention_holds where reason='E2E ${RUN}: investigation'`) === "true");
  // A year passes.
  sql(`update retention_holds set placed_at = now() - interval '366 days', review_by = current_date - 1 where reason='E2E ${RUN}: investigation'`);
  await adminB.goto("/admin/privacy");
  chk("an overdue review is flagged", /review due/.test(await adminB.text()));
  await adminB.click(/^renew for a year$/i);
  await sleep(800);
  await adminB.goto("/admin/privacy");
  chk("renewed, it is due again in a year, and no longer flagged", sql(`select (review_by = current_date + 365 and reviewed_at is not null)::text from retention_holds where reason='E2E ${RUN}: investigation'`) === "true" && !/review due/.test(await adminB.text()));
  await adminB.click(/^release$/i);
  await sleep(800);
  await adminB.goto("/admin/privacy");
  chk("released, it leaves the list and keeps who released it", !/E2E .*investigation/.test(await adminB.text()) && sql(`select (released_at is not null and released_by is not null)::text from retention_holds where reason='E2E ${RUN}: investigation'`) === "true");

  section("WLA sees a gift's status, never its code");
  const parentId = sql(`select id from auth.users where email='${parentEmail}'`);
  sql(`insert into mission_gifts (mission_id,purchaser_id,stripe_session_id,amount_minor,currency,early_supply_consent_at,cancellation_ack_at,consent_wording)
       values ('${MISSION}','${parentId}','cs_e2e_${RUN}_gift',1200,'GBP',now(),now(),'e2e')`);
  made.sessions.add(`cs_e2e_${RUN}_gift`);
  const code = sql(`select code from activate_paid_gift('cs_e2e_${RUN}_gift','pi_e2e_${RUN}_gift')`);
  const lookup = sql(`select code_lookup from mission_gifts where stripe_session_id='cs_e2e_${RUN}_gift'`);
  await adminB.goto("/admin/orders");
  await adminB.waitText(/Gifts/);
  const html = await adminB.eval("document.documentElement.outerHTML");
  const flat = html.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  chk("the paid gift is listed with its status", new RegExp(parentEmail.replace(/[.]/g, "\\.")).test(await adminB.text()) && /paid/i.test(await adminB.text()));
  chk("its code, its keyed hash and its claim appear nowhere in the page", code.length >= 12 && !flat.includes(code.replace(/-/g, "")) && !html.includes(lookup) && !/claim_hash|code_lookup|code_ciphertext/.test(html));
} finally {
  closeAll();
  try { stopFailures(); } catch {}
  sql(`delete from retention_holds where reason like 'E2E ${RUN}:%'`);
  if (!process.env.KEEP) {
    cleanup();
    const left = sql(`select name from storage.objects where bucket_id='mission-evidence' and owner is null and created_at >= '${made.since}'`).split("\n").filter(Boolean);
    if (left.length) await fetch(`${SUPABASE}/storage/v1/object/mission-evidence`, { method: "DELETE", headers: { ...SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: left }) });
  }
}
process.exit(summary() ? 1 : 0);

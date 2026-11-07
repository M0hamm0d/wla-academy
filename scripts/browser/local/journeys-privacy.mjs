// Account closure, child-profile deletion, saved work and the Privacy admin
// (D-148), and the Mission Board's anonymity review (D-151), for real: in
// Chrome against `next dev` and the local stack, with real Storage objects.
// Accounts are created through the admin API (ensureAccount), so this needs no
// signup emails. Everything it makes is removed afterwards.
import { ACADEMY, ENV, PASSWORD, SUPABASE, addChildPage, browser, childId, chk, cleanup, closeAll, ensureAccount, made, section, sleep, sql, summary } from "./driver.mjs";

const SERVICE = { apikey: ENV.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}` };
const MISSION = sql(`select id from missions where slug='six-names'`);

/** A real object in the evidence bucket, through the Storage API. */
async function upload(path, body) {
  const res = await fetch(`${SUPABASE}/storage/v1/object/mission-evidence/${path}`, {
    method: "POST", headers: { ...SERVICE, "Content-Type": "text/plain", "x-upsert": "true" }, body,
  });
  if (!res.ok) throw new Error(`upload ${path}: HTTP ${res.status}`);
}
/** Is the object still in Storage? Asked of Storage itself, not the database. */
async function stored(path) {
  const res = await fetch(`${SUPABASE}/storage/v1/object/mission-evidence/${path}`, { headers: SERVICE });
  return res.status === 200;
}
/** A child with a mission, a run, a saved answer and a Trail entry pointing at a file. */
async function seedChild(id, words) {
  sql(`
    insert into mission_entitlements (child_id, mission_id, source, stripe_payment_intent_id) values ('${id}','${MISSION}','purchase','pi_e2e_${id.slice(0, 8)}');
    insert into mission_progress (id, child_id, mission_id, status, started_at) values (gen_random_uuid(), '${id}', '${MISSION}', 'in_progress', now());
    insert into mission_responses (progress_id, screen_key, value) select id, 'e2e', '{"text":"${words} answer"}'::jsonb from mission_progress where child_id='${id}';
    insert into mission_evidence (child_id, mission_id, type, title, description, storage_path)
      values ('${id}','${MISSION}','digital','${words} plan','${words} wrote this','${id}/${MISSION}/plan.txt');
  `);
  await upload(`${id}/${MISSION}/plan.txt`, `${words}'s file`);
  await upload(`${id}/loose/extra.txt`, `${words}'s unreferenced file`);
}
const ledger = (subject) => sql(`select status||'|'||step||'|'||coalesce(summary->>'files_removed','0') from privacy_deletions where subject_id='${subject}' order by requested_at desc limit 1`);
const savedWork = (b, query = "") => b.eval(`fetch('/account/saved-work${query}').then(async r => r.status + '\\n' + (r.headers.get('content-disposition') || '') + '\\n' + await r.text())`);

const parent = await browser("parent");
const other = await browser("other");
const adminB = await browser("admin");
try {
  section("Two families, real files");
  const parentEmail = await ensureAccount(parent, "parent");
  await addChildPage(parent, "Ana");
  await addChildPage(parent, "Ben");
  const ana = childId(parentEmail, "Ana");
  const ben = childId(parentEmail, "Ben");
  const otherEmail = await ensureAccount(other, "other");
  await addChildPage(other, "Olu");
  const olu = childId(otherEmail, "Olu");
  for (const [id, w] of [[ana, "Ana"], [ben, "Ben"], [olu, "Olu"]]) await seedChild(id, w);
  const parentId = sql(`select id from auth.users where email='${parentEmail}'`);
  // A paid order and a gift bought by this parent, to see what closure keeps.
  sql(`insert into checkout_intents (stripe_session_id,parent_id,child_id,mission_id,amount_minor,currency,paid_at,stripe_payment_intent_id,early_supply_consent_at,cancellation_ack_at,consent_wording)
       values ('cs_e2e_${ana.slice(0, 8)}','${parentId}','${ana}','${MISSION}',1200,'GBP',now(),'pi_e2e_paid',now(),now(),'e2e')`);
  made.sessions.add(`cs_e2e_${ana.slice(0, 8)}`);
  sql(`insert into mission_gifts (mission_id,purchaser_id,stripe_session_id,amount_minor,currency,early_supply_consent_at,cancellation_ack_at,consent_wording)
       values ('${MISSION}','${parentId}','cs_e2e_gift_${ana.slice(0, 8)}',1200,'GBP',now(),now(),'e2e')`);
  made.sessions.add(`cs_e2e_gift_${ana.slice(0, 8)}`);
  sql(`select activate_paid_gift('cs_e2e_gift_${ana.slice(0, 8)}','pi_e2e_gift')`);
  chk("every child's files are really in Storage", (await stored(`${ana}/${MISSION}/plan.txt`)) && (await stored(`${ben}/loose/extra.txt`)) && (await stored(`${olu}/${MISSION}/plan.txt`)));

  section("Saved work, before anything is deleted");
  const benWork = await savedWork(parent, `?child=${ben}`);
  chk("one child's saved work downloads as a file", /^200\n/.test(benWork) && /attachment; filename="wla-saved-work-ben-/.test(benWork));
  chk("it holds that child's Trail and answers, and only theirs", /Ben plan/.test(benWork) && /Ben answer/.test(benWork) && !/Ana plan|Olu plan/.test(benWork));
  chk("another family's child can't be downloaded", /^404\n/.test(await savedWork(parent, `?child=${olu}`)));

  section("Removing one child");
  await parent.goto("/account/children");
  await parent.click(/^remove$/i, { nth: 1 });
  await parent.waitText(/Remove Ben.s profile\?/);
  chk("the dialog names what goes, and offers the saved work first", /mission progress/.test(await parent.text()) && /Mission Trail and any files/.test(await parent.text()) && (await parent.has(/Download Ben.s saved work first/i)));
  await parent.click(/^remove profile$/i);
  await parent.waitUrl(/removal=removed/, 30000);
  chk("the parent is told it's done, and that the others are unchanged", /Other profiles are unchanged/.test(await parent.text()));
  chk("Ben and all Ben's records are gone", !sql(`select 1 from child_profiles where id='${ben}'`) && sql(`select count(*) from mission_evidence where child_id='${ben}'`) === "0" && sql(`select count(*) from mission_progress where child_id='${ben}'`) === "0");
  chk("Ben's files are gone from Storage itself, referenced and unreferenced", !(await stored(`${ben}/${MISSION}/plan.txt`)) && !(await stored(`${ben}/loose/extra.txt`)));
  chk("Ana's records and files are untouched", sql(`select count(*) from mission_evidence where child_id='${ana}'`) === "1" && (await stored(`${ana}/${MISSION}/plan.txt`)) && (await stored(`${ana}/loose/extra.txt`)));
  chk("the other family is untouched", (await stored(`${olu}/${MISSION}/plan.txt`)) && sql(`select count(*) from mission_progress where child_id='${olu}'`) === "1");
  chk("the parent account is untouched", Boolean(sql(`select 1 from profiles where id='${parentId}'`)));
  chk("the deletion is recorded as completed, with two files removed", ledger(ben) === "completed|done|2", ledger(ben));
  made.deletions.add(sql(`select id from privacy_deletions where subject_id='${ben}'`));

  section("Closing the account");
  await parent.goto("/account");
  await parent.click(/^close your account$/i);
  await parent.waitText(/What closing deletes/);
  chk("the page lists the child, what goes and what's kept", /Ana/.test(await parent.text()) && /financial records/.test(await parent.text()) && /backups/.test(await parent.text()));
  const famWork = await savedWork(parent);
  chk("the whole family's saved work downloads first", /^200\n/.test(famWork) && /Ana plan/.test(famWork));
  await parent.fill("input[name=password]", PASSWORD);
  await parent.eval("document.querySelector('input[name=understood]').removeAttribute('required')");
  await parent.click(/^close my account$/i);
  await parent.waitText(/Tick the box to confirm/);
  chk("without the box ticked, nothing happens", Boolean(sql(`select 1 from profiles where id='${parentId}'`)) && !sql(`select 1 from privacy_deletions where subject_id='${parentId}'`));
  await parent.click(/I understand that my account/i, { selector: "label" });
  await parent.fill("input[name=password]", "not-the-password-1A");
  await parent.click(/^close my account$/i);
  await parent.waitText(/That password isn.t right/);
  chk("a wrong password closes nothing", Boolean(sql(`select 1 from profiles where id='${parentId}'`)));
  await parent.click(/I understand that my account/i, { selector: "label" });
  await parent.fill("input[name=password]", PASSWORD);
  await parent.click(/^close my account$/i);
  await parent.waitUrl(/account-closed/, 45000);
  chk("the family is told it's done", /Your account is closed/.test(await parent.text()) && /have been deleted/.test(await parent.text()));
  chk("the account, the child and their records are gone", !sql(`select 1 from auth.users where id='${parentId}'`) && !sql(`select 1 from profiles where id='${parentId}'`) && !sql(`select 1 from child_profiles where id='${ana}'`) && sql(`select count(*) from mission_evidence where child_id='${ana}'`) === "0");
  chk("Ana's files are gone from Storage", !(await stored(`${ana}/${MISSION}/plan.txt`)) && !(await stored(`${ana}/loose/extra.txt`)));
  chk("the paid order is kept as a financial record, with no family", sql(`select (parent_id is null and child_id is null and paid_at is not null)::text from checkout_intents where stripe_session_id='cs_e2e_${ana.slice(0, 8)}'`) === "true");
  chk("the gift they bought still works, without them", sql(`select (status='paid' and purchaser_id is null and code_lookup is not null)::text from mission_gifts where stripe_session_id='cs_e2e_gift_${ana.slice(0, 8)}'`) === "true");
  chk("the other family is untouched", (await stored(`${olu}/${MISSION}/plan.txt`)) && Boolean(sql(`select 1 from child_profiles where id='${olu}'`)));
  chk("the closure is recorded as completed", ledger(parentId).startsWith("completed|done"), ledger(parentId));
  made.deletions.add(sql(`select id from privacy_deletions where subject_id='${parentId}'`));
  await parent.goto(`/login?next=/account`);
  await parent.fill("input[name=email]", parentEmail);
  await parent.fill("input[name=password]", PASSWORD);
  await parent.click(/sign in|log in/i, { selector: "button[type=submit]" });
  await sleep(1500);
  chk("the closed account can't sign in", /\/login/.test(await parent.path()) && /don.t match/.test(await parent.text()));

  section("WLA closes an account for a verified erasure request, under a hold");
  const adminEmail = await ensureAccount(adminB, "admin", "/academy/my-missions");
  sql(`update profiles set is_admin=true where id=(select id from auth.users where email='${adminEmail}')`);
  const otherId = sql(`select id from auth.users where email='${otherEmail}'`);
  await adminB.goto("/admin/privacy");
  await adminB.waitText(/Closures and deletions/);
  chk("the Privacy page lists the two completed deletions", (await adminB.text()).match(/Completed/g)?.length >= 2);
  await adminB.fill("input[name=subjectId]", otherId);
  await adminB.fill("input[name=reason]", "E2E: a dispute is open");
  await adminB.click(/^place hold$/i);
  await adminB.waitText(/Hold placed/);
  await adminB.fill("input[name=email]", otherEmail);
  await adminB.fill("input[name=emailAgain]", otherEmail);
  await adminB.click(/request has been verified/i, { selector: "label" });
  await adminB.click(/^close this account$/i);
  await adminB.waitText(/retention hold stops its data being deleted/);
  chk("under the hold, the account is blocked but nothing is deleted", Boolean(sql(`select 1 from child_profiles where id='${olu}'`)) && (await stored(`${olu}/${MISSION}/plan.txt`)) && ledger(otherId).startsWith("held"));
  await other.goto("/account");
  await sleep(800);
  chk("the held account can't be used", /\/login/.test(await other.path()) || !/Olu/.test(await other.text()));
  await adminB.goto("/admin/privacy");
  await adminB.click(/^release$/i);
  await sleep(800);
  await adminB.goto("/admin/privacy");
  await adminB.click(/^retry everything open$/i);
  await sleep(2500);
  chk("released and retried, the family is deleted, files included", !sql(`select 1 from child_profiles where id='${olu}'`) && !(await stored(`${olu}/${MISSION}/plan.txt`)) && ledger(otherId).startsWith("completed"), ledger(otherId));
  made.deletions.add(sql(`select id from privacy_deletions where subject_id='${otherId}'`));
  sql(`delete from retention_holds where reason='E2E: a dispute is open'`);

  section("Mission Board moderation: anonymity before publishing (D-151)");
  const boardParent = await ensureAccount(other, "boardparent");
  await addChildPage(other, "Bea");
  const bea = childId(boardParent, "Bea");
  sql(`
    insert into mission_evidence (id, child_id, mission_id, type, title, description) values
      ('${bea.slice(0, 8)}-0000-4000-8000-000000000001','${bea}','${MISSION}','digital','A','We worked it out at Oakfield Primary on Mill Road.'),
      ('${bea.slice(0, 8)}-0000-4000-8000-000000000002','${bea}','${MISSION}','digital','B','We compared two ways and kept the fairer one.');
    insert into board_contributions (child_id, mission_id, evidence_id, text, status, permitted_at)
      select '${bea}','${MISSION}', id, description, 'pending_moderation', now() from mission_evidence where child_id='${bea}';
  `);
  await adminB.goto("/admin/board");
  chk("the moderator is shown what could identify a child", /may mention/.test(await adminB.text()) && /a school, class or teacher/.test(await adminB.text()) && /a place, street/.test(await adminB.text()));
  await adminB.click(/^publish$/i);
  await adminB.waitText(/Not published\. Tick the confirmation/);
  chk("publishing without the confirmation is refused", sql(`select count(*) from board_contributions where child_id='${bea}' and status='published'`) === "0");
  await adminB.click(/^Can.t be made anonymous: keep private$/i);
  await sleep(800);
  chk("the identifying one is kept private, with the reason", sql(`select rejected_reason from board_contributions where child_id='${bea}' and text like '%Oakfield%'`) === "cannot_anonymise");
  await adminB.goto("/admin/board");
  await adminB.click(/I.ve checked this copy contains no names/i, { selector: "label" });
  await adminB.click(/^publish$/i);
  await sleep(800);
  chk("the clean one publishes once confirmed", sql(`select status from board_contributions where child_id='${bea}' and text like '%fairer%'`) === "published");
  await other.goto("/account");
  chk("the family is told which was kept private, and when that copy goes", /Kept private by WLA/.test(await other.text()) && /will be deleted on/.test(await other.text()));
  await adminB.goto("/admin/board");
  await adminB.click(/^remove on request$/i);
  await sleep(800);
  chk("a removal request takes a published contribution away completely", sql(`select count(*) from board_contributions where child_id='${bea}' and text like '%fairer%'`) === "0");

  section("The scheduled follow-up is not open to anyone");
  const cron = await fetch(`${ACADEMY}/api/cron/privacy`);
  chk("without the secret it refuses", cron.status === 401);
} finally {
  closeAll();
  if (!process.env.KEEP) {
    cleanup();
    // Anything this run left in Storage.
    const left = sql(`select name from storage.objects where bucket_id='mission-evidence' and owner is null and created_at >= '${made.since}'`).split("\n").filter(Boolean);
    if (left.length) await fetch(`${SUPABASE}/storage/v1/object/mission-evidence`, { method: "DELETE", headers: { ...SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: left }) });
  }
}
process.exit(summary() ? 1 : 0);

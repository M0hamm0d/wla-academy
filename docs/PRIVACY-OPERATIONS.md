# Privacy operations: retention, deletion, gifting and providers

The operational record behind WLA's Privacy Policy and DPIA. It implements the client document **Privacy Policy Updates (6 November 2026)**, recorded as D-148 to D-153. Where something depends on a provider account that hasn't been inspected, it says so rather than guessing.

- **Academy:** this repository (Next.js and its Supabase project).
- **Website:** the Lovable site, a separate project with its own Supabase project (D-25, D-141).

## 1. Data inventory and retention

"Closure" means verified account closure (all children) or verified child-profile deletion (one child). Every closure is recorded in `privacy_deletions` (§2).

| Data | Where | Owner | Identifiable? | Approved rule | Child deleted | Account closed | Files | Status |
|---|---|---|---|---|---|---|---|---|
| Parent account | `auth.users`, `profiles` | Parent | Yes: email, name | Kept while open, whatever the inactivity | Kept | Auth user deleted, which deletes the profile | — | Built, tested |
| Child profile | `child_profiles` | Parent | Yes: display name, birth year | Kept while open | Deleted | Deleted | — | Built, tested |
| Entitlements | `mission_entitlements` | Child | Linked to child | Kept while the child exists | Deleted | Deleted | — | Built, tested |
| Progress, run state, responses | `mission_progress`, `mission_state`, `mission_state_private`, `mission_responses` | Child | Child's work | Kept while the child exists | Deleted | Deleted | — | Built, tested |
| Mission Trail | `mission_evidence`, plus files in bucket `mission-evidence/<child_id>/…` | Child | Child's work | Kept while the child exists | Rows deleted. Every object in the child's folder, or pointed at by a Trail entry, is removed through the Storage API first. | Same | Removed through the Storage API, and checked against Storage itself in the browser journey | Built, tested |
| Mission Board contributions | `board_contributions` | Child | Anonymised copy of the child's text | Pending: kept during moderation. Rejected or withdrawn: deleted within 30 days. Published: kept while approved; removed on withdrawal or a valid removal request. | Deleted at once (under a hold: unpublished and kept) | Same | — | Built, tested. Withdrawal deletes at once; rejected ones are deleted by the daily job after 30 days. |
| Child access codes | `child_access_credentials` (hash, lookup, encrypted copy) | Child | Credential | Revoked codes deleted 90 days after revocation | Revoked at once, then deleted | Same | — | Built, tested |
| Child sessions | `child_sessions` | Child | Session token hash | Ended sessions deleted 90 days after expiry or revocation | Revoked at once, then deleted | Same | — | Built, tested |
| Temporary mission drafts | Browser `sessionStorage` only (`wla-draft:*`), never the server (D-99) | Child's tab | Unsubmitted input | Kept only for mission continuity | Cleared on submit and when the tab closes. The account-closed page clears them. | Same | — | Built. The clearing step was not tested in a browser. |
| Analytics events | `analytics_events` | None: pseudonymous run key | Pseudonymous until the key is removed (§4) | Non-essential: 30 days at most | Key removed with the run | Same | — | Built, tested |
| Child sign-in attempts | `child_auth_attempts` | None: code lookup HMAC | Pseudonymous | Security log: 90 days | — | — | — | Built, tested |
| Gift code attempts | `gift_code_attempts` | None: HMAC of client address | Pseudonymous | Security log: 90 days | — | — | — | Built, tested |
| Supabase Auth audit trail | `auth.audit_log_entries` (includes IP addresses) | Provider | Yes | Security log: 90 days | — | — | — | Pruned daily where the platform allows it; a refusal is recorded in the run. Hosted platform log retention: see §6. |
| Payments for a child | `checkout_intents`, Stripe | Parent | Linked to the family until closure | Financial records: as the law requires | Paid record kept without the child (the parent keeps it); unpaid checkout deleted | Paid record kept with no family link; unpaid deleted | — | Built, tested |
| Gifts | `mission_gifts`, Stripe | Purchaser | Linked to the purchaser; no recipient data | Unredeemed: no expiry. Code and copy cleared on redemption. Payment kept as a financial record. | Redeeming child's link removed | Buyer link and their viewable copy removed; the gift still works for whoever holds the code | — | Built, tested |
| Stripe event ledger | `stripe_events` | None | No: event id and type | Operational, no personal data | — | — | — | Unchanged |
| Closure ledger | `privacy_deletions`, `privacy_deletion_files` | None | Ids and dates only. File paths are held only until removed. | Kept so deletions can be re-applied after a restore (§3) | — | — | — | Built, tested |
| Retention holds | `retention_holds` | WLA | A reason written by WLA | Reviewed at least yearly (enforced: review date at most one year ahead) | Stops the deletion | Stops the deletion | — | Built, tested |
| Retention runs | `retention_runs` | None | Counts only | 400 days | — | — | — | Built, tested |
| Application logs | Host's log stream (stdout, JSON) | — | Ids only, by design (`logger.ts` redacts) | Provider-controlled (§6) | — | — | — | Outstanding: provider setting |
| Journal staff and authors | `journal_*` | Staff (adults) | Staff identity | Not covered by the 6 November document | — | — | Journal media are not family data | Unchanged |
| Support enquiries | Not stored anywhere. The website's contact form shows a thank-you and sends nothing (`contact.tsx`). | — | — | 12 months after resolution | — | — | — | Outstanding: OPEN-28 |
| Reviews | Website project, `reviews` table (`reviewer_email`, `reviewer_name`, body) | Reviewer | Yes | Kept while necessary, then removed | Not linked to Academy accounts | Not linked | — | Outstanding, website project: OPEN-28 |
| Safeguarding records | Not stored in the Academy | WLA | — | Case by case, restricted, reviewed yearly | — | — | — | WLA's procedure. A hold keeps related records and enforces the annual review (D-148). |
| Backups | Supabase platform | Provider | Everything in the database | Verified provider rotation | — | — | — | Outstanding: §3, OPEN-27 |

**Inactivity never closes or deletes anything.** No job reads an activity date. The regression checks the retention function's own text for this, and a family inactive for five years keeps everything.

## 2. How a closure runs

`src/features/privacy/closure.ts` and `supabase/migrations/20261106140000_account_closure_and_retention.sql`.

1. **Verify.**
   - **A parent closing their own account:** a signed-in session, the password entered again, and a confirmation box.
   - **A parent removing one child:** `requireOwnedChild` and a confirmation dialog.
   - **A statutory erasure request made to WLA:** an administrator verifies the requester outside the app, types the address twice and confirms that the request was verified (`/admin/privacy`).
   - **An administrator's own account:** can't be closed this way.
2. **Begin.** `privacy_begin_closure` records the request with a due date 30 days ahead. It then, in this order:
   1. ends the children's codes and sessions;
   2. takes their Mission Board contributions down. Without a hold they are deleted. Whatever a hold keeps loses its permission, and is never queued, published or edited again (D-156);
   3. lists every stored file.

   The children are marked as closing (`closing_at`, D-154). From then on no parent path returns them: they leave the account's list, their saved work can't be downloaded, and no new code can be made. This holds whether the deletion finishes, fails part-way or is held.

   For a whole account, the server also blocks sign-in at once.
3. **Files.** The server removes each listed object through the Storage API and ticks it off. A failure records `failed`, the step and an error code, and nothing further is deleted.
4. **Data.** Once no file remains, `privacy_finish_closure` runs in one transaction. It:
   - deletes the children, which cascades to their entitlements, progress, state, responses, Trail, Board contributions, codes and sessions, and removes their analytics keys;
   - keeps paid orders as de-identified financial records;
   - deletes unpaid checkouts;
   - detaches gifts the parent bought.
5. **Account.** The server deletes the auth user, which removes the profile. `privacy_complete_closure` then confirms that nothing remains and records completion.

**Families can keep their work first.** "Download saved work" (`/account/saved-work`) gives a single HTML file with each child's missions, Mission Trail and saved answers. It is offered from Account, on the close-account page, and in the remove-child dialog.

**Partial failures are visible and retried.**
- `/admin/privacy` lists every open request with its step, attempts, last error code, files left and an overdue flag.
- Administrators can retry one request or all of them.
- `/api/cron/privacy`, protected by `CRON_SECRET`, retries all open requests and removes orphaned evidence files. **It must be put on a schedule at deployment (OPEN-27).**
- A parent is told their closure is done only when it is: `/account-closed?state=done` comes only from a completed closure, `pending` says it is still finishing, and `held` says WLA must keep the records for now. Removing a child is reported the same way (`removal=removed|pending|held|failed`).

**Scheduling the follow-up on Vercel (to approve and configure).** Nothing is scheduled yet: the repository has no `vercel.json`. To schedule it, add this at the repository root:

```json
{
  "crons": [{ "path": "/api/cron/privacy", "schedule": "45 3 * * *" }]
}
```

Then, in the Vercel project's environment variables (Production), set `CRON_SECRET` to a random value of at least 16 characters, for example the output of `openssl rand -hex 32`. Vercel sends it as `Authorization: Bearer <CRON_SECRET>`. Without it, the endpoint refuses every call (401).
- The schedule is in UTC, 30 minutes after the database's own daily run (pg_cron, 03:15 UTC). On Vercel's Hobby plan a daily cron can fire at any point in its hour, which is fine here.
- The route also needs the server variables it already uses: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
- Crons run only on the production deployment. To check: after deploying, Vercel's Cron Jobs page lists it and can run it once. The answer shows counts only (`attempted`, `completed`, `orphanFilesRemoved`).
- Any other scheduler works the same way: a daily `GET` with that header.

The database's daily run needs pg_cron enabled on the hosted project. The migration schedules `privacy-retention` itself, or warns if pg_cron isn't available. To check on the hosted project: `select jobname, schedule from cron.job` should list `privacy-retention | 15 3 * * *`, and `/admin/privacy` shows each day's run.

**Holds.** `retention_holds` covers an account, a child, a contribution, or routine security logs.
- A hold stops a closure before any data goes (the account is still blocked) and stops the 30-day and 90-day pruning.
- Each hold must be reviewed within a year, either renewed or released.
- Releasing a hold returns its closure to the retry queue.

## 3. Backups, and keeping deleted data deleted

**The problem this solves.** If WLA ever restores the database from a backup, everything deleted *after* that backup comes back: families who closed their accounts, removed children, withdrawn Board contributions. The database's own record of those deletions is rolled back with it, so the database alone can't tell what to delete again. (Found in the audit of 7 November, S3.)

**The safeguard: a deletion ledger outside the database (D-157).**
- Every closure request, completed closure, hold placed, renewed or released, and Mission Board removal is written, in the same transaction, to an outbox in the database (`privacy_ledger_outbox`).
- The server copies each entry to immutable segments in the private `wla-privacy-ledger` Storage bucket in a **separate Supabase project**. Existing AES-256-GCM entries remain numbered and chained with keyed HMAC-SHA256; segment ranges and predecessor hashes are checked too.
- It holds **ids and dates only**: which deletion, which account or child (by id), which hold, when. Never a name, email, hold reason or anything a child wrote.
- **A closure deletes nothing until its request is in the ledger.** If the ledger can't be written, the closure waits, shows "ledger" as its step on `/admin/privacy`, and is retried.
- **Holds travel in the ledger too.** A restore brings back the holds placed after the backup *before* it takes on the closures they cover, so a held family is never deleted by mistake. Releasing a hold is recorded the same way.

**Production settings.** Set `PRIVACY_LEDGER_URL`, `PRIVACY_LEDGER_TOKEN` and the existing `PRIVACY_LEDGER_KEY` in Vercel's server-side environment. The URL and token belong to the second project. Preserve the existing 32-byte Base64 key. Missing or invalid production settings make closures fail closed. `PRIVACY_LEDGER_DIR` remains available only for local development and simulations.

**Second-project setup.** Create the separate Supabase project, then create a Storage bucket named `wla-privacy-ledger` with **Public bucket** disabled. Do not add policies for `anon` or `authenticated`; do not create signed URLs. Use that project's server-side service token only in Vercel and the restore operator environment. Confirm the main project's URL is not being used for `PRIVACY_LEDGER_URL`. The application creates objects only under `v1/segments/` and never overwrites one.

The shipper takes a fenced single-writer lease from the main database. Segment names encode their sequence range, and uploads use `upsert: false`. After upload, the shipper downloads and verifies the complete segment chain before checkpointing. If upload succeeds but checkpointing fails, the next worker verifies the existing segment and checkpoints those same event IDs without appending duplicates.

**Initial migration of the current file.** Apply the new fenced-lease migration to the main project before importing; the older application then fails closed while it lacks the new fenced RPC. Configure both projects' credentials and the existing key in a protected operator shell, then run `node scripts/privacy-ledger.ts import-local <path-to-existing-deletion-ledger.jsonl>`. This takes the writer lease, verifies the source, confirms the main database checkpoint is present in its history, uploads the original encrypted lines into immutable segments, and verifies the destination. It does not alter the source file. Deploy the new application promptly, then confirm the queue drains. Keep the source file as a protected recovery copy until an isolated restore drill passes; do not generate a replacement key.

**Restore procedure.** Keep the restored Academy closed until every check passes.
1. Restore the backup into an isolated main Supabase project. Keep production traffic disconnected. Apply the reviewed migrations needed by this application version to the isolated project.
2. Set the restore operator environment to the isolated main project (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) and the external ledger project (`PRIVACY_LEDGER_URL`, `PRIVACY_LEDGER_TOKEN`, existing `PRIVACY_LEDGER_KEY`). Do not use a local ledger file.
3. Retrieve and verify the external ledger: `node scripts/privacy-ledger.ts verify`. Any retrieval, sequence, chain, decryption or key error means stop. Do not reopen.
4. Replay into the isolated restored database: `node scripts/privacy-ledger.ts restore`. The CLI downloads and verifies segments again, then calls `privacy_ledger_replay`. It refuses a chain that does not extend the backup checkpoint or omits closure/hold history.
5. Run the normal closure follow-up repeatedly against the isolated environment: `GET /api/cron/privacy` with `CRON_SECRET`, or **Retry everything open** on `/admin/privacy`. Confirm files, data and auth users are removed, and that active holds remain in force. A main database restore does not restore or delete Storage files; this follow-up checks/removes listed evidence files.
6. Verify with `node scripts/privacy-ledger.ts verify-restore`. It must report no problems. If it reports `subject_still_present`, `deletion_not_finished`, `held_child_usable`, `held_content_visible`, `hold_missing`, `board_contribution_returned`, or `files_remain`, keep the Academy closed, fix the cause, and repeat steps 5–6.
7. Check `/admin/privacy`: no open deletions except those under active holds, held closures remain held, and the ledger is up to date.
8. Reopen only after all checks pass and the responsible operator approves.
9. Record the backup, restore time, replay counts, verification result and approver.

For a restore drill, use an isolated copy of the ledger bucket so shipping any unshipped backup outbox rows cannot alter production ledger objects. A local simulation or isolated drill is not proof of a real production restore.

The older in-database safeguard, `privacy_reapply_deletions()`, now only reopens completed closures whose family has come back, for step 6 to finish. It is enough only for a backup taken *after* every deletion. It no longer deletes rows itself, which could leave a sign-in without its profile (S1).

**Tested.** `scripts/run-privacy-restore-simulation.sh` builds a throwaway PostgreSQL, unconnected to the local Supabase stack, and runs this whole procedure against a real `pg_dump` backup restored into a new database:
- the families deleted after the backup are deleted again;
- a held family is kept in full and stays unusable and off the Board;
- unrelated families and siblings are intact;
- a missing, edited, foreign or cut-short ledger is refused.

**What is not tested:** Supabase's own backup and restore, GoTrue and the Storage API. In the simulation they are rows. No real provider restore has been performed.

**What the provider controls, and isn't verified.** I couldn't inspect the hosted project's backup settings. Which backups exist (daily, or point-in-time recovery), how long they're kept, whether Storage objects are backed up separately, and whether either can be shortened are all set on the Supabase dashboard and depend on the plan. **No rotation period is stated here, because none was verified.** Until a backup ages out, it may still contain deleted data. The ledger and this procedure stop a restore from bringing that data back into use. OPEN-27 lists what is needed.

**Other things a restore brings back** that the ledger doesn't cover:
- child access codes and sessions revoked after the backup;
- replaced gift codes;
- retention pruning since the backup. This is redone by the next daily run, because it is based on dates.

After a restore, consider ending all child sessions and telling families to check their codes.

## 4. Mission activity records and analytics

These are classified by what they are used for, not by their names.

| Record | Purpose | Class | Retention |
|---|---|---|---|
| `mission_progress` (status, current screen, version, dates) | Resume, status, completion, "Continue Mission" | Essential: continuity, progress and completion | While the child exists |
| `mission_state`, `mission_state_private` | The server-side run (D-80): what the child has unlocked and chosen | Essential | While the child exists |
| `mission_responses` | What the child answered, shown back to them and to the Trail | Essential | While the child exists |
| `mission_evidence` | The Mission Trail | Essential | While the child exists |
| `analytics_events` without a run key | Mission-level counts in admin Analytics | Non-essential, **anonymous** | Not personal data. Kept. |
| `analytics_events.run_key` (pseudonymous run id, D-76) | Per-run questions: where children stop, repeated help, return after a gap | Non-essential, **pseudonymous child analytics**. WLA can link it to a child through `mission_progress.analytics_key`. | **30 days at most**: removed daily, and at once on deletion |
| `child_auth_attempts`, `gift_code_attempts` | Rate limits | Security log | 90 days |

**Nothing in this list is new collection.** The run key is the only identifiable analytics. It is already justified by the approved Enhancement Plan (D-76), and is now capped at the approved 30 days. Admin analytics reports only aggregates and never returns a key.

## 5. Cookies and browser storage

| Name | Where | Kind | Purpose | Consent? |
|---|---|---|---|---|
| `sb-<project>-auth-token` (and chunks) | Academy | Cookie, httpOnly, first-party | Parent session (Supabase Auth) | No: strictly necessary |
| `wla_child_session` | Academy | Cookie, httpOnly | Child access-code session (D-58) | No: strictly necessary |
| `wla_active_child` | Academy | Cookie | Which child's missions are shown. Carries no authority. | No: needed for the service the parent asked for |
| `wla_gift_claim` | Academy | Cookie, httpOnly, 24 hours | Remembers a correct gift code while the recipient signs in | No: strictly necessary |
| `wla-draft:*` | Academy | sessionStorage | Unsubmitted mission input survives a reload (D-99) | No: strictly necessary |
| `sb-<project>-auth-token` | Website | localStorage | The website's own sign-in (OPEN-24) | No: strictly necessary while those accounts exist |
| Six Names practice state | Website | localStorage | Keeps the free practice mission's progress | No: requested functionality |
| `sidebar_state` | Website, admin only | Cookie | Remembers the sidebar | No: requested functionality |

**Third parties.**
- **Academy:** no analytics, advertising or tracking scripts, and no Sentry (D-28 is not wired). Fonts are self-hosted by `next/font` and served from the Academy itself. A page and its CSS were checked: no Google requests. Stripe Checkout is a separate page on Stripe's domain.
- **Website:** fonts load from **fonts.googleapis.com / fonts.gstatic.com** (`src/routes/__root.tsx`), which sends visitors' IP addresses to Google (OPEN-28). There are no analytics scripts.

A consent banner isn't needed for any of the technologies above.

## 6. Service providers

| Provider | Confirmed from the code | Needs WLA's account to confirm |
|---|---|---|
| **Supabase** (Academy project) | Database, Auth, Storage (`mission-evidence`, `mission-resources`, `mission-media`, `mission-covers`, `journal-media`). Deletion through the Storage API; pg_cron for retention and Journal scheduling. | Region; plan; backup type, frequency and retention; PITR window; Storage backups; Auth audit and log retention; whether `auth.audit_log_entries` can be pruned; the DPA. |
| **Supabase** (website project) | A separate project with `reviews` (reviewer email), the legacy `gifts`, `user_roles`, `mission_access`, Journal tables, and its own Auth. | Region, backups and log retention, as above. A decision on OPEN-24. |
| **Stripe** | Checkout sessions created on the server; webhook signature checked; card only; the customer's email is passed to Checkout. Stripe keeps payment records. | Account country and entity; the DPA; whether Stripe sends its own receipts; Radar and other features in use. |
| **Resend** | Order confirmations (mission, or gift code) to the person who paid. Not configured anywhere yet (no key in the repository). | Sending domain; region; log and message retention; whether open/click tracking is off (it should be). |
| **Vercel** (Academy, intended: D-132) | No `vercel.json` in the repository; hosting isn't confirmed by code. `/api/cron/privacy` is ready for Vercel Cron. | Whether the Academy is on Vercel; region; runtime log retention; the cron job; `CRON_SECRET`. |
| **Cloudflare** (website) | The website builds for Cloudflare Workers (nitro `cloudflare-module` preset, wrangler). | The account; Workers log retention; analytics settings (e.g. Web Analytics off). |
| **Lovable** | The website's editor. Its preview sign-in broker is used only inside the Lovable editor. | Whether Lovable processes production data. |
| **Google Fonts** | The website only (§5). | — |

## 7. Information needed from WLA (OPEN-27)

1. **Supabase, both projects:**
   - Organisation and plan.
   - Region.
   - Backup settings: daily or point-in-time recovery, and the retention period.
   - Whether Storage is backed up, and for how long.
   - Auth and API log retention.
   - Read access (or screenshots) to confirm them.
2. **Hosting:**
   - Confirmation that the Academy is on Vercel, with the project's region and log retention.
   - Approval of the cron configuration in §2, and who will add it and set `CRON_SECRET`.
3. **Cloudflare:** the account that hosts the website, its Workers log settings, and whether Web Analytics or any other analytics is on.
4. **Resend:** the verified sending domain, the account's region, and its message and log retention, with tracking off.
5. **Stripe:** the account's legal entity and country, and whether Stripe's own email receipts are switched on.
6. **Terms & Conditions:** the published URL (set `NEXT_PUBLIC_TERMS_URL`). The site's `/terms` page is still a placeholder (OPEN-29).
7. **The deletion ledger (OPEN-30):** where it is kept in production (not this database, not this project's Storage, and not a Vercel disk), who may read it, and who keeps a copy of `PRIVACY_LEDGER_KEY` for a restore.

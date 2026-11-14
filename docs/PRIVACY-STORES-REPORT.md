# Privacy deletion and retention stores — code report

**Reviewed:** 12 November 2026  
**Scope:** The checked-in WLA Academy migrations, privacy server code, admin
page, operations documentation, and privacy/restore regression scripts. This
report describes repository code; it does not inspect a live Supabase project.
No application code or database migration was changed to produce this report.

## Executive summary

These objects have different jobs and should not be treated as interchangeable:

| Object | Where | Main job |
|---|---|---|
| `privacy_deletions` | Supabase database | Durable, minimal record and retry state for a verified child or account closure. |
| `privacy_deletion_files` | Supabase database | Temporary checklist of Storage object paths that must be removed before relational data is deleted. |
| `privacy_ledger_outbox` | Supabase database | Transactional queue of privacy events waiting to be copied outside the database. |
| `privacy_ledger_head` | Supabase database | Sequence and chain checkpoint for the last external-ledger copy acknowledged by this database. |
| `retention_holds` | Supabase database | Admin-recorded, reviewable exceptions that can prevent specified closure or retention actions. |
| `deletion-ledger.jsonl` | Server-configured filesystem outside the database | Encrypted, append-only restore record that survives a database restore, if configured in durable external storage. |

There is **no `privacy_ledger_files` table or symbol in the checked-in
repository**. The likely names being conflated are `privacy_deletion_files`
(the database's Storage-path checklist) and the external JSONL deletion ledger.
The deployment could have schema objects not present in this repository; that
cannot be confirmed without inspecting the deployed database.

The central safety principle is: a database backup can restore records that
were deleted after it was taken. The external ledger records those privacy
events separately. On a configured deployment, closure processing waits until
the request has been copied to that ledger before it removes files or data.
After restoring a backup, operators verify and replay the external ledger
before reopening service.

## 1. `privacy_deletions`: closure record and workflow state

### What it stores

The table records one verified request to close a parent account or delete a
child profile. Its columns include:

- Subject type and UUID, parent UUID, and the UUIDs of children covered.
- Whether the request came from a parent or an administrator.
- Request time and the 30-day target date (`due_by`).
- Workflow status (`in_progress`, `held`, `failed`, or `completed`) and step.
- Retry count, last attempt, a short error code, completion time, and a numeric
  summary of deleted/retained records.

It is designed to survive deletion of the corresponding account and child
rows. It retains IDs and operational dates rather than names, email addresses,
or a child's work. There can be only one non-completed request for a given
subject; a completed request does not prevent a later request row.

### What it does

The server calls `privacy_begin_closure` after verifying the request. The
database re-checks that a child belongs to the supplied parent, rejects
invalid subjects and administrator self-closure, and reuses an existing open
request rather than duplicating it. Beginning the request immediately:

1. Revokes the covered children's sessions and access credentials.
2. Makes their Mission Board contributions unavailable for public display and
   moderation; unheld contributions are removed at the start, while retained
   contributions lose permission.
3. Enqueues the relevant evidence Storage objects in `privacy_deletion_files`.
4. Marks the children as closing, preventing ordinary family use while the
   deletion is in progress or held.

When not held, the application calls `privacy_finish_closure` only after it has
removed the listed files through the Supabase Storage API. The database then
deletes child records (cascading to child-owned data), detaches or removes
financial records according to the policy, and records count-only summary
information. For a parent-account closure, the server separately deletes the
Supabase Auth user and calls `privacy_complete_closure`; completion is recorded
only after the database confirms the profile, auth user, and covered children
are gone.

Failures are recorded with a step and short error code, and open requests can
be retried. The admin view exposes open work and recently completed work
(completed rows are displayed for 90 days); the underlying completed records
are retained for restore protection. The database functions and tables are
not directly available to client roles.

### Restore role

The request IDs and covered subjects provide an in-database record to compare
against the external ledger and to reopen unfinished/completed work after a
restore. `privacy_reapply_deletions()` is only a limited fallback for backups
that already contain the relevant deletion record; it cannot recover requests
lost in an older backup. The complete procedure uses the external ledger.

## 2. `privacy_deletion_files`: temporary Storage-removal checklist

This table is related to a specific `privacy_deletions` row and contains a
bucket and object path for each file that must be removed. The database
enumerates objects in the `mission-evidence` bucket that are in a covered
child's folder or referenced by that child's Trail entry. It records only
objects that exist when listed.

The server reads the pending paths, groups them by bucket, and removes them
through the Storage API. This distinction matters: deleting a row from
`storage.objects` would not remove the stored bytes. Once the API reports
success, the path's checklist row is deleted and a count is added to the
closure summary. If removal fails, the path remains with a short error so a
retry can try again. Before deleting relational data, the database lists again
to catch an upload that arrived during closure processing.

Thus, `privacy_deletion_files` is **not** the backup-surviving event ledger. It
is a temporary queue/checklist, and its object paths disappear as files are
removed.

## 3. `privacy_ledger_outbox`: transactional event queue

This table captures privacy events in the same database transaction as the
change that caused them. Database triggers enqueue events for:

- A closure being requested, its covered child IDs changing, and its
  completion.
- A retention hold being placed, renewed, or released.
- A Mission Board contribution being removed.

Rows have an increasing sequence, a unique event UUID, an event name, a JSON
payload, creation time, and (after successful copying) a `shipped_at` time.
Payloads carry IDs and dates needed for restore replay, not names, email
addresses, hold reasons, or child-generated content.

The server fetches pending events in sequence, appends them to the external
ledger, then marks those event IDs shipped and updates `privacy_ledger_head`.
Keeping event creation transactional prevents the database change from
committing without its corresponding outbox event. Keeping unshipped entries
in the outbox also allows a restore operator to copy entries that a backup
recorded but the server had not yet shipped.

Shipped rows become eligible for pruning after 30 days; pruning is performed
when the shipping acknowledgement function runs. Pending rows are not pruned
by that rule. The external ledger, not the pruned outbox, is the long-lived
copy.

## 4. `privacy_ledger_head`: checkpoint of the external ledger

This is a singleton checkpoint containing the highest external ledger
sequence acknowledged by the database, the corresponding chain value, and
when the checkpoint was recorded. It advances only after the external append
has succeeded.

During restore, the database compares its saved checkpoint with the
corresponding entry in the supplied ledger. The ledger must extend the
checkpoint at the exact same chain value. This detects a ledger that is
truncated, belongs to another database/environment, or otherwise does not
contain what the backup says it had already shipped. The head alone is not a
copy of the events and is not sufficient to restore them.

## 5. The external ledger file (not a database table)

The external sink is named `deletion-ledger.jsonl` in the configured
`PRIVACY_LEDGER_DIR`. Its implementation is in
[`src/features/privacy/ledger-core.ts`](../src/features/privacy/ledger-core.ts)
and the operator tool is
[`scripts/privacy-ledger.ts`](../scripts/privacy-ledger.ts).

Each JSON line contains a monotonically increasing sequence, append time,
encrypted event, and keyed chain value. Event contents are encrypted with
AES-256-GCM; an HMAC-SHA256 chain covers the previous chain and the current
entry. The key is derived from `PRIVACY_LEDGER_KEY`, a 32-byte base64 secret
held outside the database. Verification checks the sequence, chain, and
decryption for every line. A broken or unverifiable ledger is a stop
condition: the operator tool writes no replay events and instructs the
operator not to reopen the restored database.

Configuration behavior is significant:

- **Neither setting present:** closures proceed without the external safeguard;
  the admin page warns that an older restore could bring deleted families
  back without their deletion record.
- **Only one setting present, or an invalid key:** configuration is
  misconfigured and closures wait rather than deleting data.
- **Both settings valid:** a closure request must be shipped and confirmed
  before file or relational data deletion proceeds.

The code explicitly warns that a local/server directory is not enough on a
host with ephemeral disk. The actual durable production storage location and
key custody are marked unresolved in the operations documentation (OPEN-30).
This report does not verify whether those variables are configured in
production.

## 6. `retention_holds`: scoped, reviewable exceptions

An active hold is a `retention_holds` row whose `released_at` is null. A hold
specifies one of four subjects:

| Subject type | Subject ID | Effect implemented in the repository |
|---|---|---|
| `parent_account` | Parent UUID | Prevents that account's closure from proceeding to deletion. |
| `child_profile` | Child UUID | Prevents that child's closure from proceeding to deletion. |
| `board_contribution` | Contribution UUID | Protects that contribution from relevant Board deletion/pruning logic and takes it off the public/queue path when closure starts. |
| `security_logs` | Must be null | Pauses the routine 90-day security-log cleanup as a whole. |

The row also stores a required WLA-written reason, placement time, placing
administrator (nullable if that admin profile is later deleted), review date,
and release/review metadata. Admin-only functions create and review holds.
The admin page lists active holds, their reasons, covered IDs, and review
dates; an administrator may renew or release them.

The admin path sets a default review date 365 days ahead and limits renewals
to at most a year. A past review date does **not** automatically release the
hold: it remains active until an administrator explicitly renews or releases
it. The daily retention run reports active holds overdue for review.

### Closure holds versus routine retention

A parent- or child-scoped hold causes the closure request to be marked `held`.
The account/child is still made unusable: sessions and codes are revoked,
parent sign-in is blocked for an account closure, and Board contributions are
removed from public and moderation paths. The actual relational deletion is
paused. Releasing the last applicable hold moves the request back to
`in_progress`, where a retry can continue it.

The routine retention function applies holds selectively, not as a blanket
exemption from every cleanup:

- A `security_logs` hold skips the 90-day pruning of child sign-in attempts,
  gift-code attempts, and the Supabase Auth audit rows, where that table is
  available and deletable.
- A contribution hold and a family/child hold prevent applicable rejected
  Board contribution pruning.
- The code still clears analytics run keys after 30 days, prunes ended child
  sessions and revoked child codes after 90 days, and removes old run records
  after 400 days. Those statements do not check for parent/child holds.
- The closure request itself is separately gated by parent/child holds.

So “retention hold” does not mean every cleanup rule is paused for every hold
type. The exact subject type and the code path matter.

## 7. End-to-end closure and restore flows

### Normal closure

1. The caller verifies the parent or child request. Direct client access to
   the deletion tables/functions is revoked; server-side service-role code
   performs the operations.
2. The database records the request, cuts off further family use, and queues
   file paths.
3. With the external ledger configured, the server ships the event and checks
   that the closure request is present in the external ledger.
4. The server deletes the queued Storage objects. Failed objects remain in the
   checklist and make the closure retryable.
5. After a final database re-list confirms no files remain, the database
   removes the covered records. For an account closure, the server then
   deletes the Auth user and records completion.
6. The daily server endpoint retries open closures and sweeps evidence files
   whose child record no longer exists. A separate database `pg_cron` job
   handles routine retention.

### Restore after a backup

The documented procedure keeps the restored service closed, verifies the
external ledger and key, copies any outbox events that were not yet shipped,
and replays the ledger into the restored database. Replay checks that the
ledger extends the saved head and includes requests/holds the backup knew
about. It then restores holds before affected closures, recreates or reopens
requests, and removes Board contributions recorded as removed. The server
retry process removes files through Storage and finishes deletions. A restore
verification function must return no problems before the Academy is reopened.

The database restore and Storage backup/restore are separate concerns. The
operations document states that provider backup settings, Storage backup
behavior, production ledger location, and hosting configuration have not
been verified.

## 8. Routine retention and evidence

`privacy_retention_run()` is scheduled for daily execution at 03:15 UTC when
`pg_cron` is available. The migration warns if the extension or scheduling is
unavailable; a successful migration alone therefore does not prove that the
job is running. The function records counts/results in `retention_runs` and
continues through separate cleanup blocks so one error does not prevent every
other cleanup from being attempted.

The configured rules in the checked-in function are:

- Clear non-essential analytics run keys after 30 days (the event rows remain).
- Prune security logs after 90 days unless the global security-log hold is
  active.
- Prune ended child sessions and revoked child credentials after 90 days.
- Prune rejected Board contributions after 30 days, subject to the applicable
  Board/family/child holds and closure state.
- Keep retention-run records for 400 days.

It does not delete accounts or children for inactivity. The operations
documentation explicitly says inactivity is not used as a closure trigger.

## 9. Important implementation caveat: contribution-only holds

The checked-in code appears to have a lifecycle gap for a
`board_contribution`-only hold when the owning child is subsequently deleted:

1. `privacy_begin_closure`/`private.closure_take_effect` avoids directly
   deleting a contribution that has its own active hold and moves it off the
   public/queue path.
2. A contribution-only hold is **not** part of `private.closure_held()`;
   that helper checks parent-account and child-profile holds.
3. `privacy_finish_closure` can therefore continue to delete the child
   profile when there is no parent/child hold.
4. The original `board_contributions.child_id` foreign key is
   `ON DELETE CASCADE`, and the reviewed migrations do not change that
   constraint. Deleting the child can consequently cascade-delete the
   contribution, despite the contribution-only hold.

The existing Board-closing regression checks that the contribution remains
immediately after the closure begins, but does not appear to finish the
closure and verify that the held contribution survives that later cascade.
This is a finding from static inspection of the checked-in files, not a
claim about a live database. It should be checked against the actual deployed
schema and clarified with the product/privacy owner before relying on
contribution-only holds to preserve a contribution through completed child
deletion.

## 10. Tests and operational boundaries

The repository includes:

- [`scripts/privacy-regression.sql`](../scripts/privacy-regression.sql) and
  [`scripts/run-privacy-regression.sh`](../scripts/run-privacy-regression.sh)
  for privacy/retention behavior.
- [`scripts/board-closing-regression.sql`](../scripts/board-closing-regression.sql)
  for Board behavior during closure and holds.
- [`scripts/run-privacy-restore-simulation.sh`](../scripts/run-privacy-restore-simulation.sh)
  for a database backup/restore plus external-ledger replay simulation.
- Unit tests under
  [`src/features/privacy/__tests__/`](../src/features/privacy/__tests/)
  for closure and ledger behavior.

The restore simulation is an isolated PostgreSQL simulation; the operations
document explicitly distinguishes it from a real Supabase provider restore,
GoTrue behavior, and Storage API restore. No live database, production
environment variables, cron schedule, external ledger directory, backup
rotation, or provider configuration was inspected for this report.

## Source map

- [`docs/PRIVACY-OPERATIONS.md`](./PRIVACY-OPERATIONS.md) — approved policy,
  closure steps, restore procedure, provider/open questions.
- [`docs/DATA-MODEL.md`](./DATA-MODEL.md) — rationale for the new tables.
- [`supabase/migrations/20261106140000_account_closure_and_retention.sql`](../supabase/migrations/20261106140000_account_closure_and_retention.sql) —
  deletion/file/hold/run tables and closure/retention RPCs.
- [`supabase/migrations/20261107100000_closing_profiles_unusable.sql`](../supabase/migrations/20261107100000_closing_profiles_unusable.sql) —
  marks covered child profiles as closing and blocks ordinary use.
- [`supabase/migrations/20261107130000_board_closing_never_public.sql`](../supabase/migrations/20261107130000_board_closing_never_public.sql) —
  Board behavior for closing subjects and the later retention implementation.
- [`supabase/migrations/20261107140000_independent_deletion_ledger.sql`](../supabase/migrations/20261107140000_independent_deletion_ledger.sql) —
  outbox, head, triggers, replay, and restore verification.
- [`src/features/privacy/closure.ts`](../src/features/privacy/closure.ts) —
  server-side Storage removal, account deletion, and retry flow.
- [`src/features/privacy/ledger.ts`](../src/features/privacy/ledger.ts) and
  [`src/features/privacy/ledger-core.ts`](../src/features/privacy/ledger-core.ts) —
  external ledger shipping and cryptographic file format.
- [`src/app/admin/privacy/page.tsx`](../src/app/admin/privacy/page.tsx) —
  admin operational view for closures, ledger status, holds, and retention runs.

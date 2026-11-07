-- ============================================================================
-- ACCOUNT CLOSURE, CHILD-PROFILE DELETION AND RETENTION (D-148; resolves the
-- retention-policy part of OPEN-14). Client document of 6 Nov 2026, §1.
--
-- Closure is a recorded process, not one DELETE:
--
--   begin    privacy_begin_closure: the request is recorded in
--            privacy_deletions (ids and dates only, no names or addresses); the
--            children's codes and sessions stop working; their Mission Board
--            contributions come down; every stored file of theirs is listed in
--            privacy_deletion_files, so a file can't be forgotten once the rows
--            pointing at it are gone.
--   files    the application server removes each listed object from Storage
--            (a DELETE on storage.objects would leave the stored bytes) and
--            ticks it off. A failure is recorded and retried.
--   data     privacy_finish_closure, once no file is left: children deleted
--            (cascading to entitlements, progress, state, responses, Trail and
--            Board), paid intents kept as financial records with the family
--            removed, unpaid intents deleted, gifts the parent bought detached.
--   account  for a parent, the application deletes the auth user (cascading to
--            the profile), then privacy_complete_closure checks nothing is
--            left and records completion.
--
-- A lawful hold (retention_holds) stops a closure before any data goes; the
-- request stays visible as 'held'. Everything incomplete is visible to admins
-- (admin_privacy_deletions) with its step and error code, and is retried.
--
-- After a backup restore, privacy_reapply_deletions deletes again everything a
-- completed request had deleted. That is why the ledger keeps the ids.
--
-- Inactivity never closes or deletes anything: nothing here, or anywhere,
-- reads last_activity_at, last_seen_at or sign-in dates to decide a deletion.
-- ============================================================================

set search_path = public, extensions;

-- ---------------------------------------------------------------- the ledger --
create table if not exists privacy_deletions (
  id               uuid primary key default gen_random_uuid(),
  subject_type     text not null check (subject_type in ('parent_account', 'child_profile')),
  -- Kept after completion so the deletion can be re-applied after a restore.
  -- An id is all that remains: no name, address or content.
  subject_id       uuid not null,
  parent_id        uuid not null,
  child_ids        uuid[] not null default '{}',
  requested_by     text not null check (requested_by in ('parent', 'admin')),
  requested_at     timestamptz not null default now(),
  -- The approved target: within 30 days of verified closure.
  due_by           timestamptz not null default now() + interval '30 days',
  status           text not null default 'in_progress'
                   check (status in ('in_progress', 'held', 'failed', 'completed')),
  step             text not null default 'begun',
  attempts         int not null default 0,
  last_error       text check (last_error is null or char_length(last_error) <= 120),
  last_attempt_at  timestamptz,
  completed_at     timestamptz,
  summary          jsonb not null default '{}'::jsonb,
  constraint privacy_deletions_completed_has_date check ((status = 'completed') = (completed_at is not null))
);
create unique index if not exists privacy_deletions_one_open
  on privacy_deletions (subject_type, subject_id) where status <> 'completed';
create index if not exists privacy_deletions_open_idx on privacy_deletions (status, due_by) where status <> 'completed';

create table if not exists privacy_deletion_files (
  deletion_id  uuid not null references privacy_deletions (id) on delete cascade,
  bucket       text not null,
  path         text not null,
  last_error   text check (last_error is null or char_length(last_error) <= 120),
  primary key (deletion_id, bucket, path)
);

-- --------------------------------------------------------------- the holds --
-- "Lawful exceptions", "documented investigation exceptions", and the annual
-- review of case-specific records: a hold names what it covers and why, and is
-- due for review within a year.
create table if not exists retention_holds (
  id            uuid primary key default gen_random_uuid(),
  subject_type  text not null check (subject_type in ('parent_account', 'child_profile', 'board_contribution', 'security_logs')),
  -- Null only for security_logs, which pauses routine log pruning as a whole.
  subject_id    uuid,
  reason        text not null check (char_length(btrim(reason)) between 3 and 500),
  placed_by     uuid references profiles (id) on delete set null,
  placed_at     timestamptz not null default now(),
  review_by     date not null default (current_date + 365),
  released_at   timestamptz,
  released_by   uuid references profiles (id) on delete set null,
  reviewed_at   timestamptz,
  constraint retention_holds_subject check ((subject_type = 'security_logs') = (subject_id is null)),
  constraint retention_holds_review_within_year check (review_by <= (coalesce(reviewed_at, placed_at)::date + 366))
);
create index if not exists retention_holds_active_idx on retention_holds (subject_type, subject_id) where released_at is null;

-- -------------------------------------------------------------- the runs --
create table if not exists retention_runs (
  id       bigint generated always as identity primary key,
  ran_at   timestamptz not null default now(),
  results  jsonb not null default '{}'::jsonb,
  error    text
);

alter table privacy_deletions      enable row level security;
alter table privacy_deletion_files enable row level security;
alter table retention_holds        enable row level security;
alter table retention_runs         enable row level security;
revoke all on privacy_deletions, privacy_deletion_files, retention_holds, retention_runs from public, anon, authenticated;

-- ------------------------------------------------------------------ helpers --
create or replace function private.hold_active(p_type text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from retention_holds h
     where h.released_at is null and h.subject_type = p_type
       and h.subject_id is not distinct from p_id
  );
$$;
revoke all on function private.hold_active(text, uuid) from public, anon, authenticated;

-- A closure is held if the family, or any child it covers, is held.
create or replace function private.closure_held(p_parent uuid, p_children uuid[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.hold_active('parent_account', p_parent)
      or exists (select 1 from unnest(p_children) c(id) where private.hold_active('child_profile', c.id));
$$;
revoke all on function private.closure_held(uuid, uuid[]) from public, anon, authenticated;

-- Every stored file of these children: anything in their folder of the
-- evidence bucket, and any object a Trail entry of theirs points at elsewhere.
-- Only objects that exist: a path whose object is gone needs no removing, and
-- an object the Storage API has removed no longer appears, so listing again
-- is always safe.
create or replace function private.enqueue_child_files(p_deletion uuid, p_children uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  insert into privacy_deletion_files (deletion_id, bucket, path)
  select p_deletion, o.bucket_id, o.name
    from storage.objects o
   where o.bucket_id = 'mission-evidence'
     and (split_part(o.name, '/', 1) = any(select c::text from unnest(p_children) c)
          or o.name in (select e.storage_path from mission_evidence e
                         where e.child_id = any(p_children) and coalesce(e.storage_path, '') <> ''))
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function private.enqueue_child_files(uuid, uuid[]) from public, anon, authenticated;

-- -------------------------------------------------------------------- begin --
/*
 * Record a verified closure and stop further use at once. The caller has
 * verified the parent (session and password re-entry, or WLA for an erasure
 * request it has verified); ownership of the child is re-asserted here.
 * Idempotent: an open request for the same subject is returned, not doubled.
 * An administrator's own account can't be closed this way.
 * Service role only.
 */
create or replace function privacy_begin_closure(
  p_subject_type text,
  p_subject_id   uuid,
  p_parent_id    uuid,
  p_requested_by text
) returns table (outcome text, deletion_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_children uuid[];
  v_id uuid;
  v_status text;
  v_admin boolean;
begin
  if p_subject_type = 'parent_account' then
    if p_subject_id is distinct from p_parent_id then
      return query select 'invalid'::text, null::uuid, null::text; return;
    end if;
    select is_admin into v_admin from profiles where id = p_parent_id;
    if not found then return query select 'not_found'::text, null::uuid, null::text; return; end if;
    if v_admin then return query select 'admin_account'::text, null::uuid, null::text; return; end if;
    select coalesce(array_agg(id order by created_at), '{}') into v_children
      from child_profiles where parent_id = p_parent_id;
  elsif p_subject_type = 'child_profile' then
    if not exists (select 1 from child_profiles where id = p_subject_id and parent_id = p_parent_id) then
      return query select 'not_found'::text, null::uuid, null::text; return;
    end if;
    v_children := array[p_subject_id];
  else
    return query select 'invalid'::text, null::uuid, null::text; return;
  end if;

  select d.id, d.status into v_id, v_status from privacy_deletions d
   where d.subject_type = p_subject_type and d.subject_id = p_subject_id and d.status <> 'completed'
   for update;
  if found then
    update privacy_deletions d
       set child_ids = (select array_agg(distinct x) from unnest(d.child_ids || v_children) x)
     where d.id = v_id;
  else
    insert into privacy_deletions (subject_type, subject_id, parent_id, child_ids, requested_by)
    values (p_subject_type, p_subject_id, p_parent_id, v_children, p_requested_by)
    returning id into v_id;
  end if;

  v_status := case when private.closure_held(p_parent_id, v_children) then 'held' else 'in_progress' end;

  -- No further use: codes and sessions end now, and nothing stays on the Board.
  -- Under a hold the contributions are kept, but taken off the Board.
  update child_sessions set revoked_at = now() where child_id = any(v_children) and revoked_at is null;
  update child_access_credentials set revoked_at = now() where child_id = any(v_children) and revoked_at is null;
  if v_status <> 'held' then
    delete from board_contributions b
     where b.child_id = any(v_children) and not private.hold_active('board_contribution', b.id);
  end if;
  update board_contributions b set status = 'pending_moderation', anonymity_checked_at = null, anonymity_checked_by = null
   where b.child_id = any(v_children) and b.status = 'published';

  perform private.enqueue_child_files(v_id, v_children);

  update privacy_deletions d set status = v_status where d.id = v_id and d.status <> 'completed';
  return query select 'begun'::text, v_id, v_status;
end;
$$;
revoke all on function privacy_begin_closure(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function privacy_begin_closure(text, uuid, uuid, text) to service_role;

-- ------------------------------------------------------------------ files --
create or replace function privacy_pending_files(p_deletion uuid)
returns table (bucket text, path text)
language sql
stable
security definer
set search_path = public
as $$
  select f.bucket, f.path from privacy_deletion_files f where f.deletion_id = p_deletion order by f.bucket, f.path;
$$;
revoke all on function privacy_pending_files(uuid) from public, anon, authenticated;
grant execute on function privacy_pending_files(uuid) to service_role;

/*
 * The server removed (or failed to remove) these objects. A removed file's row
 * goes, keeping only the count; a failed one keeps its row and an error code.
 */
create or replace function privacy_record_files(p_deletion uuid, p_bucket text, p_removed text[], p_failed text[], p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  delete from privacy_deletion_files f
   where f.deletion_id = p_deletion and f.bucket = p_bucket and f.path = any(coalesce(p_removed, '{}'));
  get diagnostics v_n = row_count;
  update privacy_deletion_files f set last_error = left(p_error, 120)
   where f.deletion_id = p_deletion and f.bucket = p_bucket and f.path = any(coalesce(p_failed, '{}'));
  update privacy_deletions d
     set summary = jsonb_set(d.summary, '{files_removed}',
                             to_jsonb(coalesce((d.summary->>'files_removed')::int, 0) + v_n))
   where d.id = p_deletion;
end;
$$;
revoke all on function privacy_record_files(uuid, text, text[], text[], text) from public, anon, authenticated;
grant execute on function privacy_record_files(uuid, text, text[], text[], text) to service_role;

-- ------------------------------------------------------------------ data --
/*
 * Delete the family's (or child's) records, once every file has gone.
 * Returns 'files_pending', 'held', 'data_deleted' or 'completed'. One
 * transaction: either all of it happens or none of it. Service role only.
 */
create or replace function privacy_finish_closure(p_deletion uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  d privacy_deletions%rowtype;
  v_children uuid[];
  v_new uuid[];
  v_parent_closure boolean;
  v jsonb := '{}'::jsonb;
  n int;
begin
  select * into d from privacy_deletions where id = p_deletion for update;
  if not found then return 'not_found'; end if;
  if d.status = 'completed' then return 'completed'; end if;
  if d.step = 'data_deleted' then return 'data_deleted'; end if;

  v_parent_closure := d.subject_type = 'parent_account';
  v_children := d.child_ids;

  -- A child added since the request (it shouldn't be possible: the account is
  -- blocked) is covered too, and its files are listed first.
  if v_parent_closure then
    select coalesce(array_agg(c.id), '{}') into v_new from child_profiles c
     where c.parent_id = d.parent_id and not (c.id = any(v_children));
    if cardinality(v_new) > 0 then
      v_children := v_children || v_new;
      update privacy_deletions set child_ids = v_children where id = d.id;
      perform private.enqueue_child_files(d.id, v_new);
      update child_sessions set revoked_at = now() where child_id = any(v_new) and revoked_at is null;
      update child_access_credentials set revoked_at = now() where child_id = any(v_new) and revoked_at is null;
    end if;
  end if;

  if private.closure_held(d.parent_id, v_children) then
    update privacy_deletions set status = 'held', last_attempt_at = now() where id = d.id;
    return 'held';
  end if;

  -- Re-list in case a file appeared since (an upload in flight at the time).
  perform private.enqueue_child_files(d.id, v_children);
  if exists (select 1 from privacy_deletion_files where deletion_id = d.id) then
    update privacy_deletions set status = 'in_progress', step = 'files', last_attempt_at = now() where id = d.id;
    return 'files_pending';
  end if;

  -- Counts for the record. Numbers only.
  select count(*) into n from mission_entitlements where child_id = any(v_children); v := v || jsonb_build_object('entitlements', n);
  select count(*) into n from mission_progress where child_id = any(v_children); v := v || jsonb_build_object('mission_runs', n);
  select count(*) into n from mission_responses r join mission_progress p on p.id = r.progress_id where p.child_id = any(v_children); v := v || jsonb_build_object('responses', n);
  select count(*) into n from mission_evidence where child_id = any(v_children); v := v || jsonb_build_object('trail_entries', n);
  select count(*) into n from board_contributions where child_id = any(v_children); v := v || jsonb_build_object('board_contributions', n);

  -- Financial records: a paid intent stays, without the child; and without the
  -- parent too once the whole account goes. (A parent who removes one child
  -- keeps their own record of what they paid for.)
  update checkout_intents ci
     set child_id = null,
         parent_id = case when v_parent_closure then null else ci.parent_id end
   where ci.paid_at is not null
     and (ci.child_id = any(v_children) or (v_parent_closure and ci.parent_id = d.parent_id));
  get diagnostics n = row_count; v := v || jsonb_build_object('payments_kept_without_family', n);
  delete from checkout_intents ci
   where ci.paid_at is null
     and (ci.child_id = any(v_children) or (v_parent_closure and ci.parent_id = d.parent_id));
  get diagnostics n = row_count; v := v || jsonb_build_object('unpaid_checkouts_deleted', n);

  -- A gift this parent bought stays redeemable by whoever holds its code; the
  -- link to the buyer and their viewable copy of the code go.
  if v_parent_closure then
    update mission_gifts set purchaser_id = null, code_ciphertext = null where purchaser_id = d.parent_id;
    get diagnostics n = row_count; v := v || jsonb_build_object('gifts_detached', n);
  end if;

  delete from child_profiles where id = any(v_children);
  get diagnostics n = row_count; v := v || jsonb_build_object('child_profiles', n);

  update privacy_deletions
     set step = 'data_deleted',
         status = 'in_progress',
         last_error = null,
         last_attempt_at = now(),
         summary = summary || v
   where id = d.id;

  if not v_parent_closure then
    update privacy_deletions set status = 'completed', step = 'done', completed_at = now() where id = d.id;
    return 'completed';
  end if;
  return 'data_deleted';
end;
$$;
revoke all on function privacy_finish_closure(uuid) from public, anon, authenticated;
grant execute on function privacy_finish_closure(uuid) to service_role;

/*
 * The parent's auth user has been deleted by the server. Completes only if
 * nothing of the account remains. Service role only.
 */
create or replace function privacy_complete_closure(p_deletion uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare d privacy_deletions%rowtype;
begin
  select * into d from privacy_deletions where id = p_deletion for update;
  if not found then return 'not_found'; end if;
  if d.status = 'completed' then return 'completed'; end if;
  if d.step <> 'data_deleted' then return 'not_ready'; end if;
  if exists (select 1 from profiles where id = d.parent_id)
     or exists (select 1 from auth.users where id = d.parent_id)
     or exists (select 1 from child_profiles where id = any(d.child_ids)) then
    return 'not_ready';
  end if;
  update privacy_deletions
     set status = 'completed', step = 'done', completed_at = now(), last_error = null
   where id = d.id;
  return 'completed';
end;
$$;
revoke all on function privacy_complete_closure(uuid) from public, anon, authenticated;
grant execute on function privacy_complete_closure(uuid) to service_role;

create or replace function privacy_record_failure(p_deletion uuid, p_step text, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  update privacy_deletions
     set status = case when status = 'held' then 'held' else 'failed' end,
         step = left(coalesce(p_step, step), 40),
         attempts = attempts + 1,
         last_error = left(p_error, 120),
         last_attempt_at = now()
   where id = p_deletion and status <> 'completed';
$$;
revoke all on function privacy_record_failure(uuid, text, text) from public, anon, authenticated;
grant execute on function privacy_record_failure(uuid, text, text) to service_role;

-- What a retry should pick up: everything open that isn't held.
create or replace function privacy_open_deletions()
returns table (id uuid, subject_type text, parent_id uuid, step text)
language sql
stable
security definer
set search_path = public
as $$
  select d.id, d.subject_type, d.parent_id, d.step from privacy_deletions d
   where d.status in ('in_progress', 'failed') order by d.requested_at limit 100;
$$;
revoke all on function privacy_open_deletions() from public, anon, authenticated;
grant execute on function privacy_open_deletions() to service_role;

/*
 * Files in the evidence bucket whose child no longer exists: left by a failure
 * outside this process, or restored from a storage backup. The server removes
 * them. Service role only.
 */
create or replace function privacy_orphan_files(p_limit int default 500)
returns table (bucket text, path text)
language sql
stable
security definer
set search_path = public
as $$
  select o.bucket_id, o.name from storage.objects o
   where o.bucket_id = 'mission-evidence'
     and not exists (
       select 1 from child_profiles c where c.id::text = split_part(o.name, '/', 1)
     )
   limit greatest(1, least(coalesce(p_limit, 500), 1000));
$$;
revoke all on function privacy_orphan_files(int) from public, anon, authenticated;
grant execute on function privacy_orphan_files(int) to service_role;

-- -------------------------------------------------- after a backup restore --
/*
 * A restored backup can bring back what a completed request deleted. Run this
 * straight after any restore, before the service is reopened, then the
 * server's orphan sweep for files (docs/PRIVACY-OPERATIONS.md). It deletes
 * again, by id, every child and account that a completed request had deleted.
 * Service role, or the database owner during a restore.
 */
create or replace function privacy_reapply_deletions()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_children int := 0;
  v_accounts int := 0;
  v_accounts_refused int := 0;
  n int;
  d record;
begin
  for d in select * from privacy_deletions where status = 'completed' loop
    update checkout_intents
       set child_id = null,
           parent_id = case when d.subject_type = 'parent_account' then null else parent_id end
     where paid_at is not null and (child_id = any(d.child_ids) or (d.subject_type = 'parent_account' and parent_id = d.parent_id));
    delete from checkout_intents
     where paid_at is null and (child_id = any(d.child_ids) or (d.subject_type = 'parent_account' and parent_id = d.parent_id));
    delete from child_profiles where id = any(d.child_ids);
    get diagnostics n = row_count; v_children := v_children + n;
    if d.subject_type = 'parent_account' then
      update mission_gifts set purchaser_id = null, code_ciphertext = null where purchaser_id = d.parent_id;
      delete from child_profiles where parent_id = d.parent_id;
      get diagnostics n = row_count; v_children := v_children + n;
      begin
        delete from auth.users where id = d.parent_id;
        get diagnostics n = row_count; v_accounts := v_accounts + n;
      exception when insufficient_privilege then
        -- Not this role's to delete: the server's auth admin call is needed.
        v_accounts_refused := v_accounts_refused + 1;
      end;
      delete from profiles where id = d.parent_id;
    end if;
  end loop;
  return jsonb_build_object('children_deleted_again', v_children, 'accounts_deleted_again', v_accounts,
                            'accounts_needing_auth_admin', v_accounts_refused);
end;
$$;
revoke all on function privacy_reapply_deletions() from public, anon, authenticated;
grant execute on function privacy_reapply_deletions() to service_role;

-- --------------------------------------------------------- retention job --
/*
 * The approved periods, applied daily (pg_cron, below). Each rule is its own
 * block, so one failing doesn't stop the rest, and every run is recorded with
 * its counts in retention_runs as evidence.
 *
 *   analytics run keys      30 days   (non-essential, pseudonymous: D-150)
 *   security logs           90 days   unless a 'security_logs' hold is active
 *   ended child sessions    90 days after expiry or revocation
 *   revoked child codes     90 days after revocation
 *   rejected Board offers   30 days after the moderation decision, unless held
 *   retention run records   400 days
 *
 * Nothing here looks at inactivity. Accounts, children, progress, responses,
 * Trails and unredeemed gifts are not touched.
 */
create or replace function privacy_retention_run()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb := '{}'::jsonb;
  n int;
  v_logs_held boolean := private.hold_active('security_logs', null);
begin
  begin
    update analytics_events set run_key = null
     where run_key is not null and occurred_at < now() - interval '30 days';
    get diagnostics n = row_count; v := v || jsonb_build_object('analytics_keys_removed', n);
  exception when others then v := v || jsonb_build_object('analytics_keys_removed', 'error ' || sqlstate);
  end;

  if v_logs_held then
    v := v || jsonb_build_object('security_logs', 'held');
  else
    begin
      delete from child_auth_attempts where occurred_at < now() - interval '90 days';
      get diagnostics n = row_count; v := v || jsonb_build_object('child_sign_in_attempts_deleted', n);
      delete from gift_code_attempts where occurred_at < now() - interval '90 days';
      get diagnostics n = row_count; v := v || jsonb_build_object('gift_code_attempts_deleted', n);
    exception when others then v := v || jsonb_build_object('security_logs', 'error ' || sqlstate);
    end;
    -- Supabase Auth's own audit trail, where the database holds it. The
    -- platform may not let this role prune it; that is recorded, not hidden.
    begin
      if to_regclass('auth.audit_log_entries') is not null then
        execute 'delete from auth.audit_log_entries where created_at < now() - interval ''90 days''';
        get diagnostics n = row_count; v := v || jsonb_build_object('auth_audit_entries_deleted', n);
      end if;
    exception when others then v := v || jsonb_build_object('auth_audit_entries_deleted', 'not permitted ' || sqlstate);
    end;
  end if;

  begin
    delete from child_sessions
     where (expires_at < now() - interval '90 days')
        or (revoked_at is not null and revoked_at < now() - interval '90 days');
    get diagnostics n = row_count; v := v || jsonb_build_object('ended_child_sessions_deleted', n);
    delete from child_access_credentials
     where revoked_at is not null and revoked_at < now() - interval '90 days';
    get diagnostics n = row_count; v := v || jsonb_build_object('revoked_child_codes_deleted', n);
  exception when others then v := v || jsonb_build_object('child_sessions', 'error ' || sqlstate);
  end;

  begin
    delete from board_contributions b
     where b.status = 'rejected'
       and coalesce(b.moderated_at, b.created_at) < now() - interval '30 days'
       and not private.hold_active('board_contribution', b.id);
    get diagnostics n = row_count; v := v || jsonb_build_object('rejected_board_offers_deleted', n);
  exception when others then v := v || jsonb_build_object('rejected_board_offers_deleted', 'error ' || sqlstate);
  end;

  select count(*) into n from privacy_deletions where status <> 'completed' and due_by < now();
  v := v || jsonb_build_object('closures_overdue', n);
  select count(*) into n from retention_holds where released_at is null and review_by < current_date;
  v := v || jsonb_build_object('holds_due_for_review', n);

  delete from retention_runs where ran_at < now() - interval '400 days';
  insert into retention_runs (results) values (v);
  return v;
end;
$$;
revoke all on function privacy_retention_run() from public, anon, authenticated;
grant execute on function privacy_retention_run() to service_role;

-- --------------------------------------------------------------- admin --
create or replace function admin_privacy_deletions()
returns table (
  id uuid, subject_type text, requested_by text, requested_at timestamptz,
  due_by timestamptz, status text, step text, attempts int, last_error text,
  completed_at timestamptz, overdue boolean, files_pending bigint, children int, summary jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return query
  select d.id, d.subject_type, d.requested_by, d.requested_at, d.due_by, d.status, d.step,
         d.attempts, d.last_error, d.completed_at,
         d.status <> 'completed' and d.due_by < now(),
         (select count(*) from privacy_deletion_files f where f.deletion_id = d.id),
         cardinality(d.child_ids), d.summary
    from privacy_deletions d
   where d.status <> 'completed' or d.completed_at > now() - interval '90 days'
   order by (d.status = 'completed'), d.requested_at desc
   limit 200;
end;
$$;
revoke all on function admin_privacy_deletions() from public, anon;
grant execute on function admin_privacy_deletions() to authenticated;

create or replace function admin_retention_holds()
returns table (id uuid, subject_type text, subject_id uuid, reason text, placed_at timestamptz, review_by date, review_due boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return query
  select h.id, h.subject_type, h.subject_id, h.reason, h.placed_at, h.review_by, h.review_by < current_date
    from retention_holds h where h.released_at is null order by h.review_by;
end;
$$;
revoke all on function admin_retention_holds() from public, anon;
grant execute on function admin_retention_holds() to authenticated;

create or replace function admin_place_hold(p_subject_type text, p_subject_id uuid, p_reason text, p_review_by date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if not is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  insert into retention_holds (subject_type, subject_id, reason, placed_by, review_by)
  values (p_subject_type, case when p_subject_type = 'security_logs' then null else p_subject_id end,
          btrim(p_reason), auth.uid(), coalesce(p_review_by, current_date + 365))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function admin_place_hold(text, uuid, text, date) from public, anon;
grant execute on function admin_place_hold(text, uuid, text, date) to authenticated;

-- Reviewing a hold either renews it (another year at most) or releases it.
create or replace function admin_review_hold(p_id uuid, p_release boolean, p_review_by date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  if p_release then
    update retention_holds set released_at = now(), released_by = auth.uid() where id = p_id and released_at is null;
    -- A closure that was waiting only for this hold carries on (the next retry).
    update privacy_deletions d set status = 'in_progress'
     where d.status = 'held' and not private.closure_held(d.parent_id, d.child_ids);
  else
    update retention_holds
       set reviewed_at = now(), review_by = least(coalesce(p_review_by, current_date + 365), current_date + 365)
     where id = p_id and released_at is null;
  end if;
end;
$$;
revoke all on function admin_review_hold(uuid, boolean, date) from public, anon;
grant execute on function admin_review_hold(uuid, boolean, date) to authenticated;

create or replace function admin_retention_runs(p_limit int default 14)
returns table (ran_at timestamptz, results jsonb, error text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return query select r.ran_at, r.results, r.error from retention_runs r order by r.ran_at desc
    limit greatest(1, least(coalesce(p_limit, 14), 90));
end;
$$;
revoke all on function admin_retention_runs(int) from public, anon;
grant execute on function admin_retention_runs(int) to authenticated;

-- --------------------------------------------------------------- schedule --
do $cron$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise warning 'pg_cron is not available: retention periods will not be applied automatically (D-148).';
    return;
  end if;
  begin
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('privacy-retention', '15 3 * * *', 'select public.privacy_retention_run()');
  exception when others then
    raise warning 'pg_cron could not be set up (%): retention periods will not be applied automatically (D-148).', sqlerrm;
  end;
end
$cron$;

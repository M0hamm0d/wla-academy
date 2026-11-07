/*
 * A DELETION LEDGER THAT SURVIVES A RESTORE (S3, D-157).
 *
 * Found in the pre-deployment audit of 7 Nov 2026: privacy_reapply_deletions()
 * read the deletion records from the same database as the backup. Restoring
 * Sunday's backup after a family was deleted on Tuesday brings the family back
 * and removes Tuesday's record of deleting them, so nothing could be reapplied.
 *
 * The design: every privacy-relevant event is written here, in the same
 * transaction as the change, to an outbox. The server copies each event to a
 * ledger kept OUTSIDE the database (src/features/privacy/ledger*.ts): an
 * append-only file of encrypted, hash-chained, keyed-MAC'd entries, under a
 * key the database never holds. When a sink is configured, a closure deletes
 * nothing until its request is in that ledger. After a restore, the verified
 * ledger is replayed into the restored database (privacy_ledger_replay below),
 * and the normal closure process redoes what had been done.
 *
 * Events, and the only data they carry (ids and dates; never a name, email,
 * hold reason or any content):
 *   closure_requested      deletion id, subject type and id, parent id, child ids, by whom, when
 *   closure_children_added deletion id, child ids
 *   closure_completed      deletion id, when
 *   hold_placed            hold id, subject type and id, placed, review by
 *   hold_renewed           hold id, reviewed, review by
 *   hold_released          hold id, when
 *   board_removed          contribution id, child id, when
 *
 * Holds travel in the ledger too, so a replay can never turn a held closure
 * into a deletion: a hold placed after the backup is restored before the
 * requests it covers are taken on.
 *
 * Also here: privacy_reapply_deletions() no longer deletes a profile while
 * leaving its auth user (the S1 precondition). It reopens the closure, so the
 * server deletes both properly.
 */

-- ------------------------------------------------------------- the outbox --
create table if not exists privacy_ledger_outbox (
  seq        bigint generated always as identity primary key,
  event_id   uuid not null default gen_random_uuid() unique,
  event      text not null check (event in (
               'closure_requested', 'closure_children_added', 'closure_completed',
               'hold_placed', 'hold_renewed', 'hold_released', 'board_removed')),
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  shipped_at timestamptz
);
create index if not exists privacy_ledger_outbox_pending on privacy_ledger_outbox (seq) where shipped_at is null;

-- Where the external ledger had reached when this database last shipped to it.
-- After a restore it shows what the backup knew, so the ledger offered for the
-- replay must contain that entry, unchanged.
create table if not exists privacy_ledger_head (
  id          boolean primary key default true check (id),
  ledger_seq  bigint not null,
  chain       text not null,
  recorded_at timestamptz not null default now()
);

alter table privacy_ledger_outbox enable row level security;
alter table privacy_ledger_head   enable row level security;
revoke all on privacy_ledger_outbox, privacy_ledger_head from public, anon, authenticated;

create or replace function private.ledger_emit(p_event text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A replay writes what the ledger already holds: it doesn't record it twice.
  if coalesce(current_setting('wla.ledger_replay', true), '') = 'on' then return; end if;
  insert into privacy_ledger_outbox (event, payload) values (p_event, p_payload);
end;
$$;
revoke all on function private.ledger_emit(text, jsonb) from public, anon, authenticated;

create or replace function private.ledger_on_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform private.ledger_emit('closure_requested', jsonb_build_object(
      'deletion_id', new.id, 'subject_type', new.subject_type, 'subject_id', new.subject_id,
      'parent_id', new.parent_id, 'child_ids', to_jsonb(new.child_ids),
      'requested_by', new.requested_by, 'requested_at', new.requested_at));
  else
    if new.child_ids is distinct from old.child_ids then
      perform private.ledger_emit('closure_children_added', jsonb_build_object(
        'deletion_id', new.id, 'child_ids', to_jsonb(new.child_ids)));
    end if;
    if new.status = 'completed' and old.status is distinct from 'completed' then
      perform private.ledger_emit('closure_completed', jsonb_build_object(
        'deletion_id', new.id, 'completed_at', new.completed_at));
    end if;
  end if;
  return null;
end;
$$;
revoke all on function private.ledger_on_deletion() from public, anon, authenticated;
drop trigger if exists privacy_deletions_ledger on privacy_deletions;
create trigger privacy_deletions_ledger
  after insert or update of child_ids, status on privacy_deletions
  for each row execute function private.ledger_on_deletion();

create or replace function private.ledger_on_hold()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform private.ledger_emit('hold_placed', jsonb_build_object(
      'hold_id', new.id, 'subject_type', new.subject_type, 'subject_id', new.subject_id,
      'placed_at', new.placed_at, 'review_by', new.review_by));
  elsif new.released_at is not null and old.released_at is null then
    perform private.ledger_emit('hold_released', jsonb_build_object('hold_id', new.id, 'released_at', new.released_at));
  elsif new.review_by is distinct from old.review_by or new.reviewed_at is distinct from old.reviewed_at then
    perform private.ledger_emit('hold_renewed', jsonb_build_object(
      'hold_id', new.id, 'reviewed_at', new.reviewed_at, 'review_by', new.review_by));
  end if;
  return null;
end;
$$;
revoke all on function private.ledger_on_hold() from public, anon, authenticated;
drop trigger if exists retention_holds_ledger on retention_holds;
create trigger retention_holds_ledger
  after insert or update on retention_holds
  for each row execute function private.ledger_on_hold();

create or replace function private.ledger_on_board_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform private.ledger_emit('board_removed', jsonb_build_object(
    'contribution_id', old.id, 'child_id', old.child_id, 'removed_at', now()));
  return null;
end;
$$;
revoke all on function private.ledger_on_board_delete() from public, anon, authenticated;
drop trigger if exists board_contributions_ledger on board_contributions;
create trigger board_contributions_ledger
  after delete on board_contributions
  for each row execute function private.ledger_on_board_delete();

-- Everything recorded before this migration enters the outbox too, in order,
-- so the first copy to the ledger is complete.
insert into privacy_ledger_outbox (event, payload, created_at)
select e, p, t from (
  select 'closure_requested' e, jsonb_build_object(
           'deletion_id', d.id, 'subject_type', d.subject_type, 'subject_id', d.subject_id,
           'parent_id', d.parent_id, 'child_ids', to_jsonb(d.child_ids),
           'requested_by', d.requested_by, 'requested_at', d.requested_at) p, d.requested_at t
    from privacy_deletions d
  union all
  select 'closure_completed', jsonb_build_object('deletion_id', d.id, 'completed_at', d.completed_at), d.completed_at
    from privacy_deletions d where d.status = 'completed'
  union all
  select 'hold_placed', jsonb_build_object(
           'hold_id', h.id, 'subject_type', h.subject_type, 'subject_id', h.subject_id,
           'placed_at', h.placed_at, 'review_by', h.review_by), h.placed_at
    from retention_holds h
  union all
  select 'hold_released', jsonb_build_object('hold_id', h.id, 'released_at', h.released_at), h.released_at
    from retention_holds h where h.released_at is not null
) x
where not exists (select 1 from privacy_ledger_outbox)
order by t;

-- ------------------------------------------------- shipping (server) --
create or replace function privacy_ledger_pending(p_limit int default 200)
returns table (seq bigint, event_id uuid, event text, payload jsonb, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select o.seq, o.event_id, o.event, o.payload, o.created_at
    from privacy_ledger_outbox o
   where o.shipped_at is null
   order by o.seq
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;
revoke all on function privacy_ledger_pending(int) from public, anon, authenticated;
grant execute on function privacy_ledger_pending(int) to service_role;

/*
 * The server appended these events to the external ledger, which had then
 * reached p_ledger_seq with chain p_chain. Shipped events are kept 30 days
 * (they are in the ledger), then pruned here.
 */
create or replace function privacy_ledger_mark_shipped(p_event_ids uuid[], p_ledger_seq bigint, p_chain text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update privacy_ledger_outbox set shipped_at = now()
   where event_id = any(p_event_ids) and shipped_at is null;
  -- Recorded only once the ledger has an entry: an empty one has no head.
  if p_ledger_seq > 0 then
    insert into privacy_ledger_head (id, ledger_seq, chain) values (true, p_ledger_seq, p_chain)
    on conflict (id) do update set ledger_seq = excluded.ledger_seq, chain = excluded.chain, recorded_at = now()
     where privacy_ledger_head.ledger_seq < excluded.ledger_seq;
  end if;
  delete from privacy_ledger_outbox where shipped_at < now() - interval '30 days';
end;
$$;
revoke all on function privacy_ledger_mark_shipped(uuid[], bigint, text) from public, anon, authenticated;
grant execute on function privacy_ledger_mark_shipped(uuid[], bigint, text) to service_role;

-- Is this closure's request in the external ledger yet?
create or replace function privacy_ledger_request_shipped(p_deletion uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from privacy_ledger_outbox o
     where o.event = 'closure_requested' and o.payload->>'deletion_id' = p_deletion::text
       and o.shipped_at is not null
  ) or exists (
    -- Shipped and since pruned: the head has moved past it, and nothing for
    -- this request is left unshipped.
    select 1 from privacy_deletions d
     where d.id = p_deletion and d.requested_at < now() - interval '30 days'
       and not exists (select 1 from privacy_ledger_outbox o
                        where o.payload->>'deletion_id' = p_deletion::text and o.shipped_at is null)
  );
$$;
revoke all on function privacy_ledger_request_shipped(uuid) from public, anon, authenticated;
grant execute on function privacy_ledger_request_shipped(uuid) to service_role;

-- For /admin/privacy: is the ledger keeping up? Counts and dates only.
create or replace function admin_privacy_ledger_status()
returns table (unshipped bigint, oldest_unshipped timestamptz, last_shipped timestamptz, ledger_seq bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return query
  select (select count(*) from privacy_ledger_outbox where shipped_at is null),
         (select min(created_at) from privacy_ledger_outbox where shipped_at is null),
         (select max(shipped_at) from privacy_ledger_outbox),
         (select h.ledger_seq from privacy_ledger_head h);
end;
$$;
revoke all on function admin_privacy_ledger_status() from public, anon;
grant execute on function admin_privacy_ledger_status() to authenticated;

-- ------------------------------------------------- after a restore --
create or replace function private.subject_present(p_type text, p_subject uuid, p_parent uuid, p_children uuid[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case when p_type = 'parent_account' then
           exists (select 1 from profiles where id = p_parent)
           or exists (select 1 from auth.users where id = p_parent)
           or exists (select 1 from child_profiles where parent_id = p_parent or id = any(p_children))
         else exists (select 1 from child_profiles where id = p_subject) end;
$$;
revoke all on function private.subject_present(text, uuid, uuid, uuid[]) from public, anon, authenticated;

/*
 * Replay the verified external ledger into a restored database (D-157).
 *
 * p_events is what `node scripts/privacy-ledger.ts verify` prints: every entry,
 * in ledger order, each {seq, chain, event_id, event, payload, created_at}. The
 * script has checked the key, the chain and the sequence; this checks that the
 * ledger belongs to this database:
 *   - the head this database last recorded must be in it, unchanged;
 *   - every closure and hold this database knows of must be in it (or in its
 *     own outbox, recorded but not yet shipped when the backup was taken).
 * Either failing raises, and nothing is replayed: deletion status is unknown,
 * and the database must not be reopened (docs/PRIVACY-OPERATIONS.md §3).
 *
 * Then, in order and idempotently: holds are recreated, renewed and released;
 * requests missing from the backup are recreated with their original ids;
 * completed ones whose family has come back are reopened; contributions that
 * had been removed are removed. Each request takes effect again through the
 * same steps as live (private.closure_take_effect): codes and sessions end,
 * nothing is on the Board, files are listed, and a hold keeps everything. The
 * server's follow-up (`/api/cron/privacy`) then deletes files, data and auth
 * users as it does for any open request.
 *
 * Service role or the database owner only. Returns counts.
 */
create or replace function privacy_ledger_replay(p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e jsonb;
  p jsonb;
  v_head privacy_ledger_head%rowtype;
  v_at_head jsonb;
  d privacy_deletions%rowtype;
  v_id uuid;
  v_other uuid;
  v_children uuid[];
  n_recreated int := 0; n_reopened int := 0; n_holds int := 0; n_released int := 0;
  n_removed int := 0; n_events int := 0;
  v_missing int;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) = 0 then
    raise exception 'ledger_empty' using errcode = '22023';
  end if;

  -- The ledger must extend what this database knew.
  select * into v_head from privacy_ledger_head;
  if found then
    select x into v_at_head from jsonb_array_elements(p_events) x where (x->>'seq')::bigint = v_head.ledger_seq;
    if v_at_head is null or v_at_head->>'chain' is distinct from v_head.chain then
      raise exception 'ledger_does_not_extend_backup' using errcode = '22023';
    end if;
  end if;

  -- Everything this database knows of must be in the ledger or its own outbox.
  select count(*) into v_missing from privacy_deletions pd
   where not exists (select 1 from jsonb_array_elements(p_events) x
                      where x->>'event' = 'closure_requested' and x->'payload'->>'deletion_id' = pd.id::text)
     and not exists (select 1 from privacy_ledger_outbox o
                      where o.event = 'closure_requested' and o.payload->>'deletion_id' = pd.id::text);
  if v_missing > 0 then raise exception 'ledger_incomplete: % closure(s) not in the ledger', v_missing using errcode = '22023'; end if;
  select count(*) into v_missing from retention_holds h
   where not exists (select 1 from jsonb_array_elements(p_events) x
                      where x->>'event' = 'hold_placed' and x->'payload'->>'hold_id' = h.id::text)
     and not exists (select 1 from privacy_ledger_outbox o
                      where o.event = 'hold_placed' and o.payload->>'hold_id' = h.id::text);
  if v_missing > 0 then raise exception 'ledger_incomplete: % hold(s) not in the ledger', v_missing using errcode = '22023'; end if;

  perform set_config('wla.ledger_replay', 'on', true);

  for e in select x from jsonb_array_elements(p_events) x order by (x->>'seq')::bigint loop
    p := e->'payload';
    n_events := n_events + 1;
    case e->>'event'
    when 'hold_placed' then
      insert into retention_holds (id, subject_type, subject_id, reason, placed_at, review_by)
      values ((p->>'hold_id')::uuid, p->>'subject_type', nullif(p->>'subject_id', '')::uuid,
              'Restored from the deletion ledger; see the original hold record',
              (p->>'placed_at')::timestamptz, (p->>'review_by')::date)
      on conflict (id) do nothing;
      if found then n_holds := n_holds + 1; end if;
      update privacy_deletions x set status = 'held'
       where x.status in ('in_progress', 'failed') and private.closure_held(x.parent_id, x.child_ids);

    when 'hold_renewed' then
      update retention_holds
         set reviewed_at = (p->>'reviewed_at')::timestamptz, review_by = (p->>'review_by')::date
       where id = (p->>'hold_id')::uuid and released_at is null;

    when 'hold_released' then
      update retention_holds set released_at = (p->>'released_at')::timestamptz
       where id = (p->>'hold_id')::uuid and released_at is null;
      if found then n_released := n_released + 1; end if;
      update privacy_deletions x set status = 'in_progress'
       where x.status = 'held' and not private.closure_held(x.parent_id, x.child_ids);

    when 'closure_requested', 'closure_children_added', 'closure_completed' then
      v_id := (p->>'deletion_id')::uuid;
      select * into d from privacy_deletions where id = v_id;
      if not found and e->>'event' = 'closure_requested' then
        select x.id into v_other from privacy_deletions x
         where x.subject_type = p->>'subject_type' and x.subject_id = (p->>'subject_id')::uuid and x.status <> 'completed';
        v_children := array(select jsonb_array_elements_text(p->'child_ids')::uuid);
        if v_other is not null then
          update privacy_deletions x
             set child_ids = (select array_agg(distinct c) from unnest(x.child_ids || v_children) c)
           where x.id = v_other;
          v_id := v_other;
        else
          insert into privacy_deletions (id, subject_type, subject_id, parent_id, child_ids, requested_by, requested_at, due_by, step)
          values (v_id, p->>'subject_type', (p->>'subject_id')::uuid, (p->>'parent_id')::uuid, v_children,
                  p->>'requested_by', (p->>'requested_at')::timestamptz,
                  (p->>'requested_at')::timestamptz + interval '30 days', 'replayed');
          n_recreated := n_recreated + 1;
        end if;
        select * into d from privacy_deletions where id = v_id;
      end if;

      if d.id is not null then
        if e->>'event' = 'closure_children_added' then
          v_children := array(select jsonb_array_elements_text(p->'child_ids')::uuid);
          update privacy_deletions x
             set child_ids = (select array_agg(distinct c) from unnest(x.child_ids || v_children) c)
           where x.id = d.id;
          select * into d from privacy_deletions where id = d.id;
        end if;

        -- Done before, but the family is back: do it again.
        if d.status = 'completed' and private.subject_present(d.subject_type, d.subject_id, d.parent_id, d.child_ids) then
          begin
            update privacy_deletions
               set status = 'in_progress', completed_at = null, step = 'replayed', last_error = null
             where id = d.id;
            n_reopened := n_reopened + 1;
          exception when unique_violation then
            null; -- another open request for the same subject will do it
          end;
        elsif d.status <> 'completed' and d.step in ('data_deleted', 'done')
              and private.subject_present(d.subject_type, d.subject_id, d.parent_id, d.child_ids) then
          update privacy_deletions set step = 'replayed' where id = d.id;
        end if;

        perform private.closure_take_effect(d.id);

        -- Nobody signs in to it meanwhile. auth.users is the platform's; where
        -- this role can't write it, the server's deletion covers it.
        if d.subject_type = 'parent_account' then
          begin
            execute 'update auth.users set banned_until = now() + interval ''100 years'' where id = $1' using d.parent_id;
          exception when others then null;
          end;
        end if;
      end if;
      d := null;

    when 'board_removed' then
      delete from board_contributions where id = (p->>'contribution_id')::uuid;
      if found then n_removed := n_removed + 1; end if;

    else
      raise exception 'ledger_unknown_event: %', e->>'event' using errcode = '22023';
    end case;
  end loop;

  return jsonb_build_object(
    'events', n_events, 'requests_recreated', n_recreated, 'requests_reopened', n_reopened,
    'holds_restored', n_holds, 'holds_released', n_released, 'board_contributions_removed', n_removed,
    'open_now', (select count(*) from privacy_deletions where status in ('in_progress', 'failed')),
    'held_now', (select count(*) from privacy_deletions where status = 'held'));
end;
$$;
revoke all on function privacy_ledger_replay(jsonb) from public, anon, authenticated;
grant execute on function privacy_ledger_replay(jsonb) to service_role;

/*
 * After the replay and the server's follow-up: is anything the ledger says is
 * gone still here? One row per problem; none means the restore is safe to
 * reopen. Ids only.
 */
create or replace function privacy_restore_verify(p_events jsonb)
returns table (problem text, ref uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  -- Every request in the ledger is in the database.
  select 'request_missing', (x->'payload'->>'deletion_id')::uuid
    from jsonb_array_elements(p_events) x
   where x->>'event' = 'closure_requested'
     and not exists (select 1 from privacy_deletions d where d.id::text = x->'payload'->>'deletion_id'
                        or (d.subject_type = x->'payload'->>'subject_type' and d.subject_id::text = x->'payload'->>'subject_id'))
  union all
  -- Nothing not held is left of a family or child the ledger closed.
  select 'subject_still_present', d.id from privacy_deletions d
   where d.status <> 'held'
     and private.subject_present(d.subject_type, d.subject_id, d.parent_id, d.child_ids)
  union all
  select 'deletion_not_finished', d.id from privacy_deletions d where d.status in ('in_progress', 'failed')
  union all
  -- A held family's records are kept, and nothing of theirs is usable or public.
  select 'held_child_usable', c.id from privacy_deletions d join child_profiles c on c.id = any(d.child_ids)
   where d.status = 'held' and c.closing_at is null
  union all
  select 'held_content_visible', b.id from privacy_deletions d join board_contributions b on b.child_id = any(d.child_ids)
   where d.status = 'held' and b.status in ('published', 'pending_moderation')
  union all
  -- Every active hold in the ledger is in force.
  select 'hold_missing', (x->'payload'->>'hold_id')::uuid
    from jsonb_array_elements(p_events) x
   where x->>'event' = 'hold_placed'
     and not exists (select 1 from jsonb_array_elements(p_events) y
                      where y->>'event' = 'hold_released' and y->'payload'->>'hold_id' = x->'payload'->>'hold_id')
     and not exists (select 1 from retention_holds h where h.id::text = x->'payload'->>'hold_id' and h.released_at is null)
  union all
  -- Removed contributions stay removed.
  select 'board_contribution_returned', b.id
    from jsonb_array_elements(p_events) x join board_contributions b on b.id::text = x->'payload'->>'contribution_id'
   where x->>'event' = 'board_removed'
  union all
  -- Stored files of a deleted child are gone from Storage's own records.
  select 'files_remain', d.id from privacy_deletions d
   where d.status = 'completed'
     and exists (select 1 from storage.objects o
                  where o.bucket_id = 'mission-evidence' and split_part(o.name, '/', 1) = any(select c::text from unnest(d.child_ids) c));
end;
$$;
revoke all on function privacy_restore_verify(jsonb) from public, anon, authenticated;
grant execute on function privacy_restore_verify(jsonb) to service_role;

/*
 * The old in-database safeguard, kept for a restore of a backup newer than
 * every deletion (where the ledger in the database is complete). It no longer
 * deletes anything itself, which could leave an auth user without a profile:
 * it reopens each completed request whose family has come back, and the
 * server's follow-up deletes files, data and the auth user together.
 */
create or replace function privacy_reapply_deletions()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d record;
  n int := 0;
begin
  for d in select * from privacy_deletions where status = 'completed' loop
    if private.subject_present(d.subject_type, d.subject_id, d.parent_id, d.child_ids) then
      begin
        update privacy_deletions
           set status = 'in_progress', completed_at = null, step = 'replayed', last_error = null
         where id = d.id;
        perform private.closure_take_effect(d.id);
        n := n + 1;
      exception when unique_violation then null;
      end;
    end if;
  end loop;
  return jsonb_build_object('requests_reopened', n);
end;
$$;
revoke all on function privacy_reapply_deletions() from public, anon, authenticated;
grant execute on function privacy_reapply_deletions() to service_role;

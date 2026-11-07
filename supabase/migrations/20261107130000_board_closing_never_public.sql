/*
 * A CLOSING FAMILY'S MISSION BOARD CONTRIBUTIONS ARE NEVER PUBLIC AGAIN
 * (S2, D-156).
 *
 * Found in the pre-deployment audit of 7 Nov 2026. When a closure is held, or
 * a contribution is itself held, privacy_begin_closure kept the contribution
 * (rightly) but moved a published one back to `pending_moderation`. The queue
 * and admin_board_moderate looked only at status, so a moderator could publish
 * it again, edit it or delete it despite the hold. Separately, the daily run
 * deleted a held family's rejected contributions after 30 days, because it
 * honoured only holds on the contribution itself.
 *
 * The rule, enforced in the database:
 *   A contribution of a child whose profile is closing (child_profiles
 *   .closing_at, D-154) is never published, never queued, never edited and
 *   never moderated. The closure owns it: it is deleted when the closure
 *   finishes, or kept unchanged while a hold applies.
 *
 *   - Closure withdraws the family's permission: a kept contribution goes to
 *     `pending_permission`, with its permission and anonymity check cleared. A
 *     parent can't permit it again (board_permit refuses closing children,
 *     D-154), so releasing a hold makes nothing public: it lets the deletion go on.
 *   - A trigger on board_contributions refuses inserting one for a closing
 *     child, putting one in the queue or on the Board, or changing its text,
 *     whatever function or role tries.
 *   - admin_board_queue leaves them out; admin_board_moderate refuses them.
 *   - The public read (private.board_for_child) leaves them out as well.
 *   - The daily run no longer prunes a rejected contribution under a family or
 *     child hold, or one whose child is closing.
 *
 * Withdrawal, removal and ordinary moderation of everyone else are unchanged.
 * The steps that make a closure take effect move into
 * private.closure_take_effect, unchanged apart from the Board, so the restore
 * replay (D-157) can apply exactly the same steps.
 */

-- ------------------------------------------------- the closure's effects --
create or replace function private.closure_take_effect(p_deletion uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  d privacy_deletions%rowtype;
  v_status text;
begin
  select * into d from privacy_deletions where id = p_deletion for update;
  if not found then return 'not_found'; end if;
  if d.status = 'completed' then return 'completed'; end if;

  v_status := case when private.closure_held(d.parent_id, d.child_ids) then 'held' else 'in_progress' end;

  -- No further use: codes and sessions end now.
  update child_sessions set revoked_at = now() where child_id = any(d.child_ids) and revoked_at is null;
  update child_access_credentials set revoked_at = now() where child_id = any(d.child_ids) and revoked_at is null;

  -- Nothing stays on the Board. Without a hold the contributions go now;
  -- whatever a hold keeps loses its permission: off the Board and out of the
  -- moderation queue, for good (D-156).
  if v_status <> 'held' then
    delete from board_contributions b
     where b.child_id = any(d.child_ids) and not private.hold_active('board_contribution', b.id);
  end if;
  update board_contributions b
     set status = 'pending_permission', permitted_at = null,
         anonymity_checked_at = null, anonymity_checked_by = null
   where b.child_id = any(d.child_ids) and b.status in ('published', 'pending_moderation');

  perform private.enqueue_child_files(d.id, d.child_ids);

  update privacy_deletions set status = v_status where id = d.id and status <> 'completed';
  return v_status;
end;
$$;
revoke all on function private.closure_take_effect(uuid) from public, anon, authenticated;

/*
 * As before (D-148): validate, record the request (idempotent), then take
 * effect. Only the Board step changed, inside closure_take_effect.
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

  select d.id into v_id from privacy_deletions d
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

  v_status := private.closure_take_effect(v_id);
  return query select 'begun'::text, v_id, v_status;
end;
$$;
revoke all on function privacy_begin_closure(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function privacy_begin_closure(text, uuid, uuid, text) to service_role;

-- ------------------------------------------- what is already closing --
-- Any contribution of a child already closing leaves the queue and the Board.
update board_contributions b
   set status = 'pending_permission', permitted_at = null,
       anonymity_checked_at = null, anonymity_checked_by = null
  from child_profiles c
 where c.id = b.child_id and c.closing_at is not null
   and b.status in ('published', 'pending_moderation');

-- ------------------------------------------------------- the table rule --
create or replace function private.board_refuse_closing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from child_profiles c where c.id = new.child_id and c.closing_at is not null) then
    if tg_op = 'INSERT'
       or new.status in ('published', 'pending_moderation')
       or new.text is distinct from old.text
       or new.approach is distinct from old.approach
       or new.curated is distinct from old.curated then
      raise exception 'board_subject_closing' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.board_refuse_closing() from public, anon, authenticated;

drop trigger if exists board_contributions_refuse_closing on board_contributions;
create trigger board_contributions_refuse_closing
  before insert or update on board_contributions
  for each row execute function private.board_refuse_closing();

-- ------------------------------------------------------- the functions --
-- Each is its current definition with the closing check added; CREATE OR
-- REPLACE keeps its grants.

CREATE OR REPLACE FUNCTION public.admin_board_queue()
 RETURNS TABLE(id uuid, mission_title text, lab wla_lab, text text, status text, curated boolean, approach text, created_at timestamp with time zone, moderated_at timestamp with time zone, flags text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return query
  select b.id, m.title, m.lab, b.text, b.status, b.curated, b.approach, b.created_at, b.moderated_at,
         private.board_flags(b.text)
  from board_contributions b join missions m on m.id = b.mission_id
  where b.status in ('pending_moderation', 'published')
    -- Never a closing family's (D-156): the closure owns those records.
    and not exists (select 1 from child_profiles c where c.id = b.child_id and c.closing_at is not null)
  order by (b.status = 'pending_moderation') desc, b.created_at;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_board_moderate(p_id uuid, p_action text, p_text text, p_curated boolean, p_approach text, p_anonymity_confirmed boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  -- A closing family's contribution belongs to the closure, not to moderation:
  -- not published, edited, rejected or removed from here, held or not (D-156).
  if exists (select 1 from board_contributions b join child_profiles c on c.id = b.child_id
              where b.id = p_id and c.closing_at is not null) then
    raise exception 'board_subject_closing' using errcode = '42501';
  end if;
  if p_action not in ('publish', 'reject', 'keep_private', 'unpublish', 'save', 'remove') then
    raise exception 'bad_action' using errcode = '22023';
  end if;
  -- Only what a parent has permitted can be moderated at all.
  if not exists (select 1 from board_contributions where id = p_id and status in ('pending_moderation', 'published')) then
    raise exception 'not_moderatable' using errcode = '22023';
  end if;

  if p_action = 'remove' then
    delete from board_contributions where id = p_id;
    return;
  end if;

  -- Publishing, or changing what is already published, needs the moderator's
  -- confirmation that the copy identifies nobody.
  if (p_action = 'publish'
      or (p_action = 'save' and exists (select 1 from board_contributions where id = p_id and status = 'published')))
     and not coalesce(p_anonymity_confirmed, false) then
    raise exception 'anonymity_not_confirmed' using errcode = '22023';
  end if;

  update board_contributions set
    text = coalesce(nullif(trim(p_text), ''), text),
    curated = coalesce(p_curated, curated),
    approach = nullif(trim(coalesce(p_approach, approach, '')), ''),
    status = case p_action when 'publish' then 'published'
                           when 'reject' then 'rejected'
                           when 'keep_private' then 'rejected'
                           when 'unpublish' then 'pending_moderation' else status end,
    rejected_reason = case p_action when 'reject' then 'not_suitable'
                                    when 'keep_private' then 'cannot_anonymise'
                                    when 'publish' then null else rejected_reason end,
    anonymity_checked_at = case when p_action in ('publish', 'save') and coalesce(p_anonymity_confirmed, false)
                                then now() when p_action = 'unpublish' then null else anonymity_checked_at end,
    anonymity_checked_by = case when p_action in ('publish', 'save') and coalesce(p_anonymity_confirmed, false)
                                then auth.uid() when p_action = 'unpublish' then null else anonymity_checked_by end,
    moderated_at = case when p_action in ('publish', 'reject', 'keep_private') then now() else moderated_at end
  where id = p_id;
end;
$function$;

CREATE OR REPLACE FUNCTION private.board_for_child(p_child uuid)
 RETURNS TABLE(mission_slug text, mission_title text, lab wla_lab, text text, approach text, curated boolean, published_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select m.slug, m.title, m.lab, b.text, b.approach, b.curated, b.moderated_at
  from board_contributions b
  join missions m on m.id = b.mission_id
  where b.status = 'published'
    and not exists (select 1 from child_profiles c where c.id = b.child_id and c.closing_at is not null)
    and exists (select 1 from mission_progress p
                where p.child_id = p_child and p.mission_id = b.mission_id and p.status = 'complete')
  order by b.curated desc, b.moderated_at desc;
$function$;

CREATE OR REPLACE FUNCTION public.privacy_retention_run()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- A hold on the family or the child protects their rejected contributions
    -- too, and a closing child's records are the closure's to delete (D-156).
    delete from board_contributions b
     using child_profiles c
     where c.id = b.child_id
       and b.status = 'rejected'
       and coalesce(b.moderated_at, b.created_at) < now() - interval '30 days'
       and not private.hold_active('board_contribution', b.id)
       and not private.closure_held(c.parent_id, array[b.child_id])
       and c.closing_at is null;
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
$function$;


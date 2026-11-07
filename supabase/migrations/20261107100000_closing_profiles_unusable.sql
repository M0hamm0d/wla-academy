/*
 * A PROFILE BEING DELETED IS NO LONGER USABLE (D-148, amended 2026-11-07).
 *
 * Closing an account or removing a child records the request and then deletes
 * in steps. If a step fails, or a retention hold stops the deletion, the child
 * profile row remains until the retry or the release. Until now it also
 * remained fully usable from the parent's session: listed, selectable, its
 * saved work downloadable and a new access code issuable, while the parent had
 * been told it could no longer be used.
 *
 * From the moment a closure covers a child, `closing_at` is set and every
 * parent-facing path refuses that profile: the RLS policy on child_profiles,
 * owns_child / owns_progress (which the other tables' policies use), and the
 * security-definer functions that check the family themselves. The service
 * role (the closure itself, the admin views) still sees it, so the deletion
 * can finish and WLA can still account for it. Nothing un-sets closing_at: a
 * closure is never cancelled, only completed.
 */

alter table child_profiles add column if not exists closing_at timestamptz;

create or replace function private.mark_closing_children()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status <> 'completed' then
    update child_profiles set closing_at = now()
     where id = any(new.child_ids) and closing_at is null;
  end if;
  return null;
end;
$$;
revoke all on function private.mark_closing_children() from public, anon, authenticated;

drop trigger if exists privacy_deletions_mark_closing on privacy_deletions;
create trigger privacy_deletions_mark_closing
  after insert or update of child_ids, status on privacy_deletions
  for each row execute function private.mark_closing_children();

-- Any closure already open when this is applied.
update child_profiles c set closing_at = now()
  from privacy_deletions d
 where d.status <> 'completed' and c.id = any(d.child_ids) and c.closing_at is null;

drop policy if exists "parent manages own children" on child_profiles;
create policy "parent manages own children" on child_profiles
  for all
  using (parent_id = auth.uid() and closing_at is null)
  with check (parent_id = auth.uid() and closing_at is null);

-- The functions below are unchanged except for `closing_at is null` beside
-- the family check. CREATE OR REPLACE keeps their existing grants.

CREATE OR REPLACE FUNCTION public.owns_child(target_child uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    -- the parent path, unchanged
    exists (
      select 1 from child_profiles c
      where c.id = target_child and c.parent_id = auth.uid() and c.closing_at is null
    )
    -- the child-session path: set only by a verified child session, and only
    -- for the duration of one transaction.
    or coalesce(current_setting('app.child_actor', true), '') = target_child::text;
$function$;

CREATE OR REPLACE FUNCTION public.owns_progress(target_progress uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from mission_progress p
    join child_profiles c on c.id = p.child_id
    where p.id = target_progress
      and (
        (c.parent_id = auth.uid() and c.closing_at is null)
        or coalesce(current_setting('app.child_actor', true), '') = c.id::text
      )
  );
$function$;

CREATE OR REPLACE FUNCTION public.issue_child_access_code(p_child_id uuid)
 RETURNS TABLE(credential_id uuid, code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_code text;
  v_owner uuid;
  v_id uuid;
begin
  select parent_id into v_owner from child_profiles where id = p_child_id and closing_at is null;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'not_your_child' using errcode = '42501';
  end if;

  -- Replacing invalidates the previous code and every session it opened.
  update child_access_credentials
     set revoked_at = now()
   where child_id = p_child_id and revoked_at is null;
  update child_sessions
     set revoked_at = now()
   where child_id = p_child_id and revoked_at is null;

  loop
    v_code := gen_child_code();
    exit when not exists (
      select 1 from child_access_credentials c
      where c.code_lookup = child_code_lookup(v_code) and c.revoked_at is null
    );
  end loop;

  insert into child_access_credentials (child_id, code_hash, code_lookup)
  values (p_child_id,
          crypt(normalize_child_code(v_code), gen_salt('bf', 10)),
          child_code_lookup(v_code))
  returning id into v_id;

  return query select v_id, v_code;
end;
$function$;

CREATE OR REPLACE FUNCTION public.store_child_code_copy(p_credential_id uuid, p_child_id uuid, p_parent_id uuid, p_ciphertext text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update child_access_credentials c
     set code_ciphertext = p_ciphertext
   where c.id = p_credential_id
     and c.child_id = p_child_id
     and c.revoked_at is null
     and c.code_ciphertext is null
     and exists (select 1 from child_profiles p where p.id = p_child_id and p.parent_id = p_parent_id and p.closing_at is null);
  return found;
end;
$function$;

CREATE OR REPLACE FUNCTION public.read_child_code_copy(p_child_id uuid, p_parent_id uuid)
 RETURNS TABLE(credential_id uuid, ciphertext text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return query
  update child_access_credentials c
     set code_last_viewed_at = now()
   where c.child_id = p_child_id
     and c.revoked_at is null
     and c.code_ciphertext is not null
     and (c.expires_at is null or c.expires_at > now())
     and exists (select 1 from child_profiles p where p.id = p_child_id and p.parent_id = p_parent_id and p.closing_at is null)
  returning c.id, c.code_ciphertext;
end;
$function$;

CREATE OR REPLACE FUNCTION public.board_offer(p_child_id uuid, p_evidence_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ev mission_evidence; v_id uuid;
begin
  if not exists (select 1 from child_profiles where id = p_child_id and parent_id = auth.uid() and closing_at is null) then
    raise exception 'not_your_child' using errcode = '42501';
  end if;
  v_ev := private.board_eligible(p_child_id, p_evidence_id);
  if v_ev.id is null then raise exception 'not_eligible' using errcode = '22023'; end if;
  -- A parent offering is the permission (D-73).
  insert into board_contributions (child_id, mission_id, evidence_id, text, status, permitted_at)
  values (p_child_id, v_ev.mission_id, v_ev.id, left(private.board_scrub(v_ev.description, p_child_id), 2000), 'pending_moderation', now())
  on conflict (evidence_id) do update
    set status = case when board_contributions.status = 'pending_permission' then 'pending_moderation' else board_contributions.status end,
        permitted_at = coalesce(board_contributions.permitted_at, now())
  returning id into v_id;
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.board_permit(p_id uuid, p_allow boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not exists (
    select 1 from board_contributions b join child_profiles c on c.id = b.child_id
    where b.id = p_id and c.parent_id = auth.uid() and c.closing_at is null
  ) then
    raise exception 'not_your_contribution' using errcode = '42501';
  end if;
  if p_allow then
    update board_contributions set status = 'pending_moderation', permitted_at = now()
    where id = p_id and status = 'pending_permission';
  else
    delete from board_contributions where id = p_id;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.board_published(p_child_id uuid)
 RETURNS TABLE(mission_slug text, mission_title text, lab wla_lab, text text, approach text, curated boolean, published_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not exists (select 1 from child_profiles where id = p_child_id and parent_id = auth.uid() and closing_at is null) then
    raise exception 'not_your_child' using errcode = '42501';
  end if;
  return query select * from private.board_for_child(p_child_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.board_family_contributions()
 RETURNS TABLE(id uuid, child_id uuid, child_name text, mission_title text, text text, status text, created_at timestamp with time zone, evidence_id uuid, rejected_reason text, delete_after timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select b.id, b.child_id, c.display_name, m.title, b.text, b.status, b.created_at, b.evidence_id,
         b.rejected_reason,
         case when b.status = 'rejected' then coalesce(b.moderated_at, b.created_at) + interval '30 days' end
    from board_contributions b
    join child_profiles c on c.id = b.child_id
    join missions m on m.id = b.mission_id
   where c.parent_id = auth.uid() and c.closing_at is null
   order by b.created_at desc;
$function$;

CREATE OR REPLACE FUNCTION public.redeem_mission_gift(p_claim_hash text, p_child_id uuid, p_parent_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_gift mission_gifts%rowtype;
  v_existing entitlement_status;
  v_inserted uuid;
begin
  select * into v_gift from mission_gifts
   where claim_hash = p_claim_hash
   for update;

  if not found then return 'invalid'; end if;
  if v_gift.status = 'redeemed' then return 'already_redeemed'; end if;
  if v_gift.status <> 'paid' or v_gift.claim_expires_at <= now() then return 'invalid'; end if;

  if not exists (
    select 1 from child_profiles where id = p_child_id and parent_id = p_parent_id and closing_at is null
  ) then
    return 'forbidden';
  end if;

  select status into v_existing from mission_entitlements
   where child_id = p_child_id and mission_id = v_gift.mission_id;
  if found then
    return case when v_existing = 'active' then 'already_owned' else 'unavailable' end;
  end if;

  insert into mission_entitlements (child_id, mission_id, source, status, stripe_payment_intent_id)
  values (p_child_id, v_gift.mission_id, 'gift', 'active', v_gift.stripe_payment_intent_id)
  on conflict (child_id, mission_id) do nothing
  returning id into v_inserted;

  if v_inserted is null then return 'already_owned'; end if;

  update mission_gifts
     set status = 'redeemed',
         redeemed_at = now(),
         redeemed_by = p_parent_id,
         redeemed_child_id = p_child_id,
         code_lookup = null,
         code_ciphertext = null
   where id = v_gift.id;

  return 'redeemed';
end;
$function$;

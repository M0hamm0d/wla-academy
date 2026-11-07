-- ============================================================================
-- MISSION BOARD ANONYMITY REVIEW (D-151). Client document of 6 Nov 2026, §4.
--
-- Unchanged: a parent permits, WLA moderates, nothing is visible until WLA
-- publishes it, withdrawal deletes at once. Added:
--
--   flags         the copy is checked for what could still identify a child:
--                 names (left-over or introduced), contact details, schools,
--                 locations, ages and birthdays. Images can't occur: only text
--                 is eligible (D-96). The flags guide the moderator; they
--                 prove nothing, and an unflagged copy is not "anonymous".
--   confirmation  publishing requires the moderator to confirm they checked
--                 each category. Enforced here, not by the page.
--   keep private  a contribution that can't be adequately anonymised is not
--                 published: it stays private to the family (status
--                 'rejected', reason 'cannot_anonymise').
--   removal       a published contribution can be removed on a valid request:
--                 the row is deleted, as a withdrawal is.
--   retention     a rejected or kept-private contribution is deleted 30 days
--                 after the decision unless held (privacy_retention_run).
-- ============================================================================

alter table board_contributions
  add column if not exists rejected_reason text
    check (rejected_reason is null or rejected_reason in ('cannot_anonymise', 'not_suitable')),
  add column if not exists anonymity_checked_at timestamptz,
  add column if not exists anonymity_checked_by uuid references profiles (id) on delete set null;

-- Published means a moderator confirmed the anonymity check.
update board_contributions set anonymity_checked_at = coalesce(moderated_at, now())
 where status = 'published' and anonymity_checked_at is null;
alter table board_contributions
  add constraint board_published_was_checked check (status <> 'published' or anonymity_checked_at is not null);

/*
 * What could still identify someone. Deliberately broad: a false flag costs
 * the moderator a second look; a missed one costs a child their privacy.
 */
create or replace function private.board_flags(p_text text)
returns text[]
language sql
immutable
set search_path = public
as $$
  select array_remove(array[
    case when p_text ~* '\[name\]|\mmy name|\mi am called|\mi''m called|\mcalled [A-Z]|\mmy (brother|sister|mum|mom|dad|friend|cousin|nan|gran|grandma|grandad) [A-Z][a-z]+' then 'names' end,
    case when p_text ~* '\[removed\]|@|\mphone|\mmobile|\memail|\minstagram|\mtiktok|\msnapchat|\myoutube|\mwhatsapp|\d{5,}' then 'contact' end,
    case when p_text ~* '\m(school|primary|secondary|academy|college|nursery|year ?[0-9]{1,2}|class [0-9]?[a-z0-9]|teacher|head ?teacher|mr|mrs|miss|ms)\M' then 'school' end,
    case when p_text ~* '\m(street|road|avenue|lane|crescent|terrace|close|drive|postcode|village|town|city|county|estate|i live|we live|lives in|next door|near my|neighbou?r)\M' then 'location' end,
    case when p_text ~* '\m(i am|i''m|aged?) [0-9]{1,2}\M|\mbirthday|\mborn in|\m[0-9]{1,2} years? old' then 'age' end,
    case when p_text ~ '(^|[^.!?]\s)[A-Z][a-z]{2,}\s[A-Z][a-z]{2,}' then 'possible_full_name' end
  ], null);
$$;
revoke all on function private.board_flags(text) from public, anon, authenticated;

drop function if exists admin_board_queue();
create function admin_board_queue()
returns table (
  id uuid, mission_title text, lab wla_lab, text text, status text, curated boolean,
  approach text, created_at timestamptz, moderated_at timestamptz, flags text[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return query
  select b.id, m.title, m.lab, b.text, b.status, b.curated, b.approach, b.created_at, b.moderated_at,
         private.board_flags(b.text)
  from board_contributions b join missions m on m.id = b.mission_id
  where b.status in ('pending_moderation', 'published')
  order by (b.status = 'pending_moderation') desc, b.created_at;
end;
$$;
revoke all on function admin_board_queue() from public, anon;
grant execute on function admin_board_queue() to authenticated;

drop function if exists admin_board_moderate(uuid, text, text, boolean, text);
create function admin_board_moderate(
  p_id uuid, p_action text, p_text text, p_curated boolean, p_approach text,
  p_anonymity_confirmed boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
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
$$;
revoke all on function admin_board_moderate(uuid, text, text, boolean, text, boolean) from public, anon;
grant execute on function admin_board_moderate(uuid, text, text, boolean, text, boolean) to authenticated;

-- The family sees why, and when it will be gone.
drop function if exists board_family_contributions();
create function board_family_contributions()
returns table (
  id uuid, child_id uuid, child_name text, mission_title text, text text, status text,
  created_at timestamptz, evidence_id uuid, rejected_reason text, delete_after timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.child_id, c.display_name, m.title, b.text, b.status, b.created_at, b.evidence_id,
         b.rejected_reason,
         case when b.status = 'rejected' then coalesce(b.moderated_at, b.created_at) + interval '30 days' end
    from board_contributions b
    join child_profiles c on c.id = b.child_id
    join missions m on m.id = b.mission_id
   where c.parent_id = auth.uid()
   order by b.created_at desc;
$$;
revoke all on function board_family_contributions() from public, anon;
grant execute on function board_family_contributions() to authenticated;

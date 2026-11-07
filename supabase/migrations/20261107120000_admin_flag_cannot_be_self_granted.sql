/*
 * THE ADMINISTRATOR FLAG CANNOT BE SELF-GRANTED (S1, D-155).
 *
 * Found in the pre-deployment audit of 7 Nov 2026: `anon` and `authenticated`
 * held a table-wide INSERT on profiles, which covers `is_admin`, and the only
 * guard (profiles_reject_is_admin_change) fires on UPDATE. A signed-in user
 * without a profile row could therefore insert one with is_admin = true and
 * pass every is_admin() check. A row goes missing, for instance, when a
 * deletion removes the profile but not the auth user.
 *
 * Nothing in the application inserts profiles from a client: onboarding is the
 * handle_new_user trigger (security definer), and administrators are made by
 * the server's service role or the database owner. So:
 *
 *   - anon may insert no profile at all;
 *   - authenticated may insert only id, email and name. The row's own RLS
 *     policy still limits it to their own id, and is_admin takes its default
 *     (false). Including is_admin in a client insert, even as false, is refused;
 *   - a BEFORE INSERT trigger refuses is_admin = true from either client role,
 *     so widening a grant later can't reopen this;
 *   - UPDATE is unchanged: only email and name are granted, and the existing
 *     trigger already refuses a client changing the flag.
 *
 * No data changes. Existing administrators keep their flag.
 */

revoke insert on table profiles from anon, authenticated;
grant insert (id, email, name) on table profiles to authenticated;
-- Never granted today; revoked explicitly so the intent is on record.
revoke update (is_admin) on table profiles from anon, authenticated;

create or replace function private.reject_client_admin_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_admin and current_user in ('authenticated', 'anon') then
    raise exception 'is_admin is not self-service' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.reject_client_admin_insert() from public, anon, authenticated;

drop trigger if exists profiles_reject_client_admin_insert on profiles;
create trigger profiles_reject_client_admin_insert
  before insert on profiles
  for each row execute function private.reject_client_admin_insert();

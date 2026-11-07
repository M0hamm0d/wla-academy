-- ============================================================================
-- PURCHASER-HELD GIFT CODES (D-149; supersedes the recipient-email delivery of
-- D-140, D-142 and D-145). Client document "Privacy Policy Updates", 6 Nov 2026:
--
--   "The purchaser receives the gift code and shares it directly with the
--    recipient. WLA does not require the recipient's email address."
--
-- So WLA no longer holds a recipient address at all. The verified webhook makes
-- the gift redeemable and gives it a code; the purchaser sees the code in their
-- account (and in their confirmation email) and passes it on however they like.
-- Whoever holds the code redeems it: the code proves the gift, an account and a
-- child of that account receive it, and redeem_mission_gift is unchanged in
-- shape. There is still only one way to redeem.
--
-- A code is:
--   12 characters from a 30-character alphabet (about 59 bits), from
--     gen_random_bytes with rejection sampling, shown as XXXX-XXXX-XXXX;
--   stored for checking only as an HMAC under a pepper no API role can read
--     (`code_lookup`); the purchaser's viewable copy is AES-256-GCM made on the
--     application server (`code_ciphertext`), never plaintext in the database;
--   valid until redeemed: no automatic expiry (approved retention rule);
--   cleared, with its copy, when the gift is redeemed;
--   replaceable by the purchaser while unredeemed, which also ends any open
--     claim made with the old one.
--
-- Guessing is limited per client (10 failures in 15 minutes) and across all
-- clients (a circuit breaker), recorded in gift_code_attempts, which is a
-- routine security log (90 days, D-148). Every failure is one word, 'invalid'.
-- ============================================================================

set search_path = public, extensions;

-- ------------------------------------------------- the email-based paths go --
drop function if exists confirm_gift_email(text, text, text);
drop function if exists issue_gift_code(text);
drop function if exists withdraw_gift_code(uuid, text);
drop function if exists confirm_gift_code(text, text, text);
drop function if exists private.gift_code_hash(uuid, text);
drop function if exists admin_gifts(int);

alter table mission_gifts
  drop constraint if exists mission_gifts_paid_has_token,
  drop constraint if exists mission_gifts_pending_has_no_token,
  drop constraint if exists mission_gifts_pending_has_no_code,
  drop constraint if exists mission_gifts_code_expires;
drop index if exists mission_gifts_recipient_paid_idx;

-- The recipient's address, the emailed link and the emailed one-time code are
-- no longer collected or needed, so they are not kept.
alter table mission_gifts
  drop column if exists recipient_email,
  drop column if exists redeem_token_hash,
  drop column if exists link_sent_at,
  drop column if exists confirm_failures,
  drop column if exists code_hash,
  drop column if exists code_expires_at,
  drop column if exists code_failures,
  drop column if exists code_sent_at;

alter table mission_gifts
  add column code_lookup     text unique,
  add column code_ciphertext text,
  add column code_issued_at  timestamptz;

-- ------------------------------------------------------------ generation --
create or replace function gen_gift_code()
returns text
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  -- The child-code alphabet: no I, L, O, U, 0 or 1, so it survives being read
  -- aloud, written down or retyped from a message.
  alphabet constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  v_out text := '';
  v_bytes bytea;
  v_byte int;
  i int;
begin
  while length(v_out) < 12 loop
    v_bytes := gen_random_bytes(32);
    for i in 0..31 loop
      v_byte := get_byte(v_bytes, i);
      -- 240 is the largest multiple of 30 under 256 (no modulo bias).
      if v_byte < 240 and length(v_out) < 12 then
        v_out := v_out || substr(alphabet, 1 + (v_byte % 30), 1);
      end if;
    end loop;
  end loop;
  return substr(v_out, 1, 4) || '-' || substr(v_out, 5, 4) || '-' || substr(v_out, 9, 4);
end;
$$;
revoke all on function gen_gift_code() from public, anon, authenticated;

-- The pepper already exists (D-145); kept, so nothing else changes.
insert into app_secrets (name, value)
values ('gift_code_pepper', encode(gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

create or replace function private.gift_code_lookup(p_code text)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare v_pepper text;
begin
  select value into v_pepper from app_secrets where name = 'gift_code_pepper';
  return encode(hmac('gift:' || normalize_child_code(p_code), v_pepper, 'sha256'), 'hex');
end;
$$;
revoke all on function private.gift_code_lookup(text) from public, anon, authenticated;

-- ------------------------------------------------------- existing records --
-- A gift already paid had its code or link emailed to a recipient address that
-- is no longer held. It gets a new code nobody knows yet, so its purchaser can
-- choose "Get a new code" in their account and pass that on. Nothing paid for
-- is lost. A redeemed gift needs no code.
update mission_gifts
   set code_lookup = private.gift_code_lookup(gen_gift_code()),
       code_issued_at = now()
 where status = 'paid';

alter table mission_gifts
  add constraint mission_gifts_paid_has_code check (
    status <> 'paid' or (code_lookup is not null and paid_at is not null)
  ),
  add constraint mission_gifts_pending_has_no_code check (
    status <> 'pending' or (code_lookup is null and code_ciphertext is null)
  ),
  add constraint mission_gifts_redeemed_has_no_code check (
    status <> 'redeemed' or (code_lookup is null and code_ciphertext is null)
  ),
  add constraint mission_gifts_copy_needs_code check (
    code_ciphertext is null or code_lookup is not null
  );

-- ---------------------------------------------------- the attempt ledger --
create table if not exists gift_code_attempts (
  id          bigint generated always as identity primary key,
  -- An HMAC of the client's network address under the pepper: enough to count
  -- one client's failures, not readable as an address.
  client_key  text not null,
  succeeded   boolean not null,
  occurred_at timestamptz not null default now()
);
create index if not exists gift_code_attempts_client_idx on gift_code_attempts (client_key, occurred_at desc);
create index if not exists gift_code_attempts_time_idx on gift_code_attempts (occurred_at desc);
alter table gift_code_attempts enable row level security;
revoke all on table gift_code_attempts from public, anon, authenticated;

-- ------------------------------------------------------------ activation --
/*
 * The verified webhook confirmed payment. Make the gift redeemable and give it
 * a code, returned once so the server can encrypt the purchaser's copy and
 * email it to them. Conditional on `pending` under a row lock, so a repeated or
 * concurrent delivery activates nothing and generates nothing: 'already'.
 * Service role only.
 */
create or replace function activate_paid_gift(p_session_id text, p_payment_intent text)
returns table (outcome text, gift_id uuid, code text)
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  v_gift mission_gifts%rowtype;
  v_code text;
begin
  select * into v_gift from mission_gifts g where g.stripe_session_id = p_session_id for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if v_gift.status <> 'pending' then
    return query select 'already'::text, v_gift.id, null::text;
    return;
  end if;

  v_code := gen_gift_code();
  update mission_gifts g
     set status = 'paid',
         paid_at = now(),
         stripe_payment_intent_id = p_payment_intent,
         code_lookup = private.gift_code_lookup(v_code),
         code_issued_at = now()
   where g.id = v_gift.id;
  return query select 'activated'::text, v_gift.id, v_code;
end;
$$;
revoke all on function activate_paid_gift(text, text) from public, anon, authenticated;
grant execute on function activate_paid_gift(text, text) to service_role;

/*
 * Store the purchaser's encrypted copy, only for the gift's current code: a
 * copy can't be attached to a code that isn't the live one. Service role only.
 */
create or replace function store_gift_code_copy(p_gift_id uuid, p_code text, p_ciphertext text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update mission_gifts g
     set code_ciphertext = p_ciphertext
   where g.id = p_gift_id and g.status = 'paid'
     and g.code_lookup = private.gift_code_lookup(p_code);
  return found;
end;
$$;
revoke all on function store_gift_code_copy(uuid, text, text) from public, anon, authenticated;
grant execute on function store_gift_code_copy(uuid, text, text) to service_role;

/*
 * The purchaser replaces the code of a gift not yet redeemed: lost, or shared
 * with the wrong person. The old code stops working at once, and so does any
 * claim made with it. The purchaser is re-asserted here. Service role only,
 * called after requireParent.
 */
create or replace function reissue_gift_code(p_gift_id uuid, p_purchaser_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code text;
begin
  perform 1 from mission_gifts g
   where g.id = p_gift_id and g.purchaser_id = p_purchaser_id and g.status = 'paid'
   for update;
  if not found then return null; end if;

  v_code := gen_gift_code();
  update mission_gifts g
     set code_lookup = private.gift_code_lookup(v_code),
         code_ciphertext = null,
         code_issued_at = now(),
         claim_hash = null,
         claim_expires_at = null
   where g.id = p_gift_id;
  return v_code;
end;
$$;
revoke all on function reissue_gift_code(uuid, uuid) from public, anon, authenticated;
grant execute on function reissue_gift_code(uuid, uuid) to service_role;

/*
 * The purchaser's own gifts, for their account. Never the redeeming family:
 * only that, and when, it was redeemed. The encrypted copy is opened on the
 * server, never sent as is. Service role only, called after requireParent.
 */
create or replace function purchaser_gifts(p_purchaser_id uuid)
returns table (
  id uuid, mission_title text, mission_slug text, status gift_status,
  created_at timestamptz, paid_at timestamptz, redeemed_at timestamptz,
  code_issued_at timestamptz, code_ciphertext text
)
language sql
stable
security definer
set search_path = public
as $$
  select g.id, m.title, m.slug, g.status, g.created_at, g.paid_at, g.redeemed_at,
         g.code_issued_at, g.code_ciphertext
    from mission_gifts g join missions m on m.id = g.mission_id
   where g.purchaser_id = p_purchaser_id
     and (g.status <> 'pending' or g.created_at > now() - interval '24 hours')
   order by g.created_at desc
   limit 50;
$$;
revoke all on function purchaser_gifts(uuid) from public, anon, authenticated;
grant execute on function purchaser_gifts(uuid) to service_role;

-- ------------------------------------------------------------ the code form --
/*
 * Answer "Enter your gift code". 'matched' records a claim (the same httpOnly
 * claim cookie as before, D-142); anything else is 'invalid' or 'rate_limited'.
 * Returns rather than raises, so that counting a failed attempt commits.
 * The row lock queues concurrent attempts on one gift. The code stays valid
 * until redemption, so a recipient whose claim expires can enter it again.
 * Service role only.
 */
create or replace function confirm_gift_code(p_code text, p_client text, p_claim_hash text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pepper text;
  v_client text;
  v_recent int;
  v_global int;
  v_gift   mission_gifts%rowtype;
begin
  select value into v_pepper from app_secrets where name = 'gift_code_pepper';
  v_client := encode(hmac('client:' || coalesce(p_client, ''), v_pepper, 'sha256'), 'hex');

  select count(*) into v_recent from gift_code_attempts
   where client_key = v_client and not succeeded and occurred_at > now() - interval '15 minutes';
  select count(*) into v_global from gift_code_attempts
   where not succeeded and occurred_at > now() - interval '5 minutes';
  if v_recent >= 10 or v_global >= 500 then
    insert into gift_code_attempts (client_key, succeeded) values (v_client, false);
    return 'rate_limited';
  end if;

  if length(normalize_child_code(p_code)) <> 12 then
    insert into gift_code_attempts (client_key, succeeded) values (v_client, false);
    return 'invalid';
  end if;

  select * into v_gift from mission_gifts g
   where g.code_lookup = private.gift_code_lookup(p_code)
   for update;
  if not found or v_gift.status <> 'paid' then
    insert into gift_code_attempts (client_key, succeeded) values (v_client, false);
    return 'invalid';
  end if;

  update mission_gifts g
     set claim_hash = p_claim_hash,
         claim_expires_at = now() + interval '24 hours'
   where g.id = v_gift.id;
  insert into gift_code_attempts (client_key, succeeded) values (v_client, true);
  return 'matched';
end;
$$;
revoke all on function confirm_gift_code(text, text, text) from public, anon, authenticated;
grant execute on function confirm_gift_code(text, text, text) to service_role;

-- ------------------------------------------------------------- redemption --
-- As D-145, and redeeming clears the code and its copy: no longer needed.
create or replace function redeem_mission_gift(
  p_claim_hash text,
  p_child_id   uuid,
  p_parent_id  uuid
) returns text
language plpgsql
security definer
set search_path = public
as $$
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
    select 1 from child_profiles where id = p_child_id and parent_id = p_parent_id
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
$$;
revoke all on function redeem_mission_gift(text, uuid, uuid) from public, anon, authenticated;
grant execute on function redeem_mission_gift(text, uuid, uuid) to service_role;

-- --------------------------------------------------------------- admin view --
-- Read only. Never a code, its copy, a claim or a Stripe id; and no recipient
-- address exists to show.
create or replace function admin_gifts(p_limit int default 100)
returns table (
  id uuid, created_at timestamptz, mission_title text,
  purchaser_email text,
  amount_minor int, currency text, status gift_status,
  paid_at timestamptz, redeemed_at timestamptz,
  redeemed_by_email text, redeemed_child_name text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;

  return query
  select g.id, g.created_at, m.title, buyer.email,
         g.amount_minor, g.currency, g.status, g.paid_at, g.redeemed_at,
         redeemer.email, c.display_name
  from mission_gifts g
  join missions m on m.id = g.mission_id
  left join profiles buyer on buyer.id = g.purchaser_id
  left join profiles redeemer on redeemer.id = g.redeemed_by
  left join child_profiles c on c.id = g.redeemed_child_id
  order by g.created_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 200));
end;
$$;
revoke all on function admin_gifts(int) from public, anon;
grant execute on function admin_gifts(int) to authenticated;

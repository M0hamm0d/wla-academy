-- Durable checkout attempts. Existing purchase records are retained and marked
-- open; new attempts reserve the logical purchase in PostgreSQL before Stripe.
create type checkout_attempt_status as enum ('initializing', 'open', 'paid', 'expired', 'failed');

alter table checkout_intents
  alter column stripe_session_id drop not null,
  add column attempt_key uuid,
  add column checkout_status checkout_attempt_status not null default 'open',
  add column mission_title text,
  add column mission_description text,
  add column mission_slug text,
  add column customer_email text,
  add column site_origin text;
alter table checkout_intents add constraint checkout_intents_attempt_key_key unique (attempt_key);
alter table checkout_intents alter column attempt_key set default gen_random_uuid();
create unique index checkout_intents_one_active_attempt
  on checkout_intents (child_id, mission_id)
  where attempt_key is not null and checkout_status in ('initializing', 'open');
create index checkout_intents_reconcile_idx on checkout_intents (created_at)
  where checkout_status in ('initializing', 'open');

alter table mission_gifts
  alter column stripe_session_id drop not null,
  add column attempt_key uuid,
  add column checkout_status checkout_attempt_status not null default 'open',
  add column mission_title text,
  add column mission_description text,
  add column mission_slug text,
  add column customer_email text,
  add column site_origin text;
alter table mission_gifts add column email_delivery_locked_until timestamptz;
alter table mission_gifts add constraint mission_gifts_attempt_key_key unique (attempt_key);
alter table mission_gifts alter column attempt_key set default gen_random_uuid();
alter table mission_gifts drop constraint if exists mission_gifts_stripe_session_id_key;
create unique index mission_gifts_session_unique on mission_gifts (stripe_session_id) where stripe_session_id is not null;
create unique index mission_gifts_one_active_attempt
  on mission_gifts (purchaser_id, mission_id, recipient_email)
  where attempt_key is not null and checkout_status in ('initializing', 'open');
create index mission_gifts_reconcile_idx on mission_gifts (created_at)
  where checkout_status in ('initializing', 'open');

-- All tables remain service-role-only for writes. Existing parent read policies
-- remain unchanged. Session IDs can be null only while Stripe creation is pending.
alter table checkout_intents add constraint checkout_intents_session_state_check
  check (checkout_status in ('initializing', 'failed') or stripe_session_id is not null);
alter table mission_gifts add constraint mission_gifts_session_state_check
  check (checkout_status in ('initializing', 'failed') or stripe_session_id is not null);

-- Shared request limits for serverless instances; only keyed digests are stored.
create table gift_request_limits (
  bucket_key text primary key,
  request_count integer not null check (request_count > 0),
  window_started_at timestamptz not null
);
create index gift_request_limits_window_idx on gift_request_limits (window_started_at);
alter table gift_request_limits enable row level security;
revoke all on table gift_request_limits from public, anon, authenticated;

create or replace function consume_gift_request_limit(p_ip text, p_email text, p_send boolean)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  v_ip_count integer;
  v_email_count integer := 0;
  v_now timestamptz := clock_timestamp();
  v_ip_key text := encode(extensions.digest(convert_to('gift-ip:' || coalesce(nullif(p_ip, ''), 'unknown'), 'UTF8'), 'sha256'), 'hex');
  v_email_key text := encode(extensions.digest(convert_to('gift-email:' || lower(btrim(coalesce(p_email, ''))), 'UTF8'), 'sha256'), 'hex');
begin
  delete from gift_request_limits where window_started_at < v_now - interval '1 day';
  insert into gift_request_limits(bucket_key, request_count, window_started_at)
  values (v_ip_key, 1, v_now)
  on conflict (bucket_key) do update set
    request_count = case when gift_request_limits.window_started_at < v_now - interval '10 minutes' then 1 else gift_request_limits.request_count + 1 end,
    window_started_at = case when gift_request_limits.window_started_at < v_now - interval '10 minutes' then v_now else gift_request_limits.window_started_at end
  returning request_count into v_ip_count;

  if p_send then
    insert into gift_request_limits(bucket_key, request_count, window_started_at)
    values (v_email_key, 1, v_now)
    on conflict (bucket_key) do update set
      request_count = case when gift_request_limits.window_started_at < v_now - interval '10 minutes' then 1 else gift_request_limits.request_count + 1 end,
      window_started_at = case when gift_request_limits.window_started_at < v_now - interval '10 minutes' then v_now else gift_request_limits.window_started_at end
    returning request_count into v_email_count;
  end if;

  return v_ip_count <= 20 and (not p_send or v_email_count <= 3);
end;
$$;
revoke all on function consume_gift_request_limit(text, text, boolean) from public, anon, authenticated;
grant execute on function consume_gift_request_limit(text, text, boolean) to service_role;

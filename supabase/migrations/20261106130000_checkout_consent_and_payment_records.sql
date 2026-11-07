-- ============================================================================
-- CHECKOUT CONSENT AND PAYMENT RECORDS (D-152, D-148).
--
-- 1. Immediate digital supply (client document of 6 Nov 2026, §8). Before a
--    paid mission or gift goes to Stripe, the customer gives express consent to
--    supply starting at once and acknowledges that they then lose the right to
--    cancel. Both are recorded, with the wording they agreed to, on the record
--    that the webhook later fulfils; and when the confirmation (the durable
--    medium) was sent.
--
-- 2. A payment survives account closure as a financial record (D-148). Until
--    now "paid" was inferred from an entitlement, which a closure deletes, and
--    the intent itself cascaded away with the family. Now the webhook stamps
--    `paid_at` and the payment intent on the intent, and closure keeps a paid
--    intent with its family links removed. An unpaid intent is not a financial
--    record and goes with the family.
-- ============================================================================

-- ------------------------------------------------------------ the intents --
alter table checkout_intents
  add column if not exists paid_at                   timestamptz,
  add column if not exists stripe_payment_intent_id  text,
  add column if not exists early_supply_consent_at   timestamptz,
  add column if not exists cancellation_ack_at       timestamptz,
  add column if not exists consent_wording           text,
  add column if not exists confirmation_sent_at      timestamptz;

-- Paid before this migration: the entitlement the webhook created says so.
update checkout_intents ci
   set paid_at = e.granted_at,
       stripe_payment_intent_id = e.stripe_payment_intent_id
  from mission_entitlements e
 where ci.paid_at is null
   and e.child_id = ci.child_id and e.mission_id = ci.mission_id
   and e.source = 'purchase' and e.stripe_payment_intent_id is not null;

-- The family links can now be removed from a retained financial record.
alter table checkout_intents
  alter column parent_id drop not null,
  alter column child_id drop not null;
alter table checkout_intents drop constraint if exists checkout_intents_parent_id_fkey;
alter table checkout_intents drop constraint if exists checkout_intents_child_id_fkey;
alter table checkout_intents
  add constraint checkout_intents_parent_id_fkey foreign key (parent_id) references profiles (id) on delete set null,
  add constraint checkout_intents_child_id_fkey  foreign key (child_id)  references child_profiles (id) on delete set null;

-- Both or neither, always.
alter table checkout_intents
  add constraint checkout_intents_consent_pair check ((early_supply_consent_at is null) = (cancellation_ack_at is null));

/*
 * Every intent or gift made from now on carries both, with the wording. A
 * trigger on insert rather than a NOT VALID check: a check is re-tested when
 * the webhook stamps an older row as paid, and a payment started just before
 * this migration must still be honoured.
 */
create or replace function private.require_checkout_consent()
returns trigger
language plpgsql
as $$
begin
  if new.early_supply_consent_at is null or new.cancellation_ack_at is null
     or coalesce(btrim(new.consent_wording), '') = '' then
    raise exception 'checkout_consent_missing' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.require_checkout_consent() from public, anon, authenticated;

drop trigger if exists checkout_intents_require_consent on checkout_intents;
create trigger checkout_intents_require_consent
  before insert on checkout_intents
  for each row execute function private.require_checkout_consent();

-- ---------------------------------------------------------------- the gifts --
alter table mission_gifts
  add column if not exists early_supply_consent_at timestamptz,
  add column if not exists cancellation_ack_at     timestamptz,
  add column if not exists consent_wording         text,
  add column if not exists confirmation_sent_at    timestamptz;

alter table mission_gifts
  add constraint mission_gifts_consent_pair check ((early_supply_consent_at is null) = (cancellation_ack_at is null));

drop trigger if exists mission_gifts_require_consent on mission_gifts;
create trigger mission_gifts_require_consent
  before insert on mission_gifts
  for each row execute function private.require_checkout_consent();

-- ------------------------------------------------------------ admin orders --
-- Paid is a recorded fact now, and an order from a closed account still lists
-- (as a financial record) without anyone's identity.
drop function if exists admin_orders(int);
create function admin_orders(p_limit int default 50)
returns table (
  id uuid, created_at timestamptz, parent_email text, child_name text,
  mission_title text, amount_minor int, currency text, state text,
  consent_recorded boolean, confirmation_sent boolean
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;

  return query
  select ci.id, ci.created_at, pr.email, c.display_name, m.title,
         ci.amount_minor, ci.currency,
         case when ci.paid_at is not null then 'paid' else 'pending' end,
         ci.early_supply_consent_at is not null and ci.cancellation_ack_at is not null,
         ci.confirmation_sent_at is not null
  from checkout_intents ci
  left join profiles pr on pr.id = ci.parent_id
  left join child_profiles c on c.id = ci.child_id
  join missions m on m.id = ci.mission_id
  order by ci.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;
revoke all on function admin_orders(int) from public;
grant execute on function admin_orders(int) to authenticated;

-- ------------------------------------------------------------- admin gifts --
-- As D-149's, with whether consent was recorded and the confirmation sent.
drop function if exists admin_gifts(int);
create function admin_gifts(p_limit int default 100)
returns table (
  id uuid, created_at timestamptz, mission_title text,
  purchaser_email text,
  amount_minor int, currency text, status gift_status,
  paid_at timestamptz, redeemed_at timestamptz,
  redeemed_by_email text, redeemed_child_name text,
  consent_recorded boolean, confirmation_sent boolean
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
         redeemer.email, c.display_name,
         g.early_supply_consent_at is not null and g.cancellation_ack_at is not null,
         g.confirmation_sent_at is not null
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

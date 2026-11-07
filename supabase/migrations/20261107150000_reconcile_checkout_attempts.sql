-- ============================================================================
-- RECONCILING DURABLE CHECKOUT ATTEMPTS WITH PURCHASER-HELD GIFT CODES.
--
-- 20261106120000_checkout_attempt_reliability (upstream) reserves every
-- purchase and gift in the database before Stripe. It was written for the
-- earlier gift model, in which WLA emailed the recipient. The client document
-- of 6 Nov 2026 replaced that model (D-149): the purchaser receives the code
-- and shares it, and no recipient address is collected. So, keeping the
-- reliability and dropping what only the old model needed:
--
-- 1. One open gift checkout per purchaser and mission. Upstream's index keyed
--    it on the recipient's address too; that column is gone
--    (20261106120500), and the index went with it. Only a still-pending gift
--    counts, as in the code's own lookup (features/gifts/checkout.ts).
-- 2. email_delivery_locked_until guarded the email to the recipient, which is
--    no longer sent. The purchaser's confirmation is sent once by the delivery
--    that activates the gift (activate_paid_gift), so it needs no lease.
-- 3. gift_request_limits / consume_gift_request_limit limited requests to
--    email a recipient, keyed on that address. There are none to limit now;
--    a guessed gift code is limited by gift_code_attempts (D-149).
-- 4. customer_email is the parent's own address, kept so a reservation can be
--    replayed to Stripe. A retained payment record keeps no identity after the
--    account closes (D-148), so it is cleared whenever the family link is.
--    A trigger rather than an edit to each closure path, so a closure
--    re-applied after a restore (D-157) clears it too.
-- ============================================================================

-- 1 ---------------------------------------------------------------------------
drop index if exists mission_gifts_one_active_attempt;
create unique index mission_gifts_one_active_attempt
  on mission_gifts (purchaser_id, mission_id)
  where attempt_key is not null and status = 'pending' and checkout_status in ('initializing', 'open');

-- 2 ---------------------------------------------------------------------------
alter table mission_gifts drop column if exists email_delivery_locked_until;

-- 3 ---------------------------------------------------------------------------
drop function if exists consume_gift_request_limit(text, text, boolean);
drop table if exists gift_request_limits;

-- 4 ---------------------------------------------------------------------------
-- One function per table: a trigger function can't name a column only one of
-- the two tables has.
create or replace function private.intent_forget_customer_email()
returns trigger
language plpgsql
as $$
begin
  if new.parent_id is null then
    new.customer_email := null;
  end if;
  return new;
end;
$$;
revoke all on function private.intent_forget_customer_email() from public, anon, authenticated;

create or replace function private.gift_forget_customer_email()
returns trigger
language plpgsql
as $$
begin
  if new.purchaser_id is null then
    new.customer_email := null;
  end if;
  return new;
end;
$$;
revoke all on function private.gift_forget_customer_email() from public, anon, authenticated;

drop trigger if exists checkout_intents_forget_customer_email on checkout_intents;
create trigger checkout_intents_forget_customer_email
  before insert or update on checkout_intents
  for each row execute function private.intent_forget_customer_email();

drop trigger if exists mission_gifts_forget_customer_email on mission_gifts;
create trigger mission_gifts_forget_customer_email
  before insert or update on mission_gifts
  for each row execute function private.gift_forget_customer_email();

-- Records already detached from a closed account.
update checkout_intents set customer_email = null where parent_id is null and customer_email is not null;
update mission_gifts set customer_email = null where purchaser_id is null and customer_email is not null;

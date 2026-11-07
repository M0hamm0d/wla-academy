-- Mission gifts with purchaser-held codes (D-149), executed against the real
-- schema. One transaction, rolled back: nothing it creates survives. Run by
-- scripts/run-gift-regression.sh, which adds real concurrent sessions.
\set ON_ERROR_STOP on
begin;
create temp table r (n serial, label text, ok boolean);
grant all on r to public; grant all on sequence r_n_seq to public;
create temp table codes (label text primary key, gift uuid, code text);
grant all on codes to public;

-- Fixtures: two families and one priced mission of its own. B buys; A redeems.
insert into auth.users (id, email, aud, role, instance_id, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('a0000000-0000-4000-8000-00000000000a','gift-a@wla-local.test','authenticated','authenticated','00000000-0000-0000-0000-000000000000','',now(),now(),'{}','{}'),
       ('b0000000-0000-4000-8000-00000000000b','gift-b@wla-local.test','authenticated','authenticated','00000000-0000-0000-0000-000000000000','',now(),now(),'{}','{}');
insert into child_profiles (id, parent_id, display_name) values
 ('c0000000-0000-4000-8000-0000000000a1','a0000000-0000-4000-8000-00000000000a','Child A1'),
 ('c0000000-0000-4000-8000-0000000000a2','a0000000-0000-4000-8000-00000000000a','Child A2'),
 ('c0000000-0000-4000-8000-0000000000b1','b0000000-0000-4000-8000-00000000000b','Child B1');
insert into missions (id, slug, title, lab, min_age, max_age, is_free, price_minor, currency, published)
values ('d0000000-0000-4000-8000-000000000001','gift-regression','Gift regression','decision',11,15,false,1200,'GBP',false);
-- One open gift checkout per purchaser and mission (20261107150000): Stripe has
-- already completed the second of these two.
insert into mission_gifts (id, mission_id, purchaser_id, stripe_session_id, amount_minor, currency, early_supply_consent_at, cancellation_ack_at, consent_wording, checkout_status)
values ('e0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000b','cs_g1',1200,'GBP',now(),now(),'v | consent | ack','open'),
       ('e0000000-0000-4000-8000-000000000002','d0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000b','cs_g2',1200,'GBP',now(),now(),'v | consent | ack','paid');

-- ---------------------------------------------------------- the schema --
insert into r(label,ok) select 'no recipient address is stored: the column is gone',
  not exists (select 1 from information_schema.columns where table_name='mission_gifts' and column_name ilike '%recipient%');
insert into r(label,ok) select 'the email-based functions are gone',
  to_regprocedure('confirm_gift_email(text,text,text)') is null and to_regprocedure('issue_gift_code(text)') is null
  and to_regprocedure('withdraw_gift_code(uuid,text)') is null;
insert into r(label,ok) select 'nothing of the recipient-email model came back with the checkout reconciliation',
  to_regclass('gift_request_limits') is null and to_regprocedure('consume_gift_request_limit(text,text,boolean)') is null
  and not exists (select 1 from information_schema.columns where table_name='mission_gifts' and column_name='email_delivery_locked_until');
do $$ begin
  insert into mission_gifts (mission_id,purchaser_id,amount_minor,currency,early_supply_consent_at,cancellation_ack_at,consent_wording,checkout_status)
  values ('d0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000b',1200,'GBP',now(),now(),'v | a | b','initializing');
  insert into r(label,ok) values ('a second open gift checkout for the same purchaser and mission is refused', false);
exception when unique_violation then
  insert into r(label,ok) values ('a second open gift checkout for the same purchaser and mission is refused', true);
end $$;
do $$ begin
  begin insert into mission_gifts (mission_id,stripe_session_id,amount_minor,currency) values ('d0000000-0000-4000-8000-000000000001','cs_x',1,'GBP');
        insert into r(label,ok) values ('a gift without both checkout statements is refused (D-152)', false);
  exception when check_violation then insert into r(label,ok) values ('a gift without both checkout statements is refused (D-152)', true); end;
  begin update mission_gifts set status='paid', paid_at=now() where stripe_session_id='cs_g2';
        insert into r(label,ok) values ('a gift cannot become paid without a code', false);
  exception when check_violation then insert into r(label,ok) values ('a gift cannot become paid without a code', true); end;
  begin update mission_gifts set code_lookup='x' where stripe_session_id='cs_g2';
        insert into r(label,ok) values ('a pending gift cannot hold a code', false);
  exception when check_violation then insert into r(label,ok) values ('a pending gift cannot hold a code', true); end;
  begin update mission_gifts set claim_hash='x', claim_expires_at=now() where stripe_session_id='cs_g2';
        insert into r(label,ok) values ('a pending gift cannot hold a claim', false);
  exception when check_violation then insert into r(label,ok) values ('a pending gift cannot hold a claim', true); end;
  begin insert into mission_gifts (mission_id,stripe_session_id,amount_minor,currency,early_supply_consent_at,cancellation_ack_at,consent_wording)
        values ('d0000000-0000-4000-8000-000000000001','cs_g1',1,'GBP',now(),now(),'w');
        insert into r(label,ok) values ('one gift per Stripe session', false);
  exception when unique_violation then insert into r(label,ok) values ('one gift per Stripe session', true); end;
end $$;

-- ----------------------------------------------------------- client roles --
set local role anon;
do $$ begin
  begin perform 1 from mission_gifts; insert into r(label,ok) values ('anon cannot read gifts',false);
  exception when insufficient_privilege then insert into r(label,ok) values ('anon cannot read gifts',true); end;
  begin perform confirm_gift_code('ABCD-EFGH-JKMN','client','c'); insert into r(label,ok) values ('anon cannot try a code directly',false);
  exception when insufficient_privilege then insert into r(label,ok) values ('anon cannot try a code directly',true); end;
  begin perform redeem_mission_gift('c','c0000000-0000-4000-8000-0000000000a1','a0000000-0000-4000-8000-00000000000a'); insert into r(label,ok) values ('anon cannot redeem',false);
  exception when insufficient_privilege then insert into r(label,ok) values ('anon cannot redeem',true); end;
  begin perform * from activate_paid_gift('cs_g1','pi'); insert into r(label,ok) values ('anon cannot activate a gift',false);
  exception when insufficient_privilege then insert into r(label,ok) values ('anon cannot activate a gift',true); end;
  begin perform 1 from gift_code_attempts; insert into r(label,ok) values ('anon cannot read the attempt log',false);
  exception when insufficient_privilege then insert into r(label,ok) values ('anon cannot read the attempt log',true); end;
  begin perform 1 from app_secrets; insert into r(label,ok) values ('anon cannot read the code pepper',false);
  exception when insufficient_privilege then insert into r(label,ok) values ('anon cannot read the code pepper',true); end;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"b0000000-0000-4000-8000-00000000000b","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','b0000000-0000-4000-8000-00000000000b',true);
do $$ begin
  begin perform 1 from mission_gifts; insert into r(label,ok) values ('even the purchaser cannot read the table',false);
  exception when insufficient_privilege then insert into r(label,ok) values ('even the purchaser cannot read the table',true); end;
  begin perform * from purchaser_gifts('b0000000-0000-4000-8000-00000000000b'); insert into r(label,ok) values ('a parent cannot call purchaser_gifts directly',false);
  exception when insufficient_privilege then insert into r(label,ok) values ('a parent cannot call purchaser_gifts directly',true); end;
  begin perform reissue_gift_code('e0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000b'); insert into r(label,ok) values ('a parent cannot reissue directly',false);
  exception when insufficient_privilege then insert into r(label,ok) values ('a parent cannot reissue directly',true); end;
  begin perform store_gift_code_copy('e0000000-0000-4000-8000-000000000001','x','y'); insert into r(label,ok) values ('a parent cannot write a code copy',false);
  exception when insufficient_privilege then insert into r(label,ok) values ('a parent cannot write a code copy',true); end;
  begin perform 1 from admin_gifts(); insert into r(label,ok) values ('a non-admin parent cannot use the admin view',false);
  exception when insufficient_privilege then insert into r(label,ok) values ('a non-admin parent cannot use the admin view',true); end;
end $$;
reset role;

-- ------------------------------------------------------------- activation --
insert into r(label,ok) select 'an unknown session activates nothing', (select outcome='not_found' from activate_paid_gift('cs_nope','pi'));
insert into codes select 'g1', gift_id, code from activate_paid_gift('cs_g1','pi_g1');
insert into r(label,ok) select 'payment makes it paid with a code: 12 characters from the alphabet, in threes of four',
  (select code ~ '^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}$' from codes where label='g1')
  and (select status='paid' and paid_at is not null and stripe_payment_intent_id='pi_g1' from mission_gifts where stripe_session_id='cs_g1');
insert into r(label,ok) select 'only a keyed hash of the code is stored',
  (select g.code_lookup ~ '^[0-9a-f]{64}$' and position(replace(c.code,'-','') in g.code_lookup)=0
          and g.code_lookup <> encode(digest(replace(c.code,'-',''),'sha256'),'hex')
     from mission_gifts g, codes c where g.stripe_session_id='cs_g1' and c.label='g1');
create temp table before_repeat as select code_lookup from mission_gifts where stripe_session_id='cs_g1';
insert into r(label,ok) select 'a repeated delivery activates nothing and returns no code',
  (select outcome='already' and code is null from activate_paid_gift('cs_g1','pi_other'));
insert into r(label,ok) select 'and changes neither the code nor the payment',
  (select g.code_lookup=b.code_lookup and g.stripe_payment_intent_id='pi_g1' from mission_gifts g, before_repeat b where g.stripe_session_id='cs_g1');
insert into r(label,ok) select 'buying grants the purchaser nothing',
  not exists (select 1 from mission_entitlements e join child_profiles c on c.id=e.child_id where c.parent_id='b0000000-0000-4000-8000-00000000000b');
insert into r(label,ok) select 'a copy can only be stored for the live code', not store_gift_code_copy('e0000000-0000-4000-8000-000000000001','ABCD-EFGH-JKMN','sealed');
insert into r(label,ok) select 'and is stored for it', store_gift_code_copy('e0000000-0000-4000-8000-000000000001',(select code from codes where label='g1'),'v1.kid.iv.tag.body');
insert into r(label,ok) select 'the purchaser''s list has their gift, with the copy for the server to open',
  (select count(*)=2 and bool_or(code_ciphertext='v1.kid.iv.tag.body') from purchaser_gifts('b0000000-0000-4000-8000-00000000000b'));
insert into r(label,ok) select 'another family''s list has none of it', not exists (select 1 from purchaser_gifts('a0000000-0000-4000-8000-00000000000a'));

-- ----------------------------------------------------------- the code form --
insert into r(label,ok) select 'a wrong code is one word', confirm_gift_code('ABCD-EFGH-JKMN','198.51.100.1','claim-w')='invalid';
insert into r(label,ok) select 'something that isn''t a code is the same word', confirm_gift_code('hello','198.51.100.1','claim-w')='invalid';
insert into r(label,ok) select 'and no claim was made', (select claim_hash is null from mission_gifts where stripe_session_id='cs_g1');
insert into r(label,ok) select 'attempts are logged under an HMAC of the client, never the address',
  (select count(*)=2 and bool_and(client_key ~ '^[0-9a-f]{64}$' and position('198.51.100.1' in client_key)=0) from gift_code_attempts where occurred_at > now() - interval '1 minute');
-- A statement doesn't see what a function in it wrote, so each result is
-- checked in the statement after.
insert into r(label,ok) select 'the right code, however typed, matches',
  confirm_gift_code(lower(replace((select code from codes where label='g1'),'-',' ')),'198.51.100.2','claim-g1')='matched';
insert into r(label,ok) select 'and gives a claim for a day',
  (select claim_hash='claim-g1' and claim_expires_at between now()+interval '23 hours' and now()+interval '25 hours' from mission_gifts where stripe_session_id='cs_g1');
insert into r(label,ok) select 'the code stays valid until redeemed: it can be entered again',
  confirm_gift_code((select code from codes where label='g1'),'198.51.100.2','claim-g1b')='matched';
insert into r(label,ok) select 'which replaces the claim', (select claim_hash='claim-g1b' from mission_gifts where stripe_session_id='cs_g1');
-- Ten failures from one client: even the right code is then refused for it.
do $$ begin perform confirm_gift_code('ABCD-EFGH-JKMN','203.0.113.9','w') from generate_series(1,10); end $$;
insert into r(label,ok) select 'after ten wrong codes a client is stopped, even with the right one',
  confirm_gift_code((select code from codes where label='g1'),'203.0.113.9','claim-blocked')='rate_limited';
insert into r(label,ok) select 'and gets no claim', (select claim_hash='claim-g1b' from mission_gifts where stripe_session_id='cs_g1');
insert into r(label,ok) select 'another client is unaffected', confirm_gift_code((select code from codes where label='g1'),'203.0.113.10','claim-g1c')='matched';
-- No automatic expiry (approved retention rule): a code from years ago works.
update mission_gifts set paid_at = now() - interval '3 years', code_issued_at = now() - interval '3 years', created_at = now() - interval '3 years' where stripe_session_id='cs_g1';
insert into r(label,ok) select 'an unredeemed code three years old still works: no automatic expiry',
  confirm_gift_code((select code from codes where label='g1'),'203.0.113.11','claim-g1d')='matched';

-- ------------------------------------------------------------- redemption --
insert into r(label,ok) select 'an unknown claim redeems nothing', redeem_mission_gift('nope','c0000000-0000-4000-8000-0000000000a1','a0000000-0000-4000-8000-00000000000a')='invalid';
insert into r(label,ok) select 'an earlier claim stopped working when the code was entered again', redeem_mission_gift('claim-g1','c0000000-0000-4000-8000-0000000000a1','a0000000-0000-4000-8000-00000000000a')='invalid';
insert into r(label,ok) select 'another family''s child is refused', redeem_mission_gift('claim-g1d','c0000000-0000-4000-8000-0000000000b1','a0000000-0000-4000-8000-00000000000a')='forbidden';
insert into r(label,ok) select 'the refusal consumed nothing', (select status='paid' from mission_gifts where stripe_session_id='cs_g1');
insert into mission_entitlements (child_id,mission_id,source) values ('c0000000-0000-4000-8000-0000000000a2','d0000000-0000-4000-8000-000000000001','purchase');
insert into r(label,ok) select 'a child who already has it is told so',
  redeem_mission_gift('claim-g1d','c0000000-0000-4000-8000-0000000000a2','a0000000-0000-4000-8000-00000000000a')='already_owned';
insert into r(label,ok) select 'and the gift is not used up', (select status='paid' from mission_gifts where stripe_session_id='cs_g1');
insert into r(label,ok) select 'redeeming for the recipient''s own child succeeds', redeem_mission_gift('claim-g1d','c0000000-0000-4000-8000-0000000000a1','a0000000-0000-4000-8000-00000000000a')='redeemed';
insert into r(label,ok) select 'it is one gift-source entitlement, for that child',
  (select count(*)=1 and bool_and(source='gift' and status='active') from mission_entitlements where child_id='c0000000-0000-4000-8000-0000000000a1' and mission_id='d0000000-0000-4000-8000-000000000001');
insert into r(label,ok) select 'the code and its copy are gone once redeemed',
  (select status='redeemed' and code_lookup is null and code_ciphertext is null and redeemed_child_id='c0000000-0000-4000-8000-0000000000a1' from mission_gifts where stripe_session_id='cs_g1');
insert into r(label,ok) select 'so the code no longer confirms', confirm_gift_code((select code from codes where label='g1'),'203.0.113.12','claim-late')='invalid';
insert into r(label,ok) select 'and a second redemption is refused', redeem_mission_gift('claim-g1d','c0000000-0000-4000-8000-0000000000b1','b0000000-0000-4000-8000-00000000000b')='already_redeemed';
insert into r(label,ok) select 'creating no second entitlement', not exists (select 1 from mission_entitlements where child_id='c0000000-0000-4000-8000-0000000000b1');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','a0000000-0000-4000-8000-00000000000a',true);
do $$ begin insert into r(label,ok) select 'the recipient family reads the entitlement in My Missions', exists(select 1 from mission_entitlements where child_id='c0000000-0000-4000-8000-0000000000a1'); end $$;
select set_config('request.jwt.claims','{"sub":"b0000000-0000-4000-8000-00000000000b","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','b0000000-0000-4000-8000-00000000000b',true);
do $$ begin insert into r(label,ok) select 'the purchaser cannot read the recipient''s entitlement', not exists(select 1 from mission_entitlements where child_id='c0000000-0000-4000-8000-0000000000a1'); end $$;
reset role;
insert into r(label,ok) select 'the purchaser''s list says redeemed, and nothing about who',
  (select status='redeemed' and code_ciphertext is null from purchaser_gifts('b0000000-0000-4000-8000-00000000000b') where id='e0000000-0000-4000-8000-000000000001')
  and not exists (select 1 from unnest(regexp_split_to_array(pg_get_function_result('purchaser_gifts(uuid)'::regprocedure), ',')) x where x ilike '%redeemed_by%' or x ilike '%child%');

-- ----------------------------------------------------- replacing a code --
insert into codes select 'g2', gift_id, code from activate_paid_gift('cs_g2','pi_g2');
select confirm_gift_code((select code from codes where label='g2'),'203.0.113.20','claim-g2');
insert into r(label,ok) select 'only the purchaser can replace a code', reissue_gift_code('e0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-00000000000a') is null;
insert into codes values ('g2-new', 'e0000000-0000-4000-8000-000000000002', reissue_gift_code('e0000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-00000000000b'));
insert into r(label,ok) select 'the purchaser gets a new code', (select code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$' and code <> (select code from codes where label='g2') from codes where label='g2-new');
insert into r(label,ok) select 'the old code stops working at once', confirm_gift_code((select code from codes where label='g2'),'203.0.113.21','claim-old')='invalid';
insert into r(label,ok) select 'and so does a claim made with it', redeem_mission_gift('claim-g2','c0000000-0000-4000-8000-0000000000a1','a0000000-0000-4000-8000-00000000000a')='invalid';
insert into r(label,ok) select 'the old copy is dropped with it', (select code_ciphertext is null from mission_gifts where stripe_session_id='cs_g2');
insert into r(label,ok) select 'the new code works', confirm_gift_code((select code from codes where label='g2-new'),'203.0.113.22','claim-g2-new')='matched';
insert into r(label,ok) select 'a redeemed gift can''t be given a new code', reissue_gift_code('e0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-00000000000b') is null;
update mission_gifts set claim_expires_at = now() - interval '1 second' where stripe_session_id='cs_g2';
insert into r(label,ok) select 'an expired claim redeems nothing',
  redeem_mission_gift('claim-g2-new','c0000000-0000-4000-8000-0000000000a1','a0000000-0000-4000-8000-00000000000a')='invalid';
insert into r(label,ok) select 'and the gift is still there to redeem', (select status='paid' from mission_gifts where stripe_session_id='cs_g2');

-- ------------------------------------------------------------- admin view --
insert into r(label,ok) select 'the admin view has no code, claim, Stripe id or recipient column',
  not exists (select 1 from unnest(regexp_split_to_array(pg_get_function_result('admin_gifts(int)'::regprocedure), ',')) x
               where x ilike '%code%' or x ilike '%claim%' or x ilike '%stripe%' or x ilike '%recipient%' or x ilike '%hash%');

select (case when ok then 'PASS' else 'FAIL' end) || '  ' || label from r order by n;
select 'PASS: ' || count(*) filter (where ok) || '   FAIL: ' || count(*) filter (where not ok) from r;
rollback;

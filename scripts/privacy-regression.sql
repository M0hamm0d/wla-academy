-- Account closure, child-profile deletion and retention (D-148), the Board's
-- anonymity review (D-151), executed against the real schema. One transaction,
-- rolled back: nothing it creates survives. Run by scripts/run-privacy-regression.sh.
--
-- Storage: objects are rows here, as they are to the database. Removing one is
-- what the server does through the Storage API (closure.ts); this stands in for
-- that by deleting the row, then reporting it the way the server does.
\set ON_ERROR_STOP on
begin;
create temp table r (n serial, label text, ok boolean);
grant all on r to public; grant all on sequence r_n_seq to public;
create temp table ids (k text primary key, v uuid);
grant all on ids to public;
select set_config('storage.allow_delete_query', 'true', true);

-- ------------------------------------------------------------- fixtures --
-- Family P: parent P with children P1 and P2. Family Q: parent Q with Q1, inactive
-- for years. An administrator. One priced mission.
insert into auth.users (id, email, aud, role, instance_id, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data) values
 ('aa000000-0000-4000-8000-000000000001','priv-p@wla-local.test','authenticated','authenticated','00000000-0000-0000-0000-000000000000','',now(),now(),'{}','{}'),
 ('aa000000-0000-4000-8000-000000000002','priv-q@wla-local.test','authenticated','authenticated','00000000-0000-0000-0000-000000000000','',now() - interval '5 years',now(),'{}','{}'),
 ('aa000000-0000-4000-8000-000000000009','priv-admin@wla-local.test','authenticated','authenticated','00000000-0000-0000-0000-000000000000','',now(),now(),'{}','{}');
update profiles set is_admin = true where id = 'aa000000-0000-4000-8000-000000000009';
update profiles set name = 'Pat Parent' where id = 'aa000000-0000-4000-8000-000000000001';
update profiles set created_at = now() - interval '5 years' where id = 'aa000000-0000-4000-8000-000000000002';
insert into child_profiles (id, parent_id, display_name, created_at) values
 ('cc000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000001','Pia', now()),
 ('cc000000-0000-4000-8000-000000000002','aa000000-0000-4000-8000-000000000001','Paz', now()),
 ('cc000000-0000-4000-8000-000000000003','aa000000-0000-4000-8000-000000000002','Quin', now() - interval '5 years');
insert into missions (id, slug, title, lab, min_age, max_age, is_free, price_minor, currency, published)
values ('dd000000-0000-4000-8000-000000000001','privacy-regression','Privacy regression','decision',11,15,false,1200,'GBP',false);

-- Each child: an entitlement, a run with a response and state, two Trail entries
-- (one with a file), a code, a session.
insert into mission_entitlements (child_id, mission_id, source, stripe_payment_intent_id)
select c, 'dd000000-0000-4000-8000-000000000001', 'purchase', 'pi_' || right(c::text, 2)
  from unnest(array['cc000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000002','cc000000-0000-4000-8000-000000000003']::uuid[]) c;
insert into mission_progress (id, child_id, mission_id, status, last_activity_at)
values ('ee000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000001','in_progress', now()),
       ('ee000000-0000-4000-8000-000000000002','cc000000-0000-4000-8000-000000000002','dd000000-0000-4000-8000-000000000001','in_progress', now()),
       ('ee000000-0000-4000-8000-000000000003','cc000000-0000-4000-8000-000000000003','dd000000-0000-4000-8000-000000000001','in_progress', now() - interval '5 years');
insert into mission_responses (progress_id, screen_key, value)
select id, 's1', '{"text":"my answer"}'::jsonb from mission_progress where mission_id = 'dd000000-0000-4000-8000-000000000001';
insert into mission_state (progress_id, state_data)
select id, '{}'::jsonb from mission_progress where mission_id = 'dd000000-0000-4000-8000-000000000001'
on conflict do nothing;
insert into mission_evidence (id, child_id, mission_id, progress_id, type, title, description, storage_path)
select ('ef000000-0000-4000-8000-0000000000' || right(c::text, 2))::uuid, c, 'dd000000-0000-4000-8000-000000000001',
       ('ee000000-0000-4000-8000-0000000000' || right(c::text, 2))::uuid, 'digital', 'Plan', 'We met at Oakfield Primary, Year 6, on Mill Road. Ask Sam Jones.',
       c::text || '/dd000000-0000-4000-8000-000000000001/plan.pdf'
  from unnest(array['cc000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000002','cc000000-0000-4000-8000-000000000003']::uuid[]) c;
insert into mission_evidence (child_id, mission_id, type, title)
select c, 'dd000000-0000-4000-8000-000000000001', 'physical', 'Poster'
  from unnest(array['cc000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000002','cc000000-0000-4000-8000-000000000003']::uuid[]) c;
insert into storage.objects (bucket_id, name)
select 'mission-evidence', c::text || suffix
  from unnest(array['cc000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000002','cc000000-0000-4000-8000-000000000003']::uuid[]) c,
       unnest(array['/dd000000-0000-4000-8000-000000000001/plan.pdf', '/unreferenced/photo.jpg']) suffix;
insert into child_access_credentials (child_id, code_hash, code_lookup)
select c, 'h-' || c, 'l-' || c from unnest(array['cc000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000002','cc000000-0000-4000-8000-000000000003']::uuid[]) c;
insert into child_sessions (child_id, token_lookup, expires_at)
select c, 't-' || c, now() + interval '30 days' from unnest(array['cc000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000002','cc000000-0000-4000-8000-000000000003']::uuid[]) c;
-- Board: P1's published, P2's published, Q1's pending.
insert into board_contributions (child_id, mission_id, evidence_id, text, status, anonymity_checked_at)
select child_id, mission_id, id, 'An approach', case when child_id = 'cc000000-0000-4000-8000-000000000003' then 'pending_moderation' else 'published' end,
       case when child_id = 'cc000000-0000-4000-8000-000000000003' then null else now() end
  from mission_evidence where storage_path is not null and mission_id = 'dd000000-0000-4000-8000-000000000001';
-- Payments: a paid and an unpaid intent per child of P; a gift P bought.
insert into checkout_intents (stripe_session_id, parent_id, child_id, mission_id, amount_minor, currency, paid_at, stripe_payment_intent_id, early_supply_consent_at, cancellation_ack_at, consent_wording)
values ('cs_p1_paid','aa000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000001',1200,'GBP',now(),'pi_01',now(),now(),'w'),
       ('cs_p1_open','aa000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000001',1200,'GBP',null,null,now(),now(),'w'),
       ('cs_p2_paid','aa000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000002','dd000000-0000-4000-8000-000000000001',1200,'GBP',now(),'pi_02',now(),now(),'w'),
       ('cs_q1_paid','aa000000-0000-4000-8000-000000000002','cc000000-0000-4000-8000-000000000003','dd000000-0000-4000-8000-000000000001',1200,'GBP',now() - interval '5 years','pi_03',now(),now(),'w');
insert into mission_gifts (id, mission_id, purchaser_id, stripe_session_id, amount_minor, currency, early_supply_consent_at, cancellation_ack_at, consent_wording)
values ('ab000000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000001','cs_p_gift',1200,'GBP',now(),now(),'w');
create temp table gift_code as select code from activate_paid_gift('cs_p_gift','pi_gift');
grant all on gift_code to public;
select store_gift_code_copy('ab000000-0000-4000-8000-000000000001', (select code from gift_code), 'v1.k.i.t.b');
-- Analytics: an event per run, now; and Q1's from 40 days ago.
insert into analytics_events (name, mission_id, mission_version, run_key, occurred_at)
select 'screen_entered', mission_id, 1, analytics_key, case when child_id = 'cc000000-0000-4000-8000-000000000003' then now() - interval '40 days' else now() end
  from mission_progress where mission_id = 'dd000000-0000-4000-8000-000000000001';
insert into ids select 'p2_key', analytics_key from mission_progress where id = 'ee000000-0000-4000-8000-000000000002';

-- ------------------------------------------------------- client roles --
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aa000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000001',true);
do $$ begin
  begin perform * from privacy_begin_closure('parent_account','aa000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000001','parent');
        insert into r(label,ok) values ('a parent cannot start a closure by calling the database directly', false);
  exception when insufficient_privilege then insert into r(label,ok) values ('a parent cannot start a closure by calling the database directly', true); end;
  begin perform privacy_reapply_deletions(); insert into r(label,ok) values ('a parent cannot run the restore safeguard', false);
  exception when insufficient_privilege then insert into r(label,ok) values ('a parent cannot run the restore safeguard', true); end;
  begin perform privacy_retention_run(); insert into r(label,ok) values ('a parent cannot run retention', false);
  exception when insufficient_privilege then insert into r(label,ok) values ('a parent cannot run retention', true); end;
  begin perform 1 from privacy_deletions; insert into r(label,ok) values ('a parent cannot read the deletion ledger', false);
  exception when insufficient_privilege then insert into r(label,ok) values ('a parent cannot read the deletion ledger', true); end;
  begin perform * from admin_privacy_deletions(); insert into r(label,ok) values ('a non-admin cannot use the admin view', false);
  exception when insufficient_privilege then insert into r(label,ok) values ('a non-admin cannot use the admin view', true); end;
  begin perform admin_place_hold('security_logs', null, 'x x x', null); insert into r(label,ok) values ('a non-admin cannot place a hold', false);
  exception when insufficient_privilege then insert into r(label,ok) values ('a non-admin cannot place a hold', true); end;
end $$;
reset role;

-- ------------------------------------------- refusals before anything --
insert into r(label,ok) select 'another family''s child can''t be deleted by this parent',
  (select outcome='not_found' from privacy_begin_closure('child_profile','cc000000-0000-4000-8000-000000000003','aa000000-0000-4000-8000-000000000001','parent'));
insert into r(label,ok) select 'and nothing of it was touched',
  (select revoked_at is null from child_access_credentials where child_id='cc000000-0000-4000-8000-000000000003')
  and exists (select 1 from board_contributions where child_id='cc000000-0000-4000-8000-000000000003');
insert into r(label,ok) select 'an administrator''s own account can''t be closed this way',
  (select outcome='admin_account' from privacy_begin_closure('parent_account','aa000000-0000-4000-8000-000000000009','aa000000-0000-4000-8000-000000000009','parent'));
insert into r(label,ok) select 'a parent account can only be closed as itself',
  (select outcome='invalid' from privacy_begin_closure('parent_account','aa000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000002','parent'));

-- ============================================= 1. ONE CHILD: P1 ==
insert into ids select 'c1', deletion_id from privacy_begin_closure('child_profile','cc000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000001','parent');
insert into r(label,ok) select 'deleting a child is recorded, with ids and dates only',
  (select subject_type='child_profile' and status='in_progress' and child_ids = array['cc000000-0000-4000-8000-000000000001']::uuid[]
          and due_by between now() + interval '29 days' and now() + interval '31 days' from privacy_deletions where id=(select v from ids where k='c1'))
  and not exists (select 1 from information_schema.columns where table_name='privacy_deletions' and column_name ~ 'name|email|text');
insert into r(label,ok) select 'the child''s code and sessions stop at once; the sibling''s don''t',
  (select bool_and(revoked_at is not null) from child_access_credentials where child_id='cc000000-0000-4000-8000-000000000001')
  and (select bool_and(revoked_at is not null) from child_sessions where child_id='cc000000-0000-4000-8000-000000000001')
  and (select bool_and(revoked_at is null) from child_access_credentials where child_id='cc000000-0000-4000-8000-000000000002')
  and (select bool_and(revoked_at is null) from child_sessions where child_id='cc000000-0000-4000-8000-000000000002');
insert into r(label,ok) select 'the child''s Board contribution comes down at once; the sibling''s stays',
  not exists (select 1 from board_contributions where child_id='cc000000-0000-4000-8000-000000000001')
  and exists (select 1 from board_contributions where child_id='cc000000-0000-4000-8000-000000000002' and status='published');
insert into r(label,ok) select 'every stored file of that child is listed, referenced or not, and only theirs',
  (select array_agg(path order by path) from privacy_pending_files((select v from ids where k='c1')))
  = array['cc000000-0000-4000-8000-000000000001/dd000000-0000-4000-8000-000000000001/plan.pdf','cc000000-0000-4000-8000-000000000001/unreferenced/photo.jpg'];
insert into r(label,ok) select 'no data goes while a file remains', privacy_finish_closure((select v from ids where k='c1'))='files_pending';
insert into r(label,ok) select 'so the child is still there', exists (select 1 from child_profiles where id='cc000000-0000-4000-8000-000000000001');
-- The server removes one object, and Storage refuses the other.
delete from storage.objects where bucket_id='mission-evidence' and name='cc000000-0000-4000-8000-000000000001/dd000000-0000-4000-8000-000000000001/plan.pdf';
select privacy_record_files((select v from ids where k='c1'), 'mission-evidence',
  array['cc000000-0000-4000-8000-000000000001/dd000000-0000-4000-8000-000000000001/plan.pdf'],
  array['cc000000-0000-4000-8000-000000000001/unreferenced/photo.jpg'], 'storage_StorageApiError');
select privacy_record_failure((select v from ids where k='c1'), 'files', 'storage_StorageApiError');
insert into r(label,ok) select 'a partial failure is visible: failed, at which step, why, and which file is left',
  (select status='failed' and step='files' and attempts=1 and last_error='storage_StorageApiError' from privacy_deletions where id=(select v from ids where k='c1'))
  and (select count(*)=1 and bool_and(last_error='storage_StorageApiError') from privacy_deletion_files where deletion_id=(select v from ids where k='c1'));
insert into r(label,ok) select 'and it is picked up by the retry', exists (select 1 from privacy_open_deletions() where id=(select v from ids where k='c1'));
-- The retry removes the last one.
delete from storage.objects where bucket_id='mission-evidence' and name='cc000000-0000-4000-8000-000000000001/unreferenced/photo.jpg';
select privacy_record_files((select v from ids where k='c1'), 'mission-evidence', array['cc000000-0000-4000-8000-000000000001/unreferenced/photo.jpg'], '{}', null);
insert into r(label,ok) select 'with every file gone, the child''s data is deleted and the request completes',
  privacy_finish_closure((select v from ids where k='c1'))='completed';
insert into r(label,ok) select 'the child and everything of theirs is gone',
  not exists (select 1 from child_profiles where id='cc000000-0000-4000-8000-000000000001')
  and not exists (select 1 from mission_entitlements where child_id='cc000000-0000-4000-8000-000000000001')
  and not exists (select 1 from mission_progress where child_id='cc000000-0000-4000-8000-000000000001')
  and not exists (select 1 from mission_responses where progress_id='ee000000-0000-4000-8000-000000000001')
  and not exists (select 1 from mission_state where progress_id='ee000000-0000-4000-8000-000000000001')
  and not exists (select 1 from mission_evidence where child_id='cc000000-0000-4000-8000-000000000001')
  and not exists (select 1 from child_access_credentials where child_id='cc000000-0000-4000-8000-000000000001')
  and not exists (select 1 from child_sessions where child_id='cc000000-0000-4000-8000-000000000001')
  and not exists (select 1 from storage.objects where bucket_id='mission-evidence' and name like 'cc000000-0000-4000-8000-000000000001/%');
insert into r(label,ok) select 'the parent account is untouched',
  exists (select 1 from profiles where id='aa000000-0000-4000-8000-000000000001')
  and exists (select 1 from auth.users where id='aa000000-0000-4000-8000-000000000001');
insert into r(label,ok) select 'the sibling is untouched: missions, progress, responses, Trail, files, code',
  (select count(*)=1 from mission_entitlements where child_id='cc000000-0000-4000-8000-000000000002')
  and (select count(*)=1 from mission_progress where child_id='cc000000-0000-4000-8000-000000000002')
  and (select count(*)=1 from mission_responses where progress_id='ee000000-0000-4000-8000-000000000002')
  and (select count(*)=2 from mission_evidence where child_id='cc000000-0000-4000-8000-000000000002')
  and (select count(*)=2 from storage.objects where bucket_id='mission-evidence' and name like 'cc000000-0000-4000-8000-000000000002/%')
  and (select count(*)=1 from child_access_credentials where child_id='cc000000-0000-4000-8000-000000000002' and revoked_at is null);
insert into r(label,ok) select 'another family is untouched',
  (select count(*)=1 from child_profiles where parent_id='aa000000-0000-4000-8000-000000000002')
  and (select count(*)=2 from storage.objects where bucket_id='mission-evidence' and name like 'cc000000-0000-4000-8000-000000000003/%');
insert into r(label,ok) select 'the child''s paid order stays, without the child; the parent keeps their own record',
  (select child_id is null and parent_id='aa000000-0000-4000-8000-000000000001' and paid_at is not null from checkout_intents where stripe_session_id='cs_p1_paid');
insert into r(label,ok) select 'the child''s unpaid checkout is deleted', not exists (select 1 from checkout_intents where stripe_session_id='cs_p1_open');
insert into r(label,ok) select 'the child''s analytics key is gone with the run; the sibling''s stays',
  (select count(*)=0 from analytics_events e where e.mission_id='dd000000-0000-4000-8000-000000000001' and e.run_key is not null
     and e.run_key not in (select analytics_key from mission_progress))
  and exists (select 1 from analytics_events where run_key=(select v from ids where k='p2_key'));
insert into r(label,ok) select 'the record of it keeps counts only',
  (select summary ? 'child_profiles' and (summary->>'child_profiles')::int=1 and (summary->>'files_removed')::int=2
          and (summary->>'payments_kept_without_family')::int=1 and (summary->>'unpaid_checkouts_deleted')::int=1
     from privacy_deletions where id=(select v from ids where k='c1'));

-- ============================================ 2. A LAWFUL HOLD: Q ==
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aa000000-0000-4000-8000-000000000009","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000009',true);
insert into ids select 'hold_q', admin_place_hold('parent_account','aa000000-0000-4000-8000-000000000002','Retained for a dispute (case 42)', null);
do $$ begin
  begin perform admin_place_hold('child_profile','cc000000-0000-4000-8000-000000000003','reason ok', current_date + 400);
        insert into r(label,ok) values ('a hold must be reviewed within a year', false);
  exception when check_violation then insert into r(label,ok) values ('a hold must be reviewed within a year', true); end;
end $$;
reset role;
insert into ids select 'q', deletion_id from privacy_begin_closure('parent_account','aa000000-0000-4000-8000-000000000002','aa000000-0000-4000-8000-000000000002','admin');
insert into r(label,ok) select 'a closure under a hold is recorded as held',
  (select status='held' and requested_by='admin' from privacy_deletions where id=(select v from ids where k='q'));
insert into r(label,ok) select 'and finishing it deletes nothing', privacy_finish_closure((select v from ids where k='q'))='held';
insert into r(label,ok) select 'the held family''s records are all still there',
  exists (select 1 from child_profiles where id='cc000000-0000-4000-8000-000000000003')
  and exists (select 1 from mission_evidence where child_id='cc000000-0000-4000-8000-000000000003')
  and exists (select 1 from profiles where id='aa000000-0000-4000-8000-000000000002');
insert into r(label,ok) select 'a held closure isn''t retried', not exists (select 1 from privacy_open_deletions() where id=(select v from ids where k='q'));
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aa000000-0000-4000-8000-000000000009","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000009',true);
select admin_review_hold((select v from ids where k='hold_q'), true, null);
reset role;
insert into r(label,ok) select 'releasing the hold returns the closure to the retry queue',
  exists (select 1 from privacy_open_deletions() where id=(select v from ids where k='q'));

-- ===================================== 3. INACTIVITY AND RETENTION ==
-- Q has been inactive for five years. Its gift-like data and logs are aged.
insert into child_auth_attempts (lookup_key, succeeded, occurred_at) values ('old', false, now() - interval '91 days'), ('recent', false, now() - interval '89 days');
insert into gift_code_attempts (client_key, succeeded, occurred_at) values ('old', false, now() - interval '91 days'), ('recent', false, now() - interval '89 days');
insert into child_sessions (child_id, token_lookup, expires_at, created_at) values
 ('cc000000-0000-4000-8000-000000000002','t-expired-long-ago', now() - interval '91 days', now() - interval '121 days'),
 ('cc000000-0000-4000-8000-000000000002','t-expired-lately', now() - interval '10 days', now() - interval '40 days');
insert into board_contributions (child_id, mission_id, evidence_id, text, status, moderated_at, rejected_reason)
select 'cc000000-0000-4000-8000-000000000002', mission_id, id, 'old rejected', 'rejected', now() - interval '31 days', 'not_suitable'
  from mission_evidence where child_id='cc000000-0000-4000-8000-000000000002' and type='physical';
create temp table run_result as select privacy_retention_run() as v;
grant all on run_result to public;
insert into r(label,ok) select 'retention removes analytics run keys older than 30 days, and only those',
  (select (v->>'analytics_keys_removed')::int >= 1 from run_result)
  and not exists (select 1 from analytics_events where run_key is not null and occurred_at < now() - interval '30 days')
  and exists (select 1 from analytics_events where run_key=(select v from ids where k='p2_key'));
insert into r(label,ok) select 'security logs older than 90 days go; younger ones stay',
  not exists (select 1 from child_auth_attempts where lookup_key='old') and exists (select 1 from child_auth_attempts where lookup_key='recent')
  and not exists (select 1 from gift_code_attempts where client_key='old') and exists (select 1 from gift_code_attempts where client_key='recent');
insert into r(label,ok) select 'a session ended over 90 days ago goes; a recent one and a live one stay',
  not exists (select 1 from child_sessions where token_lookup='t-expired-long-ago')
  and exists (select 1 from child_sessions where token_lookup='t-expired-lately')
  and exists (select 1 from child_sessions where token_lookup='t-cc000000-0000-4000-8000-000000000002');
insert into r(label,ok) select 'a Board contribution rejected over 30 days ago is deleted',
  not exists (select 1 from board_contributions where text='old rejected');
insert into r(label,ok) select 'inactivity deletes nothing: the five-year-quiet family keeps account, child, progress, Trail and files',
  exists (select 1 from profiles where id='aa000000-0000-4000-8000-000000000002')
  and exists (select 1 from child_profiles where id='cc000000-0000-4000-8000-000000000003')
  and exists (select 1 from mission_progress where id='ee000000-0000-4000-8000-000000000003')
  and (select count(*)=2 from mission_evidence where child_id='cc000000-0000-4000-8000-000000000003')
  and (select count(*)=1 from mission_entitlements where child_id='cc000000-0000-4000-8000-000000000003' and status='active');
insert into r(label,ok) select 'an unredeemed gift is untouched by retention', (select status='paid' and code_lookup is not null from mission_gifts where id='ab000000-0000-4000-8000-000000000001');
insert into r(label,ok) select 'every run is recorded with its counts', exists (select 1 from retention_runs where results ? 'child_sign_in_attempts_deleted' and results ? 'closures_overdue');
-- A security-logs hold pauses pruning.
insert into child_auth_attempts (lookup_key, succeeded, occurred_at) values ('old-held', false, now() - interval '200 days');
insert into retention_holds (subject_type, subject_id, reason) values ('security_logs', null, 'Investigation 7');
create temp table run_held as select privacy_retention_run() as v;
insert into r(label,ok) select 'a security-logs hold keeps old logs, and the run says so',
  exists (select 1 from child_auth_attempts where lookup_key='old-held') and (select v->>'security_logs'='held' from run_held);
-- Nothing in the retention job reads inactivity.
insert into r(label,ok) select 'the retention job never reads activity dates',
  pg_get_functiondef('privacy_retention_run()'::regprocedure) !~ '(last_activity_at|last_seen_at|last_sign_in|last_used_at)';

-- ============================================== 4. WHOLE ACCOUNT: P ==
insert into ids select 'p', deletion_id from privacy_begin_closure('parent_account','aa000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000001','parent');
insert into r(label,ok) select 'closing the account covers every remaining child', (select child_ids = array['cc000000-0000-4000-8000-000000000002']::uuid[] from privacy_deletions where id=(select v from ids where k='p'));
insert into r(label,ok) select 'beginning again returns the same request, not a second one',
  (select deletion_id=(select v from ids where k='p') from privacy_begin_closure('parent_account','aa000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000001','parent'))
  and (select count(*)=1 from privacy_deletions where subject_id='aa000000-0000-4000-8000-000000000001' and status<>'completed');
delete from storage.objects where bucket_id='mission-evidence' and name like 'cc000000-0000-4000-8000-000000000002/%';
select privacy_record_files((select v from ids where k='p'), 'mission-evidence', (select array_agg(path) from privacy_pending_files((select v from ids where k='p'))), '{}', null);
insert into r(label,ok) select 'the family''s data is deleted once its files are', privacy_finish_closure((select v from ids where k='p'))='data_deleted';
insert into r(label,ok) select 'not complete while the account itself remains', privacy_complete_closure((select v from ids where k='p'))='not_ready';
insert into r(label,ok) select 'every child and all their records are gone',
  not exists (select 1 from child_profiles where parent_id='aa000000-0000-4000-8000-000000000001')
  and not exists (select 1 from mission_progress where id='ee000000-0000-4000-8000-000000000002')
  and not exists (select 1 from board_contributions where child_id='cc000000-0000-4000-8000-000000000002');
insert into r(label,ok) select 'paid orders stay as financial records, with no family at all',
  (select bool_and(parent_id is null and child_id is null and paid_at is not null and amount_minor=1200) and count(*)=2
     from checkout_intents where stripe_session_id in ('cs_p1_paid','cs_p2_paid'));
insert into r(label,ok) select 'a gift they bought still works for whoever holds the code, without the buyer or their copy',
  (select status='paid' and purchaser_id is null and code_ciphertext is null and code_lookup is not null from mission_gifts where id='ab000000-0000-4000-8000-000000000001');
insert into r(label,ok) select 'and can still be entered', confirm_gift_code((select code from gift_code),'198.51.100.77','claim-after-closure')='matched';
-- The server deletes the auth user; the profile cascades.
delete from auth.users where id='aa000000-0000-4000-8000-000000000001';
insert into r(label,ok) select 'then the closure completes', privacy_complete_closure((select v from ids where k='p'))='completed';
insert into r(label,ok) select 'the account is gone, and the other family is still whole',
  not exists (select 1 from profiles where id='aa000000-0000-4000-8000-000000000001')
  and exists (select 1 from child_profiles where id='cc000000-0000-4000-8000-000000000003')
  and (select count(*)=2 from storage.objects where bucket_id='mission-evidence' and name like 'cc000000-0000-4000-8000-000000000003/%');
insert into r(label,ok) select 'nothing of the closed family''s name remains in the ledger',
  not exists (select 1 from privacy_deletions d where d.summary::text ~* '(Pia|Paz|Pat|priv-p)');

-- ================================================ 5. AFTER A RESTORE ==
-- A restored backup brings back what the requests deleted.
insert into auth.users (id, email, aud, role, instance_id, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('aa000000-0000-4000-8000-000000000001','priv-p@wla-local.test','authenticated','authenticated','00000000-0000-0000-0000-000000000000','',now(),now(),'{}','{}');
insert into child_profiles (id, parent_id, display_name) values
 ('cc000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000001','Pia'),
 ('cc000000-0000-4000-8000-000000000002','aa000000-0000-4000-8000-000000000001','Paz');
insert into storage.objects (bucket_id, name) values ('mission-evidence','cc000000-0000-4000-8000-000000000002/restored/file.jpg');
-- The in-database safeguard (a restore of a backup newer than every deletion)
-- reopens the request rather than deleting rows itself, which could leave an
-- auth user without a profile (S1). The server's follow-up then finishes it.
-- An older backup needs the external ledger instead: that is tested in
-- scripts/run-privacy-restore-simulation.sh (D-157).
create temp table reapplied as select privacy_reapply_deletions() as v;
insert into r(label,ok) select 'the safeguard reopens each completed request whose family came back: the account, and the child removed before it',
  (select (v->>'requests_reopened')::int = 2 from reapplied)
  and (select count(*) = 2 from privacy_deletions where step = 'replayed' and status = 'in_progress'
        and parent_id = 'aa000000-0000-4000-8000-000000000001')
  and (select status = 'in_progress' and completed_at is null from privacy_deletions where id = (select v from ids where k = 'p'));
insert into r(label,ok) select 'and at once makes them unusable again, listing the restored file for removal',
  (select bool_and(closing_at is not null) from child_profiles where parent_id = 'aa000000-0000-4000-8000-000000000001')
  and exists (select 1 from privacy_deletion_files where deletion_id = (select v from ids where k = 'p')
                and path = 'cc000000-0000-4000-8000-000000000002/restored/file.jpg');
insert into r(label,ok) select 'it never deletes a profile while leaving the auth user',
  exists (select 1 from profiles where id = 'aa000000-0000-4000-8000-000000000001')
  = exists (select 1 from auth.users where id = 'aa000000-0000-4000-8000-000000000001');
-- The server's follow-up: the file through the Storage API, the data, the auth user.
delete from storage.objects where bucket_id = 'mission-evidence' and name = 'cc000000-0000-4000-8000-000000000002/restored/file.jpg';
select privacy_record_files((select v from ids where k = 'p'), 'mission-evidence', array['cc000000-0000-4000-8000-000000000002/restored/file.jpg'], '{}', null);
select privacy_finish_closure((select v from ids where k = 'p'));
delete from auth.users where id = 'aa000000-0000-4000-8000-000000000001';
select privacy_complete_closure((select v from ids where k = 'p'));
insert into r(label,ok) select 'which deletes every child, the account and the file again',
  not exists (select 1 from child_profiles where id in ('cc000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000002'))
  and not exists (select 1 from profiles where id = 'aa000000-0000-4000-8000-000000000001')
  and not exists (select 1 from storage.objects where name like 'cc000000-0000-4000-8000-000000000002/%')
  and (select status = 'completed' from privacy_deletions where id = (select v from ids where k = 'p'));
insert into r(label,ok) select 'it leaves families that weren''t deleted alone', exists (select 1 from child_profiles where id='cc000000-0000-4000-8000-000000000003');

-- ================================================ 6. MISSION BOARD (D-151) ==
insert into r(label,ok) select 'the anonymity check flags names, schools and places it still finds',
  private.board_flags('We met at Oakfield Primary, Year 6, on Mill Road. Ask Sam Jones.') @> array['school','location','possible_full_name']
  and private.board_flags('I am 11 and my brother Tom helped') @> array['names','age']
  and private.board_flags('[removed] me on instagram') @> array['contact']
  and private.board_flags('We tried two ways and the second was fairer.') = '{}';
-- Quin stands in for an ordinary family here. Q's closure in section 2 would
-- otherwise keep the profile out of the family's reach (closing_at), which is
-- not what this section tests.
-- Closure withdrew its permission too (D-156): restored here with it.
update child_profiles set closing_at = null where id='cc000000-0000-4000-8000-000000000003';
update board_contributions set status = 'pending_moderation', permitted_at = now()
 where child_id = 'cc000000-0000-4000-8000-000000000003' and status = 'pending_permission';
insert into ids select 'board_q', id from board_contributions where child_id='cc000000-0000-4000-8000-000000000003';
update board_contributions set text='We met at Oakfield Primary, Year 6, on Mill Road.' where id=(select v from ids where k='board_q');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aa000000-0000-4000-8000-000000000009","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000009',true);
do $$ begin
  begin perform admin_board_moderate((select v from ids where k='board_q'),'publish',null,null,null,false);
        insert into r(label,ok) values ('publishing without the moderator''s anonymity confirmation is refused', false);
  exception when sqlstate '22023' then insert into r(label,ok) values ('publishing without the moderator''s anonymity confirmation is refused', true); end;
end $$;
do $$ begin insert into r(label,ok) select 'the moderator sees the flags', (select flags @> array['school'] from admin_board_queue() where id=(select v from ids where k='board_q')); end $$;
select admin_board_moderate((select v from ids where k='board_q'),'keep_private',null,null,null,false);
reset role;
insert into r(label,ok) select 'what can''t be made anonymous stays private, with the reason',
  (select status='rejected' and rejected_reason='cannot_anonymise' and moderated_at is not null from board_contributions where id=(select v from ids where k='board_q'));
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aa000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000002',true);
do $$ begin insert into r(label,ok) select 'the family sees it was kept private, and when the copy will be deleted',
  (select rejected_reason='cannot_anonymise' and delete_after between now() + interval '29 days' and now() + interval '31 days' from board_family_contributions() where id=(select v from ids where k='board_q')); end $$;
reset role;
-- A clean one, published with confirmation, then removed on request.
update board_contributions set status='pending_moderation', text='We tried two ways.', rejected_reason=null where id=(select v from ids where k='board_q');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aa000000-0000-4000-8000-000000000009","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000009',true);
select admin_board_moderate((select v from ids where k='board_q'),'publish',null,null,null,true);
reset role;
insert into r(label,ok) select 'with the confirmation it publishes, recording who checked and when',
  (select status='published' and anonymity_checked_at is not null and anonymity_checked_by='aa000000-0000-4000-8000-000000000009' from board_contributions where id=(select v from ids where k='board_q'));
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aa000000-0000-4000-8000-000000000009","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000009',true);
select admin_board_moderate((select v from ids where k='board_q'),'remove',null,null,null,false);
reset role;
insert into r(label,ok) select 'a valid removal request deletes a published contribution', not exists (select 1 from board_contributions where id=(select v from ids where k='board_q'));
do $$ begin
  begin insert into board_contributions (child_id, mission_id, evidence_id, text, status)
        select child_id, mission_id, id, 'unchecked', 'published' from mission_evidence
         where child_id='cc000000-0000-4000-8000-000000000003' and type='physical';
        insert into r(label,ok) values ('the schema refuses a published contribution nobody checked', false);
  exception when check_violation then insert into r(label,ok) values ('the schema refuses a published contribution nobody checked', true); end;
end $$;

-- ------------------------------- a profile being deleted is out of reach --
-- Family S: Sol is being removed (the deletion has begun but not finished, as
-- after a failed step or under a hold); Sky is not.
insert into auth.users (id, email, aud, role, instance_id, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data) values
 ('aa000000-0000-4000-8000-000000000003','priv-s@wla-local.test','authenticated','authenticated','00000000-0000-0000-0000-000000000000','',now(),now(),'{}','{}');
insert into child_profiles (id, parent_id, display_name) values
 ('cc000000-0000-4000-8000-000000000007','aa000000-0000-4000-8000-000000000003','Sol'),
 ('cc000000-0000-4000-8000-000000000008','aa000000-0000-4000-8000-000000000003','Sky');
insert into mission_progress (id, child_id, mission_id, status, last_activity_at)
values ('ee000000-0000-4000-8000-000000000007','cc000000-0000-4000-8000-000000000007','dd000000-0000-4000-8000-000000000001','in_progress', now());
select privacy_begin_closure('child_profile','cc000000-0000-4000-8000-000000000007','aa000000-0000-4000-8000-000000000003','parent');
insert into r(label,ok) select 'beginning a deletion marks the profile as closing, and only that one',
  (select closing_at is not null from child_profiles where id='cc000000-0000-4000-8000-000000000007')
  and (select closing_at is null from child_profiles where id='cc000000-0000-4000-8000-000000000008');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aa000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000003',true);
do $$ begin
  insert into r(label,ok) select 'the parent no longer sees it; its sibling is still there',
    (select array_agg(display_name) from child_profiles) = array['Sky'];
  insert into r(label,ok) select 'nor its mission runs, through owns_child and owns_progress',
    not owns_child('cc000000-0000-4000-8000-000000000007') and not owns_progress('ee000000-0000-4000-8000-000000000007')
    and owns_child('cc000000-0000-4000-8000-000000000008')
    and not exists (select 1 from mission_progress where id='ee000000-0000-4000-8000-000000000007');
  begin perform issue_child_access_code('cc000000-0000-4000-8000-000000000007');
        insert into r(label,ok) values ('no new access code can be made for it', false);
  exception when insufficient_privilege then insert into r(label,ok) values ('no new access code can be made for it', true); end;
  begin perform board_offer('cc000000-0000-4000-8000-000000000007',(select id from mission_evidence limit 1));
        insert into r(label,ok) values ('nor can it be offered to the Board', false);
  exception when insufficient_privilege or undefined_function then insert into r(label,ok) values ('nor can it be offered to the Board', true); end;
  update child_profiles set closing_at = null where id='cc000000-0000-4000-8000-000000000007';
  begin update child_profiles set closing_at = now() where id='cc000000-0000-4000-8000-000000000008';
        insert into r(label,ok) values ('a parent can neither reopen a closing profile nor mark one', false);
  exception when insufficient_privilege or check_violation then insert into r(label,ok) values ('a parent can neither reopen a closing profile nor mark one', true); end;
end $$;
reset role;
insert into r(label,ok) select 'the closing profile is untouched otherwise, ready for the deletion to finish',
  (select closing_at is not null from child_profiles where id='cc000000-0000-4000-8000-000000000007')
  and (select closing_at is null from child_profiles where id='cc000000-0000-4000-8000-000000000008')
  and exists (select 1 from mission_progress where id='ee000000-0000-4000-8000-000000000007');
insert into mission_gifts (mission_id,stripe_session_id,amount_minor,currency,early_supply_consent_at,cancellation_ack_at,consent_wording)
values ('dd000000-0000-4000-8000-000000000001','cs_priv_s',1200,'GBP',now(),now(),'v | a | b');
select confirm_gift_code((select code from activate_paid_gift('cs_priv_s','pi_priv_s')),'203.0.113.77','claim-priv-s');
insert into r(label,ok) select 'a gift can''t be redeemed for it',
  redeem_mission_gift('claim-priv-s','cc000000-0000-4000-8000-000000000007','aa000000-0000-4000-8000-000000000003') = 'forbidden';
insert into r(label,ok) select 'and stays usable', (select status = 'paid' from mission_gifts where stripe_session_id='cs_priv_s');

select (case when ok then 'PASS' else 'FAIL' end) || '  ' || label from r order by n;
select 'PASS: ' || count(*) filter (where ok) || '   FAIL: ' || count(*) filter (where not ok) from r;
rollback;

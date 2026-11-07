-- ===========================================================================
-- WLA SECURITY REGRESSION — executed, not read.
--
-- Every check below RUNS against a real PostgreSQL cluster with the real
-- migrations and seeds applied, acting as real non-owner roles with real JWT
-- claims, so RLS and `security definer` behave exactly as they do hosted.
--
-- This exists because source-text guards in this codebase have repeatedly
-- proved presence rather than behaviour. Three of the defects found while
-- building the LMS layer — the rate limiter that never engaged, the OUT
-- parameter collisions, the non-recursive reachability CTE — all passed
-- review and failed on first execution.
--
-- Run with: scripts/run-security-regression.sh
-- Output is one line per check. Any FAIL is a defect.
-- ===========================================================================
\set ON_ERROR_STOP off
\set QUIET on
\pset tuples_only on
\pset format unaligned

create or replace function chk(p_label text, p_ok boolean) returns void
language plpgsql as $$
begin
  raise notice '%  %', case when p_ok then 'PASS' else 'FAIL' end, p_label;
end $$;

-- Run a statement and report whether it raised the error we required.
create or replace function chk_raises(p_label text, p_sql text, p_expect text)
returns void language plpgsql as $$
begin
  execute p_sql;
  perform chk(p_label || ' (expected refusal, got success)', false);
exception when others then
  perform chk(p_label, position(p_expect in sqlerrm) > 0
                    or position(p_expect in sqlstate) > 0);
end $$;

create or replace function chk_ok(p_label text, p_sql text)
returns void language plpgsql as $$
begin
  execute p_sql;
  perform chk(p_label, true);
exception when others then
  perform chk(p_label || ' -> ' || sqlerrm, false);
end $$;

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001','admin@t.test'),
  ('aaaaaaaa-0000-0000-0000-000000000002','parent1@t.test'),
  ('aaaaaaaa-0000-0000-0000-000000000003','parent2@t.test')
on conflict do nothing;
insert into profiles (id,email,is_admin) values
  ('aaaaaaaa-0000-0000-0000-000000000001','admin@t.test',true),
  ('aaaaaaaa-0000-0000-0000-000000000002','parent1@t.test',false),
  ('aaaaaaaa-0000-0000-0000-000000000003','parent2@t.test',false)
on conflict (id) do update set is_admin = excluded.is_admin;
insert into child_profiles (id,parent_id,display_name) values
  ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002','ChildA'),
  ('bbbbbbbb-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002','SiblingB'),
  ('bbbbbbbb-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000003','OtherFamily')
on conflict do nothing;
insert into mission_entitlements (child_id,mission_id,source)
  select 'bbbbbbbb-0000-0000-0000-000000000001', id, 'admin' from missions where slug='six-names'
on conflict do nothing;

\echo ''
\echo '=============== CHILD CODE / SESSION ==============='
-- A code is issued by the owning parent only.
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000003';
select chk_raises('another family cannot mint a code for ChildA',
  $$select generate_child_access_code('bbbbbbbb-0000-0000-0000-000000000001')$$,
  'not_your_child');

set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000002';
select generate_child_access_code('bbbbbbbb-0000-0000-0000-000000000001') as code \gset
select generate_child_access_code('bbbbbbbb-0000-0000-0000-000000000002') as codeb \gset

-- Plaintext is nowhere in the table.
reset role;
select chk('plaintext code is not stored anywhere',
  not exists (
    select 1 from child_access_credentials
    where code_hash like '%' || replace(:'code','-','') || '%'
       or code_lookup like '%' || replace(:'code','-','') || '%'));

select chk('code is bcrypt',
  (select code_hash like '$2%' from child_access_credentials
    where child_id='bbbbbbbb-0000-0000-0000-000000000001' and revoked_at is null));

-- Redemption as a genuine anonymous caller.
set request.jwt.claim.sub = '';
set role anon;
select chk('anon cannot read child_profiles', (select count(*) = 0 from child_profiles));
select chk('anon cannot read mission_progress', (select count(*) = 0 from mission_progress));
select chk_raises('anon cannot read the pepper', $$select * from app_secrets$$, 'permission denied');

select outcome as o1 from redeem_child_code(:'code') \gset
select chk('valid code redeems', :'o1' = 'ok');
select token as tok from redeem_child_code(:'code') \gset
select token as tokb from redeem_child_code(:'codeb') \gset

select chk('session resolves to exactly one child',
  (select count(*) = 1 from verify_child_session(:'tok')));
select chk('session resolves to the RIGHT child',
  (select display_name = 'ChildA' from verify_child_session(:'tok')));
select chk('a forged token resolves to nobody',
  (select count(*) = 0 from verify_child_session('0000deadbeef0000')));
select chk('an empty token resolves to nobody',
  (select count(*) = 0 from verify_child_session('')));

-- Brute force: the limiter must actually engage.
select outcome as b1 from redeem_child_code('ZZZZ-ZZZ2') \gset
select outcome as b2 from redeem_child_code('ZZZZ-ZZZ2') \gset
select outcome as b3 from redeem_child_code('ZZZZ-ZZZ2') \gset
select outcome as b4 from redeem_child_code('ZZZZ-ZZZ2') \gset
select outcome as b5 from redeem_child_code('ZZZZ-ZZZ2') \gset
select outcome as b6 from redeem_child_code('ZZZZ-ZZZ2') \gset
select chk('wrong code is refused', :'b1' = 'invalid_code');
select chk('brute force is rate limited after 5 tries', :'b6' = 'rate_limited');
select chk('the limiter is per-code, not a global lockout',
  (select outcome = 'ok' from redeem_child_code(:'codeb')));

\echo ''
\echo '=============== CHILD AUTHORIZATION ==============='
select chk('child sees only their own entitled missions',
  (select count(*) = 1 from child_session_missions(:'tok')));
select chk('a child with no entitlement sees nothing',
  (select count(*) = 0 from child_session_missions(:'tokb')));

reset role;
select id as mid from missions where slug='six-names' \gset
set role anon;

select chk_ok('child can start their own mission',
  format($$select child_session_start_mission(%L, %L)$$, :'tok', :'mid'));
select chk('child receives exactly ONE screen',
  (select count(*) = 1 from child_session_current_screen(:'tok', :'mid')));

reset role;
select id as pid from mission_progress where child_id='bbbbbbbb-0000-0000-0000-000000000001' \gset
set role anon;

-- Forged progress id: holding one is not authorisation.
select chk_raises('sibling cannot persist onto another child progress id',
  format($$select child_session_persist_state(%L, %L, '{}'::jsonb, 'the_list')$$, :'tokb', :'pid'),
  'permission denied');
select chk_raises('sibling cannot complete another child run',
  format($$select child_session_complete_mission(%L, %L, '{}'::jsonb)$$, :'tokb', :'pid'),
  'permission denied');
select chk_raises('a forged token cannot start anything',
  format($$select child_session_start_mission('not-a-token', %L)$$, :'mid'),
  'no_child_session');

-- Forged mission id / entitlement.
select chk_raises('child cannot open a mission they are not entitled to',
  format($$select * from child_session_current_screen(%L, %L)$$, :'tokb', :'mid'),
  'not_entitled');

-- The actor GUC must not survive outside a wrapper.
select chk('the child actor GUC is empty between calls',
  coalesce(current_setting('app.child_actor', true), '') = '');
select chk('anon still cannot read mission_progress after using a session',
  (select count(*) = 0 from mission_progress));

-- Revocation kills a live session immediately.
reset role;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000002';
set role authenticated;
select revoke_child_access_code('bbbbbbbb-0000-0000-0000-000000000001');
reset role; set request.jwt.claim.sub = ''; set role anon;
select chk('revoking a code kills its open session at once',
  (select count(*) = 0 from verify_child_session(:'tok')));
select chk('the revoked code no longer redeems',
  (select outcome = 'invalid_code' from redeem_child_code(:'code')));

\echo ''
\echo '=============== PARENT / FAMILY BOUNDARY ==============='
reset role;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000003';
set role authenticated;
select chk('a parent sees only their own children',
  (select count(*) = 1 from child_profiles));
select chk_raises('a parent cannot open another family child mission',
  format($$select * from get_current_mission_screen('bbbbbbbb-0000-0000-0000-000000000001', %L)$$, :'mid'),
  'not_your_child');
select chk_raises('a parent cannot start a mission for another family child',
  format($$select start_mission('bbbbbbbb-0000-0000-0000-000000000001', %L)$$, :'mid'),
  'not_your_child');
select chk_raises('a parent cannot persist onto another family run',
  format($$select persist_mission_state(%L, '{}'::jsonb, 'the_list')$$, :'pid'),
  'permission denied');

\echo ''
\echo '=============== ADMIN ESCALATION ==============='
select chk_raises('a parent cannot read the admin catalogue',
  $$select * from admin_mission_stats()$$, 'not_admin');
select chk_raises('a parent cannot read the parent list',
  $$select * from admin_parents()$$, 'not_admin');
select chk_raises('a parent cannot read the children list',
  $$select * from admin_children()$$, 'not_admin');
select chk_raises('a parent cannot read orders',
  $$select * from admin_orders()$$, 'not_admin');
select chk_raises('a parent cannot create a mission',
  $$select create_mission('x-mission','X','curiosity',7,11)$$, 'not_admin');
select chk_raises('a parent cannot create a version',
  format($$select create_mission_version(%L)$$, :'mid'), 'not_admin');
select chk_raises('a parent cannot author a screen',
  format($$select admin_upsert_screen(%L,2,'x','content','','',1,'{}'::jsonb)$$, :'mid'),
  'not_admin');
select chk_raises('a parent cannot publish a version',
  format($$select set_mission_version_status(%L,2,'published')$$, :'mid'), 'not_admin');
select chk_raises('a parent cannot delete a mission',
  format($$select delete_mission_if_unused(%L)$$, :'mid'), 'not_admin');

-- D-49: privilege escalation via a direct profile write.
select chk_raises('a parent cannot make themselves an admin',
  $$update profiles set is_admin = true where id = auth.uid()$$, '42501');
reset role;
select chk('is_admin did not change',
  (select not is_admin from profiles where id='aaaaaaaa-0000-0000-0000-000000000003'));

\echo ''
\echo '=============== ADMIN BOUNDARIES ==============='
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
set role authenticated;
-- D-52: an admin must have no read path to mission_screens.
select chk('an admin cannot read mission_screens directly',
  (select count(*) = 0 from mission_screens));
select chk_raises('an admin cannot read a PUBLISHED version through the builder',
  format($$select * from admin_draft_screens(%L, 2)$$, :'mid'),
  'version_not_editable');
-- D-54: an admin cannot mutate structural columns on missions.
select chk_raises('an admin cannot change a mission version number by hand',
  format($$update missions set version = 99 where id = %L$$, :'mid'), '42501');
/*
 * A DELETE that RLS filters down to zero rows does NOT raise — it reports
 * success having removed nothing. Asserting on the error is therefore the
 * wrong test (it is the same false positive that made two earlier PostgREST
 * checks look like holes). Assert that the row is still there instead.
 */
select chk_ok('delete from missions is filtered, not refused',
  format($$delete from missions where id = %L$$, :'mid'));
reset role;
select chk('an admin DELETE removed no mission row',
  (select count(*) = 1 from missions where id = :'mid'));
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001'; set role authenticated;
reset role;
select chk('mission version is unchanged',
  (select version = 2 from missions where slug = 'six-names'));

\echo ''
\echo '=============== VERSION IMMUTABILITY & PINNING ==============='
select chk_raises('a published version screen cannot be UPDATED',
  $$update mission_screens set title='x' where version=2 and screen_key='the_list'$$,
  'cannot be modified');
select chk_raises('a screen cannot be INSERTED into a published version',
  format($$insert into mission_screens (mission_id,screen_key,type,sequence,version)
           values (%L,'sneak','content',999,2)$$, :'mid'),
  'cannot be modified');
select chk_raises('a published version screen cannot be DELETED',
  $$delete from mission_screens where version=2 and screen_key='the_list'$$,
  'cannot be modified');
select chk_raises('an archived version is equally immutable',
  $$update mission_screens set title='x' where version=1 and screen_key='mission_brief'$$,
  'cannot be modified');
select chk_raises('a published completion rule cannot be rewritten',
  $$update mission_versions set completion_rule='{"type":"always"}'::jsonb where version=2$$,
  'cannot be changed');
select chk('Six Names v2 is intact',
  (select count(*) = 27 from mission_screens where version = 2));
select chk('Six Names v1 is intact',
  (select count(*) = 21 from mission_screens where version = 1));
select chk('Six Names is NOT published to the catalogue',
  (select not published from missions where slug='six-names'));

\echo ''
\echo '=============== BUILDER LIFECYCLE ==============='
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
set role authenticated;
select id as newmid from create_mission('regression-mission','Regression','curiosity',7,11) \gset
select chk_ok('admin creates a mission with a draft v1',
  format($$select 1 from mission_versions where mission_id=%L and version=1 and status='draft'$$, :'newmid'));
select chk('a new draft fails validation (no screens, no rule)',
  (select count(*) >= 2 from validate_mission_version(:'newmid', 1) where blocking));
select chk_raises('publishing an invalid draft is refused',
  format($$select set_mission_version_status(%L,1,'published')$$, :'newmid'),
  'validation_failed');

select admin_upsert_screen(:'newmid',1,'intro','content','Intro','Hello',10,'{"next":"finish"}'::jsonb);
select admin_upsert_screen(:'newmid',1,'finish','completion','Done',null,20,'{"trailEntries":[]}'::jsonb);
select admin_set_completion_rule(:'newmid',1,'{"type":"screen_reached","screenKey":"finish"}'::jsonb);
/*
 * A parent note is required to publish, and a Mission Kit is required for a
 * physical or hybrid mission (D-63). The fixture supplies both, because it is
 * testing the SECURITY rules, not the validation rules — leaving them out made
 * five unrelated checks fail on a correct refusal.
 */
select admin_save_parent_note(:'newmid',1,'A short note for the adult helping.',null);
reset role;
update missions set delivery_type = 'digital' where id = :'newmid';
set role authenticated; set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000001';
select chk('a complete draft has no blocking problems',
  (select count(*) = 0 from validate_mission_version(:'newmid',1) where blocking));

-- A broken branch must be caught.
select admin_upsert_screen(:'newmid',1,'intro','content','Intro','Hello',10,'{"next":"nowhere"}'::jsonb);
select chk('a transition to a missing screen is caught',
  (select count(*) > 0 from validate_mission_version(:'newmid',1)
    where blocking and code = 'broken_reference'));
-- Reachability moved to the TypeScript simulation (validator.ts, 0028); the
-- database's guarantee is that a structurally broken version cannot publish,
-- even through a direct RPC call.
select chk_raises('a broken version cannot be published, even by a direct RPC',
  format($$select set_mission_version_status(%L,1,'published')$$, :'newmid'),
  'validation_failed');
select admin_upsert_screen(:'newmid',1,'intro','content','Intro','Hello',10,'{"next":"finish"}'::jsonb);

select chk_ok('a valid draft publishes',
  format($$select set_mission_version_status(%L,1,'published')$$, :'newmid'));
select chk_raises('the published version is now closed to authoring',
  format($$select admin_upsert_screen(%L,1,'x','content','','',99,'{}'::jsonb)$$, :'newmid'),
  'version_not_editable');
select chk_raises('a published version cannot go back to draft',
  format($$select set_mission_version_status(%L,1,'draft')$$, :'newmid'),
  'illegal_transition');

-- Version pinning across a publish (D-17).
-- Entitlements are written by the Stripe webhook under the service role, never
-- by a parent, so the fixture grants it as the owner before acting as the
-- parent. Writing it as `authenticated` silently affected zero rows under RLS
-- and made the pinning check below look like a product failure.
reset role;
insert into mission_entitlements (child_id,mission_id,source)
  values ('bbbbbbbb-0000-0000-0000-000000000002', :'newmid', 'admin') on conflict do nothing;
select chk('fixture: sibling is entitled to the regression mission',
  (select count(*) = 1 from mission_entitlements
    where child_id='bbbbbbbb-0000-0000-0000-000000000002' and mission_id=:'newmid'));
set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000002'; set role authenticated;
select chk_ok('sibling starts the regression mission',
  format($$select start_mission('bbbbbbbb-0000-0000-0000-000000000002', %L)$$, :'newmid'));
reset role; set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000001'; set role authenticated;
select create_mission_version(:'newmid');
select admin_set_completion_rule(:'newmid',2,'{"type":"screen_reached","screenKey":"finish"}'::jsonb);
select set_mission_version_status(:'newmid',2,'published');
reset role;
select chk('D-17: a run in flight keeps its pinned version across a publish',
  (select mission_version = 1 from mission_progress
    where child_id='bbbbbbbb-0000-0000-0000-000000000002' and mission_id=:'newmid'));
select chk('the superseded version is archived, not deleted',
  (select status = 'archived' from mission_versions where mission_id=:'newmid' and version=1));
select chk('new runs now get the new version',
  (select version = 2 from missions where id=:'newmid'));

\echo ''
\echo '=============== SAFE DELETION ==============='
set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000001'; set role authenticated;
select chk_raises('a mission with learner records cannot be deleted',
  format($$select delete_mission_if_unused(%L)$$, :'newmid'),
  'mission_has_learner_records');
select chk_raises('Six Names cannot be deleted',
  format($$select delete_mission_if_unused(%L)$$, :'mid'),
  'mission_has_learner_records');
select id as unused from create_mission('unused-mission','Unused','curiosity',7,11) \gset
select chk('an untouched mission can be deleted',
  (select delete_mission_if_unused(:'unused')));
reset role;
select chk('Six Names survived the whole regression',
  (select count(*) = 1 from missions where slug='six-names'));

\echo ''
\echo '=============== STORAGE / MISSION KIT ==============='
set request.jwt.claim.sub = ''; set role anon;
select chk('anon cannot list mission resources',
  (select count(*) = 0 from mission_resources));
reset role; set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000003'; set role authenticated;
select chk('a parent with no entitlement sees no resources for it',
  (select count(*) = 0 from mission_resources r where r.mission_id = :'mid'));
reset role;
\echo ''

\echo '=============== KIT FILES FOLLOW THE VERSION (D-68) ==============='
-- The rows were immutable (D-63); the OBJECTS were not. These act on
-- storage.objects directly, as the storage API does on a client's behalf.
reset role;
insert into storage.buckets (id, name, public) values ('mission-resources','mission-resources',false)
  on conflict do nothing;
select storage_path as pubpath from mission_resources r
  join mission_versions mv on mv.mission_id=r.mission_id and mv.version=r.version
 where r.mission_id = :'mid' and mv.status = 'published' limit 1 \gset
insert into storage.objects (bucket_id, name) values
  ('mission-resources', :'pubpath'),
  ('mission-resources', :'mid' || '/draft-secret.pdf'),
  ('mission-resources', :'mid' || '/orphan.pdf');

-- A draft version of Six Names with a new printable in the same folder.
set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000001'; set role authenticated;
select create_mission_version(:'mid');
select max(version) as draftv from mission_versions where mission_id = :'mid' \gset
select chk('fixture: Six Names has a new DRAFT version',
  (select status = 'draft' from mission_versions where mission_id = :'mid' and version = :draftv));
select admin_upsert_resource(:'mid', :draftv, null, 'Draft secret', null, 'pdf',
  :'mid' || '/draft-secret.pdf', true, true, true, 999);
select chk('fixture: the draft file is referenced by the draft version',
  (select count(*) = 1 from mission_resources where mission_id = :'mid' and version = :draftv
     and storage_path = :'mid' || '/draft-secret.pdf'));
select chk('admin can read a draft Kit file (needed to preview it)',
  (select count(*) = 1 from storage.objects where name = :'mid' || '/draft-secret.pdf'));

-- ParentA's ChildA is entitled to Six Names.
reset role; set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000002'; set role authenticated;
select chk('an entitled parent can read a PUBLISHED Kit file',
  (select count(*) = 1 from storage.objects where name = :'pubpath'));
select chk('an entitled parent cannot read a DRAFT Kit file in the same folder',
  (select count(*) = 0 from storage.objects where name = :'mid' || '/draft-secret.pdf'));
select chk('an entitled parent cannot read an unreferenced file in the folder',
  (select count(*) = 0 from storage.objects where name = :'mid' || '/orphan.pdf'));
select chk_raises('the release helper is not callable as an RPC from public',
  $$select public.mission_file_released('mission-resources','x')$$, 'does not exist');

reset role; set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000003'; set role authenticated;
select chk('another family cannot read the published Kit file',
  (select count(*) = 0 from storage.objects where name = :'pubpath'));

reset role; set request.jwt.claim.sub = ''; set role anon;
select chk('anon cannot read any Kit file',
  (select count(*) = 0 from storage.objects where bucket_id = 'mission-resources'));

-- Admin cannot rewrite or remove what a released version depends on.
reset role; set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000001'; set role authenticated;
update storage.objects set metadata = '{"tampered":true}' where name = :'pubpath';
delete from storage.objects where name = :'pubpath';
reset role;
select chk('admin cannot overwrite a published Kit file',
  (select metadata is null from storage.objects where name = :'pubpath'));
select chk('admin cannot delete a published Kit file',
  (select count(*) = 1 from storage.objects where name = :'pubpath'));

set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000001'; set role authenticated;
delete from storage.objects where name = :'mid' || '/orphan.pdf';
reset role;
select chk('admin can delete an orphaned upload',
  (select count(*) = 0 from storage.objects where name = :'mid' || '/orphan.pdf'));

-- Publishing the draft releases its file to entitled families.
set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000001'; set role authenticated;
select set_mission_version_status(:'mid', :draftv, 'published');
reset role; set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000002'; set role authenticated;
select chk('a file becomes readable only once its version is released',
  (select count(*) = 1 from storage.objects where name = :'mid' || '/draft-secret.pdf'));
reset role;
\echo ''

\echo '=============== SERVER-AUTHORITATIVE STATE (D-80) ==============='
-- The hole this closes: a family writing ITS OWN run directly — skipping to
-- Evidence, landing on the unused consequence, or completing without playing.
reset role;
select id as ownpid from mission_progress where child_id='bbbbbbbb-0000-0000-0000-000000000001' limit 1 \gset
set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000002'; set role authenticated;
select chk('fixture: the parent can still READ their own run', (select count(*) >= 1 from mission_progress));
select chk_raises('a parent cannot PATCH their own run''s screen (skip to Evidence)',
  format($$update mission_progress set current_screen_key = 'evidence' where id = %L$$, :'ownpid'), 'permission denied');
select chk_raises('a parent cannot mark their own run complete directly',
  format($$update mission_progress set status = 'complete' where id = %L$$, :'ownpid'), 'permission denied');
select chk_raises('a parent cannot write their own mission_state',
  format($$update mission_state set state_data = '{}'::jsonb where progress_id = %L$$, :'ownpid'), 'permission denied');
select chk_raises('a parent cannot insert evidence directly',
  format($$insert into mission_evidence (child_id, mission_id, type, title) select child_id, mission_id, 'physical', 'forged' from mission_progress where id = %L$$, :'ownpid'), 'permission denied');
select chk_raises('a parent cannot write responses directly',
  format($$insert into mission_responses (progress_id, screen_key, value) values (%L, 'x', '"y"')$$, :'ownpid'), 'permission denied');
select chk_raises('a parent cannot call persist_mission_state on their OWN run',
  format($$select persist_mission_state(%L, '{}'::jsonb, 'evidence')$$, :'ownpid'), 'permission denied');
select chk_raises('a parent cannot call complete_mission on their OWN run',
  format($$select complete_mission(%L, '{}'::jsonb, '[]'::jsonb)$$, :'ownpid'), 'permission denied');
select chk_raises('a parent cannot call the engine store',
  format($$select engine_save(%L, '{}', '{}', 'evidence', null, null, true, '[]', '[]')$$, :'ownpid'), 'permission denied');
select chk_raises('a parent cannot load the whole pinned model',
  format($$select engine_load_run(%L)$$, :'ownpid'), 'permission denied');
select chk_raises('a parent cannot read private run state',
  $$select * from mission_state_private$$, 'permission denied');
select chk_raises('a parent cannot record analytics directly',
  format($$select engine_record_events(%L, '[]')$$, :'ownpid'), 'permission denied');
select chk_raises('a parent cannot read a version definition',
  $$select definition from mission_versions$$, 'permission denied');
select chk_raises('a parent cannot read mission insights',
  format($$select admin_mission_insights(%L)$$, :'mid'), 'not_admin');
select chk_ok('version metadata is still readable by column',
  $$select id, status from mission_versions$$);
reset role; set request.jwt.claim.sub = ''; set role anon;
select chk_raises('anon cannot call the engine store',
  format($$select engine_save(%L, '{}', '{}', 'evidence', null, null, true, '[]', '[]')$$, :'ownpid'), 'permission denied');
reset role; set role service_role;
select chk_ok('the server role can load a run', format($$select engine_load_run(%L)$$, :'ownpid'));
select chk('the loaded run carries the whole pinned model server-side',
  (select jsonb_array_length(engine_load_run(:'ownpid')->'screens') > 0));
reset role;
select chk('analytics detail cannot carry free-text keys (D-76)',
  not exists (select 1 from pg_constraint where conname = 'analytics_events_detail_keys_check') = false);
do $$ begin
  insert into analytics_events (name, mission_id, mission_version, detail)
    select 'screen_entered', id, 1, '{"child":"x"}'::jsonb from missions limit 1;
  perform chk('an analytics row with a non-allow-listed detail key is refused', false);
exception when check_violation then
  perform chk('an analytics row with a non-allow-listed detail key is refused', true);
end $$;
\echo ''
\echo '=============== MISSION DUPLICATION (0030) ==============='
reset role; set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000002'; set role authenticated;
select chk_raises('a parent cannot duplicate a mission',
  format($$select admin_duplicate_mission(%L, 'copy-x', 'Copy')$$, :'mid'), 'not_admin');
reset role; set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000001'; set role authenticated;
select admin_duplicate_mission(:'mid', 'six-names-copy', 'Six Names copy', 2) as dup \gset
reset role;
select (:'dup'::jsonb->>'id') as dupid \gset
select chk('the copy is unpublished at a v1 draft',
  (select not published and version = 1 from missions where id = :'dupid')
  and (select status = 'draft' from mission_versions where mission_id = :'dupid' and version = 1));
select chk('the copy has the source version''s screens',
  (select count(*) from mission_screens where mission_id = :'dupid' and version = 1)
  = (select count(*) from mission_screens where mission_id = :'mid' and version = 2));
select chk('the copy''s Kit paths live in its own folder (D-68)',
  not exists (select 1 from mission_resources where mission_id = :'dupid' and storage_path not like :'dupid' || '/%'));
select chk('no learner records are copied',
  not exists (select 1 from mission_progress where mission_id = :'dupid')
  and not exists (select 1 from mission_entitlements where mission_id = :'dupid'));
select chk('the source is untouched',
  (select published = false and version >= 2 from missions where id = :'mid'));
\echo ''
\echo '=============== INTERACTION LIBRARY (0031) ==============='
reset role;
select screen_key as anykey from mission_screens where mission_id = :'dupid' and version = 1 and type = 'completion' limit 1 \gset
select chk('fixture: the copy has a completion screen to route to', :'anykey' <> '');
set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000001'; set role authenticated;
select admin_upsert_screen(:'dupid', 1, 'lib_code', 'code_entry', 'Code', null, 9001,
  jsonb_build_object('prompt', 'Enter it', 'outcomes', jsonb_build_array(jsonb_build_object('id', 'ok', 'match', '{"values":["x"]}'::jsonb, 'next', :'anykey'))));
select chk('a screen whose only way on is an outcome is not a dead end',
  not exists (select 1 from validate_mission_version(:'dupid', 1) v where v.code = 'dead_end' and v.screen_key = 'lib_code'));
select admin_upsert_screen(:'dupid', 1, 'lib_code', 'code_entry', 'Code', null, 9001,
  '{"prompt":"Enter it","outcomes":[{"id":"ok","match":{"values":["x"]},"next":"nowhere"}],"onNoMatch":{"mode":"retry","fallbackNext":"also_nowhere"}}'::jsonb);
select chk('a broken outcome target is reported by the database gate',
  exists (select 1 from validate_mission_version(:'dupid', 1) v where v.code = 'broken_reference' and v.detail like '%"nowhere"%'));
select chk('a broken no-match fallback is reported by the database gate',
  exists (select 1 from validate_mission_version(:'dupid', 1) v where v.code = 'broken_reference' and v.detail like '%"also_nowhere"%'));
reset role;
select chk('every library type is a screen_type value',
  (select count(*) from unnest(enum_range(null::screen_type)) t
    where t::text in ('numeric_entry','code_entry','token_sequence','arrange','matching','allocate','inventory','compare','hotspot','sketch','map','pattern_grid','simulation','workspace')) = 14);
\echo ''
\echo '=============== MISSION MEDIA (0032) ==============='
reset role; set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000001'; set role authenticated;
select chk_ok('an admin adds media to a draft',
  format($$select admin_upsert_asset(%L, 1, 'bridge', 'image', %L, 'A bridge', null, null, null)$$, :'dupid', :'dupid' || '/media/bridge.png'));
select chk_raises('a media path outside the mission is refused',
  format($$select admin_upsert_asset(%L, 1, 'x', 'image', 'elsewhere/x.png', 'x', null, null, null)$$, :'dupid'), 'asset_path_outside_mission');
select chk_raises('media cannot be added to a published version',
  format($$select admin_upsert_asset(%L, 2, 'x', 'image', %L, 'x', null, null, null)$$, :'mid', :'mid' || '/x.png'), 'version_not_editable');
select chk_raises('published media cannot be read through authoring (D-61)',
  format($$select * from admin_draft_assets(%L, 2)$$, :'mid'), 'version_not_editable');
select chk_raises('an admin cannot write the table directly',
  format($$insert into mission_assets (mission_id, version, key, kind, storage_path) values (%L, 1, 'y', 'image', %L)$$, :'dupid', :'dupid' || '/y.png'), 'permission denied');
select chk('draft media is readable for the builder',
  (select count(*) = 1 from admin_draft_assets(:'dupid', 1)));
select (create_mission_version(:'dupid', 1)).version as dupv2 \gset
select chk('a new version carries its media',
  (select count(*) = 1 from admin_draft_assets(:'dupid', :dupv2)));
select admin_duplicate_mission(:'dupid', 'six-names-copy-2', 'Copy 2', 1) as dup2 \gset
reset role;
select (:'dup2'::jsonb->>'id') as dup2id \gset
select chk('a duplicate carries its media into its own folder',
  (select count(*) = 1 from mission_assets where mission_id = :'dup2id' and storage_path like :'dup2id' || '/%'));
select chk('the duplicate lists the media file to copy, in the media bucket',
  (select bool_or(f->>'bucket' = 'mission-media') from jsonb_array_elements(:'dup2'::jsonb->'files') f));
insert into storage.objects (bucket_id, name) values ('mission-media', :'dupid' || '/media/bridge.png');
reset role; set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000002'; set role authenticated;
select chk_raises('a parent cannot read the media table',
  $$select * from mission_assets$$, 'permission denied');
select chk_raises('a parent cannot author media',
  format($$select admin_upsert_asset(%L, 1, 'z', 'image', %L, 'z', null, null, null)$$, :'dupid', :'dupid' || '/z.png'), 'not_admin');
select chk('a parent cannot see media files in storage (learners get server-signed URLs only)',
  (select count(*) = 0 from storage.objects where bucket_id = 'mission-media'));
reset role; set request.jwt.claim.sub = ''; set role anon;
select chk_raises('anon cannot read the media table', $$select * from mission_assets$$, 'permission denied');
reset role;
\echo ''
\echo '=============== ANALYTICS NEVER FAIL A SAVE (0033) ==============='
reset role; set role service_role;
select chk_ok('a save with an unlisted analytics event still saves (D-50, D-90)',
  format($$select engine_save(%L, '{"visitedScreens":["d90"]}', '{}', null, null, null, false, '[]', '[{"name":"not_an_event"},{"name":"screen_entered","detail":{"child":"x"}},{"name":"screen_entered","detail":{"screen_type":"content"}}]')$$, :'ownpid'));
reset role;
select chk('the learner state from that save is kept',
  (select state_data->'visitedScreens' ? 'd90' from mission_state where progress_id = :'ownpid'));
select chk('only the allowed event was recorded',
  (select count(*) = 0 from analytics_events where name = 'not_an_event')
  and (select count(*) = 0 from analytics_events where detail ? 'child'));
\echo ''
\echo '=============== CHILD TRAIL v2 (0034) ==============='
reset role;
insert into mission_evidence (id, child_id, mission_id, type, title, description, evidence_key, source)
values ('eeeeeeee-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', :'mid', 'digital', 'First plan', 'Go left', 'plan', 'mission');
insert into mission_evidence (child_id, mission_id, type, title, description, evidence_key, source, related_to, relation)
values ('bbbbbbbb-0000-0000-0000-000000000001', :'mid', 'digital', 'Changed plan', 'Go right', 'plan2', 'mission', 'eeeeeeee-0000-0000-0000-000000000001', 'changed_plan_of');
insert into mission_evidence (child_id, mission_id, type, title, description)
values ('bbbbbbbb-0000-0000-0000-000000000002', :'mid', 'digital', 'Sibling secret', 'not yours');
set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000002';
select generate_child_access_code('bbbbbbbb-0000-0000-0000-000000000001') as code_t \gset
reset role; set request.jwt.claim.sub = ''; set role anon;
select token as tok_t from redeem_child_code(:'code_t') \gset
select chk('the child Trail returns how entries relate',
  exists (select 1 from child_session_trail(:'tok_t', 'six-names') t
          where t.title = 'Changed plan' and t.relation = 'changed_plan_of'
            and t.related_to = 'eeeeeeee-0000-0000-0000-000000000001' and t.source = 'mission'));
select chk('the child Trail never returns a sibling''s entry',
  not exists (select 1 from child_session_trail(:'tok_t', 'six-names') t where t.title = 'Sibling secret'));
select chk_raises('a forged token gets no Trail at all',
  $$select * from child_session_trail('0000deadbeef0000', 'six-names')$$, 'no_child_session');
reset role; set role service_role;
select chk('the engine loads the run''s own responses for recall',
  jsonb_typeof(engine_load_run(:'ownpid')->'responses') = 'object');
reset role;
\echo ''
\echo '=============== DEVICE INPUT (0035) ==============='
select chk('device_input is a screen_type value',
  exists (select 1 from unnest(enum_range(null::screen_type)) t where t::text = 'device_input'));
\echo ''
\echo '=============== MISSION BOARD (0036) ==============='
reset role;
insert into mission_evidence (id, child_id, mission_id, type, title, description, source)
values ('eeeeeeee-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001', :'mid', 'digital', 'Identifying', 'ChildA and SiblingB checked it. Mail me at kid@example.com or see https://example.com/x, call 07700 900123, we live near SW1A 1AA.', 'mission'),
       ('eeeeeeee-0000-0000-0000-000000000012', 'bbbbbbbb-0000-0000-0000-000000000001', :'mid', 'physical', 'Kept at home', 'A drawing', 'completion'),
       ('eeeeeeee-0000-0000-0000-000000000013', 'bbbbbbbb-0000-0000-0000-000000000001', :'mid', 'digital', 'Child offer', 'I started from the names.', 'mission'),
       ('eeeeeeee-0000-0000-0000-000000000014', 'bbbbbbbb-0000-0000-0000-000000000002', :'mid', 'digital', 'Sibling offer', 'Mine.', 'mission');
set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000003';
select chk_raises('another family cannot offer a child''s Trail entry',
  $$select board_offer('bbbbbbbb-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000011')$$, 'not_your_child');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000002';
select chk_raises('a sibling''s entry cannot be offered as this child''s',
  $$select board_offer('bbbbbbbb-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000014')$$, 'not_eligible');
select chk_raises('physical evidence is never eligible (nothing is stored)',
  $$select board_offer('bbbbbbbb-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000012')$$, 'not_eligible');
select board_offer('bbbbbbbb-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000011') as bc1 \gset
select chk_raises('families cannot read the Board table directly', $$select * from board_contributions$$, 'permission denied');
reset role;
select text as scrubbed from board_contributions where id = :'bc1' \gset
select chk('anonymised: no family names, email, link, phone or postcode in the copy',
  :'scrubbed' not like '%ChildA%' and :'scrubbed' not like '%SiblingB%' and :'scrubbed' not like '%example.com%'
  and :'scrubbed' not like '%07700%' and :'scrubbed' not like '%SW1A%' and :'scrubbed' like '%[name]%');
select chk('a parent''s own offer goes straight to moderation (the offer is the permission)',
  (select status = 'pending_moderation' and permitted_at is not null from board_contributions where id = :'bc1'));
-- a child-session offer waits for the parent
set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000002';
select generate_child_access_code('bbbbbbbb-0000-0000-0000-000000000001') as code_b \gset
reset role; set request.jwt.claim.sub = ''; set role anon;
select token as tok_b from redeem_child_code(:'code_b') \gset
select child_session_board_offer(:'tok_b', 'eeeeeeee-0000-0000-0000-000000000013') as bc2 \gset
select chk_raises('a child cannot offer a sibling''s entry',
  $$select child_session_board_offer('$$ || :'tok_b' || $$', 'eeeeeeee-0000-0000-0000-000000000014')$$, 'not_eligible');
select chk('the child sees their own offer and where it stands',
  exists (select 1 from child_session_board_offers(:'tok_b') o where o.evidence_id = 'eeeeeeee-0000-0000-0000-000000000013' and o.status = 'pending_permission'));
select chk_ok('the child can open the Board in their own session', format($$select * from child_session_board(%L)$$, :'tok_b'));
-- PostgREST runs STABLE/IMMUTABLE functions in a READ-ONLY transaction, and
-- the child-session check writes (it records the session's use). So every
-- child_session_* function must be VOLATILE, or it fails for real children
-- while passing here (D-97).
select chk('every child-session function is VOLATILE (PostgREST would run it read-only)',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like 'child\_session\_%' and p.provolatile <> 'v'));
reset role;
select chk('a child-session offer waits for parent permission',
  (select status = 'pending_permission' and permitted_at is null from board_contributions where id = :'bc2'));
set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select chk('WLA moderation sees what a parent permitted, not what waits for permission',
  exists (select 1 from admin_board_queue() q where q.id = :'bc1') and not exists (select 1 from admin_board_queue() q where q.id = :'bc2'));
select chk_raises('nothing un-permitted can be published',
  format($$select admin_board_moderate(%L, 'publish', null, null, null)$$, :'bc2'), 'not_moderatable');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000003';
select chk_raises('another family cannot permit it', format($$select board_permit(%L, true)$$, :'bc2'), 'not_your_contribution');
select chk_raises('a parent cannot moderate', format($$select admin_board_moderate(%L, 'publish', null, null, null)$$, :'bc1'), 'not_admin');
select chk('another family sees none of this family''s contributions', (select count(*) = 0 from board_family_contributions()));
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000002';
select chk('the parent sees their children''s offers, with the waiting one', (select count(*) = 2 from board_family_contributions()));
select board_permit(:'bc2', true);
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
-- D-151: publishing needs the moderator's confirmation that nothing identifies a child.
select chk_raises('publishing without the anonymity confirmation is refused',
  format($$select admin_board_moderate(%L, 'publish', 'x', null, null)$$, :'bc2'), 'anonymity_not_confirmed');
select admin_board_moderate(:'bc2', 'publish', 'I started from what the names had in common.', true, 'Started from the evidence', true);
reset role;
select chk('published, edited and curated by WLA',
  (select status = 'published' and curated and approach = 'Started from the evidence' and text like 'I started from what%' from board_contributions where id = :'bc2'));
-- browsing is limited to missions the child has completed
update mission_progress set status = 'not_started' where child_id = 'bbbbbbbb-0000-0000-0000-000000000001' and mission_id = :'mid';
set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000002';
select chk('before completing the mission, its approaches stay hidden (no spoilers)',
  (select count(*) = 0 from board_published('bbbbbbbb-0000-0000-0000-000000000001')));
reset role;
insert into mission_progress (child_id, mission_id, status, mission_version)
values ('bbbbbbbb-0000-0000-0000-000000000001', :'mid', 'complete', 2)
on conflict (child_id, mission_id) do update set status = 'complete';
set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000002';
select chk('after completing it, the published approach is there — with no author',
  (select count(*) = 1 from board_published('bbbbbbbb-0000-0000-0000-000000000001') b where b.curated and b.text like 'I started from what%'));
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000003';
select chk_raises('a parent cannot browse as another family''s child',
  $$select * from board_published('bbbbbbbb-0000-0000-0000-000000000001')$$, 'not_your_child');
select chk_raises('another family cannot withdraw it', format($$select board_withdraw(%L)$$, :'bc2'), 'not_your_contribution');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000002';
select board_withdraw(:'bc2');
reset role;
select chk('withdrawal removes it at once', not exists (select 1 from board_contributions where id = :'bc2'));
-- child-profile deletion removes their contributions
set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000002';
select board_offer('bbbbbbbb-0000-0000-0000-000000000002', 'eeeeeeee-0000-0000-0000-000000000014') as bc3 \gset
reset role;
delete from child_profiles where id = 'bbbbbbbb-0000-0000-0000-000000000002';
select chk('deleting the child removes their contributions', not exists (select 1 from board_contributions where id = :'bc3'));
set request.jwt.claim.sub = ''; set role anon;
select chk_raises('anon cannot read the Board table', $$select * from board_contributions$$, 'permission denied');
reset role;
\echo ''
\echo '=============== CODE ATTEMPTS IN INSIGHTS ==============='
reset role;
insert into analytics_events (name, mission_id, mission_version, screen_key, detail)
values ('code_attempted', :'mid', 2, 'qa_code_screen', '{"outcome":"no_match"}'),
       ('code_attempted', :'mid', 2, 'qa_code_screen', '{"outcome":"solved"}');
set role authenticated; set request.jwt.claim.sub='aaaaaaaa-0000-0000-0000-000000000001';
select chk('insights count code/cipher attempts per screen (the metric was always 0)',
  exists (select 1 from jsonb_array_elements(admin_mission_insights(:'mid', 2)->'friction') f
          where f->>'screen_key' = 'qa_code_screen' and (f->>'code_attempts')::int = 2));
reset role;
\echo ''
\echo '=============== CHILD CODE ENCRYPTED COPY (D-143) ==============='
reset role;
delete from child_auth_attempts;
insert into child_profiles (id,parent_id,display_name) values
  ('bbbbbbbb-0000-0000-0000-000000000043','aaaaaaaa-0000-0000-0000-000000000002','CopyChild') on conflict do nothing;
set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000002';
select credential_id as cred1, code as copy_code1 from issue_child_access_code('bbbbbbbb-0000-0000-0000-000000000043') \gset
select chk('a generated code has the XXXX-XXXX shape from the unambiguous alphabet',
  :'copy_code1' ~ '^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}$');
select chk('before a copy is stored the parent sees it is not viewable',
  (select not has_viewable_copy from child_access_credentials where id = :'cred1'));
select chk_raises('a parent cannot select the ciphertext column',
  $$select code_ciphertext from child_access_credentials$$, 'permission denied');
select chk_raises('a parent cannot store a copy directly',
  $$select store_child_code_copy(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x')$$, 'permission denied');
select chk_raises('a parent cannot read a copy directly',
  $$select * from read_child_code_copy('bbbbbbbb-0000-0000-0000-000000000043','aaaaaaaa-0000-0000-0000-000000000002')$$, 'permission denied');
select chk_raises('a client cannot call the generator itself', $$select gen_child_code()$$, 'permission denied');
-- An administrator is an authenticated client too: nothing extra.
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select chk_raises('an admin cannot select the ciphertext column',
  $$select code_ciphertext from child_access_credentials$$, 'permission denied');
select chk_raises('an admin cannot read a copy',
  $$select * from read_child_code_copy('bbbbbbbb-0000-0000-0000-000000000043','aaaaaaaa-0000-0000-0000-000000000002')$$, 'permission denied');
select chk_raises('an admin cannot generate a code for a child',
  $$select * from issue_child_access_code('bbbbbbbb-0000-0000-0000-000000000043')$$, 'not_your_child');
set request.jwt.claim.sub = ''; set role anon;
select chk_raises('anon cannot select the ciphertext column',
  $$select code_ciphertext from child_access_credentials$$, 'permission denied');
select chk_raises('anon cannot read a copy',
  $$select * from read_child_code_copy('bbbbbbbb-0000-0000-0000-000000000043','aaaaaaaa-0000-0000-0000-000000000002')$$, 'permission denied');
reset role;
set role service_role;
select chk('a copy is refused for the wrong parent',
  not store_child_code_copy(:'cred1','bbbbbbbb-0000-0000-0000-000000000043','aaaaaaaa-0000-0000-0000-000000000003','sealed-1'));
select chk('a copy is refused for the wrong child',
  not store_child_code_copy(:'cred1','bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002','sealed-1'));
select chk('a copy is stored for the owner',
  store_child_code_copy(:'cred1','bbbbbbbb-0000-0000-0000-000000000043','aaaaaaaa-0000-0000-0000-000000000002','sealed-1'));
select chk('a stored copy is never overwritten',
  not store_child_code_copy(:'cred1','bbbbbbbb-0000-0000-0000-000000000043','aaaaaaaa-0000-0000-0000-000000000002','sealed-2'));
select chk('another parent reads nothing',
  not exists (select 1 from read_child_code_copy('bbbbbbbb-0000-0000-0000-000000000043','aaaaaaaa-0000-0000-0000-000000000003')));
select chk('the owner reads the copy of this credential',
  (select ciphertext = 'sealed-1' and credential_id = :'cred1' from read_child_code_copy('bbbbbbbb-0000-0000-0000-000000000043','aaaaaaaa-0000-0000-0000-000000000002')));
reset role;
select chk('a view is recorded, without the code', (select code_last_viewed_at is not null from child_access_credentials where id = :'cred1'));
select chk('the plaintext is not in the copy, the hash or the lookup',
  not exists (select 1 from child_access_credentials
    where coalesce(code_ciphertext,'') || code_hash || code_lookup like '%' || replace(:'copy_code1','-','') || '%'));
set request.jwt.claim.sub = ''; set role anon;
select outcome as copy_o1, token as copy_tok from redeem_child_code(:'copy_code1') \gset
select chk('the code signs in', :'copy_o1' = 'ok');
reset role;
set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000002';
select credential_id as cred2, code as copy_code2 from issue_child_access_code('bbbbbbbb-0000-0000-0000-000000000043') \gset
reset role;
select chk('replacing removes the old copy along with the old code',
  (select code_ciphertext is null and revoked_at is not null from child_access_credentials where id = :'cred1'));
select chk('replacing revokes the child sessions',
  not exists (select 1 from child_sessions where child_id = 'bbbbbbbb-0000-0000-0000-000000000043' and revoked_at is null));
set role service_role;
select chk('a late copy for a replaced credential is refused',
  not store_child_code_copy(:'cred1','bbbbbbbb-0000-0000-0000-000000000043','aaaaaaaa-0000-0000-0000-000000000002','sealed-late'));
reset role;
set request.jwt.claim.sub = ''; set role anon;
select outcome as copy_o2 from redeem_child_code(:'copy_code1') \gset
select outcome as copy_o3 from redeem_child_code(:'copy_code2') \gset
select chk('the old code no longer signs in', :'copy_o2' = 'invalid_code');
select chk('the new code signs in, with no copy stored', :'copy_o3' = 'ok');
reset role;
select chk('2,000 generated codes all use only the alphabet and are all different',
  (select count(distinct c) = 2000 and bool_and(c ~ '^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}$')
     from (select gen_child_code() c from generate_series(1,2000)) g));
\echo ''
\echo '=============== ADDING A CHILD IS SAFE TO RETRY (D-144) ==============='
reset role;
set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000002';
insert into child_profiles (parent_id, display_name, creation_key)
  values ('aaaaaaaa-0000-0000-0000-000000000002','Retry','44444444-0000-4000-8000-000000000001');
select chk_raises('the same key for the same parent is refused by the database',
  $$insert into child_profiles (parent_id, display_name, creation_key) values ('aaaaaaaa-0000-0000-0000-000000000002','Retry','44444444-0000-4000-8000-000000000001')$$,
  'child_profiles_creation_key_idx');
select chk('and one profile exists', (select count(*)=1 from child_profiles where creation_key='44444444-0000-4000-8000-000000000001'));
select chk_raises('a parent cannot add a child to another family',
  $$insert into child_profiles (parent_id, display_name) values ('aaaaaaaa-0000-0000-0000-000000000003','Sneaky')$$,
  'row-level security');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000003';
select chk_ok('another parent using the same key is unaffected',
  $$insert into child_profiles (parent_id, display_name, creation_key) values ('aaaaaaaa-0000-0000-0000-000000000003','Theirs','44444444-0000-4000-8000-000000000001')$$);
select chk('a parent cannot see another family''s child by its key',
  (select count(*)=1 from child_profiles where creation_key='44444444-0000-4000-8000-000000000001'));
reset role;
\echo ''

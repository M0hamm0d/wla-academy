-- A Mission Board contribution of a child or family being closed is never
-- public again, held or not (S2, D-156). One transaction, rolled back: nothing
-- it creates survives. Runs against the isolated cluster (scripts/local-db.sh)
-- or the local stack alike.
--
-- Families: P (Pia is removed; her brother Pip is not), Q (the whole account is
-- closed under a hold), R (Rex is removed while one of his contributions is
-- itself held), U (an unrelated family whose child Uma views the Board and
-- whose contributions are moderated normally).
\set ON_ERROR_STOP on
begin;
create temp table r (n serial, label text, ok boolean);
grant all on r to public; grant all on sequence r_n_seq to public;
create temp table ids (k text primary key, v uuid);
grant all on ids to public;

-- ------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
 ('b6000000-0000-4000-8000-0000000000a1','s2-p@wla-local.test'),
 ('b6000000-0000-4000-8000-0000000000a2','s2-q@wla-local.test'),
 ('b6000000-0000-4000-8000-0000000000a3','s2-r@wla-local.test'),
 ('b6000000-0000-4000-8000-0000000000a4','s2-u@wla-local.test'),
 ('b6000000-0000-4000-8000-0000000000a9','s2-admin@wla-local.test');
update profiles set is_admin = true where id = 'b6000000-0000-4000-8000-0000000000a9';
insert into child_profiles (id, parent_id, display_name) values
 ('c6000000-0000-4000-8000-0000000000c1','b6000000-0000-4000-8000-0000000000a1','Pia'),
 ('c6000000-0000-4000-8000-0000000000c2','b6000000-0000-4000-8000-0000000000a1','Pip'),
 ('c6000000-0000-4000-8000-0000000000c3','b6000000-0000-4000-8000-0000000000a2','Quin'),
 ('c6000000-0000-4000-8000-0000000000c4','b6000000-0000-4000-8000-0000000000a3','Rex'),
 ('c6000000-0000-4000-8000-0000000000c5','b6000000-0000-4000-8000-0000000000a4','Uma');
insert into missions (id, slug, title, lab, min_age, max_age, is_free, price_minor, currency, published)
values ('d6000000-0000-4000-8000-000000000001','s2-board','S2 board','decision',11,15,true,null,'GBP',false);
-- Uma has completed the mission, so she sees its Board.
insert into mission_progress (id, child_id, mission_id, status, last_activity_at)
values ('e6000000-0000-4000-8000-000000000005','c6000000-0000-4000-8000-0000000000c5','d6000000-0000-4000-8000-000000000001','complete', now());

-- One Trail entry per contribution; k names it.
insert into mission_evidence (id, child_id, mission_id, type, title, description)
select v, c, 'd6000000-0000-4000-8000-000000000001', 'digital', k, 'We compared two ways and kept the fairer one.'
  from (values
    ('f6000000-0000-4000-8000-000000000001'::uuid, 'c6000000-0000-4000-8000-0000000000c1'::uuid, 'pia'),
    ('f6000000-0000-4000-8000-000000000002'::uuid, 'c6000000-0000-4000-8000-0000000000c2'::uuid, 'pip'),
    ('f6000000-0000-4000-8000-000000000003'::uuid, 'c6000000-0000-4000-8000-0000000000c3'::uuid, 'quin'),
    ('f6000000-0000-4000-8000-000000000004'::uuid, 'c6000000-0000-4000-8000-0000000000c3'::uuid, 'quin_rejected'),
    ('f6000000-0000-4000-8000-000000000005'::uuid, 'c6000000-0000-4000-8000-0000000000c4'::uuid, 'rex'),
    ('f6000000-0000-4000-8000-000000000006'::uuid, 'c6000000-0000-4000-8000-0000000000c5'::uuid, 'uma_pending'),
    ('f6000000-0000-4000-8000-000000000007'::uuid, 'c6000000-0000-4000-8000-0000000000c5'::uuid, 'uma_withdraw'),
    ('f6000000-0000-4000-8000-000000000008'::uuid, 'c6000000-0000-4000-8000-0000000000c5'::uuid, 'uma_remove'),
    ('f6000000-0000-4000-8000-000000000009'::uuid, 'c6000000-0000-4000-8000-0000000000c5'::uuid, 'uma_rejected'),
    ('f6000000-0000-4000-8000-00000000000a'::uuid, 'c6000000-0000-4000-8000-0000000000c3'::uuid, 'quin_extra')
  ) x(v, c, k);
insert into board_contributions (id, child_id, mission_id, evidence_id, text, status, permitted_at, anonymity_checked_at, moderated_at, rejected_reason)
select ('a7000000-0000-4000-8000-00000000000' || right(e.id::text, 1))::uuid, e.child_id, e.mission_id, e.id, e.title || ': we kept the fairer one.',
       case when e.title in ('uma_pending') then 'pending_moderation' when e.title like '%rejected' then 'rejected' else 'published' end,
       now(),
       case when e.title in ('uma_pending') or e.title like '%rejected' then null else now() end,
       case when e.title like '%rejected' then now() - interval '40 days' when e.title = 'uma_pending' then null else now() end,
       case when e.title like '%rejected' then 'not_suitable' end
  from mission_evidence e where e.mission_id = 'd6000000-0000-4000-8000-000000000001' and e.title <> 'quin_extra';
insert into ids select 'b_' || e.title, b.id from board_contributions b join mission_evidence e on e.id = b.evidence_id
 where b.mission_id = 'd6000000-0000-4000-8000-000000000001';

create temp view seen as
  select text from private.board_for_child('c6000000-0000-4000-8000-0000000000c5');
grant select on seen to public;

insert into r(label,ok) select 'before anything: Pia''s, Pip''s, Quin''s and Rex''s contributions are on the Board',
  (select count(*) = 4 from seen where text like 'pia:%' or text like 'pip:%' or text like 'quin:%' or text like 'rex:%');

-- ---------------------------------------- 1. a child removed, no hold --
select outcome from privacy_begin_closure('child_profile','c6000000-0000-4000-8000-0000000000c1','b6000000-0000-4000-8000-0000000000a1','parent');
insert into r(label,ok) select 'removing a child takes their published contribution off the Board at once',
  not exists (select 1 from seen where text like 'pia:%');
insert into r(label,ok) select 'their brother''s contribution is unaffected and still public',
  exists (select 1 from seen where text like 'pip:%')
  and (select status = 'published' from board_contributions where id = (select v from ids where k = 'b_pip'));

-- ------------------------------ 2. a whole account closed, under a hold --
insert into retention_holds (subject_type, subject_id, reason, review_by)
values ('parent_account','b6000000-0000-4000-8000-0000000000a2','S2 regression: a dispute', current_date + 30);
insert into ids select 'hold_q', id from retention_holds where reason = 'S2 regression: a dispute';
insert into ids select 'del_q', deletion_id from privacy_begin_closure('parent_account','b6000000-0000-4000-8000-0000000000a2','b6000000-0000-4000-8000-0000000000a2','admin');
insert into r(label,ok) select 'the closure is held', (select status = 'held' from privacy_deletions where id = (select v from ids where k = 'del_q'));
insert into r(label,ok) select 'the held family''s contribution is off the Board',
  not exists (select 1 from seen where text like 'quin:%');
insert into r(label,ok) select 'but kept, as the hold requires',
  exists (select 1 from board_contributions where id = (select v from ids where k = 'b_quin'));
insert into r(label,ok) select 'and not returned to the moderation queue: its permission is withdrawn',
  (select status = 'pending_permission' and permitted_at is null and anonymity_checked_at is null
     from board_contributions where id = (select v from ids where k = 'b_quin'));

-- ------------------------- 3. a child removed while a contribution is held --
insert into retention_holds (subject_type, subject_id, reason, review_by)
values ('board_contribution',(select v from ids where k = 'b_rex'),'S2 regression: a complaint about this post', current_date + 30);
select outcome from privacy_begin_closure('child_profile','c6000000-0000-4000-8000-0000000000c4','b6000000-0000-4000-8000-0000000000a3','parent');
insert into r(label,ok) select 'a contribution held on its own is kept, off the Board, out of the queue',
  (select status = 'pending_permission' from board_contributions where id = (select v from ids where k = 'b_rex'))
  and not exists (select 1 from seen where text like 'rex:%');

-- -------------------------------------------------- the moderator's view --
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"b6000000-0000-4000-8000-0000000000a9","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','b6000000-0000-4000-8000-0000000000a9',true);
do $$
declare q uuid[];
begin
  select array_agg(id) into q from admin_board_queue();
  insert into r(label,ok) values ('the moderation queue shows none of a closing family''s contributions',
    not ((select v from ids where k = 'b_quin') = any(coalesce(q, '{}')))
    and not ((select v from ids where k = 'b_rex') = any(coalesce(q, '{}'))));
  insert into r(label,ok) values ('but still shows the sibling''s and the unrelated family''s',
    (select v from ids where k = 'b_pip') = any(coalesce(q, '{}'))
    and (select v from ids where k = 'b_uma_pending') = any(coalesce(q, '{}')));
  begin
    perform admin_board_moderate((select v from ids where k = 'b_quin'), 'publish', null, null, null, true);
    insert into r(label,ok) values ('a moderator calling the database directly cannot publish a held family''s contribution', false);
  exception when others then
    insert into r(label,ok) values ('a moderator calling the database directly cannot publish a held family''s contribution', sqlerrm = 'board_subject_closing');
  end;
  begin
    perform admin_board_moderate((select v from ids where k = 'b_rex'), 'save', 'Edited text', null, null, true);
    insert into r(label,ok) values ('nor edit one', false);
  exception when others then
    insert into r(label,ok) values ('nor edit one', sqlerrm = 'board_subject_closing');
  end;
  begin
    perform admin_board_moderate((select v from ids where k = 'b_rex'), 'remove', null, null, null, false);
    insert into r(label,ok) values ('nor remove one that a hold protects', false);
  exception when others then
    insert into r(label,ok) values ('nor remove one that a hold protects', sqlerrm = 'board_subject_closing');
  end;
end $$;
reset role;
insert into r(label,ok) select 'so it is still kept, unedited and unpublished',
  (select status = 'pending_permission' and text like 'rex:%' from board_contributions where id = (select v from ids where k = 'b_rex'));

-- Below the functions: the table itself refuses.
do $$ begin
  begin
    update board_contributions set status = 'published', anonymity_checked_at = now() where id = (select v from ids where k = 'b_quin');
    insert into r(label,ok) values ('even a direct write cannot publish a closing family''s contribution', false);
  exception when others then
    insert into r(label,ok) values ('even a direct write cannot publish a closing family''s contribution', sqlerrm = 'board_subject_closing');
  end;
  begin
    update board_contributions set status = 'pending_moderation' where id = (select v from ids where k = 'b_quin');
    insert into r(label,ok) values ('nor put it back in the queue', false);
  exception when others then
    insert into r(label,ok) values ('nor put it back in the queue', sqlerrm = 'board_subject_closing');
  end;
  begin
    insert into board_contributions (child_id, mission_id, evidence_id, text, status)
    values ('c6000000-0000-4000-8000-0000000000c3','d6000000-0000-4000-8000-000000000001',
            (select id from mission_evidence where title = 'quin_extra'), 'new', 'pending_permission');
    insert into r(label,ok) values ('nor add a new contribution for a closing child', false);
  exception when others then
    insert into r(label,ok) values ('nor add a new contribution for a closing child', sqlerrm = 'board_subject_closing');
  end;
end $$;

-- ------------------------------------------ the daily retention run --
-- Two rejected contributions, both 40 days old: Quin's (held family) and
-- Uma's (no hold). Only Uma's may go.
select privacy_retention_run();
insert into r(label,ok) select 'the 30-day pruning deletes an ordinary rejected contribution',
  not exists (select 1 from board_contributions where id = (select v from ids where k = 'b_uma_rejected'));
insert into r(label,ok) select 'but not one a family hold protects',
  exists (select 1 from board_contributions where id = (select v from ids where k = 'b_quin_rejected'));

-- ----------------------------------------------- releasing the hold --
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"b6000000-0000-4000-8000-0000000000a9","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','b6000000-0000-4000-8000-0000000000a9',true);
select admin_review_hold((select v from ids where k = 'hold_q'), true, null);
reset role;
insert into r(label,ok) select 'releasing the hold sends the closure on to deletion',
  (select status = 'in_progress' from privacy_deletions where id = (select v from ids where k = 'del_q'));
insert into r(label,ok) select 'and makes nothing public again',
  not exists (select 1 from seen where text like 'quin:%')
  and (select status = 'pending_permission' from board_contributions where id = (select v from ids where k = 'b_quin'));

-- ------------------------------ ordinary moderation is unaffected --
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"b6000000-0000-4000-8000-0000000000a9","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','b6000000-0000-4000-8000-0000000000a9',true);
select admin_board_moderate((select v from ids where k = 'b_uma_pending'), 'publish', null, null, null, true);
select admin_board_moderate((select v from ids where k = 'b_uma_remove'), 'remove', null, null, null, false);
select admin_board_moderate((select v from ids where k = 'b_pip'), 'save', 'pip: an edit, checked again.', null, null, true);
reset role;
insert into r(label,ok) select 'an eligible contribution is still moderated and published',
  exists (select 1 from seen where text like 'uma_pending:%');
insert into r(label,ok) select 'a removal request still deletes a published contribution',
  not exists (select 1 from board_contributions where id = (select v from ids where k = 'b_uma_remove'));
insert into r(label,ok) select 'a sibling''s published contribution can still be edited with confirmation',
  exists (select 1 from seen where text = 'pip: an edit, checked again.');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"b6000000-0000-4000-8000-0000000000a4","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','b6000000-0000-4000-8000-0000000000a4',true);
select board_withdraw((select v from ids where k = 'b_uma_withdraw'));
reset role;
insert into r(label,ok) select 'a family can still withdraw its own contribution',
  not exists (select 1 from board_contributions where id = (select v from ids where k = 'b_uma_withdraw'));

select (case when ok then 'PASS' else 'FAIL' end) || '  ' || label from r order by n;
select 'PASS: ' || count(*) filter (where ok) || '   FAIL: ' || count(*) filter (where not ok) from r;
rollback;

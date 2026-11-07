-- The administrator flag cannot be self-granted (S1, D-155): not by inserting a
-- profile, not by updating one, not as anon, and not after an account was left
-- without a profile. Normal onboarding and trusted provisioning still work.
-- One transaction, rolled back: nothing it creates survives. Runs against the
-- isolated cluster (scripts/local-db.sh) or the local stack alike.
\set ON_ERROR_STOP on
begin;
create temp table r (n serial, label text, ok boolean);
grant all on r to public; grant all on sequence r_n_seq to public;

-- ------------------------------------------------------------- fixtures --
-- U1 signs up normally. U2 is a second ordinary parent. A1 is an existing
-- administrator. U3 is left with an auth user but no profile, as a failed or
-- partial deletion could leave one.
insert into auth.users (id, email) values
 ('a5000000-0000-4000-8000-000000000001','s1-u1@wla-local.test'),
 ('a5000000-0000-4000-8000-000000000002','s1-u2@wla-local.test'),
 ('a5000000-0000-4000-8000-000000000003','s1-u3@wla-local.test'),
 ('a5000000-0000-4000-8000-000000000009','s1-admin@wla-local.test');
update profiles set is_admin = true where id = 'a5000000-0000-4000-8000-000000000009';
delete from profiles where id = 'a5000000-0000-4000-8000-000000000003';

insert into r(label,ok) select 'onboarding creates an ordinary profile for every new user',
  (select count(*) = 2 from profiles where id in ('a5000000-0000-4000-8000-000000000001','a5000000-0000-4000-8000-000000000002') and not is_admin);
insert into r(label,ok) select 'the trusted path (database owner) can still provision an administrator',
  (select is_admin from profiles where id = 'a5000000-0000-4000-8000-000000000009');

-- ------------------------------------------- U3: no profile, signed in --
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','a5000000-0000-4000-8000-000000000003',true);
do $$ begin
  begin
    insert into profiles (id, email, is_admin) values ('a5000000-0000-4000-8000-000000000003','s1-u3@wla-local.test', true);
    insert into r(label,ok) values ('a user without a profile cannot insert one marked administrator', false);
  exception when insufficient_privilege then
    insert into r(label,ok) values ('a user without a profile cannot insert one marked administrator', true);
  end;
  insert into r(label,ok) values ('and is_admin() stays false for them', not is_admin());
  begin
    insert into profiles (id, email, is_admin) values ('a5000000-0000-4000-8000-000000000003','s1-u3@wla-local.test', false)
    on conflict (id) do update set is_admin = true;
    insert into r(label,ok) values ('nor through an upsert that sets the flag on conflict', false);
  exception when insufficient_privilege then
    insert into r(label,ok) values ('nor through an upsert that sets the flag on conflict', true);
  end;
  begin
    insert into profiles (id, email) values ('a5000000-0000-4000-8000-000000000003','s1-u3@wla-local.test');
    insert into r(label,ok) values ('they can still create an ordinary profile for themselves', true);
  exception when others then
    insert into r(label,ok) values ('they can still create an ordinary profile for themselves', false);
  end;
  insert into r(label,ok) values ('which is not an administrator', not is_admin());
  begin
    insert into profiles (id, email) values ('a5000000-0000-4000-8000-000000000077','someone-else@wla-local.test');
    insert into r(label,ok) values ('nor can they create a profile for another id', false);
  exception when insufficient_privilege then
    insert into r(label,ok) values ('nor can they create a profile for another id', true);
  end;
end $$;
reset role;

-- --------------------------------------------- U1: an ordinary parent --
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a5000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','a5000000-0000-4000-8000-000000000001',true);
do $$ begin
  begin
    update profiles set is_admin = true where id = 'a5000000-0000-4000-8000-000000000001';
    insert into r(label,ok) values ('a parent cannot update their own flag', false);
  exception when insufficient_privilege or raise_exception then
    insert into r(label,ok) values ('a parent cannot update their own flag', true);
  end;
  begin
    update profiles set is_admin = true where id = 'a5000000-0000-4000-8000-000000000002';
    insert into r(label,ok) values ('a parent cannot promote another parent', true);
  exception when insufficient_privilege or raise_exception then
    insert into r(label,ok) values ('a parent cannot promote another parent', true);
  end;
  begin
    update profiles set name = 'New name' where id = 'a5000000-0000-4000-8000-000000000001';
    insert into r(label,ok) values ('a parent can still edit their own name', true);
  exception when others then
    insert into r(label,ok) values ('a parent can still edit their own name', false);
  end;
  insert into r(label,ok) values ('is_admin() is false for a parent', not is_admin());
end $$;
reset role;
insert into r(label,ok) select 'nobody was promoted',
  (select count(*) = 0 from profiles where is_admin and id in ('a5000000-0000-4000-8000-000000000001','a5000000-0000-4000-8000-000000000002','a5000000-0000-4000-8000-000000000003'));

-- ------------------------------------------------------------------ anon --
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select set_config('request.jwt.claim.sub','',true);
do $$ begin
  begin
    insert into profiles (id, email, is_admin) values ('a5000000-0000-4000-8000-000000000088','anon@wla-local.test', true);
    insert into r(label,ok) values ('an anonymous visitor cannot create an administrator', false);
  exception when insufficient_privilege then
    insert into r(label,ok) values ('an anonymous visitor cannot create an administrator', true);
  end;
  begin
    insert into profiles (id, email) values ('a5000000-0000-4000-8000-000000000088','anon@wla-local.test');
    insert into r(label,ok) values ('nor any profile at all', false);
  exception when insufficient_privilege then
    insert into r(label,ok) values ('nor any profile at all', true);
  end;
end $$;
reset role;

-- ---------------------------------------------------- the administrator --
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a5000000-0000-4000-8000-000000000009","role":"authenticated"}',true);
select set_config('request.jwt.claim.sub','a5000000-0000-4000-8000-000000000009',true);
do $$ begin
  insert into r(label,ok) values ('an existing administrator is still an administrator', is_admin());
  begin
    update profiles set is_admin = false where id = 'a5000000-0000-4000-8000-000000000009';
    insert into r(label,ok) values ('and cannot change the flag from the client either', false);
  exception when insufficient_privilege or raise_exception then
    insert into r(label,ok) values ('and cannot change the flag from the client either', true);
  end;
end $$;
reset role;

-- The service role, as the server uses it, provisions administrators.
set local role service_role;
update profiles set is_admin = true where id = 'a5000000-0000-4000-8000-000000000002';
reset role;
insert into r(label,ok) select 'the service role can provision an administrator',
  (select is_admin from profiles where id = 'a5000000-0000-4000-8000-000000000002');

select (case when ok then 'PASS' else 'FAIL' end) || '  ' || label from r order by n;
select 'PASS: ' || count(*) filter (where ok) || '   FAIL: ' || count(*) filter (where not ok) from r;
rollback;

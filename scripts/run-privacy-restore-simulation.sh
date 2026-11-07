#!/bin/zsh
# The restore of an OLDER backup, simulated end to end in a throwaway cluster
# (S3, D-157). Never touches the local Supabase stack or anything else:
# scripts/local-db.sh builds a separate PostgreSQL on its own port and data
# directory, which this stops at the end.
#
#   1. Families with progress, answers, Trail entries, stored-file records and
#      Board contributions. The ledger is shipped, then a REAL backup (pg_dump).
#   2. After the backup: an account is closed; one child of another family is
#      removed; a third family is put under a hold and closes (held); a Board
#      contribution is withdrawn. Every event is shipped to the ledger file.
#   3. The backup is restored into a NEW database: the deleted families are back,
#      and the old in-database safeguard can't see why.
#   4. A missing, edited, foreign or cut-short ledger is refused: nothing is
#      replayed, and the operator is told not to reopen.
#   5. The procedure: verify the ledger, replay it, run the server follow-up,
#      verify. The deleted are gone again, the held are kept, the rest intact.
#
# What this can't reproduce: Supabase's own backup/restore, GoTrue, and the
# Storage API. Auth users and Storage objects are rows here; the server's
# Storage API removal and auth deletion are stood in for by deleting the rows,
# exactly as scripts/privacy-regression.sql does.
#
#   scripts/run-privacy-restore-simulation.sh
set -e
PORT=${PORT:-55475}
R=$(cd "$(dirname "$0")/.." && pwd)
B=/opt/homebrew/opt/postgresql@16/bin
W=$(mktemp -d "${TMPDIR:-/tmp}/wla-restore-sim.XXXXXX")
export WLA_PGDIR=${WLA_PGDIR:-$W/pg}
export PRIVACY_LEDGER_KEY=$(openssl rand -base64 32)
# Node runs the .ts tool directly; its "module type" notice is noise here.
export NODE_OPTIONS="--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"
LEDGER=$W/deletion-ledger.jsonl
pass=0; fail=0
chk() { if [ "$2" = "true" ]; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1${3:+ :: $3}"; fi; }
q() { "$B/psql" -h 127.0.0.1 -p $PORT -U postgres -d ${DB:-postgres} -X -A -t -q -v ON_ERROR_STOP=1 "$@"; }
# SQL with psql variables: stdin, because psql doesn't interpolate inside -c.
qv() { local sql=$1; shift; print -r -- "$sql" | q "$@"; }
finish() { "$B/pg_ctl" -D "$WLA_PGDIR/$PORT" stop >/dev/null 2>&1 || true; rm -rf "$W"; }
trap finish EXIT

"$R/scripts/local-db.sh" "$PORT" >/dev/null

# The server's two steps, stood in for: copy the outbox to the ledger file, and
# finish a closure (Storage API removal and auth deletion as row deletions).
ship() {
  q -c "select coalesce(json_agg(json_build_object('event_id', event_id, 'event', event, 'payload', payload, 'created_at', created_at) order by seq), '[]') from privacy_ledger_pending(1000)" > $W/outbox.json
  local head=$(node "$R/scripts/privacy-ledger.ts" append "$LEDGER" --events $W/outbox.json)
  qv "select privacy_ledger_mark_shipped(array(select jsonb_array_elements_text((:'head')::jsonb->'event_ids'))::uuid[], ((:'head')::jsonb->>'seq')::bigint, (:'head')::jsonb->>'chain')" -v head="$head"
}
server_sql() { cat <<'SQL'
create schema if not exists sim;
create or replace function sim.server_run(p_deletion uuid) returns text language plpgsql as $$
declare d privacy_deletions%rowtype; f record; v text;
begin
  for f in select * from privacy_pending_files(p_deletion) loop
    delete from storage.objects where bucket_id = f.bucket and name = f.path;
    perform privacy_record_files(p_deletion, f.bucket, array[f.path], '{}', null);
  end loop;
  v := privacy_finish_closure(p_deletion);
  if v = 'data_deleted' then
    select * into d from privacy_deletions where id = p_deletion;
    delete from auth.users where id = d.parent_id;
    v := privacy_complete_closure(p_deletion);
  end if;
  return v;
end $$;
create or replace function sim.follow_up() returns int language plpgsql as $$
declare d record; n int := 0;
begin
  for d in select * from privacy_open_deletions() loop perform sim.server_run(d.id); n := n + 1; end loop;
  delete from storage.objects o using privacy_orphan_files(1000) x where o.bucket_id = x.bucket and o.name = x.path;
  return n;
end $$;
SQL
}

# ------------------------------------------------------------ 1. fixtures --
q <<'SQL'
insert into storage.buckets (id, name) values ('mission-evidence', 'mission-evidence') on conflict do nothing;
insert into missions (id, slug, title, lab, min_age, max_age, is_free, price_minor, currency, published)
values ('d9000000-0000-4000-8000-000000000001','restore-sim','Restore sim','decision',11,15,true,null,'GBP',false);
-- A: closed after the backup. B: one child (Bo) removed after it; Bea stays.
-- C: held, then closes, after it. D: untouched, one contribution withdrawn.
-- E: closed and deleted BEFORE the backup.
insert into auth.users (id, email) values
 ('a9000000-0000-4000-8000-00000000000a','sim-a@wla-local.test'),
 ('a9000000-0000-4000-8000-00000000000b','sim-b@wla-local.test'),
 ('a9000000-0000-4000-8000-00000000000c','sim-c@wla-local.test'),
 ('a9000000-0000-4000-8000-00000000000d','sim-d@wla-local.test'),
 ('a9000000-0000-4000-8000-00000000000e','sim-e@wla-local.test');
insert into child_profiles (id, parent_id, display_name) values
 ('c9000000-0000-4000-8000-0000000000a1','a9000000-0000-4000-8000-00000000000a','Ada'),
 ('c9000000-0000-4000-8000-0000000000a2','a9000000-0000-4000-8000-00000000000a','Abe'),
 ('c9000000-0000-4000-8000-0000000000b1','a9000000-0000-4000-8000-00000000000b','Bo'),
 ('c9000000-0000-4000-8000-0000000000b2','a9000000-0000-4000-8000-00000000000b','Bea'),
 ('c9000000-0000-4000-8000-0000000000c1','a9000000-0000-4000-8000-00000000000c','Cal'),
 ('c9000000-0000-4000-8000-0000000000d1','a9000000-0000-4000-8000-00000000000d','Dee'),
 ('c9000000-0000-4000-8000-0000000000e1','a9000000-0000-4000-8000-00000000000e','Eve');
-- Every child: a run with an answer, a Trail entry with a stored file, and a
-- published Board contribution. Dee has a second contribution to withdraw.
insert into mission_progress (id, child_id, mission_id, status, last_activity_at)
select ('e9' || substr(c.id::text, 3))::uuid, c.id, 'd9000000-0000-4000-8000-000000000001', 'complete', now()
  from child_profiles c where c.id::text like 'c9000000-%';
insert into mission_responses (progress_id, screen_key, value)
select p.id, 'answer', '{"text":"my answer"}' from mission_progress p where p.child_id::text like 'c9000000-%';
insert into mission_evidence (id, child_id, mission_id, type, title, description, storage_path)
select ('f9' || substr(c.id::text, 3))::uuid, c.id, 'd9000000-0000-4000-8000-000000000001', 'digital', c.display_name, 'We kept the fairer one.',
       c.id || '/d9000000-0000-4000-8000-000000000001/plan.txt'
  from child_profiles c where c.id::text like 'c9000000-%';
insert into mission_evidence (id, child_id, mission_id, type, title, description)
values ('f9000000-0000-4000-8000-0000000000d2','c9000000-0000-4000-8000-0000000000d1','d9000000-0000-4000-8000-000000000001','digital','Dee 2','We tried again.');
insert into storage.objects (bucket_id, name)
select 'mission-evidence', storage_path from mission_evidence where storage_path like 'c9000000-%';
insert into board_contributions (id, child_id, mission_id, evidence_id, text, status, permitted_at, anonymity_checked_at, moderated_at)
select ('b9' || substr(e.id::text, 3))::uuid, e.child_id, e.mission_id, e.id, e.title || ': we kept the fairer one.', 'published', now(), now(), now()
  from mission_evidence e where e.child_id::text like 'c9000000-%';
SQL
server_sql | q
# E closes before the backup.
q -c "select outcome from privacy_begin_closure('parent_account','a9000000-0000-4000-8000-00000000000e','a9000000-0000-4000-8000-00000000000e','parent')" >/dev/null
q -c "select sim.follow_up()" >/dev/null
ship
chk "before the backup: E is deleted, and its request is in the ledger" \
  "$(q -c "select (not exists (select 1 from child_profiles where id='c9000000-0000-4000-8000-0000000000e1') and exists (select 1 from privacy_ledger_head))::text")"

# --------------------------------------------------------------- backup --
"$B/pg_dump" -h 127.0.0.1 -p $PORT -U postgres -d postgres -Fc -f $W/sunday.dump
chk "a real backup is taken (pg_dump)" "$([ -s $W/sunday.dump ] && echo true)"

# ------------------------------------------------- 2. after the backup --
q -c "select outcome from privacy_begin_closure('parent_account','a9000000-0000-4000-8000-00000000000a','a9000000-0000-4000-8000-00000000000a','parent')" >/dev/null
q -c "select outcome from privacy_begin_closure('child_profile','c9000000-0000-4000-8000-0000000000b1','a9000000-0000-4000-8000-00000000000b','parent')" >/dev/null
q -c "insert into retention_holds (subject_type, subject_id, reason, review_by) values ('parent_account','a9000000-0000-4000-8000-00000000000c','A dispute is open', current_date + 60)"
q -c "select outcome from privacy_begin_closure('parent_account','a9000000-0000-4000-8000-00000000000c','a9000000-0000-4000-8000-00000000000c','admin')" >/dev/null
q -c "delete from board_contributions where id='b9000000-0000-4000-8000-0000000000d2'"
ship                      # the server copies each request before deleting anything
q -c "select sim.follow_up()" >/dev/null
ship                      # and records what completed
chk "after the backup: A and Bo are deleted, C is held, Dee's offer withdrawn" \
  "$(q -c "select (not exists (select 1 from auth.users where id='a9000000-0000-4000-8000-00000000000a')
           and not exists (select 1 from child_profiles where id='c9000000-0000-4000-8000-0000000000b1')
           and (select status='held' from privacy_deletions where subject_id='a9000000-0000-4000-8000-00000000000c')
           and not exists (select 1 from board_contributions where id='b9000000-0000-4000-8000-0000000000d2'))::text")"

# ---------------------------------------------- 3. restore the old backup --
q -c "create database restored"
"$B/pg_restore" -h 127.0.0.1 -p $PORT -U postgres -d restored $W/sunday.dump
export DB=restored
chk "the restored database has the deleted families back" \
  "$(q -c "select (exists (select 1 from auth.users where id='a9000000-0000-4000-8000-00000000000a')
           and exists (select 1 from child_profiles where id='c9000000-0000-4000-8000-0000000000b1')
           and exists (select 1 from board_contributions where id='b9000000-0000-4000-8000-0000000000d2' and status='published'))::text")"
chk "and no record that they asked to go: the old safeguard reopens nothing" \
  "$(q -c "begin" -c "select ((privacy_reapply_deletions()->>'requests_reopened')::int = 0 and not exists (select 1 from privacy_deletions where subject_id='a9000000-0000-4000-8000-00000000000a'))::text" -c "rollback")"
server_sql | q

# ------------------------------------------- 4. a ledger that can't be used --
refused() { # $1 = ledger file: verify must refuse, and say not to reopen
  local out; out=$(node "$R/scripts/privacy-ledger.ts" verify "$1" --out $W/bad.json 2>&1) && return 1
  [[ "$out" == *"Do not reopen"* ]] && [ ! -e $W/bad.json ]
}
chk "no ledger at all: refused, do not reopen" "$(refused $W/no-such-ledger.jsonl && echo true)"
sed '2s/"at":"20/"at":"19/' "$LEDGER" > $W/edited.jsonl
cmp -s "$LEDGER" $W/edited.jsonl && { echo "FAIL  the edit didn't change the ledger"; exit 1; }
chk "an edited ledger: refused" "$(refused $W/edited.jsonl && echo true)"
chk "another environment's ledger (another key): refused" \
  "$( (export PRIVACY_LEDGER_KEY=$(openssl rand -base64 32); refused "$LEDGER") && echo true)"
before=$(q -c "select count(*) || '/' || (select count(*) from child_profiles) || '/' || (select count(*) from retention_holds) from privacy_deletions")
head -n 1 "$LEDGER" > $W/cut.jsonl
node "$R/scripts/privacy-ledger.ts" verify $W/cut.jsonl --out $W/cut.json >/dev/null
chk "a ledger cut short before what the backup knew: replay refuses" \
  "$(qv "select privacy_ledger_replay((:'ev')::jsonb)" -v ev="$(cat $W/cut.json)" >/dev/null 2>$W/err.txt || true; grep -q ledger_does_not_extend_backup $W/err.txt && echo true)" "$(head -c 300 $W/err.txt)"
# A ledger missing a request this database knows of (a different ledger, or one
# that lost entries): refused even without the head to compare.
node "$R/scripts/privacy-ledger.ts" verify "$LEDGER" --out $W/events.json >/dev/null
qv "select json_agg(x) from json_array_elements((:'ev')::json) x where not (x->>'event' = 'closure_requested' and x->'payload'->>'subject_id' = 'a9000000-0000-4000-8000-00000000000e')" -v ev="$(cat $W/events.json)" > $W/partial.json
chk "a ledger missing a request the database knows of: replay refuses" \
  "$(qv "begin; delete from privacy_ledger_head; delete from privacy_ledger_outbox; select privacy_ledger_replay((:'ev')::jsonb); rollback" -v ev="$(cat $W/partial.json)" >/dev/null 2>$W/err.txt || true; grep -q ledger_incomplete $W/err.txt && echo true)" "$(head -c 300 $W/err.txt)"
chk "and each refusal changed nothing" \
  "$([ "$before" = "$(q -c "select count(*) || '/' || (select count(*) from child_profiles) || '/' || (select count(*) from retention_holds) from privacy_deletions")" ] && echo true)"

# ------------------------------------------------------ 5. the procedure --
ship   # anything the backup recorded but hadn't copied yet
out=$(node "$R/scripts/privacy-ledger.ts" verify "$LEDGER" --out $W/events.json)
chk "the ledger verifies" "$([[ "$out" == "LEDGER OK"* ]] && echo true)" "$out"
summary=$(qv "select privacy_ledger_replay((:'ev')::jsonb)" -v ev="$(cat $W/events.json)")
chk "the replay recreates the lost requests and the hold" \
  "$(qv "select (((:'s')::jsonb->>'requests_recreated')::int = 3 and ((:'s')::jsonb->>'holds_restored')::int = 1 and ((:'s')::jsonb->>'board_contributions_removed')::int = 1)::text" -v s="$summary")" "$summary"
chk "before the follow-up, nothing of a closing family is usable or public" \
  "$(q -c "select (not exists (select 1 from child_profiles c where c.parent_id in ('a9000000-0000-4000-8000-00000000000a','a9000000-0000-4000-8000-00000000000c') and c.closing_at is null)
           and not exists (select 1 from board_contributions b join child_profiles c on c.id=b.child_id where c.closing_at is not null and b.status in ('published','pending_moderation')))::text")"
q -c "select sim.follow_up()" >/dev/null
chk "A is deleted again: account, both children, runs, answers, Trail, Board, files" \
  "$(q -c "select (not exists (select 1 from auth.users where id='a9000000-0000-4000-8000-00000000000a')
           and not exists (select 1 from profiles where id='a9000000-0000-4000-8000-00000000000a')
           and not exists (select 1 from child_profiles where parent_id='a9000000-0000-4000-8000-00000000000a')
           and not exists (select 1 from mission_progress where child_id::text like 'c9000000-0000-4000-8000-0000000000a%')
           and not exists (select 1 from mission_responses r join mission_progress p on p.id=r.progress_id where p.child_id::text like 'c9000000-0000-4000-8000-0000000000a%')
           and not exists (select 1 from mission_evidence where child_id::text like 'c9000000-0000-4000-8000-0000000000a%')
           and not exists (select 1 from board_contributions where child_id::text like 'c9000000-0000-4000-8000-0000000000a%')
           and not exists (select 1 from storage.objects where name like 'c9000000-0000-4000-8000-0000000000a%'))::text")"
chk "Bo is deleted again, and his sister Bea and their parent are intact" \
  "$(q -c "select (not exists (select 1 from child_profiles where id='c9000000-0000-4000-8000-0000000000b1')
           and not exists (select 1 from storage.objects where name like 'c9000000-0000-4000-8000-0000000000b1%')
           and exists (select 1 from child_profiles where id='c9000000-0000-4000-8000-0000000000b2' and closing_at is null)
           and exists (select 1 from mission_responses r join mission_progress p on p.id=r.progress_id where p.child_id='c9000000-0000-4000-8000-0000000000b2')
           and exists (select 1 from storage.objects where name like 'c9000000-0000-4000-8000-0000000000b2%')
           and exists (select 1 from board_contributions where child_id='c9000000-0000-4000-8000-0000000000b2' and status='published')
           and exists (select 1 from profiles where id='a9000000-0000-4000-8000-00000000000b'))::text")"
chk "C, under the hold, is kept in full: nothing deleted, nothing usable, nothing public" \
  "$(q -c "select ((select status from privacy_deletions where subject_id='a9000000-0000-4000-8000-00000000000c') = 'held'
           and exists (select 1 from retention_holds where subject_id='a9000000-0000-4000-8000-00000000000c' and released_at is null)
           and exists (select 1 from child_profiles where id='c9000000-0000-4000-8000-0000000000c1' and closing_at is not null)
           and exists (select 1 from mission_responses r join mission_progress p on p.id=r.progress_id where p.child_id='c9000000-0000-4000-8000-0000000000c1')
           and exists (select 1 from storage.objects where name like 'c9000000-0000-4000-8000-0000000000c1%')
           and (select status from board_contributions where child_id='c9000000-0000-4000-8000-0000000000c1') = 'pending_permission')::text")"
chk "D is untouched, except the contribution it withdrew, which stays withdrawn" \
  "$(q -c "select (exists (select 1 from board_contributions where id='b9000000-0000-4000-8000-0000000000d1' and status='published')
           and not exists (select 1 from board_contributions where id='b9000000-0000-4000-8000-0000000000d2')
           and exists (select 1 from storage.objects where name like 'c9000000-0000-4000-8000-0000000000d1%')
           and exists (select 1 from child_profiles where id='c9000000-0000-4000-8000-0000000000d1' and closing_at is null))::text")"
chk "E, deleted before the backup, stays deleted" \
  "$(q -c "select (not exists (select 1 from child_profiles where id='c9000000-0000-4000-8000-0000000000e1') and not exists (select 1 from auth.users where id='a9000000-0000-4000-8000-00000000000e'))::text")"
problems=$(qv "select string_agg(problem, ', ') from privacy_restore_verify((:'ev')::jsonb)" -v ev="$(cat $W/events.json)")
chk "privacy_restore_verify finds nothing: safe to reopen" "$([ -z "$problems" ] && echo true)" "$problems"
chk "replaying the ledger again changes nothing" \
  "$(qv "select ((privacy_ledger_replay((:'ev')::jsonb)->>'requests_recreated')::int = 0)::text" -v ev="$(cat $W/events.json)" )"
ship
chk "the restored database goes on writing to the same ledger, which still verifies" \
  "$(node "$R/scripts/privacy-ledger.ts" verify "$LEDGER" --out $W/after.json >/dev/null && echo true)"
# Decrypted, the events carry ids and dates only: no name, email or hold reason.
chk "the ledger holds ids and dates only, even decrypted: no name, email or hold reason" \
  "$(! grep -qE '@|sim-|"(Ada|Abe|Bo|Bea|Cal|Dee|Eve)"|dispute' $W/after.json && ! grep -q '@' "$LEDGER" && echo true)"

echo; echo "PASS: $pass   FAIL: $fail"
[ "$fail" -eq 0 ]

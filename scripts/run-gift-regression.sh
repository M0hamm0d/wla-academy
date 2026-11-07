#!/usr/bin/env bash
# Gift regression against the local stack (D-149). One transaction, rolled back;
# then real concurrent sessions on one gift, whose fixtures are removed afterwards.
# Any SQL error counts as a failure: an error silently drops the check it fed.
set -euo pipefail
PSQL=(docker exec -i supabase_db_WLA psql -U postgres -d postgres -X -A -t -q)
count() { "${PSQL[@]}" -c "select (select count(*) from mission_gifts)||'/'||(select count(*) from mission_entitlements)||'/'||(select count(*) from missions)||'/'||(select count(*) from gift_code_attempts)"; }
before=$(count)
raw=$("${PSQL[@]}" < "$(dirname "$0")/gift-regression.sql" 2>&1 || true)
out=$(echo "$raw" | grep -E '^(PASS|FAIL)  ' || true)
errs=$(echo "$raw" | grep -c 'ERROR:' || true)
echo "$out"
[ "$errs" -gt 0 ] && { echo "$raw" | grep 'ERROR:' | head -3; }

RACE_MISSION=d1000000-0000-4000-8000-000000000001
"${PSQL[@]}" <<'SQL'
insert into auth.users (id,email,aud,role,instance_id,encrypted_password,created_at,updated_at,raw_app_meta_data,raw_user_meta_data) values ('a1000000-0000-4000-8000-00000000000a','gift-race@wla-local.test','authenticated','authenticated','00000000-0000-0000-0000-000000000000','',now(),now(),'{}','{}');
insert into child_profiles (id,parent_id,display_name) values ('c1000000-0000-4000-8000-0000000000a1','a1000000-0000-4000-8000-00000000000a','R1'),('c1000000-0000-4000-8000-0000000000a2','a1000000-0000-4000-8000-00000000000a','R2');
insert into missions (id,slug,title,lab,min_age,max_age,is_free,price_minor,currency,published) values ('d1000000-0000-4000-8000-000000000001','gift-race','Gift race','decision',11,15,false,1200,'GBP',false);
insert into mission_gifts (mission_id,stripe_session_id,amount_minor,currency,early_supply_consent_at,cancellation_ack_at,consent_wording) values ('d1000000-0000-4000-8000-000000000001','cs_race',1200,'GBP',now(),now(),'v | a | b');
SQL
cleanup() { "${PSQL[@]}" <<'SQL'
delete from gift_code_attempts where occurred_at > now() - interval '1 hour' and client_key in (select encode(extensions.hmac('client:race-'||i, (select value from app_secrets where name='gift_code_pepper'), 'sha256'),'hex') from generate_series(1,8) i);
delete from mission_gifts where stripe_session_id in ('cs_race');
delete from mission_entitlements where mission_id='d1000000-0000-4000-8000-000000000001';
delete from missions where id='d1000000-0000-4000-8000-000000000001';
delete from child_profiles where parent_id='a1000000-0000-4000-8000-00000000000a';
delete from profiles where id='a1000000-0000-4000-8000-00000000000a';
delete from auth.users where id='a1000000-0000-4000-8000-00000000000a';
SQL
}
trap cleanup EXIT

# 1. Two deliveries of the same paid webhook at once: one activation, one code.
r=$(mktemp -d)
for i in 1 2; do "${PSQL[@]}" -c "select outcome||':'||coalesce(code,'') from activate_paid_gift('cs_race','pi_race');" > "$r/$i" & done
wait
activated=$(cat "$r"/* | grep -c '^activated:' || true)
code=$(cat "$r"/* | grep '^activated:' | head -1 | cut -d: -f2)
rm -rf "$r"
if [ "$activated" = "1" ] && [ -n "$code" ]; then echo "PASS  two simultaneous webhook deliveries: one activation, one code"; a=1; else echo "FAIL  activation race: activated=$activated"; a=0; fi

# 2. Eight sessions enter the same correct code at once: all may match, but only
#    the last claim stands, so exactly one of them can then redeem.
r=$(mktemp -d)
for i in 1 2 3 4 5 6 7 8; do
  "${PSQL[@]}" -c "select confirm_gift_code('$code','race-$i','claim-race-$i');" > "$r/$i" &
done
wait
matched=$(cat "$r"/* | grep -c '^matched' || true)
claims=$("${PSQL[@]}" -c "select count(*) from mission_gifts where stripe_session_id='cs_race' and claim_hash like 'claim-race-%'")
rm -rf "$r"
if [ "$matched" = "8" ] && [ "$claims" = "1" ]; then echo "PASS  eight simultaneous entries of one code leave exactly one live claim"; c=1; else echo "FAIL  code race: matched=$matched claims=$claims"; c=0; fi

# 3. All eight claims redeem at once, for two different children: one wins.
r=$(mktemp -d)
for i in 1 2 3 4 5 6 7 8; do
  child=$([ $((i % 2)) -eq 0 ] && echo c1000000-0000-4000-8000-0000000000a2 || echo c1000000-0000-4000-8000-0000000000a1)
  "${PSQL[@]}" -c "select redeem_mission_gift('claim-race-$i','$child','a1000000-0000-4000-8000-00000000000a');" > "$r/$i" &
done
wait
won=$(cat "$r"/* | grep -c '^redeemed' || true)
rm -rf "$r"
n=$("${PSQL[@]}" -c "select count(*) from mission_entitlements where mission_id='d1000000-0000-4000-8000-000000000001'")
if [ "$won" = "1" ] && [ "$n" = "1" ]; then echo "PASS  eight simultaneous redemptions: one wins, one entitlement"; v=1; else echo "FAIL  redeem race: won=$won entitlements=$n"; v=0; fi

cleanup; trap - EXIT
after=$(count)
[ "$before" = "$after" ] && { echo "PASS  local data unchanged ($after)"; d=1; } || { echo "FAIL  local data changed: $before -> $after"; d=0; }
p=$(echo "$out" | grep -c '^PASS' || true); f=$(echo "$out" | grep -c '^FAIL' || true)
[ "$p" -gt 0 ] || { echo "FAIL  the SQL checks did not run"; f=$((f + 1)); }
fails=$((f + errs + 4 - a - c - v - d))
echo; echo "PASS: $((p + a + c + v + d))   FAIL: $fails"
[ "$fails" -eq 0 ]

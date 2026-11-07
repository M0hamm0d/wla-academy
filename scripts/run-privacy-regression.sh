#!/usr/bin/env bash
# Privacy regression against the local stack (D-148, D-151): closure, deletion,
# retention and the Board's anonymity review, in one transaction that is rolled
# back. Any SQL error counts as a failure. Local data must be unchanged after.
set -euo pipefail
PSQL=(docker exec -i supabase_db_WLA psql -U postgres -d postgres -X -A -t -q)
count() { "${PSQL[@]}" -c "select (select count(*) from auth.users)||'/'||(select count(*) from child_profiles)||'/'||(select count(*) from mission_progress)||'/'||(select count(*) from mission_evidence)||'/'||(select count(*) from storage.objects)||'/'||(select count(*) from privacy_deletions)||'/'||(select count(*) from retention_runs)||'/'||(select count(*) from analytics_events where run_key is not null)"; }
before=$(count)
raw=$("${PSQL[@]}" < "$(dirname "$0")/privacy-regression.sql" 2>&1 || true)
out=$(echo "$raw" | grep -E '^(PASS|FAIL)  ' || true)
errs=$(echo "$raw" | grep -c 'ERROR:' || true)
echo "$out"
[ "$errs" -gt 0 ] && echo "$raw" | grep -A2 'ERROR:' | head -6
after=$(count)
[ "$before" = "$after" ] && { echo "PASS  local data unchanged ($after)"; d=1; } || { echo "FAIL  local data changed: $before -> $after"; d=0; }
p=$(echo "$out" | grep -c '^PASS' || true); f=$(echo "$out" | grep -c '^FAIL' || true)
[ "$p" -gt 0 ] || { echo "FAIL  the SQL checks did not run"; f=$((f + 1)); }
fails=$((f + errs + 1 - d))
echo; echo "PASS: $((p + d))   FAIL: $fails"
[ "$fails" -eq 0 ]

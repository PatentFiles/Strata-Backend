#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
PATH="${PG_BIN:?set PG_BIN to PostgreSQL bin directory}:$PATH"
# Never inherit a PG service, host address, role, credentials or connection options.
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGOPTIONS
db=$(mktemp -d /tmp/dedup-pg.XXXXXX)
trap 'pg_ctl -D "$db/data" -m immediate stop >/dev/null 2>&1 || :; rm -rf "$db"' EXIT
initdb -A trust -U strata_retry_fixture -D "$db/data" --no-locale >"$db/init.log"
pg_ctl -D "$db/data" -l "$db/postgres.log" -o "-c listen_addresses='' -p 5432 -c unix_socket_directories='$db' -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap" -w start >/dev/null
export PGHOST="$db" PGDATABASE=postgres PGUSER=strata_retry_fixture PGPORT=5432
psql -X -q -v ON_ERROR_STOP=1 -f baseline.sql -f ../../lib/db/drizzle/0046_strata_direct_entry_source.sql -f retry-candidate.sql -f staged-compat.sql -f retry-activate-rehearsal.sql -f exact-cases.sql
q(){ psql -X -qAt -v ON_ERROR_STOP=1 -c " $1"; }
wait_lock(){
 for _ in {1..100}; do
   if [[ $(q "SELECT count(*) FROM pg_stat_activity WHERE application_name='$1' AND wait_event='PgSleep'") == 1 ]]; then return; fi
   sleep .03
 done
 return 1
}
# Session application name + wait-event evidence makes the race ordering deterministic.
PGAPPNAME=first_prepare q "BEGIN; SELECT prepare_fixture('p','p1'); SELECT pg_sleep(2); COMMIT" >"$db/prepare" &
a=$!
wait_lock first_prepare
[[ $(q "SELECT retire_fixture('p','p1')") == f ]]
wait "$a"
[[ $(head -1 "$db/prepare") == t ]]
PGAPPNAME=first_retire q "BEGIN; SELECT retire_fixture('r','r1'); SELECT pg_sleep(2); COMMIT" >"$db/retire" &
a=$!
wait_lock first_retire
[[ $(q "SELECT prepare_fixture('r','r1')") == f ]]
wait "$a"
[[ $(head -1 "$db/retire") == t ]]
[[ $(q "SELECT claim_fixture('r','r2','0 ms')") == t ]]
[[ $(q "SELECT prepare_fixture('r','r2')") == t ]]
echo 'PASS: exact 0046 rehearsal, receipt ACL, rollback, and both account-lock race outcomes'

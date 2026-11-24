#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
pg="${PG_BIN:?PG_BIN must select disposable PostgreSQL 16 tools}"
[[ "$("$pg/postgres" --version)" == "postgres (PostgreSQL) 16."* ]]
disposable=$(mktemp -d /tmp/strata-worker-review-XXXXXXXX)
cleanup(){ "$pg/pg_ctl" -D "$disposable/db" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf "$disposable"; }
trap cleanup EXIT
port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
"$pg/initdb" -D "$disposable/db" -U fixture --auth=trust --no-locale --no-sync >/dev/null
"$pg/pg_ctl" -D "$disposable/db" -l "$disposable/server.log" -o "-c listen_addresses=127.0.0.1 -p $port -c unix_socket_directories=''" -w start >/dev/null
"$pg/createdb" -h 127.0.0.1 -p "$port" -U fixture independent_trace
sql=( "$pg/psql" -X -h 127.0.0.1 -p "$port" -U fixture -d independent_trace -v ON_ERROR_STOP=1 )
for f in base-fixture.sql ../../../../lib/db/drizzle/0046_strata_direct_entry_source.sql trace-fixture.sql trace.test.sql; do "${sql[@]}" -f "$f" >/dev/null; done
echo 'Disposable direct trace accepted exact evidence; cross-account, late, duplicate and dispatch rows refused.'
env -i PATH="$PATH" NODE_ENV=test FIXTURE_PORT="$port" node --test --test-concurrency=1 ./*.postgres.test.cjs

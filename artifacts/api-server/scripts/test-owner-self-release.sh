#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
export OWNER_RECOVERY_SOURCE_ROOT="$ROOT" DATABASE_URL='postgresql://agent@127.0.0.1:55469/owner_self_disposable' NODE_ENV=test
PG_BIN_DIR=${PG_BIN_DIR:-$(pg_config --bindir)}
D=$(mktemp -d /tmp/owner-self-release-XXXXXX)
"$PG_BIN_DIR/initdb" -D "$D" -U agent --auth=trust --no-locale >/dev/null
"$PG_BIN_DIR/pg_ctl" -D "$D" -l "$D/server.log" -o "-h 127.0.0.1 -p 55469 -k ''" start >/dev/null
trap '"$PG_BIN_DIR/pg_ctl" -D "$D" stop -m fast >/dev/null' EXIT
"$PG_BIN_DIR/createdb" -h127.0.0.1 -p55469 -U agent owner_self_disposable
cd "$ROOT/artifacts/api-server"
"${ESBUILD:-node_modules/.bin/esbuild}" src/lib/strata/ownerSelfStandingReview.offline.ts --bundle --platform=node --format=cjs --outfile=dist/ownerSelfStandingReview.offline.cjs --external:pg-native --external:pino --external:pino-pretty --external:pdfjs-dist >/dev/null
node dist/ownerSelfStandingReview.offline.cjs

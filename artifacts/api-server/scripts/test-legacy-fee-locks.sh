#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
export LEGACY_FEE_SOURCE_ROOT="$ROOT" NODE_ENV=test
PG_BIN_DIR=${PG_BIN_DIR:-$(pg_config --bindir)}
D=$(mktemp -d /tmp/legacy-fee-locks-XXXXXX)
"$PG_BIN_DIR/initdb" -D "$D" -U agent --auth=trust --no-locale >/dev/null
"$PG_BIN_DIR/pg_ctl" -D "$D" -l "$D/server.log" -o "-h 127.0.0.1 -p 55474 -k ''" start >/dev/null
trap '"$PG_BIN_DIR/pg_ctl" -D "$D" stop -m fast >/dev/null' EXIT
"$PG_BIN_DIR/createdb" -h127.0.0.1 -p55474 -U agent legacy_fee_locks_disposable
cd "$ROOT/artifacts/api-server"
"${ESBUILD:-node_modules/.bin/esbuild}" src/lib/strata/legacyFeeAuthorityLocks.offline.ts --bundle --platform=node --format=cjs --outfile=dist/legacy-fee-locks.cjs --external:pg-native --external:pino --external:pino-pretty --external:pdfjs-dist >/dev/null
DATABASE_URL=postgresql://agent@127.0.0.1:55474/legacy_fee_locks_disposable node dist/legacy-fee-locks.cjs

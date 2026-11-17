#!/usr/bin/env bash
# Disposable local cluster only. Requires preinstalled PostgreSQL and repo dependencies.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${PG_BIN:?Set PG_BIN to trusted PostgreSQL bin directory}"
: "${PG_SHARE:?Set PG_SHARE to its share directory}"
D=$(mktemp -d /tmp/owner-final-native.XXXXXX)
cleanup() { "$PG_BIN/pg_ctl" -D "$D" -m immediate stop >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$PG_BIN/initdb" -D "$D" -L "$PG_SHARE" -U agent --auth=trust --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$D" -l "$D/server.log" -o "-h 127.0.0.1 -p 55481 -k ''" start
"$PG_BIN/createdb" -h127.0.0.1 -p55481 -Uagent owner_activation_disposable
cd "$ROOT"
artifacts/api-server/node_modules/.bin/esbuild artifacts/api-server/src/lib/strata/durableActivation.native.test.ts --bundle --platform=node --format=cjs --outfile=artifacts/api-server/dist/durable-activation-native.cjs --external:pg-native --external:pino --external:pino-pretty --external:pdfjs-dist
OWNER_FINAL_SOURCE_ROOT="$ROOT" NODE_ENV=test DATABASE_URL=postgresql://agent@127.0.0.1:55481/owner_activation_disposable node --test artifacts/api-server/dist/durable-activation-native.cjs
printf 'Disposable evidence retained at %s; cluster stopped on exit.\n' "$D"

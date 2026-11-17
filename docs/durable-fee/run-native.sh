#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
artifacts/api-server/node_modules/.bin/esbuild artifacts/api-server/src/lib/strata/durableFeeMigration.ts artifacts/api-server/src/lib/strata/durableFeeLifecycle.ts artifacts/api-server/src/lib/strata/durableOwnerFeePolicy.ts artifacts/api-server/src/lib/strata/guardedDurableFeeWire.ts --bundle --platform=node --format=cjs --outdir=artifacts/api-server/dist --out-extension:.js=.cjs --external:pg-native --external:pdfjs-dist --external:pino --external:pino-pretty
artifacts/api-server/node_modules/.bin/esbuild docs/durable-fee/migration-fixture.ts --bundle --platform=node --format=cjs --outfile=artifacts/api-server/dist/migration-fixture.cjs
artifacts/api-server/node_modules/.bin/esbuild artifacts/api-server/src/routes/userExecutionRouter.ts --bundle --platform=node --format=cjs --outfile=artifacts/api-server/dist/durableUserExecutionRouter.cjs --external:express --external:pg-native --external:pdfjs-dist --external:pino --external:pino-pretty
: "${PG_BIN:?}" "${PG_SHARE:?}"
D=$(mktemp -d /tmp/durable-fee-native.XXXXXX)
trap '"$PG_BIN/pg_ctl" -D "$D" -m immediate stop >/dev/null 2>&1 || true' EXIT
"$PG_BIN/initdb" -D "$D" -L "$PG_SHARE" -U agent --auth=trust --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$D" -l "$D/server.log" -o "-h 127.0.0.1 -p 55483 -k ''" start >/dev/null
"$PG_BIN/createdb" -h127.0.0.1 -p55483 -Uagent durable_fee_disposable
NODE_ENV=test STRATA_DURABLE_OWNER_FEE_ENABLED=true DATABASE_URL=postgresql://agent@127.0.0.1:55483/durable_fee_disposable DURABLE_TEST_DATABASE_URL=postgresql://agent@127.0.0.1:55483/durable_fee_disposable node docs/durable-fee/native-test.mjs
NODE_ENV=test STRATA_DURABLE_OWNER_FEE_ENABLED=true DATABASE_URL=postgresql://agent@127.0.0.1:55483/durable_fee_disposable DURABLE_TEST_DATABASE_URL=postgresql://agent@127.0.0.1:55483/durable_fee_disposable node docs/durable-fee/lifecycle-native.mjs
NODE_ENV=test STRATA_DURABLE_OWNER_FEE_ENABLED=true DATABASE_URL=postgresql://agent@127.0.0.1:55483/durable_fee_disposable DURABLE_TEST_DATABASE_URL=postgresql://agent@127.0.0.1:55483/durable_fee_disposable node docs/durable-fee/migration-native.mjs

#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
export OWNER_RECOVERY_SOURCE_ROOT="$ROOT"
# Disposable only. Never reuse ambient database/provider credentials.
export DATABASE_URL='postgresql://agent@127.0.0.1:55461/compatible_disposable'
export NODE_ENV=test
PG_BIN_DIR=${PG_BIN_DIR:-$(pg_config --bindir)}
D=$(mktemp -d /tmp/owner-recovery-disposable-XXXXXX)
"$PG_BIN_DIR/initdb" -D "$D" -U agent --auth=trust --no-locale >/dev/null
"$PG_BIN_DIR/pg_ctl" -D "$D" -l "$D/server.log" -o "-h 127.0.0.1 -p 55461 -k ''" start >/dev/null
trap '"$PG_BIN_DIR/pg_ctl" -D "$D" stop -m fast >/dev/null' EXIT
"$PG_BIN_DIR/createdb" -h127.0.0.1 -p55461 -U agent compatible_disposable
cd "$ROOT/artifacts/api-server"
node_modules/.bin/esbuild src/lib/strata/ownerAtomicRecovery.offline.ts src/lib/strata/ownerRecoveryProviderIdentityCandidate.test.ts src/routes/ownerOnlyRecoveryAdmission.test.ts src/lib/strata/ownerRecoveryPoolsCandidate.test.ts --bundle --platform=node --format=cjs --outdir=dist/owner-only-candidate --out-extension:.js=.cjs --external:pg-native --external:pdfjs-dist '--external:pdfjs-dist/*' --external:pino --external:pino-pretty >/dev/null
node dist/owner-only-candidate/lib/strata/ownerAtomicRecovery.offline.cjs
node --test dist/owner-only-candidate/lib/strata/ownerRecoveryProviderIdentityCandidate.test.cjs dist/owner-only-candidate/routes/ownerOnlyRecoveryAdmission.test.cjs dist/owner-only-candidate/lib/strata/ownerRecoveryPoolsCandidate.test.cjs

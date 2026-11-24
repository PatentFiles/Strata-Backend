#!/usr/bin/env bash
set -euo pipefail
# This workflow never uses DATABASE_URL or any production credentials.
: "${TEST_CONTAINER:?GitHub service container required}"
: "${TEST_SCENARIO:?}"
: "${TEST_PG_MAJOR:?}"
[[ "$GITHUB_ACTIONS" == true && "$TEST_CONTAINER" =~ ^[a-f0-9]{64}$ && "$TEST_PG_MAJOR" =~ ^(16|17)$ ]]
[[ "$TEST_SCENARIO" == fresh || "$TEST_SCENARIO" == upgrade ]]
cd "$(git rev-parse --show-toplevel)"
db() { docker exec -i "$TEST_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d strata_platform_fee_disposable "$@"; }
[[ "$(db -Atc 'SELECT current_database()')" == strata_platform_fee_disposable ]]
[[ "$(db -Atc "SELECT current_setting('server_version_num')::int / 10000")" == "$TEST_PG_MAJOR" ]]
db <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
SQL
db < artifacts/api-server/src/lib/strata/fixtures/ownerUnknownRecoveryPlatform.sql
migration=lib/db/drizzle/0049_strata_platform_official_fee_capture.sql
mapfile -t manifest < <(node -e 'for(const p of require("./artifacts/api-server/src/lib/strata/fixtures/ownerUnknownRecoveryMigrationManifest.json")) console.log(p)')
[[ "$(printf '%s\n' "${manifest[@]}" | grep -Fxc "$migration")" == 1 ]]
for f in "${manifest[@]}"; do
  [[ "$f" == "$migration" ]] && continue
  echo "Replay $f"
  db < "$f"
done
# Production contains these tables; use their actual checked-in definition,
# not synthetic stand-ins that would skip the conditional guard.
db < docs/durable-fee/schema.sql
db < lib/db/owner-self-release/005_durable_fee_release_authorization.sql
# Fingerprint the exact tested migration and database inputs.
sha256sum "$migration" docs/durable-fee/schema.sql
snapshot() {
  db -Atc "SELECT jsonb_build_object('accounts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.v13_production_account a),'models',(SELECT jsonb_agg(to_jsonb(m) ORDER BY model_id) FROM private.strata_durable_owner_fee_model m),'states',(SELECT jsonb_agg(to_jsonb(s) ORDER BY model_id) FROM private.strata_durable_owner_fee_state s),'captures',(SELECT jsonb_agg(to_jsonb(c)-'platform_capture_id' ORDER BY capture_id) FROM private.strata_railway_official_fee_capture_v5 c))"
}
if [[ "$TEST_SCENARIO" == upgrade ]]; then
  db < docs/platform-fee-native/seed.sql
fi
before="$(snapshot)"
# Fault injection at the end of the exact migration must roll back all DDL.
if sed 's/^COMMIT;$/SELECT 1\/0; COMMIT;/' "$migration" | db; then
  echo "Expected transactional migration failure" >&2; exit 1
fi
[[ "$(db -Atc "SELECT to_regclass('private.strata_platform_official_fee_capture_v1') IS NULL")" == t ]]
[[ "$(snapshot)" == "$before" ]]
db < "$migration"
[[ "$(snapshot)" == "$before" ]]
if [[ "$TEST_SCENARIO" == fresh ]]; then
  db < docs/platform-fee-native/seed.sql
fi
db < docs/platform-fee-native/assertions.sql
echo "PASS 0049 PostgreSQL $TEST_PG_MAJOR $TEST_SCENARIO (actual schema and synthetic fee bytes only)"

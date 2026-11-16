#!/usr/bin/env bash
# Disposable local PostgreSQL only. Do not connect to production.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
BIN=/usr/lib/postgresql/16/bin
DIR=$(mktemp -d /tmp/strata-standing-fee-XXXXXX)
"$BIN/initdb" -D "$DIR" -U agent --auth=trust --no-locale >/dev/null
"$BIN/pg_ctl" -D "$DIR" -l "$DIR/server.log" -o "-h 127.0.0.1 -p 55470 -k ''" start >/dev/null
trap '"$BIN/pg_ctl" -D "$DIR" stop -m fast >/dev/null' EXIT
"$BIN/createdb" -h127.0.0.1 -p55470 -U agent standing_fee_ci
export PGHOST=127.0.0.1 PGPORT=55470 PGUSER=agent PGDATABASE=standing_fee_ci
P="$BIN/psql"
"$P" -X -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE SCHEMA auth;CREATE SCHEMA private;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid);
INSERT INTO auth.users VALUES ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
INSERT INTO public.v13_production_account VALUES('owner-account','11111111-1111-4111-8111-111111111111');
SQL
"$P" -X -q -v ON_ERROR_STOP=1 -f "$ROOT/lib/db/drizzle/0036_owner_fee_v3_evidence.sql"
"$P" -X -q -v ON_ERROR_STOP=1 -f "$ROOT/lib/db/drizzle/0037_owner_v3_fee_authority.sql"
"$P" -X -q -v ON_ERROR_STOP=1 -f "$ROOT/lib/db/owner-self-release/002_owner_standing_fee_v1.sql"
"$P" -X -q -v ON_ERROR_STOP=1 <<'SQL'
DO $block$
BEGIN
 IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
   WHERE oid='private.strata_owner_standing_fee_v1'::regclass)
 OR has_table_privilege('authenticated','private.strata_owner_standing_fee_v1','SELECT')
 THEN RAISE EXCEPTION 'owner_standing_fee_rls_not_secure'; END IF;
END $block$;
INSERT INTO private.strata_owner_fee_evidence_v3
(attestation_id,owner_user_id,execution_account_id,release_commit_sha,source_digest,market_ticker,
 verification_stage,source_kind,owner_confirmation,expires_at)
VALUES ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',
 'owner-account',repeat('a',40),repeat('b',64),'KXBTC15M-TEST-1','STEP_9',
 'official_kalshi_server_verified_v3',
 'I_AUTHORIZE_MY_OWN_OFFICIAL_KALSHI_FEE_EVIDENCE_V3',now()+interval '119 minutes');
INSERT INTO private.strata_owner_fee_authority_v3
(authority_id,attestation_id,owner_user_id,execution_account_id,release_commit_sha,official_source_digest,
 official_source_url,policy_version,formula_version,scope,authorized_stages,confirmation,expires_at)
VALUES ('44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333',
 '11111111-1111-4111-8111-111111111111','owner-account',repeat('a',40),repeat('b',64),
 'https://kalshi.com/docs/kalshi-fee-schedule.pdf',
 'strata_owner_official_monetary_fee_v3','standard-quadratic-0.07-v1',
 'KXBTC15M:INDEX2:SUBACCOUNT1',ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[],
 'I_APPROVE_MY_OWN_VERIFIED_MONETARY_FEE_GRANT_V3',now()+interval '14 minutes');
INSERT INTO private.strata_owner_standing_fee_v1
(consent_id,owner_user_id,execution_account_id,release_commit_sha,approved_policy_hash,
 source_authority_id,official_source_digest,fee_policy_version,formula_version,scope,
 confirmation,consent_digest,expires_at)
VALUES ('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111',
 'owner-account',repeat('a',40),repeat('c',64),'44444444-4444-4444-8444-444444444444',
 repeat('b',64),'strata_owner_official_monetary_fee_v3','standard-quadratic-0.07-v1',
 'KXBTC15M:INDEX2:SUBACCOUNT1',
 'I_AUTHORIZE_MY_OWN_STANDING_OFFICIAL_KALSHI_FEE_MODEL_V1',repeat('d',64),
 now()+interval '23 hours');
SQL
# A different user may not reuse an existing authenticated issuer authority.
if "$P" -X -q -v ON_ERROR_STOP=1 -c "
INSERT INTO private.strata_owner_standing_fee_v1
(consent_id,owner_user_id,execution_account_id,release_commit_sha,approved_policy_hash,
 source_authority_id,official_source_digest,fee_policy_version,formula_version,scope,
 confirmation,consent_digest,expires_at)
SELECT '66666666-6666-4666-8666-666666666666','22222222-2222-4222-8222-222222222222',
 execution_account_id,release_commit_sha,approved_policy_hash,source_authority_id,official_source_digest,
 fee_policy_version,formula_version,scope,confirmation,consent_digest,now()+interval '10 hours'
FROM private.strata_owner_standing_fee_v1 LIMIT 1;" >/dev/null 2>&1;then
 echo 'FAIL cross-owner source accepted' >&2;exit 1
fi
if "$P" -X -q -v ON_ERROR_STOP=1 -c "
UPDATE private.strata_owner_standing_fee_v1 SET approved_policy_hash=repeat('e',64)
 WHERE consent_id='55555555-5555-4555-8555-555555555555';" >/dev/null 2>&1;then
 echo 'FAIL policy scope mutable' >&2;exit 1
fi
if "$P" -X -q -v ON_ERROR_STOP=1 -c "
DELETE FROM private.strata_owner_standing_fee_v1
 WHERE consent_id='55555555-5555-4555-8555-555555555555';" >/dev/null 2>&1;then
 echo 'FAIL deletion permitted' >&2;exit 1
fi
"$P" -X -q -v ON_ERROR_STOP=1 -c "
UPDATE private.strata_owner_standing_fee_v1
SET revoked_at=clock_timestamp(),revocation_reason='authenticated_owner_revocation'
WHERE consent_id='55555555-5555-4555-8555-555555555555';"
if "$P" -X -q -v ON_ERROR_STOP=1 -c "
UPDATE private.strata_owner_standing_fee_v1 SET revoked_at=clock_timestamp()
WHERE consent_id='55555555-5555-4555-8555-555555555555';" >/dev/null 2>&1;then
 echo 'FAIL second mutation permitted' >&2;exit 1
fi
"$P" -X -q -v ON_ERROR_STOP=1 -c "
DO \$block\$ BEGIN
IF (SELECT count(*) FROM private.strata_owner_standing_fee_v1 WHERE revoked_at IS NOT NULL)<>1
OR (SELECT count(*) FROM private.strata_owner_fee_authority_v3)<>1
THEN RAISE EXCEPTION 'signed provenance lost'; END IF;
END \$block\$;"
echo 'PASS: native PostgreSQL 16 owner standing scope, RLS, source FK and one-way revocation'

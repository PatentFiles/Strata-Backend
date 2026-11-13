#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PG_BIN_DIR=${PG_BIN_DIR:-$(pg_config --bindir)}
D=$(mktemp -d /tmp/owner-recovery-schema-XXXXXX)
"$PG_BIN_DIR/initdb" -D "$D" -U agent --auth=trust --no-locale >/dev/null
"$PG_BIN_DIR/pg_ctl" -D "$D" -l "$D/server.log" -o "-h 127.0.0.1 -p 55462 -k ''" start >/dev/null
trap '"$PG_BIN_DIR/pg_ctl" -D "$D" stop -m fast >/dev/null' EXIT
"$PG_BIN_DIR/createdb" -h127.0.0.1 -p55462 -U agent owner_schema_disposable
PSQL=("$PG_BIN_DIR/psql" -X -h127.0.0.1 -p55462 -U agent -d owner_schema_disposable -v ON_ERROR_STOP=1)
M="$ROOT/lib/db/owner-only-candidate/001_owner_recovery_evidence.sql"
"${PSQL[@]}" -c 'CREATE SCHEMA private' >/dev/null
if "${PSQL[@]}" -f "$M" >"$D/refused.log" 2>&1; then echo 'missing prerequisites unexpectedly accepted'; exit 1; fi
grep -q owner_control_head_schema_missing "$D/refused.log"
"${PSQL[@]}" <<'SQL' >/dev/null
DO $$ BEGIN IF to_regclass('private.strata_owner_machine_authority') IS NOT NULL THEN RAISE EXCEPTION 'partial migration'; END IF; END $$;
CREATE TABLE private.strata_owner_control_heads(execution_account_id text PRIMARY KEY);
CREATE TABLE private.kalshi_account_worker_lease(consent_epoch bigint);
SQL
"${PSQL[@]}" -f "$M" >/dev/null
"${PSQL[@]}" <<'SQL' >/dev/null
CREATE ROLE unprivileged_candidate NOLOGIN;
DO $$ BEGIN
 IF has_table_privilege('unprivileged_candidate','private.strata_owner_machine_authority','INSERT')
 OR has_table_privilege('unprivileged_candidate','private.strata_owner_recovery_release_receipt','INSERT') THEN RAISE EXCEPTION 'unexpected runtime rights'; END IF;
 BEGIN TRUNCATE private.strata_owner_recovery_release_receipt; RAISE EXCEPTION 'truncate allowed';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'owner_recovery_receipt_immutable' THEN RAISE; END IF; END;
 BEGIN TRUNCATE private.strata_owner_machine_authority; RAISE EXCEPTION 'truncate allowed';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'machine_authority_immutable' THEN RAISE; END IF; END;
END $$;
SQL
# Reapplication must refuse rather than silently accept incompatible old objects.
if "${PSQL[@]}" -f "$M" >"$D/duplicate.log" 2>&1; then echo 'duplicate migration unexpectedly accepted'; exit 1; fi
{ printf 'PREPARE recovery_probe(text) AS '; cat "$ROOT/docs/owner-only-recovery-candidate/recovery-runtime-permissions-readonly.sql"; printf "\nEXECUTE recovery_probe('agent');\n"; } | "${PSQL[@]}" >"$D/permission-findings.log"
grep -q required_object_missing "$D/permission-findings.log"
grep -q reachable_privileged_role "$D/permission-findings.log"
echo 'PASS: prerequisite rollback, complete schema, no public authority, immutable receipts/authority, duplicate refusal (disposable PostgreSQL only)'

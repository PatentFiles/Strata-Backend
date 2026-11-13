import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { requireDevelopmentDatabase } from "./require-development-db.mjs";

const dbRequire = createRequire(import.meta.resolve("@workspace/db"));
const { Client } = dbRequire("pg");
const schema = `micro_live_test_${randomBytes(12).toString("hex")}`;
const testFile = process.argv[2] ?? "dist/microLive.integration.test.cjs";
if (!["dist/microLive.integration.test.cjs", "dist/microLiveEntryFees.test.cjs",
  "dist/microLiveFeeVerification.test.cjs",
  "dist/microLivePairKeyProvisioningAttempt.test.cjs",
  "dist/microLivePairFunding.test.cjs",
  "dist/microLivePairCommissioningApproval.test.cjs"].includes(testFile)) {
  throw new Error("Unsupported isolated micro-live test file");
}
const tables = [
  "forward_test_engine",
  "forward_test_evaluations",
  "live_execution_config",
  "micro_live_config",
  "micro_live_run_archive",
  "micro_live_commissioning_archive",
  "micro_live_pair_fee_approval",
  "micro_live_pair_funding_attempts",
  "micro_live_orders",
  "micro_live_fills",
  "micro_live_settlements",
  "micro_live_decisions",
  "micro_live_pair_boundary",
  "micro_live_subaccount_creation_attempts",
  "kalshi_key_provisioning_attempts",
];

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const isolatedUrl = new URL(process.env.DATABASE_URL);
const oldOptions = isolatedUrl.searchParams.get("options");
isolatedUrl.searchParams.set("options", [oldOptions, `-csearch_path=${schema}`].filter(Boolean).join(" "));
const setup = new Client({ connectionString: process.env.DATABASE_URL });
await setup.connect();
let schemaCreated = false;
try {
  // REPLIT_ENVIRONMENT is not a reliable database selector here: the shell
  // reports "production" while DATABASE_URL resolves to the verified dev DB.
  // Check the actual destination, without altering or bypassing any env flag.
  await requireDevelopmentDatabase(setup);
  await setup.query("BEGIN");
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    for (const table of tables) {
      await setup.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    // New gate-table DDL is isolated here until its development schema is
    // intentionally pushed; test runs must not mutate shared public schema.
    await setup.query(`
      CREATE TABLE ${schema}.micro_live_fee_verification (
        approval_id text PRIMARY KEY,
        approval_digest text NOT NULL,
        policy_version text NOT NULL,
        source_url text NOT NULL,
        formula_version text NOT NULL,
        status text NOT NULL CHECK (status IN ('pending', 'verified', 'unavailable', 'invalid')),
        attempt_id text,
        reason text,
        fee_evidence_fingerprint text,
        checked_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (
          (status = 'pending' AND attempt_id IS NOT NULL) OR
          (status <> 'pending' AND attempt_id IS NULL)
        ),
        CHECK (
          approval_digest ~ '^[0-9a-f]{64}$' AND
          btrim(approval_id) <> '' AND btrim(policy_version) <> '' AND
          btrim(source_url) <> '' AND btrim(formula_version) <> ''
        ),
        CHECK (
          status <> 'verified' OR (
            checked_at IS NOT NULL AND isfinite(checked_at) AND
            fee_evidence_fingerprint IS NOT NULL AND
            btrim(fee_evidence_fingerprint) <> ''
          )
        )
      )
    `);
    await setup.query(`
      CREATE TABLE ${schema}.micro_live_pair_key_provisioning_attempts (
        attempt_uuid uuid PRIMARY KEY,
        key_name text NOT NULL,
        subaccount integer NOT NULL,
        exchange_index integer NOT NULL,
        scopes text[] NOT NULL,
        creation_attempt_id text NOT NULL,
        clean_boundary_evidence_digest text NOT NULL,
        key_id text,
        state text NOT NULL,
        created_at timestamptz NOT NULL,
        attempted_at timestamptz,
        response_received_at timestamptz,
        metadata_verified_at timestamptz,
        confirmed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT micro_live_pair_key_attempt_pair_unique UNIQUE (subaccount, exchange_index),
        CONSTRAINT micro_live_pair_key_attempt_name_unique UNIQUE (key_name),
        CONSTRAINT micro_live_pair_key_attempt_key_id_unique UNIQUE (key_id),
        CONSTRAINT micro_live_pair_key_attempt_identity_check CHECK (
          key_name = 'MICRO_LIVE_INDEX2_SUBACCOUNT_1' AND
          subaccount = 1 AND exchange_index = 2 AND
          scopes = ARRAY['read', 'write::trade']::text[] AND
          btrim(creation_attempt_id) <> '' AND
          clean_boundary_evidence_digest ~ '^[0-9a-f]{64}$' AND
          (key_id IS NULL OR (btrim(key_id) <> '' AND length(key_id) <= 256))
        ),
        CONSTRAINT micro_live_pair_key_attempt_state_check CHECK (
          state IN ('prepared', 'attempted', 'response_received', 'metadata_verified',
            'handoff_confirmed', 'uncertain')
        ),
        CONSTRAINT micro_live_pair_key_attempt_transitions_check CHECK (
          (state = 'prepared' AND attempted_at IS NULL AND response_received_at IS NULL AND
            metadata_verified_at IS NULL AND confirmed_at IS NULL AND key_id IS NULL) OR
          (state = 'attempted' AND attempted_at IS NOT NULL AND response_received_at IS NULL AND
            metadata_verified_at IS NULL AND confirmed_at IS NULL AND key_id IS NULL) OR
          (state = 'uncertain' AND attempted_at IS NOT NULL AND response_received_at IS NULL AND
            metadata_verified_at IS NULL AND confirmed_at IS NULL AND key_id IS NULL) OR
          (state = 'response_received' AND attempted_at IS NOT NULL AND
            response_received_at IS NOT NULL AND metadata_verified_at IS NULL AND
            confirmed_at IS NULL AND key_id IS NOT NULL) OR
          (state = 'metadata_verified' AND attempted_at IS NOT NULL AND
            response_received_at IS NOT NULL AND metadata_verified_at IS NOT NULL AND
            confirmed_at IS NULL AND key_id IS NOT NULL) OR
          (state = 'handoff_confirmed' AND attempted_at IS NOT NULL AND
            response_received_at IS NOT NULL AND confirmed_at IS NOT NULL AND key_id IS NOT NULL)
        )
      )
    `);
    await setup.query("COMMIT");
  } catch (error) {
    await setup.query("ROLLBACK");
    throw error;
  }

  const isolation = new Client({ connectionString: isolatedUrl.toString() });
  try {
    await isolation.connect();
    const { rows: [context] } = await isolation.query(
      "SELECT current_schema() AS schema, count(*)::integer AS configs FROM micro_live_config",
    );
    if (context.schema !== schema || context.configs !== 0) {
      throw new Error("Micro-live test connection is not isolated");
    }
  } finally {
    await isolation.end();
  }

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test",
      ...(process.env.MICRO_LIVE_TEST_TIMEOUT_MS
        ? ["--test-timeout", process.env.MICRO_LIVE_TEST_TIMEOUT_MS] : []),
      ...(process.env.MICRO_LIVE_TEST_NAME_PATTERN
        ? ["--test-name-pattern", process.env.MICRO_LIVE_TEST_NAME_PATTERN] : []),
      testFile], {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "development",
        DATABASE_URL: isolatedUrl.toString(),
        MICRO_LIVE_TEST_ISOLATED_SCHEMA: schema,
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Micro-live tests terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  if (schemaCreated) await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await setup.end();
}
import { createHash } from "node:crypto";
import type { CredentialDatabase } from "./accountCredentialStore";

export const EXECUTE_EXECUTION_ACCOUNT_PROVISIONING_CONFIRMATION =
  "EXECUTE_PROVISION_PERSONAL_STRATA_ACCOUNT";

type AttemptState =
  | "prepared"
  | "attempted"
  | "response_received"
  | "uncertain"
  | "completed"
  | "cancelled";

export interface ExecutionAccountProvisioningResult {
  ok: boolean;
  reason: string;
  attempted: boolean;
  executable: false;
  attemptId: string | null;
  state: AttemptState | null;
  executionAccountId: string | null;
  commissioned: false;
  executionEnabled: false;
  killSwitch: true;
  idempotent: boolean;
}

const LOCK_ATTEMPT_SQL = `
  -- account-execution-provisioning:lock-attempt
  SELECT a.id::text AS attempt_id,
         a.state,
         a.plan,
         a.planned_execution_account_id,
         a.target_credential_id::text AS target_credential_id,
         a.target_fingerprint,
         restricted.id::text AS active_credential_id,
         restricted.key_fingerprint AS active_fingerprint
  FROM private.kalshi_account_operation_attempts a
  JOIN private.kalshi_connection_credentials restricted
    ON restricted.id = a.target_credential_id
   AND restricted.owner_user_id = a.owner_user_id
   AND restricted.provider_connection_id = a.provider_connection_id
   AND restricted.role = 'restricted_execution'
   AND restricted.revoked_at IS NULL
   AND restricted.verified_at IS NOT NULL
   AND restricted.verification_reason = 'credential_verified'
   AND restricted.key_fingerprint = a.target_fingerprint
  WHERE a.id = $1::uuid
    AND a.owner_user_id = $2::uuid
    AND a.financial_account_id = $3::uuid
    AND a.provider_connection_id = $4::uuid
    AND a.operation = 'provision_execution_account'
    AND restricted.id = $5::uuid
    AND restricted.key_fingerprint = $6
  FOR UPDATE OF a, restricted
`;

const MASTER_SAFETY_SQL = `
  -- account-execution-provisioning:master-safety
  SELECT live_execution_enabled, manual_kill_switch
  FROM live_execution_config
  WHERE id = 'singleton'
  FOR SHARE
`;

const LOCK_OWNED_CONNECTION_SQL = `
  -- account-execution-provisioning:lock-owned-connection
  SELECT pc.id::text AS provider_connection_id
  FROM private.provider_connections pc
  JOIN public.financial_accounts fa
    ON fa.id = pc.financial_account_id
   AND fa.user_id = $1::uuid
   AND fa.provider = 'kalshi'
  WHERE pc.id = $2::uuid
    AND pc.financial_account_id = $3::uuid
  FOR UPDATE OF pc
`;

const LOCK_UNRESOLVED_KEY_GENERATION_SQL = `
  -- account-execution-provisioning:block-unresolved-key-generation
  SELECT id::text AS attempt_id
  FROM private.kalshi_account_operation_attempts
  WHERE owner_user_id = $1::uuid
    AND financial_account_id = $2::uuid
    AND provider_connection_id = $3::uuid
    AND operation = 'generate_api_key'
    AND state IN ('attempted', 'response_received', 'uncertain')
  FOR UPDATE
`;

const LOCK_ACCOUNT_CONFLICTS_SQL = `
  -- account-execution-provisioning:lock-account-conflicts
  SELECT id,
         owner_user_id::text AS owner_user_id,
         kalshi_connection_id::text AS kalshi_connection_id,
         subaccount,
         exchange_index,
         key_fingerprint,
         commissioned,
         execution_enabled,
         kill_switch,
         cash_precision_verified,
         cash_micros::text AS cash_micros,
         reserved_micros::text AS reserved_micros,
         initial_cash_micros::text AS initial_cash_micros
  FROM v13_production_account
  WHERE id = $1
     OR owner_user_id = $2::uuid
     OR (owner_user_id = $2::uuid AND subaccount = 1 AND exchange_index = 2)
  FOR UPDATE
`;

const INSERT_ACCOUNT_SQL = `
  -- account-execution-provisioning:insert-disabled-account
  INSERT INTO v13_production_account (
    id,
    owner_user_id,
    kalshi_connection_id,
    policy_id,
    subaccount,
    exchange_index,
    key_fingerprint,
    commissioning_digest,
    kill_switch,
    execution_enabled,
    commissioned,
    minimum_exit_micros,
    fee_artifact_digest,
    cash_precision_verified,
    cash_micros,
    reserved_micros,
    initial_cash_micros,
    blocked_reason,
    reconciled_at,
    evidence_digest,
    revision
  ) VALUES (
    $1, $2::uuid, $3::uuid, NULL, 1, 2, $4, NULL,
    true, false, false, NULL, NULL, false,
    0, 0, 0, 'awaiting_account_commissioning', NULL, NULL, 0
  )
  RETURNING id
`;

const COMPLETE_ATTEMPT_SQL = `
  -- account-execution-provisioning:complete-attempt
  UPDATE private.kalshi_account_operation_attempts
  SET state = 'completed',
      attempted_at = COALESCE(attempted_at, now()),
      response_received_at = COALESCE(response_received_at, now()),
      completed_at = COALESCE(completed_at, now()),
      response_status = 201,
      response_digest = $5,
      result_reference = $6,
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND financial_account_id = $3::uuid
    AND provider_connection_id = $4::uuid
    AND operation = 'provision_execution_account'
    AND state = 'prepared'
  RETURNING id::text AS attempt_id
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^strata-account-[0-9a-f]{24}$/;

/**
 * Provisions only a disabled, killed, uncommissioned owner row. No policy,
 * configured stake, funding, worker lease, order, or exchange mutation occurs.
 */
export async function executePreparedExecutionAccountProvisioning(
  db: CredentialDatabase,
  input: {
    authenticatedUserId: string;
    financialAccountId: string;
    providerConnectionId: string;
    attemptId: string;
    confirmation: unknown;
    restrictedCredentialId: string;
    restrictedFingerprint: string;
  },
): Promise<ExecutionAccountProvisioningResult> {
  if (input.confirmation !== EXECUTE_EXECUTION_ACCOUNT_PROVISIONING_CONFIRMATION) {
    return result(false, "explicit_execution_authorization_required", false, null, null, null);
  }
  if (!UUID.test(input.attemptId)) {
    return result(false, "account_setup_attempt_invalid", false, null, null, null);
  }
  try {
    return await db.transaction(async (client) => {
      const connection = await client.query(LOCK_OWNED_CONNECTION_SQL, [
        input.authenticatedUserId,
        input.providerConnectionId,
        input.financialAccountId,
      ]);
      if (connection.rows.length !== 1) {
        return result(false, "credential_not_owned", false, input.attemptId, null, null);
      }
      const locked = await client.query(LOCK_ATTEMPT_SQL, [
        input.attemptId,
        input.authenticatedUserId,
        input.financialAccountId,
        input.providerConnectionId,
        input.restrictedCredentialId,
        input.restrictedFingerprint,
      ]);
      if (locked.rows.length !== 1) {
        return result(false, "owned_prepared_execution_provisioning_attempt_missing",
          false, input.attemptId, null, null);
      }
      const state = attemptState(locked.rows[0]?.state);
      const accountId = text(locked.rows[0]?.planned_execution_account_id);
      if (!state) {
        return result(false, "account_setup_attempt_state_invalid",
          false, input.attemptId, null, null);
      }
      if (!accountId || !ACCOUNT_ID.test(accountId) ||
          !validProvisioningPlan(locked.rows[0]?.plan, accountId)) {
        return result(false, "execution_account_provisioning_plan_invalid",
          false, input.attemptId, state, null);
      }
      if (state === "completed") {
        const accounts = await client.query(LOCK_ACCOUNT_CONFLICTS_SQL, [
          accountId,
          input.authenticatedUserId,
        ]);
        return exactSafeAccount(
          accounts.rows,
          input.authenticatedUserId,
          input.financialAccountId,
          accountId,
          input.restrictedFingerprint,
        )
          ? result(true, "execution_account_already_provisioned", false,
            input.attemptId, "completed", accountId, true)
          : result(false, "completed_provisioning_account_reconciliation_required",
            false, input.attemptId, "completed", null);
      }
      if (state !== "prepared") {
        return result(false, retryBlockedReason(state), false,
          input.attemptId, state, null);
      }
      const unresolvedGeneration = await client.query(
        LOCK_UNRESOLVED_KEY_GENERATION_SQL,
        [
          input.authenticatedUserId,
          input.financialAccountId,
          input.providerConnectionId,
        ],
      );
      if (unresolvedGeneration.rows.length > 0) {
        return result(false, "restricted_key_generation_reconciliation_required",
          false, input.attemptId, state, null);
      }
      const master = await client.query(MASTER_SAFETY_SQL);
      if (master.rows.length !== 1 ||
          master.rows[0]?.live_execution_enabled !== false ||
          master.rows[0]?.manual_kill_switch !== true) {
        return result(false, "production_safety_controls_not_fail_closed",
          false, input.attemptId, state, null);
      }
      const accounts = await client.query(LOCK_ACCOUNT_CONFLICTS_SQL, [
        accountId,
        input.authenticatedUserId,
      ]);
      if (accounts.rows.length > 0) {
        return result(false, accountConflictReason(
          accounts.rows,
          input.authenticatedUserId,
          accountId,
        ), false, input.attemptId, state, null);
      }
      const inserted = await client.query(INSERT_ACCOUNT_SQL, [
        accountId,
        input.authenticatedUserId,
        input.financialAccountId,
        input.restrictedFingerprint,
      ]);
      if (inserted.rows.length !== 1 || text(inserted.rows[0]?.id) !== accountId) {
        throw new Error("execution_account_not_inserted");
      }
      const completed = await completeAttempt(client, input, accountId);
      if (!completed) throw new Error("execution_account_provisioning_not_recorded");
      return result(true, "execution_account_provisioned_disabled_and_killed",
        true, input.attemptId, "completed", accountId);
    });
  } catch {
    return result(false, "execution_account_provisioning_transaction_failed",
      false, input.attemptId, null, null);
  }
}

async function completeAttempt(
  client: {
    query(text: string, params?: unknown[]): Promise<{
      rows: Array<Record<string, unknown>>;
      rowCount?: number | null;
    }>;
  },
  input: {
    authenticatedUserId: string;
    financialAccountId: string;
    providerConnectionId: string;
    attemptId: string;
    restrictedFingerprint: string;
  },
  accountId: string,
): Promise<boolean> {
  const digest = createHash("sha256").update(JSON.stringify({
    executionAccountId: accountId,
    subaccount: 1,
    exchangeIndex: 2,
    commissioned: false,
    executionEnabled: false,
    killSwitch: true,
    cashPrecisionVerified: false,
    keyFingerprint: input.restrictedFingerprint,
  })).digest("hex");
  const completed = await client.query(COMPLETE_ATTEMPT_SQL, [
    input.attemptId,
    input.authenticatedUserId,
    input.financialAccountId,
    input.providerConnectionId,
    digest,
    accountId,
  ]);
  return completed.rows.length === 1;
}

function exactSafeAccount(
  rows: Array<Record<string, unknown>>,
  ownerUserId: string,
  financialAccountId: string,
  accountId: string,
  fingerprint: string,
): boolean {
  if (rows.length !== 1) return false;
  const row = rows[0] ?? {};
  return text(row.id) === accountId &&
    text(row.owner_user_id) === ownerUserId &&
    text(row.kalshi_connection_id) === financialAccountId &&
    integer(row.subaccount) === 1 &&
    integer(row.exchange_index) === 2 &&
    text(row.key_fingerprint) === fingerprint &&
    row.commissioned === false &&
    row.execution_enabled === false &&
    row.kill_switch === true &&
    row.cash_precision_verified === false &&
    text(row.cash_micros) === "0" &&
    text(row.reserved_micros) === "0" &&
    text(row.initial_cash_micros) === "0";
}

function accountConflictReason(
  rows: Array<Record<string, unknown>>,
  ownerUserId: string,
  accountId: string,
): string {
  if (rows.some((row) => text(row.id) === accountId &&
      text(row.owner_user_id) !== ownerUserId)) {
    return "execution_account_id_conflict";
  }
  if (rows.some((row) => text(row.owner_user_id) === ownerUserId)) {
    return "execution_account_already_exists";
  }
  return "execution_account_provisioning_conflict";
}

function validProvisioningPlan(value: unknown, accountId: string): boolean {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const plan = parsed as Record<string, unknown>;
  return Object.keys(plan).length === 8 &&
    plan.operation === "provision_execution_account" &&
    plan.plannedExecutionAccountId === accountId &&
    plan.subaccount === 1 &&
    plan.exchangeIndex === 2 &&
    plan.commissioned === false &&
    plan.executionEnabled === false &&
    plan.killSwitch === true &&
    plan.cashPrecisionVerified === false;
}

function retryBlockedReason(state: AttemptState): string {
  if (state === "cancelled") return "execution_account_provisioning_attempt_cancelled";
  return `execution_account_provisioning_retry_blocked_${state}`;
}

function attemptState(value: unknown): AttemptState | null {
  return value === "prepared" || value === "attempted" || value === "response_received" ||
    value === "uncertain" || value === "completed" || value === "cancelled"
    ? value
    : null;
}

function result(
  ok: boolean,
  reason: string,
  attempted: boolean,
  attemptId: string | null,
  state: AttemptState | null,
  executionAccountId: string | null,
  idempotent = false,
): ExecutionAccountProvisioningResult {
  return {
    ok,
    reason,
    attempted,
    executable: false,
    attemptId,
    state,
    executionAccountId,
    commissioned: false,
    executionEnabled: false,
    killSwitch: true,
    idempotent,
  };
}

function text(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return typeof value === "string" && value.trim() ? value : null;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

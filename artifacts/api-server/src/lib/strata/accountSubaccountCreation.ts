import { createHash } from "node:crypto";
import type { CredentialDatabase } from "./accountCredentialStore";

export const EXECUTE_SUBACCOUNT_CREATION_CONFIRMATION =
  "EXECUTE_CREATE_SUBACCOUNT_1_ON_EXCHANGE_INDEX_2";

export interface SubaccountCreationExchangeResult {
  status: number;
  body: unknown;
  unreadable: boolean;
}

export type SubaccountCreationTransport = (
  material: { keyId: string; privateKey: string },
) => Promise<SubaccountCreationExchangeResult | "uncertain">;

export interface SubaccountCreationExecutionResult {
  ok: boolean;
  reason: string;
  attempted: boolean;
  executable: false;
  attemptId: string | null;
  state: "prepared" | "attempted" | "response_received" | "uncertain" | "completed" | "cancelled" | null;
  subaccount1Exists: boolean | null;
  subaccount1Exchange2Exists: boolean | null;
}

const LOCK_ATTEMPT_SQL = `
  -- account-subaccount-creation:lock-attempt
  SELECT a.id::text AS attempt_id,
         a.state,
         a.plan,
         c.id::text AS execution_credential_id
  FROM private.kalshi_account_operation_attempts a
  JOIN private.kalshi_connection_credentials c
    ON c.id = $5::uuid
   AND c.owner_user_id = a.owner_user_id
   AND c.provider_connection_id = a.provider_connection_id
   AND c.role = 'account_setup_execution'
   AND c.revoked_at IS NULL
   AND c.verified_at IS NOT NULL
   AND c.verification_reason = 'credential_verified'
   AND c.key_fingerprint = $6
  WHERE a.id = $1::uuid
    AND a.owner_user_id = $2::uuid
    AND a.financial_account_id = $3::uuid
    AND a.provider_connection_id = $4::uuid
    AND a.operation = 'create_subaccount'
  FOR UPDATE OF a
`;

const MASTER_SAFETY_SQL = `
  -- account-subaccount-creation:master-safety
  SELECT live_execution_enabled, manual_kill_switch
  FROM live_execution_config
  WHERE id = 'singleton'
  FOR SHARE
`;

const MARK_ATTEMPTED_SQL = `
  -- account-subaccount-creation:mark-attempted
  UPDATE private.kalshi_account_operation_attempts
  SET state = 'attempted',
      attempted_at = now(),
      target_credential_id = $5::uuid,
      target_fingerprint = $6,
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND financial_account_id = $3::uuid
    AND provider_connection_id = $4::uuid
    AND operation = 'create_subaccount'
    AND state = 'prepared'
  RETURNING id::text AS attempt_id, state
`;

const MARK_UNCERTAIN_SQL = `
  -- account-subaccount-creation:mark-uncertain
  UPDATE private.kalshi_account_operation_attempts
  SET state = 'uncertain',
      response_status = $4::integer,
      response_digest = $5,
      uncertainty_reason = $6,
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND provider_connection_id = $3::uuid
    AND operation = 'create_subaccount'
    AND state = 'attempted'
  RETURNING id::text AS attempt_id
`;

const MARK_RESPONSE_SQL = `
  -- account-subaccount-creation:mark-response
  UPDATE private.kalshi_account_operation_attempts
  SET state = 'response_received',
      response_received_at = now(),
      response_status = $4::integer,
      response_digest = $5,
      result_reference = $6,
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND provider_connection_id = $3::uuid
    AND operation = 'create_subaccount'
    AND state = 'attempted'
  RETURNING id::text AS attempt_id
`;

const MARK_COMPLETED_SQL = `
  -- account-subaccount-creation:mark-completed
  UPDATE private.kalshi_account_operation_attempts
  SET state = 'completed',
      completed_at = now(),
      result_reference = 'subaccount_1_exchange_2_inventory_verified',
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND provider_connection_id = $3::uuid
    AND operation = 'create_subaccount'
    AND state = 'response_received'
    AND response_status = 201
  RETURNING id::text AS attempt_id
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Performs at most one fixed Kalshi POST after a committed attempted latch.
 * All authorization and read-only inventory checks must be supplied fresh by
 * the caller. No state other than prepared can ever cross the POST boundary.
 */
export async function executePreparedSubaccountCreation(
  db: CredentialDatabase,
  input: {
    authenticatedUserId: string;
    financialAccountId: string;
    providerConnectionId: string;
    attemptId: string;
    confirmation: unknown;
    executionCredentialId: string;
    executionFingerprint: string;
    executionMaterial: { keyId: string; privateKey: string };
    transport: SubaccountCreationTransport;
    verifyCreated: () => Promise<{
      ok: boolean;
      reason: string;
      subaccount1Exists: boolean | null;
      subaccount1Exchange2Exists: boolean | null;
    }>;
  },
): Promise<SubaccountCreationExecutionResult> {
  if (input.confirmation !== EXECUTE_SUBACCOUNT_CREATION_CONFIRMATION) {
    return result(false, "explicit_execution_authorization_required", false, null, null);
  }
  if (!UUID.test(input.attemptId)) {
    return result(false, "account_setup_attempt_invalid", false, null, null);
  }
  const claimed = await claimAttempt(db, input);
  if (!claimed.ok) {
    return result(false, claimed.reason, false, input.attemptId, claimed.state);
  }

  let response: SubaccountCreationExchangeResult | "uncertain";
  try {
    response = await input.transport(input.executionMaterial);
  } catch {
    response = "uncertain";
  }
  if (response === "uncertain") {
    await markUncertain(db, input, null, null, "transport_outcome_unknown");
    return result(false, "subaccount_creation_outcome_uncertain_no_retry", true,
      input.attemptId, "uncertain");
  }

  const digest = responseDigest(response);
  if (ambiguousResponse(response)) {
    await markUncertain(
      db,
      input,
      response.status,
      digest,
      response.status === 201
        ? "creation_response_unreadable_or_invalid"
        : "upstream_response_may_be_ambiguous",
    );
    return result(false, "subaccount_creation_outcome_uncertain_no_retry", true,
      input.attemptId, "uncertain");
  }

  if (response.status !== 201) {
    const stored = await markResponse(
      db,
      input,
      response.status,
      digest,
      safeResponseReference(response),
    );
    return result(false, stored
      ? "subaccount_creation_rejected_no_retry"
      : "subaccount_creation_response_not_recorded_no_retry",
    true, input.attemptId, stored ? "response_received" : "attempted");
  }

  if (createdSubaccount(response.body) !== 1) {
    await markUncertain(db, input, response.status, digest, "unexpected_created_subaccount");
    return result(false, "subaccount_creation_response_mismatch_no_retry", true,
      input.attemptId, "uncertain");
  }
  const responseStored = await markResponse(
    db,
    input,
    response.status,
    digest,
    "subaccount_1_creation_response_received",
  );
  if (!responseStored) {
    return result(false, "subaccount_creation_response_not_recorded_no_retry", true,
      input.attemptId, "attempted");
  }

  let verification: Awaited<ReturnType<typeof input.verifyCreated>>;
  try {
    verification = await input.verifyCreated();
  } catch {
    verification = {
      ok: false,
      reason: "subaccount_inventory_unproven",
      subaccount1Exists: null,
      subaccount1Exchange2Exists: null,
    };
  }
  if (!verification.ok || verification.subaccount1Exists !== true ||
      verification.subaccount1Exchange2Exists !== true) {
    return {
      ...result(false, "creation_response_received_inventory_verification_required",
        true, input.attemptId, "response_received"),
      subaccount1Exists: verification.subaccount1Exists,
      subaccount1Exchange2Exists: verification.subaccount1Exchange2Exists,
    };
  }
  const completed = await markCompleted(db, input);
  return {
    ...result(completed, completed
      ? "subaccount_1_created_and_verified"
      : "subaccount_creation_completion_not_recorded",
    true, input.attemptId, completed ? "completed" : "response_received"),
    subaccount1Exists: true,
    subaccount1Exchange2Exists: true,
  };
}

async function claimAttempt(
  db: CredentialDatabase,
  input: {
    authenticatedUserId: string;
    financialAccountId: string;
    providerConnectionId: string;
    attemptId: string;
    executionCredentialId: string;
    executionFingerprint: string;
  },
): Promise<{ ok: true } | {
  ok: false;
  reason: string;
  state: SubaccountCreationExecutionResult["state"];
}> {
  try {
    return await db.transaction(async (client) => {
      const locked = await client.query(LOCK_ATTEMPT_SQL, [
        input.attemptId,
        input.authenticatedUserId,
        input.financialAccountId,
        input.providerConnectionId,
        input.executionCredentialId,
        input.executionFingerprint,
      ]);
      if (locked.rows.length !== 1) {
        return { ok: false as const, reason: "owned_prepared_creation_attempt_missing", state: null };
      }
      const state = attemptState(locked.rows[0]?.state);
      if (!state) {
        return { ok: false as const, reason: "account_setup_attempt_state_invalid", state: null };
      }
      if (!validCreationPlan(locked.rows[0]?.plan)) {
        return { ok: false as const, reason: "subaccount_creation_plan_invalid", state };
      }
      if (state !== "prepared") {
        return { ok: false as const, reason: retryBlockedReason(state), state };
      }
      const master = await client.query(MASTER_SAFETY_SQL);
      if (master.rows.length !== 1 ||
          master.rows[0]?.live_execution_enabled !== false ||
          master.rows[0]?.manual_kill_switch !== true) {
        return { ok: false as const, reason: "production_safety_controls_not_fail_closed", state };
      }
      const marked = await client.query(MARK_ATTEMPTED_SQL, [
        input.attemptId,
        input.authenticatedUserId,
        input.financialAccountId,
        input.providerConnectionId,
        input.executionCredentialId,
        input.executionFingerprint,
      ]);
      if (marked.rows.length !== 1) {
        return { ok: false as const, reason: "subaccount_creation_attempt_not_claimed", state };
      }
      return { ok: true as const };
    });
  } catch {
    return { ok: false, reason: "subaccount_creation_attempt_not_claimed", state: null };
  }
}

async function markUncertain(
  db: CredentialDatabase,
  input: { authenticatedUserId: string; providerConnectionId: string; attemptId: string },
  status: number | null,
  digest: string | null,
  reason: string,
): Promise<boolean> {
  const marked = await db.query(MARK_UNCERTAIN_SQL, [
    input.attemptId,
    input.authenticatedUserId,
    input.providerConnectionId,
    status,
    digest,
    reason,
  ]);
  return marked.rows.length === 1;
}

async function markResponse(
  db: CredentialDatabase,
  input: { authenticatedUserId: string; providerConnectionId: string; attemptId: string },
  status: number,
  digest: string,
  reference: string,
): Promise<boolean> {
  const marked = await db.query(MARK_RESPONSE_SQL, [
    input.attemptId,
    input.authenticatedUserId,
    input.providerConnectionId,
    status,
    digest,
    reference,
  ]);
  return marked.rows.length === 1;
}

async function markCompleted(
  db: CredentialDatabase,
  input: { authenticatedUserId: string; providerConnectionId: string; attemptId: string },
): Promise<boolean> {
  const marked = await db.query(MARK_COMPLETED_SQL, [
    input.attemptId,
    input.authenticatedUserId,
    input.providerConnectionId,
  ]);
  return marked.rows.length === 1;
}

function ambiguousResponse(response: SubaccountCreationExchangeResult): boolean {
  return response.unreadable ||
    response.status === 408 ||
    response.status === 409 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500;
}

function createdSubaccount(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (record.exchange_index !== undefined && record.exchange_index !== 2) return null;
  return record.subaccount_number === 1 ? 1 : null;
}

function safeResponseReference(response: SubaccountCreationExchangeResult): string {
  let code = "no_code";
  if (response.body && typeof response.body === "object" && !Array.isArray(response.body)) {
    const value = (response.body as Record<string, unknown>).code;
    if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value)) code = value;
  }
  return `http_${response.status}_${code}`.slice(0, 200);
}

function responseDigest(response: SubaccountCreationExchangeResult): string {
  return createHash("sha256").update(canonicalJson({
    status: response.status,
    unreadable: response.unreadable,
    body: response.body,
  })).digest("hex");
}

function validCreationPlan(value: unknown): boolean {
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
  if (plan.operation !== "create_subaccount" ||
      plan.exchangePath !== "/trade-api/v2/portfolio/subaccounts" ||
      plan.method !== "POST" ||
      plan.expectedSubaccount !== 1 ||
      !plan.request || typeof plan.request !== "object" || Array.isArray(plan.request)) return false;
  const request = plan.request as Record<string, unknown>;
  return Object.keys(request).length === 1 && request.exchange_index === 2;
}

function attemptState(value: unknown): SubaccountCreationExecutionResult["state"] {
  return value === "prepared" || value === "attempted" || value === "response_received" ||
    value === "uncertain" || value === "completed" || value === "cancelled"
    ? value
    : null;
}

function retryBlockedReason(state: Exclude<SubaccountCreationExecutionResult["state"], null>): string {
  if (state === "completed") return "subaccount_creation_already_completed";
  if (state === "cancelled") return "subaccount_creation_attempt_cancelled";
  return `subaccount_creation_retry_blocked_${state}`;
}

function result(
  ok: boolean,
  reason: string,
  attempted: boolean,
  attemptId: string | null,
  state: SubaccountCreationExecutionResult["state"],
): SubaccountCreationExecutionResult {
  return {
    ok,
    reason,
    attempted,
    executable: false,
    attemptId,
    state,
    subaccount1Exists: null,
    subaccount1Exchange2Exists: null,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

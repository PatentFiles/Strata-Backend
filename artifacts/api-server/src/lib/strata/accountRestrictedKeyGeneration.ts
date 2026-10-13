import { createHash, randomUUID } from "node:crypto";
import {
  replaceOwnedCredentialInTransaction,
  type CredentialDatabase,
} from "./accountCredentialStore";
import { dedicatedSignerFingerprint } from "./commissioning";

export const EXECUTE_RESTRICTED_KEY_GENERATION_CONFIRMATION =
  "EXECUTE_GENERATE_STRATA_V13_SUBACCOUNT_1_KEY";
export const RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION =
  "RECONCILE_GENERATED_STRATA_V13_SUBACCOUNT_1_KEY";

export interface RestrictedKeyGenerationExchangeResult {
  status: number;
  body: unknown;
  unreadable: boolean;
}

export type RestrictedKeyGenerationTransport = (
  material: { keyId: string; privateKey: string },
) => Promise<RestrictedKeyGenerationExchangeResult | "uncertain">;

type AttemptState =
  | "prepared"
  | "attempted"
  | "response_received"
  | "uncertain"
  | "completed"
  | "cancelled";

export interface RestrictedKeyGenerationExecutionResult {
  ok: boolean;
  reason: string;
  attempted: boolean;
  executable: false;
  attemptId: string | null;
  state: AttemptState | null;
  restrictedKeyVerified: boolean;
  reconciliationRequired: boolean;
}

const LOCK_ATTEMPT_SQL = `
  -- account-restricted-key-generation:lock-attempt
  SELECT a.id::text AS attempt_id,
         a.state,
         a.plan,
         a.target_fingerprint,
         prior.key_fingerprint AS prior_fingerprint
  FROM private.kalshi_account_operation_attempts a
  JOIN private.kalshi_connection_credentials preparation
    ON preparation.id = a.authority_credential_id
   AND preparation.owner_user_id = a.owner_user_id
   AND preparation.provider_connection_id = a.provider_connection_id
   AND preparation.role = 'provisioning'
   AND preparation.revoked_at IS NULL
   AND preparation.verified_at IS NOT NULL
   AND preparation.verification_reason = 'credential_verified'
   AND preparation.key_fingerprint = a.authority_fingerprint
  JOIN private.kalshi_connection_credentials execution
    ON execution.id = $5::uuid
   AND execution.owner_user_id = a.owner_user_id
   AND execution.provider_connection_id = a.provider_connection_id
   AND execution.role = 'account_setup_execution'
   AND execution.revoked_at IS NULL
   AND execution.verified_at IS NOT NULL
   AND execution.verification_reason = 'credential_verified'
   AND execution.key_fingerprint = $6
  JOIN private.kalshi_connection_credentials verification
    ON verification.id = $7::uuid
   AND verification.owner_user_id = a.owner_user_id
   AND verification.provider_connection_id = a.provider_connection_id
   AND verification.role = 'verification'
   AND verification.revoked_at IS NULL
   AND verification.verified_at IS NOT NULL
   AND verification.verification_reason = 'credential_verified'
   AND verification.key_fingerprint = $8
  LEFT JOIN private.kalshi_connection_credentials prior
    ON prior.owner_user_id = a.owner_user_id
   AND prior.provider_connection_id = a.provider_connection_id
   AND prior.role = 'restricted_execution'
   AND prior.revoked_at IS NULL
  WHERE a.id = $1::uuid
    AND a.owner_user_id = $2::uuid
    AND a.financial_account_id = $3::uuid
    AND a.provider_connection_id = $4::uuid
    AND a.operation = 'generate_api_key'
  FOR UPDATE OF a
`;

const MASTER_SAFETY_SQL = `
  -- account-restricted-key-generation:master-safety
  SELECT live_execution_enabled, manual_kill_switch
  FROM live_execution_config
  WHERE id = 'singleton'
  FOR SHARE
`;

const MARK_ATTEMPTED_SQL = `
  -- account-restricted-key-generation:mark-attempted
  UPDATE private.kalshi_account_operation_attempts
  SET state = 'attempted',
      attempted_at = now(),
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND financial_account_id = $3::uuid
    AND provider_connection_id = $4::uuid
    AND operation = 'generate_api_key'
    AND state = 'prepared'
  RETURNING id::text AS attempt_id
`;

const LOCK_ATTEMPTED_SQL = `
  -- account-restricted-key-generation:lock-attempted
  SELECT id::text AS attempt_id,
         target_fingerprint
  FROM private.kalshi_account_operation_attempts
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND financial_account_id = $3::uuid
    AND provider_connection_id = $4::uuid
    AND operation = 'generate_api_key'
    AND state = 'attempted'
  FOR UPDATE
`;

const LOCK_ACTIVE_RESTRICTED_SQL = `
  -- account-restricted-key-generation:lock-active-restricted
  SELECT id::text AS credential_id,
         key_fingerprint
  FROM private.kalshi_connection_credentials
  WHERE owner_user_id = $1::uuid
    AND financial_account_id = $2::uuid
    AND provider_connection_id = $3::uuid
    AND role = 'restricted_execution'
    AND revoked_at IS NULL
  FOR UPDATE
`;

const LOCK_OWNED_CONNECTION_SQL = `
  -- account-restricted-key-generation:lock-owned-connection
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

const EXISTING_EXECUTION_ACCOUNT_SQL = `
  -- account-restricted-key-generation:existing-execution-account
  SELECT id
  FROM v13_production_account
  WHERE owner_user_id = $1::uuid
    AND kalshi_connection_id = $2::uuid
  LIMIT 1
`;

const CREATE_VAULT_SECRET_SQL = `
  -- account-restricted-key-generation:create-secret
  SELECT vault.create_secret($1, $2, $3) AS id
`;

const MARK_RESPONSE_STORED_SQL = `
  -- account-restricted-key-generation:mark-response-stored
  UPDATE private.kalshi_account_operation_attempts
  SET state = 'response_received',
      response_received_at = now(),
      response_status = 201,
      response_digest = $5,
      result_reference = 'restricted_credential_stored_pending_verification',
      target_credential_id = $6::uuid,
      target_fingerprint = $7,
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND financial_account_id = $3::uuid
    AND provider_connection_id = $4::uuid
    AND operation = 'generate_api_key'
    AND state = 'attempted'
  RETURNING id::text AS attempt_id
`;

const INSERT_RECONCILIATION_BINDING_SQL = `
  -- account-restricted-key-generation:insert-reconciliation-binding
  INSERT INTO private.kalshi_connection_credentials (
    owner_user_id,
    financial_account_id,
    provider_connection_id,
    role,
    vault_secret_id,
    key_fingerprint,
    verified_at,
    verification_reason,
    revoked_at
  ) VALUES (
    $1::uuid, $2::uuid, $3::uuid, 'restricted_execution',
    $4::uuid, $5, NULL, 'generated_reconciliation_required', now()
  )
  RETURNING id::text AS credential_id
`;

const MARK_ROTATED_RESPONSE_STORED_SQL = `
  -- account-restricted-key-generation:mark-rotated-response-stored
  UPDATE private.kalshi_account_operation_attempts
  SET state = 'uncertain',
      response_received_at = now(),
      response_status = 201,
      response_digest = $5,
      result_reference = 'restricted_credential_stored_for_reconciliation',
      uncertainty_reason = 'restricted_execution_credential_rotated_during_generation',
      target_credential_id = $6::uuid,
      target_fingerprint = $7,
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND financial_account_id = $3::uuid
    AND provider_connection_id = $4::uuid
    AND operation = 'generate_api_key'
    AND state = 'attempted'
  RETURNING id::text AS attempt_id
`;

const MARK_REJECTED_RESPONSE_SQL = `
  -- account-restricted-key-generation:mark-rejected-response
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
    AND operation = 'generate_api_key'
    AND state = 'attempted'
  RETURNING id::text AS attempt_id
`;

const MARK_UNCERTAIN_SQL = `
  -- account-restricted-key-generation:mark-uncertain
  UPDATE private.kalshi_account_operation_attempts
  SET state = 'uncertain',
      response_status = COALESCE($4::integer, response_status),
      response_digest = COALESCE($5, response_digest),
      uncertainty_reason = $6,
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND provider_connection_id = $3::uuid
    AND operation = 'generate_api_key'
    AND state IN ('attempted', 'response_received')
  RETURNING id::text AS attempt_id
`;

const LOCK_RESPONSE_AND_AUTHORITIES_SQL = `
  -- account-restricted-key-generation:lock-response-and-authorities
  SELECT a.id::text AS attempt_id,
         target.id::text AS target_credential_id,
         verification.id::text AS verification_credential_id,
         preparation.id::text AS preparation_credential_id,
         execution.id::text AS execution_credential_id
  FROM private.kalshi_account_operation_attempts a
  JOIN private.kalshi_connection_credentials target
    ON target.id = a.target_credential_id
   AND target.owner_user_id = a.owner_user_id
   AND target.provider_connection_id = a.provider_connection_id
   AND target.role = 'restricted_execution'
   AND target.revoked_at IS NULL
   AND target.key_fingerprint = a.target_fingerprint
  JOIN private.kalshi_connection_credentials verification
    ON verification.id = $5::uuid
   AND verification.owner_user_id = a.owner_user_id
   AND verification.provider_connection_id = a.provider_connection_id
   AND verification.role = 'verification'
   AND verification.revoked_at IS NULL
   AND verification.verified_at IS NOT NULL
   AND verification.verification_reason = 'credential_verified'
   AND verification.key_fingerprint = $6
  JOIN private.kalshi_connection_credentials preparation
    ON preparation.id = a.authority_credential_id
   AND preparation.owner_user_id = a.owner_user_id
   AND preparation.provider_connection_id = a.provider_connection_id
   AND preparation.role = 'provisioning'
   AND preparation.revoked_at IS NULL
   AND preparation.verified_at IS NOT NULL
   AND preparation.verification_reason = 'credential_verified'
   AND preparation.key_fingerprint = a.authority_fingerprint
  JOIN private.kalshi_connection_credentials execution
    ON execution.id = $7::uuid
   AND execution.owner_user_id = a.owner_user_id
   AND execution.provider_connection_id = a.provider_connection_id
   AND execution.role = 'account_setup_execution'
   AND execution.revoked_at IS NULL
   AND execution.verified_at IS NOT NULL
   AND execution.verification_reason = 'credential_verified'
   AND execution.key_fingerprint = $8
  WHERE a.id = $1::uuid
    AND a.owner_user_id = $2::uuid
    AND a.financial_account_id = $3::uuid
    AND a.provider_connection_id = $4::uuid
    AND a.operation = 'generate_api_key'
    AND a.state = 'response_received'
    AND a.response_status = 201
  FOR UPDATE OF a, target, verification, preparation, execution
`;

const MARK_CREDENTIAL_VERIFIED_SQL = `
  -- account-restricted-key-generation:mark-credential-verified
  UPDATE private.kalshi_connection_credentials
  SET verified_at = now(),
      verification_reason = 'credential_verified',
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND provider_connection_id = $3::uuid
    AND role = 'restricted_execution'
    AND key_fingerprint = $4
    AND revoked_at IS NULL
    AND verified_at IS NULL
  RETURNING id::text AS credential_id
`;

const MARK_COMPLETED_SQL = `
  -- account-restricted-key-generation:mark-completed
  UPDATE private.kalshi_account_operation_attempts
  SET state = 'completed',
      completed_at = now(),
      result_reference = 'restricted_credential_bound_and_verified',
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND provider_connection_id = $3::uuid
    AND operation = 'generate_api_key'
    AND state = 'response_received'
    AND target_credential_id = $4::uuid
    AND target_fingerprint = $5
  RETURNING id::text AS attempt_id
`;

const LOCK_RECONCILABLE_RESPONSE_SQL = `
  -- account-restricted-key-generation:lock-reconcilable-response
  SELECT a.id::text AS attempt_id,
         a.state,
         target.id::text AS target_credential_id,
         verification.id::text AS verification_credential_id
  FROM private.kalshi_account_operation_attempts a
  JOIN private.kalshi_connection_credentials target
    ON target.id = a.target_credential_id
   AND target.owner_user_id = a.owner_user_id
   AND target.financial_account_id = a.financial_account_id
   AND target.provider_connection_id = a.provider_connection_id
   AND target.role = 'restricted_execution'
   AND target.revoked_at IS NULL
   AND target.key_fingerprint = a.target_fingerprint
  JOIN private.kalshi_connection_credentials verification
    ON verification.id = $7::uuid
   AND verification.owner_user_id = a.owner_user_id
   AND verification.financial_account_id = a.financial_account_id
   AND verification.provider_connection_id = a.provider_connection_id
   AND verification.role = 'verification'
   AND verification.revoked_at IS NULL
   AND verification.verified_at IS NOT NULL
   AND verification.verification_reason = 'credential_verified'
   AND verification.key_fingerprint = $8
  WHERE a.id = $1::uuid
    AND a.owner_user_id = $2::uuid
    AND a.financial_account_id = $3::uuid
    AND a.provider_connection_id = $4::uuid
    AND a.operation = 'generate_api_key'
    AND a.state IN ('response_received', 'uncertain', 'completed')
    AND a.response_status = 201
    AND a.response_received_at IS NOT NULL
    AND target.id = $5::uuid
    AND target.key_fingerprint = $6
  FOR UPDATE OF a, target, verification
`;

const MARK_RECONCILED_CREDENTIAL_VERIFIED_SQL = `
  -- account-restricted-key-generation:mark-reconciled-credential-verified
  UPDATE private.kalshi_connection_credentials
  SET verified_at = COALESCE(verified_at, now()),
      verification_reason = 'credential_verified',
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND financial_account_id = $3::uuid
    AND provider_connection_id = $4::uuid
    AND role = 'restricted_execution'
    AND key_fingerprint = $5
    AND revoked_at IS NULL
    AND (verified_at IS NULL OR verification_reason = 'credential_verified')
  RETURNING id::text AS credential_id
`;

const MARK_RECONCILED_COMPLETED_SQL = `
  -- account-restricted-key-generation:mark-reconciled-completed
  UPDATE private.kalshi_account_operation_attempts
  SET state = 'completed',
      completed_at = COALESCE(completed_at, now()),
      uncertainty_reason = NULL,
      result_reference = 'restricted_credential_bound_and_verified',
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND financial_account_id = $3::uuid
    AND provider_connection_id = $4::uuid
    AND operation = 'generate_api_key'
    AND state IN ('response_received', 'uncertain')
    AND response_status = 201
    AND response_received_at IS NOT NULL
    AND target_credential_id = $5::uuid
    AND target_fingerprint = $6
  RETURNING id::text AS attempt_id
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Executes one fixed key-generation POST. The attempted latch is committed
 * first. A successful one-time private key is Vault-stored before any
 * independent verification read, and no retry path exists after that latch.
 */
export async function executePreparedRestrictedKeyGeneration(
  db: CredentialDatabase,
  input: {
    authenticatedUserId: string;
    financialAccountId: string;
    providerConnectionId: string;
    attemptId: string;
    confirmation: unknown;
    verificationCredentialId: string;
    verificationFingerprint: string;
    provisioningCredentialId: string;
    executionCredentialId: string;
    executionFingerprint: string;
    executionMaterial: { keyId: string; privateKey: string };
    transport: RestrictedKeyGenerationTransport;
    verifyGenerated: (
      material: { keyId: string; privateKey: string },
      fingerprint: string,
    ) => Promise<{ ok: boolean; reason: string }>;
  },
): Promise<RestrictedKeyGenerationExecutionResult> {
  if (input.confirmation !== EXECUTE_RESTRICTED_KEY_GENERATION_CONFIRMATION) {
    return result(false, "explicit_execution_authorization_required", false, null, null);
  }
  if (!UUID.test(input.attemptId)) {
    return result(false, "account_setup_attempt_invalid", false, null, null);
  }
  const claimed = await claimAttempt(db, input);
  if (!claimed.ok) {
    if (claimed.state === "completed") {
      return result(true, "restricted_key_already_generated_and_verified", false,
        input.attemptId, "completed", true);
    }
    return result(false, claimed.reason, false, input.attemptId, claimed.state);
  }

  let response: RestrictedKeyGenerationExchangeResult | "uncertain";
  try {
    response = await input.transport(input.executionMaterial);
  } catch {
    response = "uncertain";
  }
  if (response === "uncertain") {
    const marked = await markUncertain(db, input, null, null, "transport_outcome_unknown");
    return result(false, marked
      ? "restricted_key_generation_outcome_uncertain_no_retry"
      : "restricted_key_generation_outcome_not_recorded_no_retry",
    true, input.attemptId, marked ? "uncertain" : "attempted");
  }

  const digest = responseDigest(response);
  if (ambiguousResponse(response)) {
    const marked = await markUncertain(
      db,
      input,
      response.status,
      digest,
      response.status === 201
        ? "generation_response_unreadable_or_invalid"
        : "upstream_response_may_be_ambiguous",
    );
    return result(false, marked
      ? "restricted_key_generation_outcome_uncertain_no_retry"
      : "restricted_key_generation_outcome_not_recorded_no_retry",
    true, input.attemptId, marked ? "uncertain" : "attempted");
  }

  if (response.status !== 201) {
    const stored = await markRejectedResponse(db, input, response, digest);
    return result(false, stored
      ? "restricted_key_generation_rejected_no_retry"
      : "restricted_key_generation_response_not_recorded_no_retry",
    true, input.attemptId, stored ? "response_received" : "attempted");
  }

  const generated = generatedCredential(response.body);
  if (!generated) {
    const marked = await markUncertain(
      db,
      input,
      response.status,
      digest,
      "generation_response_missing_valid_rsa_credential",
    );
    return result(false, "restricted_key_generation_response_mismatch_no_retry",
      true, input.attemptId, marked ? "uncertain" : "attempted");
  }

  let stored: {
    credentialId: string;
    fingerprint: string;
    active: boolean;
  } | null = null;
  try {
    stored = await storeGeneratedCredential(db, input, generated, digest);
  } catch {
    stored = null;
  }
  if (!stored) {
    const marked = await markUncertain(
      db,
      input,
      response.status,
      digest,
      "vault_storage_or_binding_failed",
    );
    return result(false, "restricted_key_storage_failed_reconciliation_required",
      true, input.attemptId, marked ? "uncertain" : "attempted");
  }
  if (!stored.active) {
    return result(false, "restricted_key_stored_rotation_reconciliation_required",
      true, input.attemptId, "uncertain");
  }

  let verification: { ok: boolean; reason: string };
  try {
    verification = await input.verifyGenerated(generated, stored.fingerprint);
  } catch {
    verification = { ok: false, reason: "generated_key_verification_failed" };
  }
  if (!verification.ok) {
    const marked = await markUncertain(
      db,
      input,
      response.status,
      digest,
      uncertaintyReason(verification.reason),
    );
    return result(false, marked
      ? "restricted_key_stored_verification_reconciliation_required"
      : "restricted_key_verification_state_not_recorded_no_retry",
    true, input.attemptId, marked ? "uncertain" : "response_received");
  }

  const completed = await completeVerifiedCredential(db, input, stored);
  if (!completed) {
    const marked = await markUncertain(
      db,
      input,
      response.status,
      digest,
      "credential_rotation_or_completion_failed",
    );
    return result(false, marked
      ? "restricted_key_completion_reconciliation_required"
      : "restricted_key_completion_state_not_recorded_no_retry",
    true, input.attemptId, marked ? "uncertain" : "response_received");
  }
  return result(true, "restricted_key_generated_stored_and_verified",
    true, input.attemptId, "completed", true);
}

/**
 * Completes only a previously Vault-stored response. It performs no Kalshi
 * mutation and cannot create or regenerate a key.
 */
export async function reconcileStoredRestrictedKeyGeneration(
  db: CredentialDatabase,
  input: {
    authenticatedUserId: string;
    financialAccountId: string;
    providerConnectionId: string;
    attemptId: string;
    confirmation: unknown;
    targetCredentialId: string;
    targetFingerprint: string;
    verificationCredentialId: string;
    verificationFingerprint: string;
  },
): Promise<RestrictedKeyGenerationExecutionResult> {
  if (input.confirmation !== RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION) {
    return result(false, "explicit_reconciliation_authorization_required",
      false, input.attemptId, null);
  }
  if (!UUID.test(input.attemptId) || !UUID.test(input.targetCredentialId)) {
    return result(false, "account_setup_attempt_invalid", false, null, null);
  }
  try {
    return await db.transaction(async (client) => {
      const locked = await client.query(LOCK_RECONCILABLE_RESPONSE_SQL, [
        input.attemptId,
        input.authenticatedUserId,
        input.financialAccountId,
        input.providerConnectionId,
        input.targetCredentialId,
        input.targetFingerprint,
        input.verificationCredentialId,
        input.verificationFingerprint,
      ]);
      if (locked.rows.length !== 1) {
        return result(false, "stored_restricted_key_reconciliation_not_available",
          false, input.attemptId, null);
      }
      const state = attemptState(locked.rows[0]?.state);
      if (state === "completed") {
        return result(true, "restricted_key_already_generated_and_verified",
          false, input.attemptId, "completed", true);
      }
      if (state !== "response_received" && state !== "uncertain") {
        return result(false, "stored_restricted_key_reconciliation_not_available",
          false, input.attemptId, state);
      }
      const master = await client.query(MASTER_SAFETY_SQL);
      if (master.rows.length !== 1 ||
          master.rows[0]?.live_execution_enabled !== false ||
          master.rows[0]?.manual_kill_switch !== true) {
        return result(false, "production_safety_controls_not_fail_closed",
          false, input.attemptId, state);
      }
      const verified = await client.query(MARK_RECONCILED_CREDENTIAL_VERIFIED_SQL, [
        input.targetCredentialId,
        input.authenticatedUserId,
        input.financialAccountId,
        input.providerConnectionId,
        input.targetFingerprint,
      ]);
      if (verified.rows.length !== 1) {
        return result(false, "stored_restricted_key_binding_changed",
          false, input.attemptId, state);
      }
      const completed = await client.query(MARK_RECONCILED_COMPLETED_SQL, [
        input.attemptId,
        input.authenticatedUserId,
        input.financialAccountId,
        input.providerConnectionId,
        input.targetCredentialId,
        input.targetFingerprint,
      ]);
      if (completed.rows.length !== 1) {
        throw new Error("restricted_key_reconciliation_not_recorded");
      }
      return result(true, "restricted_key_reconciled_and_verified",
        false, input.attemptId, "completed", true);
    });
  } catch {
    return result(false, "restricted_key_reconciliation_transaction_failed",
      false, input.attemptId, null);
  }
}

async function claimAttempt(
  db: CredentialDatabase,
  input: {
    authenticatedUserId: string;
    financialAccountId: string;
    providerConnectionId: string;
    attemptId: string;
    verificationCredentialId: string;
    verificationFingerprint: string;
    executionCredentialId: string;
    executionFingerprint: string;
  },
): Promise<{ ok: true } | { ok: false; reason: string; state: AttemptState | null }> {
  try {
    return await db.transaction(async (client) => {
      const connection = await client.query(LOCK_OWNED_CONNECTION_SQL, [
        input.authenticatedUserId,
        input.providerConnectionId,
        input.financialAccountId,
      ]);
      if (connection.rows.length !== 1) {
        return { ok: false as const, reason: "credential_not_owned", state: null };
      }
      const locked = await client.query(LOCK_ATTEMPT_SQL, [
        input.attemptId,
        input.authenticatedUserId,
        input.financialAccountId,
        input.providerConnectionId,
        input.executionCredentialId,
        input.executionFingerprint,
        input.verificationCredentialId,
        input.verificationFingerprint,
      ]);
      if (locked.rows.length !== 1) {
        return { ok: false as const, reason: "owned_prepared_key_generation_attempt_missing", state: null };
      }
      const state = attemptState(locked.rows[0]?.state);
      if (!state) {
        return { ok: false as const, reason: "account_setup_attempt_state_invalid", state: null };
      }
      if (!validGenerationPlan(locked.rows[0]?.plan)) {
        return { ok: false as const, reason: "restricted_key_generation_plan_invalid", state };
      }
      if (state !== "prepared") {
        return { ok: false as const, reason: retryBlockedReason(state), state };
      }
      if (text(locked.rows[0]?.target_fingerprint) !==
          text(locked.rows[0]?.prior_fingerprint)) {
        return {
          ok: false as const,
          reason: "restricted_execution_credential_rotated_since_preparation",
          state,
        };
      }
      const executionAccount = await client.query(EXISTING_EXECUTION_ACCOUNT_SQL, [
        input.authenticatedUserId,
        input.financialAccountId,
      ]);
      if (executionAccount.rows.length > 0) {
        return {
          ok: false as const,
          reason: "execution_account_exists_before_restricted_key_generation",
          state,
        };
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
      ]);
      return marked.rows.length === 1
        ? { ok: true as const }
        : { ok: false as const, reason: "restricted_key_generation_attempt_not_claimed", state };
    });
  } catch {
    return { ok: false, reason: "restricted_key_generation_attempt_not_claimed", state: null };
  }
}

async function storeGeneratedCredential(
  db: CredentialDatabase,
  input: {
    authenticatedUserId: string;
    financialAccountId: string;
    providerConnectionId: string;
    attemptId: string;
  },
  generated: { keyId: string; privateKey: string },
  digest: string,
): Promise<{
  credentialId: string;
  fingerprint: string;
  active: boolean;
} | null> {
  const fingerprint = dedicatedSignerFingerprint(generated.keyId, generated.privateKey);
  if (!fingerprint) return null;
  const payload = JSON.stringify({
    api_key_id: generated.keyId.trim(),
    private_key: generated.privateKey.trim(),
  });
  const name = `kalshi:${input.authenticatedUserId}:restricted_execution:${randomUUID()}`;
  return db.transaction(async (client) => {
    const connection = await client.query(LOCK_OWNED_CONNECTION_SQL, [
      input.authenticatedUserId,
      input.providerConnectionId,
      input.financialAccountId,
    ]);
    if (connection.rows.length !== 1) throw new Error("credential_not_owned");
    const attempt = await client.query(LOCK_ATTEMPTED_SQL, [
      input.attemptId,
      input.authenticatedUserId,
      input.financialAccountId,
      input.providerConnectionId,
    ]);
    if (attempt.rows.length !== 1) throw new Error("key_generation_attempt_not_attempted");
    const active = await client.query(LOCK_ACTIVE_RESTRICTED_SQL, [
      input.authenticatedUserId,
      input.financialAccountId,
      input.providerConnectionId,
    ]);
    if (active.rows.length > 1) throw new Error("ambiguous_credential_role");
    const expectedFingerprint = text(attempt.rows[0]?.target_fingerprint);
    const activeFingerprint = text(active.rows[0]?.key_fingerprint);
    const created = await client.query(CREATE_VAULT_SECRET_SQL, [
      payload,
      name,
      "kalshi-generated-restricted-execution-credential",
    ]);
    const vaultSecretId = text(created.rows[0]?.id);
    if (!vaultSecretId || !UUID.test(vaultSecretId)) {
      throw new Error("vault_secret_not_created");
    }
    if (expectedFingerprint !== activeFingerprint) {
      const inserted = await client.query(INSERT_RECONCILIATION_BINDING_SQL, [
        input.authenticatedUserId,
        input.financialAccountId,
        input.providerConnectionId,
        vaultSecretId,
        fingerprint,
      ]);
      const credentialId = text(inserted.rows[0]?.credential_id);
      if (!credentialId) throw new Error("reconciliation_credential_not_bound");
      const recorded = await client.query(MARK_ROTATED_RESPONSE_STORED_SQL, [
        input.attemptId,
        input.authenticatedUserId,
        input.financialAccountId,
        input.providerConnectionId,
        digest,
        credentialId,
        fingerprint,
      ]);
      if (recorded.rows.length !== 1) {
        throw new Error("key_generation_reconciliation_not_recorded");
      }
      return { credentialId, fingerprint, active: false };
    }
    const replaced = await replaceOwnedCredentialInTransaction(client, {
      authenticatedUserId: input.authenticatedUserId,
      providerConnectionId: input.providerConnectionId,
      role: "restricted_execution",
      vaultSecretId,
      keyFingerprint: fingerprint,
    });
    if (!replaced.ok) throw new Error("credential_binding_rejected");
    const recorded = await client.query(MARK_RESPONSE_STORED_SQL, [
      input.attemptId,
      input.authenticatedUserId,
      input.financialAccountId,
      input.providerConnectionId,
      digest,
      replaced.credentialId,
      fingerprint,
    ]);
    if (recorded.rows.length !== 1) throw new Error("key_generation_response_not_recorded");
    return { credentialId: replaced.credentialId, fingerprint, active: true };
  });
}

async function completeVerifiedCredential(
  db: CredentialDatabase,
  input: {
    authenticatedUserId: string;
    financialAccountId: string;
    providerConnectionId: string;
    attemptId: string;
    verificationCredentialId: string;
    verificationFingerprint: string;
    provisioningCredentialId: string;
    executionCredentialId: string;
    executionFingerprint: string;
  },
  stored: { credentialId: string; fingerprint: string },
): Promise<boolean> {
  try {
    return await db.transaction(async (client) => {
      const locked = await client.query(LOCK_RESPONSE_AND_AUTHORITIES_SQL, [
        input.attemptId,
        input.authenticatedUserId,
        input.financialAccountId,
        input.providerConnectionId,
        input.verificationCredentialId,
        input.verificationFingerprint,
        input.executionCredentialId,
        input.executionFingerprint,
      ]);
      if (locked.rows.length !== 1 ||
          text(locked.rows[0]?.target_credential_id) !== stored.credentialId ||
          text(locked.rows[0]?.verification_credential_id) !== input.verificationCredentialId ||
          text(locked.rows[0]?.preparation_credential_id) !== input.provisioningCredentialId ||
          text(locked.rows[0]?.execution_credential_id) !== input.executionCredentialId) {
        return false;
      }
      const verified = await client.query(MARK_CREDENTIAL_VERIFIED_SQL, [
        stored.credentialId,
        input.authenticatedUserId,
        input.providerConnectionId,
        stored.fingerprint,
      ]);
      if (verified.rows.length !== 1) return false;
      const completed = await client.query(MARK_COMPLETED_SQL, [
        input.attemptId,
        input.authenticatedUserId,
        input.providerConnectionId,
        stored.credentialId,
        stored.fingerprint,
      ]);
      if (completed.rows.length !== 1) {
        throw new Error("restricted_key_generation_completion_not_recorded");
      }
      return true;
    });
  } catch {
    return false;
  }
}

async function markRejectedResponse(
  db: CredentialDatabase,
  input: { authenticatedUserId: string; providerConnectionId: string; attemptId: string },
  response: RestrictedKeyGenerationExchangeResult,
  digest: string,
): Promise<boolean> {
  const marked = await db.query(MARK_REJECTED_RESPONSE_SQL, [
    input.attemptId,
    input.authenticatedUserId,
    input.providerConnectionId,
    response.status,
    digest,
    safeResponseReference(response),
  ]);
  return marked.rows.length === 1;
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

function generatedCredential(body: unknown): { keyId: string; privateKey: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keyId = typeof record.api_key_id === "string" ? record.api_key_id.trim() : "";
  const privateKey = typeof record.private_key === "string" ? record.private_key.trim() : "";
  if (!keyId || keyId.length > 256 || /[\u0000-\u001f\u007f]/.test(keyId) ||
      !privateKey || privateKey.length > 20_000) return null;
  return dedicatedSignerFingerprint(keyId, privateKey) ? { keyId, privateKey } : null;
}

function ambiguousResponse(response: RestrictedKeyGenerationExchangeResult): boolean {
  return response.unreadable ||
    response.status === 408 ||
    response.status === 409 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500;
}

function responseDigest(response: RestrictedKeyGenerationExchangeResult): string {
  const record = response.body && typeof response.body === "object" && !Array.isArray(response.body)
    ? response.body as Record<string, unknown>
    : {};
  return createHash("sha256").update(JSON.stringify({
    status: response.status,
    unreadable: response.unreadable,
    apiKeyIdPresent: typeof record.api_key_id === "string" && record.api_key_id.length > 0,
    privateKeyPresent: typeof record.private_key === "string" && record.private_key.length > 0,
    warningPresent: typeof record.warning === "string" && record.warning.length > 0,
  })).digest("hex");
}

function safeResponseReference(response: RestrictedKeyGenerationExchangeResult): string {
  let code = "no_code";
  if (response.body && typeof response.body === "object" && !Array.isArray(response.body)) {
    const value = (response.body as Record<string, unknown>).code;
    if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value)) code = value;
  }
  return `http_${response.status}_${code}`.slice(0, 200);
}

function validGenerationPlan(value: unknown): boolean {
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
  if (plan.operation !== "generate_api_key" ||
      plan.exchangePath !== "/trade-api/v2/api_keys/generate" ||
      plan.method !== "POST" ||
      plan.vaultDestination !== "supabase_vault" ||
      !plan.request || typeof plan.request !== "object" || Array.isArray(plan.request)) return false;
  const request = plan.request as Record<string, unknown>;
  return Object.keys(request).length === 4 &&
    request.name === "STRATA_V13_SUBACCOUNT_1" &&
    request.key_type === "rsa" &&
    Array.isArray(request.scopes) &&
    request.scopes.length === 2 &&
    request.scopes[0] === "read" &&
    request.scopes[1] === "write::trade" &&
    request.subaccount === 1;
}

function uncertaintyReason(reason: string): string {
  return /^[a-z0-9_]{1,150}$/.test(reason)
    ? `generated_key_${reason}`.slice(0, 200)
    : "generated_key_verification_failed";
}

function retryBlockedReason(state: AttemptState): string {
  if (state === "completed") return "restricted_key_generation_already_completed";
  if (state === "cancelled") return "restricted_key_generation_attempt_cancelled";
  return `restricted_key_generation_retry_blocked_${state}`;
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
  restrictedKeyVerified = false,
): RestrictedKeyGenerationExecutionResult {
  return {
    ok,
    reason,
    attempted,
    executable: false,
    attemptId,
    state,
    restrictedKeyVerified,
    reconciliationRequired: state === "attempted" ||
      state === "response_received" ||
      state === "uncertain",
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

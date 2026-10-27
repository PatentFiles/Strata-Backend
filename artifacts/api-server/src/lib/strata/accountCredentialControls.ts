import { emptyUserExecutionView } from "./userExecutionScope";
import { prepareOwnerShardAllocation, ownerShardAllocationStatus,
  executeOwnerShardAllocation, reconcileOwnerShardAllocation,
  type ShardAllocationView } from "./ownerShardAllocation";
import {
  prepareOwnedPilotTransfer, executeOwnedPilotTransfer, ownedPilotTransferStatus, reconcileOwnedPilotTransfer,
  historicalFundingStatus, verifyOwnedHistoricalFunding, type HistoricalFundingResult,
  type PilotResult,
} from "./ownedPilotTransfer";
import type { UserScopeQuery } from "./userScopeDatabase";
import {
  resolveAccountCommissioningContext,
  type StoredCredentialRef,
} from "./accountCommissioningContext";
import {
  createDatabaseAccountCommissioningPorts,
  credentialDatabaseFromPool,
  type CredentialDatabase,
  type PgPoolLike,
} from "./accountCredentialStore";
import {
  listAccountCredentialStatus,
  registerAccountCredential,
  revokeAccountCredential,
  userCommissioningReadiness,
  verifyAccountCredential,
  type AccountCredentialStatus,
} from "./accountCredentialLifecycle";
import { dedicatedSignerFingerprint } from "./commissioning";
import {
  prepareFrozenKeyRecovery,
  executeFrozenKeyRecovery,
  type RecoveryIdentity,
} from "./ownerRestrictedKeyRecovery";
import {
  inspectAccountSetupExecutionCredential,
  inspectProvisioningCredential,
  inspectRestrictedKeyMetadata,
  inspectSubaccount1,
  probeAccountCredential,
  restrictedMetadataNextRequirement,
  type AccountSetupNextRequirement,
  type CredentialProbeResult,
  type VerifiedCredentialAuthority,
} from "./accountCredentialProbe";
import {
  authorizeFutureAccountOperation,
  futureAccountOperationConfirmation,
  persistAccountFundingAuthorization,
  persistAccountFundingEvidence,
  readAccountFunding,
  RECORD_FUNDING_EVIDENCE_CONFIRMATION,
  type FutureAccountOperation,
} from "./accountFunding";
import { operateAccountWorker, SAFETY_EXPOSURE_SQL, SCOPED_POLICY_SQL } from "./accountScopedExecution";
import { predictionsApiTier } from "../kalshiSubaccountInventory";
import {
  ACCOUNT_SETUP_CONFIRMATIONS,
  accountSetupPlan,
  accountSetupPreconditionDigest,
  listOwnedAccountSetupAttempts,
  prepareAccountSetupOperation,
  type AccountSetupNextAuthorizedAction,
  type AccountSetupOperation,
  type PublicAccountSetupAttempt,
} from "./accountSetupPreparation";
import {
  EXECUTE_SUBACCOUNT_CREATION_CONFIRMATION,
  executePreparedSubaccountCreation,
  type SubaccountCreationTransport,
} from "./accountSubaccountCreation";
import {
  EXECUTE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
  RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
  executePreparedRestrictedKeyGeneration,
  reconcileStoredRestrictedKeyGeneration,
  type RestrictedKeyGenerationTransport,
} from "./accountRestrictedKeyGeneration";
import {
  EXECUTE_EXECUTION_ACCOUNT_PROVISIONING_CONFIRMATION,
  executePreparedExecutionAccountProvisioning,
} from "./accountExecutionProvisioning";

const CREDENTIAL_TABLE_SQL = `
  SELECT to_regclass('private.kalshi_connection_credentials') AS name
`;
const LEASE_TABLE_SQL = `
  SELECT to_regclass('private.kalshi_account_worker_lease') AS name
`;
const FUNDING_TABLE_SQL = `
  SELECT to_regclass('private.kalshi_account_funding') AS name
`;

// Read-only and owner-scoped: a DRAFT is not linked to the execution account until
// approval. The Wallets checklist must never infer a saved draft from APPROVED alone.
const OWNED_POLICY_DRAFT_SQL = `
  SELECT id::text AS policy_id, version, capital_limit_cents,
    max_entry_stake_cents, max_entry_all_in_cents, max_daily_loss_cents,
    max_total_loss_cents, max_quote_age_ms, max_fee_evidence_age_ms
  FROM public.v13_live_money_policy
  WHERE execution_account_id = $1
    AND created_by = $2::text
    AND state = 'DRAFT'
  ORDER BY version DESC LIMIT 1
`;

// Only these public risk limits may leave the trusted backend. No policy approval,
// strategy parameters, credentials, or authority can be changed by reading them.
type OwnedDraftView = {
  policyId: string;
  version: number;
  capitalLimitCents: number;
  maxEntryStakeCents: number;
  maxEntryAllInCents: number;
  maxDailyLossCents: number;
  maxTotalLossCents: number;
  maxQuoteAgeMs: number;
  maxFeeEvidenceAgeMs: number;
};
function safeOwnedDraft(row: Record<string, unknown>): OwnedDraftView | null {
  const policyId = row.policy_id;
  if (typeof policyId !== 'string' || !/^[0-9a-f-]{36}$/i.test(policyId)) return null;
  const fields = [
    'version', 'capital_limit_cents', 'max_entry_stake_cents',
    'max_entry_all_in_cents', 'max_daily_loss_cents', 'max_total_loss_cents',
    'max_quote_age_ms', 'max_fee_evidence_age_ms',
  ] as const;
  const nums = fields.map((field) => Number(row[field]));
  if (!nums.every((n) => Number.isSafeInteger(n) && n > 0)) return null;
  return {
    policyId, version: nums[0]!,
    capitalLimitCents: nums[1]!, maxEntryStakeCents: nums[2]!,
    maxEntryAllInCents: nums[3]!, maxDailyLossCents: nums[4]!,
    maxTotalLossCents: nums[5]!, maxQuoteAgeMs: nums[6]!,
    maxFeeEvidenceAgeMs: nums[7]!,
  };
}
const SETUP_ATTEMPT_TABLE_SQL = `
  SELECT to_regclass('private.kalshi_account_operation_attempts') AS name
`;
const OWNED_SETUP_ATTEMPT_SQL = `
  -- account-setup-execution:owned-attempt
  SELECT id::text AS attempt_id,
         financial_account_id::text AS financial_account_id,
         provider_connection_id::text AS provider_connection_id,
         state
  FROM private.kalshi_account_operation_attempts
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND operation = $3
`;
const UNRESOLVED_GENERATION_SQL = `
  -- account-setup-execution:unresolved-generation
  SELECT id::text AS attempt_id, state
  FROM private.kalshi_account_operation_attempts
  WHERE owner_user_id = $1::uuid
    AND provider_connection_id = $2::uuid
    AND operation = 'generate_api_key'
    AND state IN ('attempted', 'response_received', 'uncertain')
  LIMIT 1
`;
const GENERATED_ATTEMPT_SECRET_SQL = `
  -- account-setup-execution:generated-attempt-secret
  SELECT a.state,
         a.response_status,
         c.id::text AS credential_id,
         c.vault_secret_id::text AS vault_secret_id,
         c.key_fingerprint,
         c.revoked_at
  FROM private.kalshi_account_operation_attempts a
  JOIN private.kalshi_connection_credentials c
    ON c.id = a.target_credential_id
   AND c.owner_user_id = a.owner_user_id
   AND c.financial_account_id = a.financial_account_id
   AND c.provider_connection_id = a.provider_connection_id
   AND c.role = 'restricted_execution'
   AND c.key_fingerprint = a.target_fingerprint
   AND (
     c.revoked_at IS NULL
     OR c.verification_reason = 'generated_reconciliation_required'
   )
  WHERE a.id = $1::uuid
    AND a.owner_user_id = $2::uuid
    AND a.financial_account_id = $3::uuid
    AND a.provider_connection_id = $4::uuid
    AND a.operation = 'generate_api_key'
    AND a.state IN ('response_received', 'uncertain', 'completed')
    AND a.response_status = 201
    AND a.response_received_at IS NOT NULL
`;
const COMPLETED_GENERATION_SQL = `
  -- account-setup-execution:completed-generation
  SELECT a.id::text AS attempt_id
  FROM private.kalshi_account_operation_attempts a
  WHERE a.id = $1::uuid
    AND a.owner_user_id = $2::uuid
    AND a.financial_account_id = $3::uuid
    AND a.provider_connection_id = $4::uuid
    AND a.operation = 'generate_api_key'
    AND a.state = 'completed'
    AND a.response_status = 201
    AND a.response_received_at IS NOT NULL
    AND a.target_credential_id IS NOT NULL
    AND a.target_fingerprint IS NOT NULL
`;
const COMPLETED_PROVISION_CREDENTIAL_SQL = `
  -- account-setup-execution:completed-provision-credential
  SELECT c.id::text AS credential_id,
         c.key_fingerprint
  FROM private.kalshi_account_operation_attempts a
  JOIN private.kalshi_connection_credentials c
    ON c.id = a.target_credential_id
   AND c.owner_user_id = a.owner_user_id
   AND c.financial_account_id = a.financial_account_id
   AND c.provider_connection_id = a.provider_connection_id
   AND c.role = 'restricted_execution'
   AND c.revoked_at IS NULL
   AND c.verified_at IS NOT NULL
   AND c.verification_reason = 'credential_verified'
   AND c.key_fingerprint = a.target_fingerprint
  WHERE a.id = $1::uuid
    AND a.owner_user_id = $2::uuid
    AND a.financial_account_id = $3::uuid
    AND a.provider_connection_id = $4::uuid
    AND a.operation = 'provision_execution_account'
    AND a.state = 'completed'
`;
const SETUP_EXECUTION_ROLE_SQL = `
  -- account-setup-execution-role:ready
  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'private.kalshi_connection_credentials'::regclass
      AND conname = 'kalshi_connection_credentials_role_check'
      AND pg_get_constraintdef(oid) LIKE '%account_setup_execution%'
  ) AS ready
`;
const ACCOUNT_LIMITS_PATH = "/trade-api/v2/account/limits";
const HELD_GENERATION_SECRET_SQL = `
  -- account-setup-execution:held-generation-secret
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE id = $1::uuid
    AND EXISTS (
      SELECT 1
      FROM private.kalshi_connection_credentials c
      JOIN private.kalshi_account_operation_attempts a
        ON a.target_credential_id = c.id
       AND a.owner_user_id = c.owner_user_id
       AND a.financial_account_id = c.financial_account_id
       AND a.provider_connection_id = c.provider_connection_id
       AND a.id = $3::uuid
       AND a.operation = 'generate_api_key'
       AND a.response_status = 201
       AND a.target_fingerprint = c.key_fingerprint
      WHERE c.vault_secret_id = vault.decrypted_secrets.id
        AND c.owner_user_id = $2::uuid
        AND c.role = 'restricted_execution'
        AND (
          c.revoked_at IS NULL
          OR c.verification_reason = 'generated_reconciliation_required'
        )
    )
`;
const OWNED_SECRET_SQL = `
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE id = $1::uuid
    AND EXISTS (
      SELECT 1 FROM private.kalshi_connection_credentials c
      WHERE c.vault_secret_id = vault.decrypted_secrets.id
        AND c.owner_user_id = $2::uuid
        AND c.revoked_at IS NULL
    )
`;
const VERIFIED_ROLE_SECRET_SQL = `
  -- account-credential:verified-role-secret
  SELECT c.id::text AS credential_id,
         c.vault_secret_id::text AS vault_secret_id,
         c.key_fingerprint,
         s.decrypted_secret
  FROM private.kalshi_connection_credentials c
  JOIN private.provider_connections pc
    ON pc.id = c.provider_connection_id
   AND pc.financial_account_id = c.financial_account_id
  JOIN public.financial_accounts fa
    ON fa.id = c.financial_account_id
   AND fa.user_id = c.owner_user_id
  JOIN vault.decrypted_secrets s ON s.id = c.vault_secret_id
  WHERE c.owner_user_id = $1::uuid
    AND c.provider_connection_id = $2::uuid
    AND c.role = $3
    AND c.revoked_at IS NULL
    AND c.verified_at IS NOT NULL
    AND c.verification_reason = 'credential_verified'
`;

export function accountCredentialControls(
  db: UserScopeQuery,
  options: {
    kalshiGet?: (creds: { keyId: string; privateKey: string }, path: string, query?: string) => Promise<unknown>;
    kalshiCreateSubaccount?: SubaccountCreationTransport;
    kalshiGenerateRestrictedKey?: RestrictedKeyGenerationTransport;
    session?: { stopOwner(userId: string, action?: "STOP" | "KILL"): Promise<{ workerStopped: boolean }> };
  } = {},
) {
  const database = executionDatabase(db);
  const ports = () => createDatabaseAccountCommissioningPorts(database);
  return {
    async safetyControl(userId: string, action: "STOP" | "DISARM" | "KILL") {
      if (options.session) {
        const stopped = await options.session.stopOwner(userId, action === "KILL" ? "KILL" : "STOP");
        if (!stopped.workerStopped) {
          return {
            ok: false as const,
            reason: "worker_still_scheduled",
            executable: false as const,
            workerStarted: false as const,
            executionActive: false as const,
            view: emptyUserExecutionView(userId),
          };
        }
      }
      const closed = {
        ok: false as const,
        reason: "user_scope_not_migrated",
        executable: false as const,
        workerStarted: false as const,
        executionActive: false as const,
        view: emptyUserExecutionView(userId),
      };
      try {
        const ready = await db.query(LEASE_TABLE_SQL);
        if (!ready.rows[0]?.name) {
          if (action !== "KILL") {
            if (options.session) {
              return {
                ok: true as const,
                reason: "entries_stopped",
                executable: false as const,
                workerStarted: false as const,
                executionActive: false as const,
                view: emptyUserExecutionView(userId),
              };
            }
            return closed;
          }
          await db.query(
            "UPDATE v13_production_account SET kill_switch = true WHERE owner_user_id = $1::uuid",
            [userId],
          );
          return {
            ok: true as const,
            reason: "account_killed",
            executable: false as const,
            workerStarted: false as const,
            executionActive: false as const,
            view: emptyUserExecutionView(userId),
          };
        }
        const result = await operateAccountWorker({
          commissioning: ports(),
          activity: { async readOwnedAccount() { return null; } },
          leases: database,
          safety: {
            async listAccounts(ownerUserId) {
              const accounts = await db.query(SAFETY_EXPOSURE_SQL, [ownerUserId]);
              return accounts.rows.flatMap((row) => {
                const executionAccountId = text(row.execution_account_id);
                const financialAccountId = text(row.financial_account_id);
                if (!executionAccountId || !financialAccountId) return [];
                return [{
                  executionAccountId,
                  ownerUserId,
                  financialAccountId,
                  providerConnectionId: financialAccountId,
                  keyFingerprint: null,
                  vaultSecretId: null,
                  openPositionCount: count(row.open_positions),
                  unresolvedIntentCount: count(row.unresolved_intents),
                }];
              });
            },
            async markKilled(ownerUserId, executionAccountId) {
              await db.query(
                `UPDATE v13_production_account SET kill_switch = true
                 WHERE id = $1 AND owner_user_id = $2::uuid`,
                [executionAccountId, ownerUserId],
              );
            },
          },
          async globalKill() {
            const kill = await db.query("SELECT manual_kill_switch FROM live_execution_config");
            return kill.rows.length !== 1 || kill.rows[0]?.manual_kill_switch === true;
          },
          now: () => Date.now(),
        }, { authenticatedUserId: userId, holderId: "account-safety", action });
        return { ...result, view: emptyUserExecutionView(userId) };
      } catch {
        return closed;
      }
    },
    async credentialStatus(userId: string) {
      if (!await credentialTablesReady(db)) {
        return { ok: false, reason: "credential_migration_missing", executable: false as const, roles: [] };
      }
      return listAccountCredentialStatus(database, ports(), userId);
    },
    async registerCredential(userId: string, body: unknown) {
      if (!await credentialTablesReady(db)) return { ok: false, reason: "credential_migration_missing", executable: false as const };
      const fields = credentialBody(body);
      if (!fields) return { ok: false, reason: "credential_invalid", executable: false as const };
      return registerAccountCredential(database, ports(), { authenticatedUserId: userId, ...fields });
    },
    async revokeCredential(userId: string, body: unknown) {
      if (!await credentialTablesReady(db)) return { ok: false, reason: "credential_migration_missing", executable: false as const };
      const role = roleOf(body);
      if (!role) return { ok: false, reason: "credential_role_rejected", executable: false as const };
      return revokeAccountCredential(database, ports(), { authenticatedUserId: userId, role });
    },
    async verifyCredential(userId: string, body: unknown) {
      if (!await credentialTablesReady(db)) return { ok: false, reason: "credential_migration_missing", executable: false as const };
      const role = roleOf(body);
      if (!role) return { ok: false, reason: "credential_role_rejected", executable: false as const };
      const getJson = options.kalshiGet ?? (async () => {
        throw new Error("verification_transport_not_enabled");
      });
      return verifyAccountCredential(database, ports(), {
        authenticatedUserId: userId,
        role,
        confirmation: body && typeof body === "object" ? (body as Record<string, unknown>).confirmation : null,
        readSecret: (vaultSecretId) => readOwnedSecret(db, userId, vaultSecretId),
        async probe(material, context) {
          const fingerprint = dedicatedSignerFingerprint(material.keyId, material.privateKey);
          if (!fingerprint) return { ok: false, reason: "credential_fingerprint_mismatch" };
          let verifiedBinding: Extract<VerifiedAuthorityResult, { ok: true }> | undefined;
          let provisioningBinding: Extract<VerifiedAuthorityResult, { ok: true }> | undefined;
          if (role === "restricted_execution" || role === "account_setup_execution") {
            let verified: VerifiedAuthorityResult;
            try {
              verified = await readVerifiedRoleAuthority(
                db,
                userId,
                context.providerConnectionId,
                "verification",
              );
            } catch {
              return { ok: false, reason: "verified_verification_credential_required" };
            }
            if (!verified.ok) return { ok: false, reason: verified.reason };
            verifiedBinding = verified;
          }
          let probed: CredentialProbeResult;
          if (role === "account_setup_execution") {
            let provisioning: VerifiedAuthorityResult;
            try {
              provisioning = await readVerifiedRoleAuthority(
                db,
                userId,
                context.providerConnectionId,
                "provisioning",
              );
            } catch {
              return { ok: false, reason: "verified_provisioning_credential_required" };
            }
            if (!provisioning.ok) return { ok: false, reason: provisioning.reason };
            provisioningBinding = provisioning;
            if (!verifiedBinding ||
                !credentialIsIndependent(fingerprint, material.keyId, verifiedBinding.authority) ||
                !credentialIsIndependent(fingerprint, material.keyId, provisioning.authority)) {
              return { ok: false, reason: "account_setup_execution_credential_not_independent" };
            }
            const metadata = await inspectAccountSetupExecutionCredential(
              material.keyId,
              verifiedBinding.authority,
              getJson,
            );
            if (!metadata.ok) return credentialProbeResult(false, metadata.reason);
            let limits: unknown;
            try {
              limits = await getJson(material, ACCOUNT_LIMITS_PATH, "");
            } catch {
              return credentialProbeResult(false, "account_setup_execution_read_check_failed");
            }
            const tier = predictionsApiTier(limits);
            probed = tier.apiTier && tier.subaccountCreationTierEligible
              ? credentialProbeResult(true, "credential_verified")
              : credentialProbeResult(false,
                tier.apiTier ? "advanced_api_tier_required" : "provisioning_api_tier_unproven");
          } else {
            probed = await probeAccountCredential(
              role,
              fingerprint,
              material,
              getJson,
              verifiedBinding?.authority,
            );
          }
          if (probed.ok && verifiedBinding) {
            let current: VerifiedAuthorityResult;
            try {
              current = await readVerifiedRoleAuthority(
                db,
                userId,
                context.providerConnectionId,
                "verification",
              );
            } catch {
              return { ...probed, ok: false, reason: "verification_credential_rotated" };
            }
            if (!current.ok ||
                current.credentialId !== verifiedBinding.credentialId ||
                current.vaultSecretId !== verifiedBinding.vaultSecretId ||
                current.authority.expectedFingerprint !== verifiedBinding.authority.expectedFingerprint) {
              return { ...probed, ok: false, reason: "verification_credential_rotated" };
            }
          }
          if (probed.ok && provisioningBinding) {
            let current: VerifiedAuthorityResult;
            try {
              current = await readVerifiedRoleAuthority(
                db,
                userId,
                context.providerConnectionId,
                "provisioning",
              );
            } catch {
              return { ...probed, ok: false, reason: "provisioning_credential_rotated" };
            }
            if (!sameAuthority(provisioningBinding, current)) {
              return { ...probed, ok: false, reason: "provisioning_credential_rotated" };
            }
          }
          return probed;
        },
      });
    },

    /**
     * Generates a replacement Subaccount 1 RSA key using the already-verified,
     * encrypted account setup signer. No private material in the HTTP body.
     * Only the owner can call this route; neither phase ever starts trading.
     */
    async prepareRestrictedKeyRecovery(userId:string) {
      const proof=await recoveryKeyContext(db,database,options.kalshiGet,userId);
      if(!proof.ok)return {ok:false,reason:proof.reason,executable:false as const,exchangePostAttempted:false as const};
      return prepareFrozenKeyRecovery(database,proof.identity);
    },
    async executeRestrictedKeyRecovery(userId:string,body:unknown) {
      const b=body&&typeof body==="object"&&!Array.isArray(body)?body as Record<string,unknown>:{};
      if(typeof b.attemptId!=="string"||typeof b.confirmation!=="string")
        return {ok:false,reason:"recovery_confirmation_missing",executable:false as const,exchangePostAttempted:false as const};
      if(!options.kalshiGenerateRestrictedKey)
        return {ok:false,reason:"recovery_generation_transport_unavailable",executable:false as const,exchangePostAttempted:false as const};
      const proof=await recoveryKeyContext(db,database,options.kalshiGet,userId);
      if(!proof.ok)return {ok:false,reason:proof.reason,executable:false as const,exchangePostAttempted:false as const};
      const get=options.kalshiGet!;
      return executeFrozenKeyRecovery(database,{
        identity:proof.identity,attemptId:b.attemptId,confirmation:b.confirmation,
        transport:options.kalshiGenerateRestrictedKey,
        setupMaterial:proof.setup.authority.material,
        async verify(material,fingerprint){
          const current=await readVerifiedRoleAuthority(db,userId,proof.identity.connection,"verification");
          if(!sameAuthority(proof.verification,current))return {ok:false,reason:"verification_credential_rotated"};
          const currentSetup=await readVerifiedRoleAuthority(db,userId,proof.identity.connection,"account_setup_execution");
          if(!sameAuthority(proof.setup,currentSetup))return {ok:false,reason:"account_setup_execution_credential_rotated"};
          const evidence=await probeAccountCredential("restricted_execution",fingerprint,material,get,proof.verification.authority);
          return {ok:evidence.ok,reason:evidence.reason};
        }
      });
    },
    async ownerShardAllocationStatus(userId: string): Promise<ShardAllocationView> {
      return ownerShardAllocationStatus(db, userId);
    },
    async prepareOwnerShardAllocation(userId: string): Promise<ShardAllocationView> {
      return prepareOwnerShardAllocation(db, userId, { read: options.kalshiGet });
    },
    async executeOwnerShardAllocation(userId: string, body: unknown): Promise<ShardAllocationView> {
      const input = body && typeof body==="object" && !Array.isArray(body)
        ? body as Record<string,unknown> : {};
      return executeOwnerShardAllocation(db, userId, {
        attemptId: input.attemptId, confirmation: input.confirmation,
      }, { read: options.kalshiGet });
    },
    async reconcileOwnerShardAllocation(userId: string): Promise<ShardAllocationView> {
      return reconcileOwnerShardAllocation(db, userId, { read: options.kalshiGet });
    },
    async ownerPilotTransferStatus(userId: string): Promise<PilotResult> {
      return ownedPilotTransferStatus(db, userId);
    },
    async reconcileOwnerPilotTransfer(userId: string): Promise<PilotResult> {
      return reconcileOwnedPilotTransfer(db, userId, { get: options.kalshiGet });
    },
    async historicalFundingStatus(userId: string): Promise<HistoricalFundingResult> {
      return historicalFundingStatus(db, userId);
    },
    async verifyHistoricalFunding(userId: string): Promise<HistoricalFundingResult> {
      return verifyOwnedHistoricalFunding(db, userId, { get: options.kalshiGet });
    },
    async prepareOwnerPilotTransfer(userId: string): Promise<PilotResult> {
      return prepareOwnedPilotTransfer(db, userId, { get: options.kalshiGet });
    },
    async executeOwnerPilotTransfer(userId: string, body: unknown): Promise<PilotResult> {
      const input = body && typeof body === "object" && !Array.isArray(body)
        ? body as Record<string,unknown> : {};
      return executeOwnedPilotTransfer(db, userId, {
        attemptId: input.attemptId, confirmation: input.confirmation,
      }, { get: options.kalshiGet });
    },
    async authorizeFunding(userId: string, body: unknown) {
      if (!await fundingTableReady(db)) {
        return { ok: false, reason: "funding_migration_missing", executable: false as const, transferAttempted: false as const, authorizedMicros: null, evidenceMicros: null };
      }
      const fields = fundingBody(body);
      if (!fields) {
        return { ok: false, reason: "funding_amount_invalid", executable: false as const, transferAttempted: false as const, authorizedMicros: null, evidenceMicros: null };
      }
      return persistAccountFundingAuthorization(database, ports(), {
        authenticatedUserId: userId,
        confirmation: fields.confirmation,
        authorizedMicros: fields.authorizedMicros,
      });
    },
    async recordFundingEvidence(userId: string, body: unknown) {
      if (!await fundingTableReady(db)) {
        return { ok: false, reason: "funding_migration_missing", executable: false as const, transferAttempted: false as const, authorizedMicros: null, evidenceMicros: null };
      }
      const confirmation = body && typeof body === "object" ? (body as Record<string, unknown>).confirmation : null;
      if (confirmation !== RECORD_FUNDING_EVIDENCE_CONFIRMATION) {
        return { ok: false, reason: "explicit_authorization_required", executable: false as const, transferAttempted: false as const, authorizedMicros: null, evidenceMicros: null };
      }
      const getJson = options.kalshiGet ?? (async () => {
        throw new Error("verification_transport_not_enabled");
      });
      const observed = await observeBalance(db, ports(), getJson, userId);
      if (!observed.ok || !observed.evidenceMicros) {
        return { ok: false, reason: observed.reason, executable: false as const, transferAttempted: false as const, authorizedMicros: null, evidenceMicros: null };
      }
      return persistAccountFundingEvidence(database, ports(), {
        authenticatedUserId: userId,
        confirmation,
        evidenceMicros: observed.evidenceMicros,
        evidenceSource: "kalshi_balance",
      });
    },
    async authorizeOperation(userId: string, body: unknown) {
      const operation = operationOf(body);
      if (!operation) {
        return {
          ok: false as const,
          reason: "explicit_authorization_required",
          attempted: false as const,
          executable: false as const,
        };
      }
      const authorization = authorizeFutureAccountOperation({
        operation,
        confirmation: body && typeof body === "object" ? (body as Record<string, unknown>).confirmation : null,
      });
      if (authorization.reason === "explicit_authorization_required" || !isAccountSetupOperation(operation)) {
        return { ...authorization, executable: false as const };
      }
      return prepareSetupReview(db, database, options.kalshiGet, userId, operation);
    },
    async executeOperation(userId: string, body: unknown) {
      const fields = accountSetupExecutionBody(body);
      if (!fields || !executionConfirmationAllowed(fields.operation, fields.confirmation)) {
        return rejectedCreationExecution("explicit_execution_authorization_required");
      }
      if (!await setupAttemptTableReady(db)) {
        return rejectedCreationExecution(
          "account_setup_attempt_migration_missing",
          fields.attemptId,
        );
      }
      const ownedAttempt = await readOwnedSetupAttempt(
        db,
        userId,
        fields.attemptId,
        fields.operation,
      );
      if (!ownedAttempt.ok) {
        return rejectedCreationExecution(ownedAttempt.reason, fields.attemptId);
      }
      if (fields.operation === "provision_execution_account" &&
          await unresolvedGenerationExists(db, userId, ownedAttempt.providerConnectionId)) {
        return rejectedCreationExecution(
          "restricted_key_generation_reconciliation_required",
          fields.attemptId,
        );
      }
      if (fields.operation === "create_subaccount") {
        return executeSubaccountCreation(
          db,
          database,
          options.kalshiGet,
          options.kalshiCreateSubaccount,
          userId,
          fields.attemptId,
          fields.confirmation,
          ownedAttempt,
        );
      }
      if (fields.operation === "generate_api_key") {
        if (fields.confirmation === RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION) {
          return executeRestrictedKeyReconciliation(
            db,
            database,
            options.kalshiGet,
            userId,
            fields.attemptId,
            fields.confirmation,
            ownedAttempt,
          );
        }
        return executeRestrictedKeyGeneration(
          db,
          database,
          options.kalshiGet,
          options.kalshiGenerateRestrictedKey,
          userId,
          fields.attemptId,
          fields.confirmation,
          ownedAttempt,
        );
      }
      return executeExecutionAccountProvisioning(
        db,
        database,
        options.kalshiGet,
        userId,
        fields.attemptId,
        fields.confirmation,
        ownedAttempt,
      );
    },
    async commissioningStatus(userId: string) {
      if (!await credentialTablesReady(db)) {
        const setup = unknownAccountSetup("credential_migration_missing");
        return {
          ready: false as const,
          executable: false as const,
          blockers: ["credential_migration_missing"],
          ...setup,
          operationPreparationAvailable: false,
          policyDraftExists: null as boolean | null,
          policyDraft: null as OwnedDraftView | null,
          subaccountCreationExecutionRoleAvailable: false,
          operationPreparations: [] as PublicAccountSetupAttempt[],
          nextAuthorizedAction: nextAuthorizedSetupAction(setup, false, false, []),
        };
      }
      const commissioning = ports();
      const resolved = await resolveAccountCommissioningContext(userId, commissioning);
      const status = resolved.ok
        ? await listAccountCredentialStatus(database, commissioning, userId)
        : { roles: [] };
      let policyOwned = false;
      let policyDraftExists: boolean | null = null;
      let policyDraft: OwnedDraftView | null = null;
      if (resolved.ok && resolved.context.executionAccountId) {
        try {
          const draft = await db.query(OWNED_POLICY_DRAFT_SQL,
            [resolved.context.executionAccountId, userId]);
          policyDraftExists = draft.rows.length === 0 ? false : true;
          // Bad or unexpected data must not supply an approvable policy.
          policyDraft = draft.rows.length === 1 ? safeOwnedDraft(draft.rows[0]!) : null;
          if (policyDraftExists && !policyDraft) policyDraftExists = null;
        } catch {
          policyDraftExists = null;
          policyDraft = null;
        }
        try {
          const policy = await db.query(SCOPED_POLICY_SQL, [resolved.context.executionAccountId, userId]);
          policyOwned = policy.rows.length === 1;
        } catch {
          policyOwned = false;
        }
      }
      let authorizedMicros: string | null = null;
      let evidenceMicros: string | null = null;
      let evidenceSource: string | null = null;
      if (resolved.ok && await fundingTableReady(db)) {
        try {
          const funding = await readAccountFunding(database, userId, resolved.context.providerConnectionId);
          authorizedMicros = funding.authorizedMicros;
          evidenceMicros = funding.evidenceMicros;
          evidenceSource = funding.evidenceSource;
        } catch {
          authorizedMicros = null;
          evidenceMicros = null;
        }
      }
      const readiness = userCommissioningReadiness({
        roles: status.roles,
        authorizedMicros,
        evidenceMicros,
        evidenceSource,
        subaccount: resolved.ok ? resolved.context.subaccount : null,
        exchangeIndex: resolved.ok ? resolved.context.exchangeIndex : null,
        policyOwned,
      });
      if (!resolved.ok) readiness.blockers.unshift(resolved.reason);
      const setup = resolved.ok
        ? await inspectAccountSetup(
          db,
          userId,
          resolved.context.providerConnectionId,
          resolved.context.executionAccountId,
          resolved.context.executionKeyFingerprint,
          resolved.context.credentials,
          status.roles,
          options.kalshiGet,
        )
        : unknownAccountSetup(resolved.reason);
      if (setup.setupReason === "execution_account_credential_fingerprint_mismatch" &&
          !readiness.blockers.includes(setup.setupReason)) {
        readiness.blockers.push(setup.setupReason);
        readiness.ready = false;
        readiness.executable = false;
      }
      let operationPreparationAvailable = false;
      let creationExecutionRoleAvailable = false;
      let operationPreparations: PublicAccountSetupAttempt[] = [];
      if (resolved.ok) {
        operationPreparationAvailable = await setupAttemptTableReady(db);
        creationExecutionRoleAvailable = await setupExecutionRoleReady(db);
        if (operationPreparationAvailable) {
          try {
            operationPreparations = await listOwnedAccountSetupAttempts(
              database,
              userId,
              resolved.context.providerConnectionId,
            );
          } catch {
            operationPreparationAvailable = false;
          }
        }
      }
      return {
        ...readiness,
        ...setup,
        operationPreparationAvailable,
        policyDraftExists,
        policyDraft,
        subaccountCreationExecutionRoleAvailable: creationExecutionRoleAvailable,
        operationPreparations,
        nextAuthorizedAction:
          // Initial generation is permanently completed for this owner;
          // do not send them back to the old one-shot Step 3 operation.
          setup.executionAccountExists &&
          replaceableRestrictedKeyReason(setup.setupReason)
            ? {
              action: "prepare_frozen_restricted_key_recovery",
              operation: null,
              endpoint: "/api/strata/me/credentials/recover-restricted/prepare",
              requiredConfirmation: null,
              effect: "review_new_scoped_rsa_key_for_existing_subaccount_1_no_trading",
              attemptId: null,
            }
            : nextAuthorizedSetupAction(
              setup,
              operationPreparationAvailable,
              creationExecutionRoleAvailable,
              operationPreparations,
            ),
      };
    },
  };
}


/**
 * Owner-only signed preflight. An empty Strata ledger alone is not proof of
 * absent external orders/positions. Unknown response shapes fail closed.
 */
async function recoveryKeyContext(
  db:UserScopeQuery,
  database:CredentialDatabase,
  get:((key:{keyId:string;privateKey:string},path:string,query?:string)=>Promise<unknown>)|undefined,
  userId:string,
):Promise<
  |{ok:true;identity:RecoveryIdentity;setup:Extract<VerifiedAuthorityResult,{ok:true}>;verification:Extract<VerifiedAuthorityResult,{ok:true}>}
  |{ok:false;reason:string}
>{
  if(!get)return {ok:false,reason:"kalshi_signed_read_unavailable"};
  const resolved=await resolveAccountCommissioningContext(userId,createDatabaseAccountCommissioningPorts(database));
  if(!resolved.ok)return {ok:false,reason:resolved.reason};
  const ctx=resolved.context;
  if(!ctx.executionAccountId || !ctx.executionKeyFingerprint ||
      ctx.subaccount!==1 || ctx.exchangeIndex!==2)
    return {ok:false,reason:"recovery_execution_pair_unavailable"};
  const restricted=ctx.credentials.find(x=>x.role==="restricted_execution");
  if(!restricted || !restricted.keyFingerprint ||
      restricted.keyFingerprint!==ctx.executionKeyFingerprint)
    return {ok:false,reason:"recovery_active_credential_binding_mismatch"};
  const verification=await readVerifiedRoleAuthority(db,userId,ctx.providerConnectionId,"verification");
  if(!verification.ok)return {ok:false,reason:verification.reason};
  const setup=await readVerifiedRoleAuthority(db,userId,ctx.providerConnectionId,"account_setup_execution");
  if(!setup.ok)return {ok:false,reason:setup.reason};
  if(!credentialIsIndependent(setup.authority.expectedFingerprint,setup.authority.material.keyId,verification.authority))
    return {ok:false,reason:"recovery_setup_and_verification_not_independent"};
  const meta=await inspectAccountSetupExecutionCredential(
    setup.authority.material.keyId,verification.authority,get
  );
  if(!meta.ok)return {ok:false,reason:meta.reason};
  const sub=await inspectSubaccount1(verification.authority,get);
  if(!sub.ok||sub.exists!==true||sub.exchangeIndex2Exists!==true)
    return {ok:false,reason:sub.reason};
  const existing=await readOwnedSecret(db,userId,restricted.vaultSecretId);
  if(!existing||dedicatedSignerFingerprint(existing.keyId,existing.privateKey)!==restricted.keyFingerprint)
    return {ok:false,reason:"recovery_restricted_secret_unavailable"};
  const old=await inspectRestrictedKeyMetadata(existing.keyId,verification.authority,get);
  if(old.ok)return {ok:false,reason:"recovery_restricted_key_already_correct"};
  if(!replaceableRestrictedKeyReason(old.reason))return {ok:false,reason:old.reason};

  // Signed, owner-filtered Kalshi reads; no transfer/order POST. Refuse any
  // position, resting order, nonempty cursor or malformed inventory.
  try{
    const [orders,positions]=await Promise.all([
      get(verification.authority.material,"/trade-api/v2/portfolio/orders","subaccount=1&status=resting&limit=200"),
      get(verification.authority.material,"/trade-api/v2/portfolio/positions","subaccount=1&limit=200"),
    ]);
    const o=orders&&typeof orders==="object"&&!Array.isArray(orders)?orders as Record<string,unknown>:{};
    const p=positions&&typeof positions==="object"&&!Array.isArray(positions)?positions as Record<string,unknown>:{};
    if(!Array.isArray(o.orders) || !Array.isArray(p.market_positions) ||
       !Array.isArray(p.event_positions) || o.orders.length!==0 ||
       p.market_positions.length!==0 || p.event_positions.length!==0 ||
       Boolean(o.cursor) || Boolean(p.cursor))
      return {ok:false,reason:"recovery_exchange_exposure_or_pagination_unresolved"};
  }catch{return {ok:false,reason:"recovery_signed_exchange_exposure_unavailable"};}
  return {ok:true,setup,verification,identity:{
    owner:userId,financial:ctx.financialAccountId,connection:ctx.providerConnectionId,
    execution:ctx.executionAccountId,previous:ctx.executionKeyFingerprint,
    setupId:setup.credentialId,setupFingerprint:setup.authority.expectedFingerprint,
    verificationId:verification.credentialId,
    verificationFingerprint:verification.authority.expectedFingerprint
  }};
}

function executionDatabase(db: UserScopeQuery): CredentialDatabase {
  if ("connect" in db && typeof (db as PgPoolLike).connect === "function") {
    return credentialDatabaseFromPool(db as PgPoolLike);
  }
  return {
    query: (text, params) => db.query(text, params),
    transaction: (work) => work(db),
  };
}

async function credentialTablesReady(db: UserScopeQuery): Promise<boolean> {
  try {
    const ready = await db.query(CREDENTIAL_TABLE_SQL);
    return Boolean(ready.rows[0]?.name);
  } catch {
    return false;
  }
}

async function fundingTableReady(db: UserScopeQuery): Promise<boolean> {
  try {
    const ready = await db.query(FUNDING_TABLE_SQL);
    return Boolean(ready.rows[0]?.name);
  } catch {
    return false;
  }
}

async function setupAttemptTableReady(db: UserScopeQuery): Promise<boolean> {
  try {
    const ready = await db.query(SETUP_ATTEMPT_TABLE_SQL);
    return Boolean(ready.rows[0]?.name);
  } catch {
    return false;
  }
}

async function setupExecutionRoleReady(db: UserScopeQuery): Promise<boolean> {
  try {
    const ready = await db.query(SETUP_EXECUTION_ROLE_SQL);
    return ready.rows.length === 1 && ready.rows[0]?.ready === true;
  } catch {
    return false;
  }
}

interface OwnedSetupAttempt {
  attemptId: string;
  financialAccountId: string;
  providerConnectionId: string;
  state: string;
}

type OwnedSetupAttemptResult =
  | ({ ok: true } & OwnedSetupAttempt)
  | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readOwnedSetupAttempt(
  db: UserScopeQuery,
  userId: string,
  attemptId: string,
  operation: AccountSetupOperation,
): Promise<OwnedSetupAttemptResult> {
  if (!UUID.test(attemptId)) return { ok: false, reason: "account_setup_attempt_invalid" };
  try {
    const read = await db.query(OWNED_SETUP_ATTEMPT_SQL, [
      attemptId,
      userId,
      operation,
    ]);
    if (read.rows.length !== 1) {
      return { ok: false, reason: "owned_account_setup_attempt_missing" };
    }
    const financialAccountId = text(read.rows[0]?.financial_account_id);
    const providerConnectionId = text(read.rows[0]?.provider_connection_id);
    const state = text(read.rows[0]?.state);
    if (!financialAccountId || !providerConnectionId || !state) {
      return { ok: false, reason: "account_setup_attempt_invalid" };
    }
    return {
      ok: true,
      attemptId,
      financialAccountId,
      providerConnectionId,
      state,
    };
  } catch {
    return { ok: false, reason: "account_setup_attempt_unavailable" };
  }
}

async function unresolvedGenerationExists(
  db: UserScopeQuery,
  userId: string,
  providerConnectionId: string,
): Promise<boolean> {
  try {
    const unresolved = await db.query(UNRESOLVED_GENERATION_SQL, [
      userId,
      providerConnectionId,
    ]);
    return unresolved.rows.length > 0;
  } catch {
    return true;
  }
}

function executionConfirmationAllowed(
  operation: AccountSetupOperation,
  confirmation: string,
): boolean {
  if (operation === "create_subaccount") {
    return confirmation === EXECUTE_SUBACCOUNT_CREATION_CONFIRMATION;
  }
  if (operation === "generate_api_key") {
    return confirmation === EXECUTE_RESTRICTED_KEY_GENERATION_CONFIRMATION ||
      confirmation === RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION;
  }
  return confirmation === EXECUTE_EXECUTION_ACCOUNT_PROVISIONING_CONFIRMATION;
}

function attemptMatchesContext(
  attempt: OwnedSetupAttempt,
  context: { financialAccountId: string; providerConnectionId: string },
): boolean {
  return attempt.financialAccountId === context.financialAccountId &&
    attempt.providerConnectionId === context.providerConnectionId;
}

async function readOwnedSecret(
  db: UserScopeQuery,
  userId: string,
  vaultSecretId: string,
): Promise<{ keyId: string; privateKey: string } | null> {
  const secret = await db.query(OWNED_SECRET_SQL, [vaultSecretId, userId]);
  if (secret.rows.length !== 1) return null;
  return parseSecret(secret.rows[0]?.decrypted_secret);
}

type VerifiedAuthorityResult =
  | {
    ok: true;
    credentialId: string;
    vaultSecretId: string;
    authority: VerifiedCredentialAuthority;
  }
  | { ok: false; reason: string };

interface AccountSetupStatus {
  subaccount1Exists: boolean | null;
  subaccount1Exchange2Exists: boolean | null;
  subaccount1SafeToCreate: boolean | null;
  subaccountEvidence: "kalshi_subaccount_balance_inventory" | null;
  provisioningKeyMetadataVerified: boolean | null;
  provisioningApiTier: string | null;
  provisioningSubaccountCreationEligible: boolean | null;
  subaccountCreationAuthorityPresent: boolean;
  subaccountCreationAuthorityVerified: boolean;
  restrictedKeyMetadataVerified: boolean | null;
  restrictedKeyReadVerified: boolean;
  executionAccountExists: boolean;
  setupReason: string;
  nextRequirement: AccountSetupNextRequirement | null;
}

async function readVerifiedRoleAuthority(
  db: UserScopeQuery,
  userId: string,
  providerConnectionId: string,
  role: "verification" | "provisioning" | "account_setup_execution" | "restricted_execution",
): Promise<VerifiedAuthorityResult> {
  const rows = await db.query(VERIFIED_ROLE_SECRET_SQL, [userId, providerConnectionId, role]);
  if (rows.rows.length !== 1) {
    return {
      ok: false,
      reason: rows.rows.length > 1
        ? "ambiguous_credential_role"
        : `verified_${role}_credential_required`,
    };
  }
  const credentialId = text(rows.rows[0]?.credential_id);
  const vaultSecretId = text(rows.rows[0]?.vault_secret_id);
  const fingerprint = text(rows.rows[0]?.key_fingerprint);
  const material = parseSecret(rows.rows[0]?.decrypted_secret);
  if (!credentialId || !vaultSecretId || !fingerprint || !material) {
    return { ok: false, reason: `${role}_credential_invalid` };
  }
  if (dedicatedSignerFingerprint(material.keyId, material.privateKey) !== fingerprint) {
    return { ok: false, reason: `${role}_credential_fingerprint_mismatch` };
  }
  return {
    ok: true,
    credentialId,
    vaultSecretId,
    authority: { expectedFingerprint: fingerprint, material },
  };
}

async function inspectAccountSetup(
  db: UserScopeQuery,
  userId: string,
  providerConnectionId: string,
  executionAccountId: string | null,
  executionKeyFingerprint: string | null,
  credentials: StoredCredentialRef[],
  statuses: AccountCredentialStatus[],
  getJson: ((creds: { keyId: string; privateKey: string }, path: string, query?: string) => Promise<unknown>) | undefined,
): Promise<AccountSetupStatus> {
  const boundRestricted = credentials.find((credential) => credential.role === "restricted_execution");
  if (executionAccountId !== null &&
      (!executionKeyFingerprint || boundRestricted?.keyFingerprint !== executionKeyFingerprint)) {
    return {
      ...unknownAccountSetup("execution_account_credential_fingerprint_mismatch", true),
      nextRequirement: "repair_execution_account_credential_binding",
    };
  }
  if (!getJson) return unknownAccountSetup("verification_transport_not_enabled", executionAccountId !== null);
  let authority: VerifiedAuthorityResult;
  try {
    authority = await readVerifiedRoleAuthority(db, userId, providerConnectionId, "verification");
  } catch {
    return unknownAccountSetup("verified_verification_credential_required", executionAccountId !== null);
  }
  if (!authority.ok) {
    return {
      ...unknownAccountSetup(authority.reason, executionAccountId !== null),
      nextRequirement: "verify_verification_credential",
    };
  }
  const subaccount = await inspectSubaccount1(authority.authority, getJson);
  const provisioningRef = credentials.find((credential) => credential.role === "provisioning");
  let provisioningMetadataVerified: boolean | null = provisioningRef ? false : null;
  let provisioningApiTier: string | null = null;
  let provisioningSubaccountCreationEligible: boolean | null = null;
  if (provisioningRef) {
    let provisioningAuthority: VerifiedAuthorityResult;
    try {
      provisioningAuthority = await readVerifiedRoleAuthority(
        db,
        userId,
        providerConnectionId,
        "provisioning",
      );
    } catch {
      provisioningAuthority = { ok: false, reason: "verified_provisioning_credential_required" };
    }
    if (provisioningAuthority.ok) {
      const inspected = await inspectProvisioningCredential(
        provisioningAuthority.authority.expectedFingerprint,
        provisioningAuthority.authority.material,
        getJson,
      );
      provisioningMetadataVerified = inspected.ok;
      if (inspected.ok) {
        try {
          const limits = await getJson(
            provisioningAuthority.authority.material,
            ACCOUNT_LIMITS_PATH,
            "",
          );
          const tier = predictionsApiTier(limits);
          provisioningApiTier = tier.apiTier;
          provisioningSubaccountCreationEligible = tier.subaccountCreationTierEligible;
        } catch {
          provisioningSubaccountCreationEligible = null;
        }
      }
    }
  }
  const creationAuthority = credentials.find((credential) =>
    credential.role === "account_setup_execution");
  const creationAuthorityStatus = statuses.find((status) =>
    status.role === "account_setup_execution" && !status.revoked);
  const restricted = credentials.find((credential) => credential.role === "restricted_execution");
  let metadataVerified: boolean | null = null;
  let metadataReason = restricted ? "restricted_key_metadata_unproven" : "missing_credential";
  let metadataNextRequirement: AccountSetupNextRequirement | null =
    restricted ? null : "generate_subaccount_1_restricted_key";
  if (restricted?.keyFingerprint) {
    let material: { keyId: string; privateKey: string } | null = null;
    try {
      material = await readOwnedSecret(db, userId, restricted.vaultSecretId);
    } catch {
      metadataReason = "vault_secret_missing";
    }
    if (!material) {
      metadataReason = "vault_secret_missing";
    } else if (dedicatedSignerFingerprint(material.keyId, material.privateKey) !== restricted.keyFingerprint) {
      metadataReason = "credential_fingerprint_mismatch";
    } else if (restricted.keyFingerprint === authority.authority.expectedFingerprint ||
        material.keyId.trim() === authority.authority.material.keyId.trim()) {
      metadataVerified = false;
      metadataReason = "verification_credential_not_independent";
      metadataNextRequirement = "generate_subaccount_1_restricted_key";
    } else {
      const metadata = await inspectRestrictedKeyMetadata(material.keyId, authority.authority, getJson);
      metadataVerified = metadata.ok;
      metadataReason = metadata.reason;
      metadataNextRequirement = restrictedMetadataNextRequirement(metadata.reason);
    }
  }
  const restrictedStatus = statuses.find((status) =>
    status.role === "restricted_execution" && !status.revoked);
  const readVerified = restrictedStatus?.verified === true;
  const executionFingerprintMismatch = executionAccountId !== null &&
    (!executionKeyFingerprint || restricted?.keyFingerprint !== executionKeyFingerprint);
  let nextRequirement: AccountSetupNextRequirement | null = null;
  if (executionFingerprintMismatch) {
    nextRequirement = "repair_execution_account_credential_binding";
  } else if (subaccount.exists === false) {
    nextRequirement = "create_subaccount_1";
  } else if (subaccount.exists === true && subaccount.exchangeIndex2Exists === true) {
    if (metadataVerified !== true) nextRequirement = metadataNextRequirement;
    else if (!readVerified) nextRequirement = "verify_restricted_execution_credential";
    else if (!executionAccountId) nextRequirement = "provision_execution_account";
  }
  const setupReason = executionFingerprintMismatch
    ? "execution_account_credential_fingerprint_mismatch"
    : !subaccount.ok || !subaccount.exists || !subaccount.exchangeIndex2Exists
    ? subaccount.reason
    : metadataVerified !== true
      ? metadataReason
      : !readVerified
        ? "restricted_execution_unverified"
        : !executionAccountId
          ? "execution_account_not_provisioned"
          : "account_setup_verified";
  return {
    subaccount1Exists: subaccount.exists,
    subaccount1Exchange2Exists: subaccount.exchangeIndex2Exists,
    subaccount1SafeToCreate: subaccount.safeToCreate,
    subaccountEvidence: subaccount.exists === null ? null : "kalshi_subaccount_balance_inventory",
    provisioningKeyMetadataVerified: provisioningMetadataVerified,
    provisioningApiTier,
    provisioningSubaccountCreationEligible,
    subaccountCreationAuthorityPresent: creationAuthority !== undefined,
    subaccountCreationAuthorityVerified: creationAuthorityStatus?.verified === true,
    restrictedKeyMetadataVerified: metadataVerified,
    restrictedKeyReadVerified: readVerified,
    executionAccountExists: executionAccountId !== null,
    setupReason,
    nextRequirement,
  };
}

function unknownAccountSetup(reason: string, executionAccountExists = false): AccountSetupStatus {
  return {
    subaccount1Exists: null,
    subaccount1Exchange2Exists: null,
    subaccount1SafeToCreate: null,
    subaccountEvidence: null,
    provisioningKeyMetadataVerified: null,
    provisioningApiTier: null,
    provisioningSubaccountCreationEligible: null,
    subaccountCreationAuthorityPresent: false,
    subaccountCreationAuthorityVerified: false,
    restrictedKeyMetadataVerified: null,
    restrictedKeyReadVerified: false,
    executionAccountExists,
    setupReason: reason,
    nextRequirement: null,
  };
}

function nextAuthorizedSetupAction(
  setup: AccountSetupStatus,
  preparationAvailable: boolean,
  creationExecutionRoleAvailable: boolean,
  attempts: PublicAccountSetupAttempt[],
): AccountSetupNextAuthorizedAction | null {
  const unresolved = attempts.find((item) =>
    item.state === "attempted" ||
    item.state === "response_received" ||
    item.state === "uncertain");
  if (unresolved) {
    if (unresolved.operation === "generate_api_key" &&
        unresolved.storedResponseAvailable === true &&
        (unresolved.state === "response_received" || unresolved.state === "uncertain")) {
      return nextAction(
        "reconcile_stored_restricted_key_generation",
        unresolved.operation,
        "/api/strata/me/account-operations/execute",
        RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
        "get_only_metadata_and_scoped_read_verification_without_regeneration",
        unresolved.attemptId,
      );
    }
    return nextAction(
      "reconcile_prior_operation_without_retry",
      unresolved.operation,
      null,
      null,
      `operation_${unresolved.state}_retry_blocked`,
      unresolved.attemptId,
    );
  }
  if (setup.nextRequirement === "verify_verification_credential") {
    return nextAction(
      "verify_verification_credential",
      null,
      "/api/strata/me/credentials/verify",
      null,
      "read_only_verification",
    );
  }
  if (setup.nextRequirement === "verify_restricted_execution_credential") {
    return nextAction(
      "verify_restricted_execution_credential",
      null,
      "/api/strata/me/credentials/verify",
      null,
      "read_only_verification",
    );
  }
  const operation = setupOperationForRequirement(setup.nextRequirement);
  if (!operation) {
    if (setup.setupReason === "account_setup_verified") return null;
    return nextAction(
      "resolve_account_setup_blocker",
      null,
      null,
      null,
      setup.setupReason,
    );
  }
  if (operation === "create_subaccount") {
    if (setup.subaccount1SafeToCreate !== true) {
      return nextAction(
        "resolve_subaccount_sequence_or_inventory",
        operation,
        null,
        null,
        setup.setupReason,
      );
    }
    if (setup.provisioningKeyMetadataVerified !== true) {
      return nextAction(
        "verify_account_wide_provisioning_key",
        operation,
        "/api/strata/me/credentials/verify",
        null,
        "prove_account_wide_read_scope_for_preparation",
      );
    }
    if (setup.provisioningSubaccountCreationEligible !== true) {
      return nextAction(
        setup.provisioningApiTier ? "obtain_advanced_or_higher_api_tier" : "verify_api_tier",
        operation,
        null,
        null,
        "subaccount_creation_remains_blocked",
      );
    }
  }
  if (operation === "generate_api_key" && setup.provisioningKeyMetadataVerified !== true) {
    return nextAction(
      "verify_account_wide_provisioning_key",
      operation,
      "/api/strata/me/credentials/verify",
      null,
      "prove_account_wide_read_scope_for_preparation",
    );
  }
  const attempt = attempts.find((item) => item.operation === operation);
  if (attempt) {
    if (attempt.state === "prepared") {
      if (operation === "create_subaccount") {
        if (!creationExecutionRoleAvailable) {
          return nextAction(
            "review_and_separately_apply_migration_0016",
            operation,
            null,
            null,
            "enable_independent_account_setup_execution_role",
            attempt.attemptId,
          );
        }
        if (!setup.subaccountCreationAuthorityPresent) {
          return nextAction(
            "register_independent_account_setup_execution_key",
            operation,
            "/api/strata/me/credentials",
            null,
            "store_new_key_in_user_vault_without_replacing_existing_keys",
            attempt.attemptId,
          );
        }
        if (!setup.subaccountCreationAuthorityVerified) {
          return nextAction(
            "verify_independent_account_setup_execution_key",
            operation,
            "/api/strata/me/credentials/verify",
            null,
            "prove_account_wide_read_and_write_permissions",
            attempt.attemptId,
          );
        }
        return nextAction(
          "separately_authorize_subaccount_creation",
          operation,
          "/api/strata/me/account-operations/execute",
          EXECUTE_SUBACCOUNT_CREATION_CONFIRMATION,
          "one_fixed_subaccount_creation_post_then_get_only_verification",
          attempt.attemptId,
        );
      }
      if (operation === "generate_api_key") {
        if (!creationExecutionRoleAvailable) {
          return nextAction(
            "review_and_separately_apply_migration_0016",
            operation,
            null,
            null,
            "enable_independent_account_setup_execution_role",
            attempt.attemptId,
          );
        }
        if (!setup.subaccountCreationAuthorityPresent) {
          return nextAction(
            "register_independent_account_setup_execution_key",
            operation,
            "/api/strata/me/credentials",
            null,
            "store_new_key_in_user_vault_without_replacing_existing_keys",
            attempt.attemptId,
          );
        }
        if (!setup.subaccountCreationAuthorityVerified) {
          return nextAction(
            "verify_independent_account_setup_execution_key",
            operation,
            "/api/strata/me/credentials/verify",
            null,
            "prove_account_wide_read_and_write_permissions",
            attempt.attemptId,
          );
        }
        return nextAction(
          "separately_authorize_restricted_key_generation",
          operation,
          "/api/strata/me/account-operations/execute",
          EXECUTE_RESTRICTED_KEY_GENERATION_CONFIRMATION,
          "one_fixed_key_generation_post_then_vault_storage_and_read_only_verification",
          attempt.attemptId,
        );
      }
      return nextAction(
        "separately_authorize_execution_account_provisioning",
        operation,
        "/api/strata/me/account-operations/execute",
        EXECUTE_EXECUTION_ACCOUNT_PROVISIONING_CONFIRMATION,
        "create_only_owner_disabled_killed_uncommissioned_execution_account",
        attempt.attemptId,
      );
    }
    if (attempt.state === "attempted" || attempt.state === "response_received" ||
        attempt.state === "uncertain") {
      return nextAction(
        "reconcile_prior_operation_without_retry",
        operation,
        null,
        null,
        `operation_${attempt.state}_retry_blocked`,
      );
    }
    return nextAction(
      "review_prior_operation_state",
      operation,
      null,
      null,
      `operation_${attempt.state}`,
    );
  }
  if (!preparationAvailable) {
    return nextAction(
      "review_and_separately_apply_migration_0015",
      operation,
      null,
      null,
      "enable_durable_review_only_operation_preparation",
    );
  }
  return nextAction(
    `prepare_${operation}`,
    operation,
    "/api/strata/me/account-operations",
    futureAccountOperationConfirmation(operation),
    "persist_review_only_plan_without_external_mutation",
  );
}

function setupOperationForRequirement(
  requirement: AccountSetupNextRequirement | null,
): AccountSetupOperation | null {
  if (requirement === "create_subaccount_1") return "create_subaccount";
  if (requirement === "generate_subaccount_1_restricted_key") return "generate_api_key";
  if (requirement === "provision_execution_account") return "provision_execution_account";
  return null;
}

function nextAction(
  action: string,
  operation: AccountSetupOperation | null,
  endpoint: string | null,
  requiredConfirmation: string | null,
  effect: string,
  attemptId: string | null = null,
): AccountSetupNextAuthorizedAction {
  return { action, operation, endpoint, requiredConfirmation, effect, attemptId };
}

async function prepareSetupReview(
  db: UserScopeQuery,
  database: CredentialDatabase,
  getJson: ((creds: { keyId: string; privateKey: string }, path: string, query?: string) => Promise<unknown>) | undefined,
  userId: string,
  operation: AccountSetupOperation,
) {
  if (!await setupAttemptTableReady(db)) {
    return rejectedPreparation("account_setup_attempt_migration_missing");
  }
  if (!getJson) return rejectedPreparation("verification_transport_not_enabled");
  const commissioning = createDatabaseAccountCommissioningPorts(database);
  const resolved = await resolveAccountCommissioningContext(userId, commissioning);
  if (!resolved.ok) return rejectedPreparation(resolved.reason);
  if (operation === "provision_execution_account" &&
      await unresolvedGenerationExists(db, userId, resolved.context.providerConnectionId)) {
    return rejectedPreparation("restricted_key_generation_reconciliation_required");
  }
  if (operation === "provision_execution_account" && resolved.context.executionAccountId) {
    return rejectedPreparation("execution_account_already_exists");
  }

  let verification: VerifiedAuthorityResult;
  try {
    verification = await readVerifiedRoleAuthority(
      db,
      userId,
      resolved.context.providerConnectionId,
      "verification",
    );
  } catch {
    return rejectedPreparation("verified_verification_credential_required");
  }
  if (!verification.ok) return rejectedPreparation(verification.reason);
  const subaccount = await inspectSubaccount1(verification.authority, getJson);
  if (!subaccount.ok) return rejectedPreparation(subaccount.reason);

  let authority = verification;
  let targetCredentialId: string | null = null;
  let targetFingerprint: string | null = null;
  let apiTier: string | null = null;

  if (operation === "create_subaccount") {
    if (subaccount.exists) return rejectedPreparation("subaccount_1_already_exists");
    if (subaccount.safeToCreate !== true) {
      return rejectedPreparation(subaccount.reason === "subaccount_1_missing"
        ? "subaccount_inventory_unproven"
        : subaccount.reason);
    }
    const provisioning = await verifiedProvisioningAuthority(
      db,
      userId,
      resolved.context.providerConnectionId,
      getJson,
    );
    if (!provisioning.ok) return rejectedPreparation(provisioning.reason);
    authority = provisioning;
    let limits: unknown;
    try {
      limits = await getJson(authority.authority.material, ACCOUNT_LIMITS_PATH, "");
    } catch {
      return rejectedPreparation("provisioning_api_tier_unproven");
    }
    const tier = predictionsApiTier(limits);
    apiTier = tier.apiTier;
    if (!tier.apiTier) return rejectedPreparation("provisioning_api_tier_unproven");
    if (!tier.subaccountCreationTierEligible) {
      return rejectedPreparation("advanced_api_tier_required");
    }
  } else if (operation === "generate_api_key") {
    if (!subaccount.exists || !subaccount.exchangeIndex2Exists) {
      return rejectedPreparation(subaccount.reason);
    }
    const restricted = resolved.context.credentials.find((item) =>
      item.role === "restricted_execution");
    if (restricted) {
      if (!restricted.keyFingerprint) return rejectedPreparation("credential_fingerprint_missing");
      let material: { keyId: string; privateKey: string } | null;
      try {
        material = await readOwnedSecret(db, userId, restricted.vaultSecretId);
      } catch {
        material = null;
      }
      if (!material ||
          dedicatedSignerFingerprint(material.keyId, material.privateKey) !== restricted.keyFingerprint) {
        return rejectedPreparation("restricted_credential_recovery_required");
      }
      const existing = await inspectRestrictedKeyMetadata(
        material.keyId,
        verification.authority,
        getJson,
      );
      if (existing.ok) return rejectedPreparation("restricted_key_already_verified");
      if (!replaceableRestrictedKeyReason(existing.reason)) {
        return rejectedPreparation(existing.reason);
      }
      targetFingerprint = restricted.keyFingerprint;
    }
    const provisioning = await verifiedProvisioningAuthority(
      db,
      userId,
      resolved.context.providerConnectionId,
      getJson,
    );
    if (!provisioning.ok) return rejectedPreparation(provisioning.reason);
    authority = provisioning;
  } else {
    if (!subaccount.exists || !subaccount.exchangeIndex2Exists) {
      return rejectedPreparation(subaccount.reason);
    }
    const restricted = await readVerifiedRoleAuthority(
      db,
      userId,
      resolved.context.providerConnectionId,
      "restricted_execution",
    );
    if (!restricted.ok) return rejectedPreparation(restricted.reason);
    const probed = await probeAccountCredential(
      "restricted_execution",
      restricted.authority.expectedFingerprint,
      restricted.authority.material,
      getJson,
      verification.authority,
    );
    if (!probed.ok) return rejectedPreparation(probed.reason);
    authority = restricted;
    targetCredentialId = restricted.credentialId;
    targetFingerprint = restricted.authority.expectedFingerprint;
  }

  let currentAuthority: VerifiedAuthorityResult;
  let currentVerification: VerifiedAuthorityResult;
  try {
    currentAuthority = await readVerifiedRoleAuthority(
      db,
      userId,
      resolved.context.providerConnectionId,
      operation === "provision_execution_account" ? "restricted_execution" : "provisioning",
    );
    currentVerification = await readVerifiedRoleAuthority(
      db,
      userId,
      resolved.context.providerConnectionId,
      "verification",
    );
  } catch {
    return rejectedPreparation("setup_authority_rotated");
  }
  if (!sameAuthority(authority, currentAuthority)) {
    return rejectedPreparation("setup_authority_rotated");
  }
  if (!sameAuthority(verification, currentVerification)) {
    return rejectedPreparation("verification_credential_rotated");
  }

  const plan = accountSetupPlan(operation, resolved.context.providerConnectionId);
  const preconditionDigest = accountSetupPreconditionDigest({
    ownerUserId: userId,
    financialAccountId: resolved.context.financialAccountId,
    providerConnectionId: resolved.context.providerConnectionId,
    operation,
    subaccount1Exists: subaccount.exists,
    subaccount1Exchange2Exists: subaccount.exchangeIndex2Exists,
    subaccount1SafeToCreate: subaccount.safeToCreate,
    numberedSubaccounts: subaccount.numberedSubaccounts,
    apiTier,
    verificationCredentialId: verification.credentialId,
    verificationFingerprint: verification.authority.expectedFingerprint,
    authorityCredentialId: authority.credentialId,
    authorityFingerprint: authority.authority.expectedFingerprint,
    targetCredentialId,
    targetFingerprint,
    existingExecutionAccountId: resolved.context.executionAccountId,
    plan,
  });
  return prepareAccountSetupOperation(database, {
    ownerUserId: userId,
    financialAccountId: resolved.context.financialAccountId,
    providerConnectionId: resolved.context.providerConnectionId,
    operation,
    authorityCredentialId: authority.credentialId,
    authorityFingerprint: authority.authority.expectedFingerprint,
    targetCredentialId,
    targetFingerprint,
    plan,
    preconditionDigest,
  });
}

async function executeSubaccountCreation(
  db: UserScopeQuery,
  database: CredentialDatabase,
  getJson: ((creds: { keyId: string; privateKey: string }, path: string, query?: string) => Promise<unknown>) | undefined,
  createSubaccount: SubaccountCreationTransport | undefined,
  userId: string,
  attemptId: string,
  confirmation: string,
  ownedAttempt: OwnedSetupAttempt,
) {
  if (confirmation !== EXECUTE_SUBACCOUNT_CREATION_CONFIRMATION) {
    return rejectedCreationExecution("explicit_execution_authorization_required", attemptId);
  }
  if (!await setupAttemptTableReady(db)) {
    return rejectedCreationExecution("account_setup_attempt_migration_missing", attemptId);
  }
  if (!await setupExecutionRoleReady(db)) {
    return rejectedCreationExecution("account_setup_execution_role_migration_missing", attemptId);
  }
  if (!getJson) return rejectedCreationExecution("verification_transport_not_enabled", attemptId);
  if (!createSubaccount) {
    return rejectedCreationExecution("subaccount_creation_transport_not_enabled", attemptId);
  }
  const commissioning = createDatabaseAccountCommissioningPorts(database);
  const resolved = await resolveAccountCommissioningContext(userId, commissioning);
  if (!resolved.ok) return rejectedCreationExecution(resolved.reason, attemptId);
  if (!attemptMatchesContext(ownedAttempt, resolved.context)) {
    return rejectedCreationExecution("account_setup_attempt_context_mismatch", attemptId);
  }
  if (resolved.context.executionAccountId) {
    return rejectedCreationExecution("execution_account_already_exists", attemptId);
  }

  const verification = await readVerifiedRoleAuthority(
    db,
    userId,
    resolved.context.providerConnectionId,
    "verification",
  );
  if (!verification.ok) return rejectedCreationExecution(verification.reason, attemptId);
  const inventory = await inspectSubaccount1(verification.authority, getJson);
  if (!inventory.ok) return rejectedCreationExecution(inventory.reason, attemptId);
  if (inventory.exists) {
    return rejectedCreationExecution("subaccount_1_already_exists", attemptId);
  }
  if (inventory.safeToCreate !== true) {
    return rejectedCreationExecution("subaccount_creation_inventory_stale", attemptId);
  }

  const provisioning = await verifiedProvisioningAuthority(
    db,
    userId,
    resolved.context.providerConnectionId,
    getJson,
  );
  if (!provisioning.ok) return rejectedCreationExecution(provisioning.reason, attemptId);
  let preparationLimits: unknown;
  try {
    preparationLimits = await getJson(provisioning.authority.material, ACCOUNT_LIMITS_PATH, "");
  } catch {
    return rejectedCreationExecution("provisioning_api_tier_unproven", attemptId);
  }
  const preparationTier = predictionsApiTier(preparationLimits);
  if (!preparationTier.apiTier) {
    return rejectedCreationExecution("provisioning_api_tier_unproven", attemptId);
  }
  if (!preparationTier.subaccountCreationTierEligible) {
    return rejectedCreationExecution("advanced_api_tier_required", attemptId);
  }

  const execution = await readVerifiedRoleAuthority(
    db,
    userId,
    resolved.context.providerConnectionId,
    "account_setup_execution",
  );
  if (!execution.ok) return rejectedCreationExecution(execution.reason, attemptId);
  if (!credentialIsIndependent(
    execution.authority.expectedFingerprint,
    execution.authority.material.keyId,
    verification.authority,
  ) || !credentialIsIndependent(
    execution.authority.expectedFingerprint,
    execution.authority.material.keyId,
    provisioning.authority,
  )) {
    return rejectedCreationExecution(
      "account_setup_execution_credential_not_independent",
      attemptId,
    );
  }
  const executionMetadata = await inspectAccountSetupExecutionCredential(
    execution.authority.material.keyId,
    verification.authority,
    getJson,
  );
  if (!executionMetadata.ok) {
    return rejectedCreationExecution(executionMetadata.reason, attemptId);
  }
  let executionLimits: unknown;
  try {
    executionLimits = await getJson(execution.authority.material, ACCOUNT_LIMITS_PATH, "");
  } catch {
    return rejectedCreationExecution("account_setup_execution_read_check_failed", attemptId);
  }
  const executionTier = predictionsApiTier(executionLimits);
  if (!executionTier.apiTier || !executionTier.subaccountCreationTierEligible) {
    return rejectedCreationExecution(
      executionTier.apiTier ? "advanced_api_tier_required" : "provisioning_api_tier_unproven",
      attemptId,
    );
  }

  const [currentVerification, currentProvisioning, currentExecution] = await Promise.all([
    readVerifiedRoleAuthority(db, userId, resolved.context.providerConnectionId, "verification"),
    readVerifiedRoleAuthority(db, userId, resolved.context.providerConnectionId, "provisioning"),
    readVerifiedRoleAuthority(db, userId, resolved.context.providerConnectionId, "account_setup_execution"),
  ]);
  if (!sameAuthority(verification, currentVerification)) {
    return rejectedCreationExecution("verification_credential_rotated", attemptId);
  }
  if (!sameAuthority(provisioning, currentProvisioning)) {
    return rejectedCreationExecution("provisioning_credential_rotated", attemptId);
  }
  if (!sameAuthority(execution, currentExecution)) {
    return rejectedCreationExecution("account_setup_execution_credential_rotated", attemptId);
  }

  return executePreparedSubaccountCreation(database, {
    authenticatedUserId: userId,
    financialAccountId: resolved.context.financialAccountId,
    providerConnectionId: resolved.context.providerConnectionId,
    attemptId,
    confirmation,
    executionCredentialId: execution.credentialId,
    executionFingerprint: execution.authority.expectedFingerprint,
    executionMaterial: execution.authority.material,
    transport: createSubaccount,
    async verifyCreated() {
      const current = await readVerifiedRoleAuthority(
        db,
        userId,
        resolved.context.providerConnectionId,
        "verification",
      );
      if (!sameAuthority(verification, current)) {
        return {
          ok: false,
          reason: "verification_credential_rotated",
          subaccount1Exists: null,
          subaccount1Exchange2Exists: null,
        };
      }
      const verified = await inspectSubaccount1(verification.authority, getJson);
      return {
        ok: verified.ok && verified.exists === true && verified.exchangeIndex2Exists === true,
        reason: verified.reason,
        subaccount1Exists: verified.exists,
        subaccount1Exchange2Exists: verified.exchangeIndex2Exists,
      };
    },
  });
}

async function executeRestrictedKeyGeneration(
  db: UserScopeQuery,
  database: CredentialDatabase,
  getJson: ((creds: { keyId: string; privateKey: string }, path: string, query?: string) => Promise<unknown>) | undefined,
  generateRestrictedKey: RestrictedKeyGenerationTransport | undefined,
  userId: string,
  attemptId: string,
  confirmation: string,
  ownedAttempt: OwnedSetupAttempt,
) {
  if (confirmation !== EXECUTE_RESTRICTED_KEY_GENERATION_CONFIRMATION) {
    return rejectedCreationExecution("explicit_execution_authorization_required", attemptId);
  }
  if (!await setupAttemptTableReady(db)) {
    return rejectedCreationExecution("account_setup_attempt_migration_missing", attemptId);
  }
  if (!await setupExecutionRoleReady(db)) {
    return rejectedCreationExecution("account_setup_execution_role_migration_missing", attemptId);
  }
  if (!getJson) {
    return rejectedCreationExecution("verification_transport_not_enabled", attemptId);
  }
  if (!generateRestrictedKey) {
    return rejectedCreationExecution("restricted_key_generation_transport_not_enabled", attemptId);
  }

  const commissioning = createDatabaseAccountCommissioningPorts(database);
  const resolved = await resolveAccountCommissioningContext(userId, commissioning);
  if (!resolved.ok) return rejectedCreationExecution(resolved.reason, attemptId);
  if (!attemptMatchesContext(ownedAttempt, resolved.context)) {
    return rejectedCreationExecution("account_setup_attempt_context_mismatch", attemptId);
  }
  if (resolved.context.executionAccountId) {
    return rejectedCreationExecution(
      "execution_account_exists_before_restricted_key_generation",
      attemptId,
    );
  }

  const verification = await readVerifiedRoleAuthority(
    db,
    userId,
    resolved.context.providerConnectionId,
    "verification",
  );
  if (!verification.ok) return rejectedCreationExecution(verification.reason, attemptId);
  const inventory = await inspectSubaccount1(verification.authority, getJson);
  if (!inventory.ok || inventory.exists !== true ||
      inventory.exchangeIndex2Exists !== true) {
    return rejectedCreationExecution(inventory.reason, attemptId);
  }

  const provisioning = await verifiedProvisioningAuthority(
    db,
    userId,
    resolved.context.providerConnectionId,
    getJson,
  );
  if (!provisioning.ok) return rejectedCreationExecution(provisioning.reason, attemptId);
  const execution = await readVerifiedRoleAuthority(
    db,
    userId,
    resolved.context.providerConnectionId,
    "account_setup_execution",
  );
  if (!execution.ok) return rejectedCreationExecution(execution.reason, attemptId);
  if (!credentialIsIndependent(
    execution.authority.expectedFingerprint,
    execution.authority.material.keyId,
    verification.authority,
  ) || !credentialIsIndependent(
    execution.authority.expectedFingerprint,
    execution.authority.material.keyId,
    provisioning.authority,
  )) {
    return rejectedCreationExecution(
      "account_setup_execution_credential_not_independent",
      attemptId,
    );
  }
  const executionMetadata = await inspectAccountSetupExecutionCredential(
    execution.authority.material.keyId,
    verification.authority,
    getJson,
  );
  if (!executionMetadata.ok) {
    return rejectedCreationExecution(executionMetadata.reason, attemptId);
  }
  try {
    const limits = predictionsApiTier(await getJson(
      execution.authority.material,
      ACCOUNT_LIMITS_PATH,
      "",
    ));
    if (!limits.apiTier) {
      return rejectedCreationExecution("account_setup_execution_api_tier_unproven", attemptId);
    }
  } catch {
    return rejectedCreationExecution("account_setup_execution_read_check_failed", attemptId);
  }

  const existing = resolved.context.credentials.find((item) =>
    item.role === "restricted_execution");
  if (existing) {
    if (!existing.keyFingerprint) {
      return rejectedCreationExecution("credential_fingerprint_missing", attemptId);
    }
    let material: { keyId: string; privateKey: string } | null;
    try {
      material = await readOwnedSecret(db, userId, existing.vaultSecretId);
    } catch {
      material = null;
    }
    if (!material ||
        dedicatedSignerFingerprint(material.keyId, material.privateKey) !== existing.keyFingerprint) {
      return rejectedCreationExecution("restricted_credential_recovery_required", attemptId);
    }
    const metadata = await inspectRestrictedKeyMetadata(
      material.keyId,
      verification.authority,
      getJson,
    );
    if (metadata.ok) {
      return rejectedCreationExecution("restricted_key_already_verified", attemptId);
    }
    if (!replaceableRestrictedKeyReason(metadata.reason)) {
      return rejectedCreationExecution(metadata.reason, attemptId);
    }
  }

  const [currentVerification, currentProvisioning, currentExecution] = await Promise.all([
    readVerifiedRoleAuthority(db, userId, resolved.context.providerConnectionId, "verification"),
    readVerifiedRoleAuthority(db, userId, resolved.context.providerConnectionId, "provisioning"),
    readVerifiedRoleAuthority(db, userId, resolved.context.providerConnectionId, "account_setup_execution"),
  ]);
  if (!sameAuthority(verification, currentVerification)) {
    return rejectedCreationExecution("verification_credential_rotated", attemptId);
  }
  if (!sameAuthority(provisioning, currentProvisioning)) {
    return rejectedCreationExecution("provisioning_credential_rotated", attemptId);
  }
  if (!sameAuthority(execution, currentExecution)) {
    return rejectedCreationExecution("account_setup_execution_credential_rotated", attemptId);
  }

  return executePreparedRestrictedKeyGeneration(database, {
    authenticatedUserId: userId,
    financialAccountId: resolved.context.financialAccountId,
    providerConnectionId: resolved.context.providerConnectionId,
    attemptId,
    confirmation,
    verificationCredentialId: verification.credentialId,
    verificationFingerprint: verification.authority.expectedFingerprint,
    provisioningCredentialId: provisioning.credentialId,
    executionCredentialId: execution.credentialId,
    executionFingerprint: execution.authority.expectedFingerprint,
    executionMaterial: execution.authority.material,
    transport: generateRestrictedKey,
    async verifyGenerated(material, fingerprint) {
      if (!credentialIsIndependent(fingerprint, material.keyId, verification.authority) ||
          !credentialIsIndependent(fingerprint, material.keyId, provisioning.authority) ||
          !credentialIsIndependent(fingerprint, material.keyId, execution.authority)) {
        return { ok: false, reason: "generated_credential_not_independent" };
      }
      const [freshVerification, freshProvisioning, freshExecution] = await Promise.all([
        readVerifiedRoleAuthority(db, userId, resolved.context.providerConnectionId, "verification"),
        readVerifiedRoleAuthority(db, userId, resolved.context.providerConnectionId, "provisioning"),
        readVerifiedRoleAuthority(db, userId, resolved.context.providerConnectionId, "account_setup_execution"),
      ]);
      if (!sameAuthority(verification, freshVerification)) {
        return { ok: false, reason: "verification_credential_rotated" };
      }
      if (!sameAuthority(provisioning, freshProvisioning)) {
        return { ok: false, reason: "provisioning_credential_rotated" };
      }
      if (!sameAuthority(execution, freshExecution)) {
        return { ok: false, reason: "account_setup_execution_credential_rotated" };
      }
      const probed = await probeAccountCredential(
        "restricted_execution",
        fingerprint,
        material,
        getJson,
        verification.authority,
      );
      return { ok: probed.ok, reason: probed.reason };
    },
  });
}

async function executeRestrictedKeyReconciliation(
  db: UserScopeQuery,
  database: CredentialDatabase,
  getJson: ((creds: { keyId: string; privateKey: string }, path: string, query?: string) => Promise<unknown>) | undefined,
  userId: string,
  attemptId: string,
  confirmation: string,
  ownedAttempt: OwnedSetupAttempt,
) {
  if (confirmation !== RECONCILE_RESTRICTED_KEY_GENERATION_CONFIRMATION) {
    return rejectedCreationExecution("explicit_execution_authorization_required", attemptId);
  }
  const commissioning = createDatabaseAccountCommissioningPorts(database);
  const resolved = await resolveAccountCommissioningContext(userId, commissioning);
  if (!resolved.ok) return rejectedCreationExecution(resolved.reason, attemptId);
  if (!attemptMatchesContext(ownedAttempt, resolved.context)) {
    return rejectedCreationExecution("account_setup_attempt_context_mismatch", attemptId);
  }
  if (ownedAttempt.state === "completed") {
    let completed: Awaited<ReturnType<UserScopeQuery["query"]>>;
    try {
      completed = await db.query(COMPLETED_GENERATION_SQL, [
        attemptId,
        userId,
        resolved.context.financialAccountId,
        resolved.context.providerConnectionId,
      ]);
    } catch {
      return rejectedCreationExecution("restricted_key_reconciliation_unavailable", attemptId);
    }
    if (completed.rows.length === 1) {
      return {
        ok: true as const,
        reason: "restricted_key_already_generated_and_verified",
        attempted: false as const,
        executable: false as const,
        attemptId,
        state: "completed" as const,
        restrictedKeyVerified: true,
        reconciliationRequired: false,
      };
    }
  }
  if (!getJson) {
    return rejectedCreationExecution("verification_transport_not_enabled", attemptId);
  }
  if (!["response_received", "uncertain", "completed"].includes(ownedAttempt.state)) {
    return rejectedCreationExecution(
      ownedAttempt.state === "attempted"
        ? "restricted_key_generation_response_not_stored"
        : "restricted_key_generation_not_reconcilable",
      attemptId,
    );
  }

  let generatedRead: Awaited<ReturnType<UserScopeQuery["query"]>>;
  try {
    generatedRead = await db.query(GENERATED_ATTEMPT_SECRET_SQL, [
      attemptId,
      userId,
      resolved.context.financialAccountId,
      resolved.context.providerConnectionId,
    ]);
  } catch {
    return rejectedCreationExecution("restricted_key_reconciliation_unavailable", attemptId);
  }
  if (generatedRead.rows.length !== 1) {
    return rejectedCreationExecution(
      "restricted_key_generation_stored_credential_missing",
      attemptId,
    );
  }
  const generatedCredentialId = text(generatedRead.rows[0]?.credential_id);
  const generatedVaultSecretId = text(generatedRead.rows[0]?.vault_secret_id);
  const generatedFingerprint = text(generatedRead.rows[0]?.key_fingerprint);
  const generatedRevoked = generatedRead.rows[0]?.revoked_at != null;
  if (!generatedCredentialId || !generatedVaultSecretId || !generatedFingerprint) {
    return rejectedCreationExecution(
      "restricted_key_generation_stored_credential_invalid",
      attemptId,
    );
  }
  if (resolved.context.executionAccountId &&
      resolved.context.executionKeyFingerprint !== generatedFingerprint) {
    return rejectedCreationExecution(
      "execution_account_credential_fingerprint_mismatch",
      attemptId,
    );
  }

  const verification = await readVerifiedRoleAuthority(
    db,
    userId,
    resolved.context.providerConnectionId,
    "verification",
  );
  if (!verification.ok) return rejectedCreationExecution(verification.reason, attemptId);
  let generatedMaterial: { keyId: string; privateKey: string } | null;
  try {
    const secret = await db.query(HELD_GENERATION_SECRET_SQL, [
      generatedVaultSecretId,
      userId,
      attemptId,
    ]);
    generatedMaterial = secret.rows.length === 1
      ? parseSecret(secret.rows[0]?.decrypted_secret)
      : null;
  } catch {
    generatedMaterial = null;
  }
  if (!generatedMaterial ||
      dedicatedSignerFingerprint(generatedMaterial.keyId, generatedMaterial.privateKey) !==
        generatedFingerprint) {
    return rejectedCreationExecution(
      "restricted_credential_recovery_required",
      attemptId,
    );
  }
  const verified = await probeAccountCredential(
    "restricted_execution",
    generatedFingerprint,
    generatedMaterial,
    getJson,
    verification.authority,
  );
  let retainedActiveCredential: { credentialId: string; fingerprint: string } | undefined;
  if (generatedRevoked) {
    const active = await readVerifiedRoleAuthority(
      db,
      userId,
      resolved.context.providerConnectionId,
      "restricted_execution",
    );
    if (!active.ok) {
      if (active.reason !== "verified_restricted_execution_credential_required") {
        return rejectedCreationExecution(active.reason, attemptId);
      }
      if (!verified.ok) return rejectedCreationExecution(verified.reason, attemptId);
    } else if (active.credentialId === generatedCredentialId ||
        active.authority.expectedFingerprint === generatedFingerprint) {
      return rejectedCreationExecution("stored_restricted_key_binding_changed", attemptId);
    } else {
      const activeProbe = await probeAccountCredential(
        "restricted_execution",
        active.authority.expectedFingerprint,
        active.authority.material,
        getJson,
        verification.authority,
      );
      if (!activeProbe.ok) return rejectedCreationExecution(activeProbe.reason, attemptId);
      retainedActiveCredential = {
        credentialId: active.credentialId,
        fingerprint: active.authority.expectedFingerprint,
      };
    }
  } else if (!verified.ok) {
    return rejectedCreationExecution(verified.reason, attemptId);
  }

  return reconcileStoredRestrictedKeyGeneration(database, {
    authenticatedUserId: userId,
    financialAccountId: resolved.context.financialAccountId,
    providerConnectionId: resolved.context.providerConnectionId,
    attemptId,
    confirmation,
    verificationCredentialId: verification.credentialId,
    verificationFingerprint: verification.authority.expectedFingerprint,
    targetCredentialId: generatedCredentialId,
    targetFingerprint: generatedFingerprint,
    retainedActiveCredential,
  });
}

async function executeExecutionAccountProvisioning(
  db: UserScopeQuery,
  database: CredentialDatabase,
  getJson: ((creds: { keyId: string; privateKey: string }, path: string, query?: string) => Promise<unknown>) | undefined,
  userId: string,
  attemptId: string,
  confirmation: string,
  ownedAttempt: OwnedSetupAttempt,
) {
  if (confirmation !== EXECUTE_EXECUTION_ACCOUNT_PROVISIONING_CONFIRMATION) {
    return rejectedCreationExecution("explicit_execution_authorization_required", attemptId);
  }
  if (!await setupAttemptTableReady(db)) {
    return rejectedCreationExecution("account_setup_attempt_migration_missing", attemptId);
  }
  const commissioning = createDatabaseAccountCommissioningPorts(database);
  const resolved = await resolveAccountCommissioningContext(userId, commissioning);
  if (!resolved.ok) return rejectedCreationExecution(resolved.reason, attemptId);
  if (!attemptMatchesContext(ownedAttempt, resolved.context)) {
    return rejectedCreationExecution("account_setup_attempt_context_mismatch", attemptId);
  }
  if (ownedAttempt.state === "completed") {
    let target: Awaited<ReturnType<UserScopeQuery["query"]>>;
    try {
      target = await db.query(COMPLETED_PROVISION_CREDENTIAL_SQL, [
        attemptId,
        userId,
        resolved.context.financialAccountId,
        resolved.context.providerConnectionId,
      ]);
    } catch {
      return rejectedCreationExecution(
        "completed_provisioning_account_reconciliation_required",
        attemptId,
      );
    }
    const credentialId = text(target.rows[0]?.credential_id);
    const fingerprint = text(target.rows[0]?.key_fingerprint);
    if (target.rows.length !== 1 || !credentialId || !fingerprint) {
      return rejectedCreationExecution(
        "completed_provisioning_account_reconciliation_required",
        attemptId,
      );
    }
    return executePreparedExecutionAccountProvisioning(database, {
      authenticatedUserId: userId,
      financialAccountId: resolved.context.financialAccountId,
      providerConnectionId: resolved.context.providerConnectionId,
      attemptId,
      confirmation,
      restrictedCredentialId: credentialId,
      restrictedFingerprint: fingerprint,
    });
  }
  if (!getJson) {
    return rejectedCreationExecution("verification_transport_not_enabled", attemptId);
  }

  const verification = await readVerifiedRoleAuthority(
    db,
    userId,
    resolved.context.providerConnectionId,
    "verification",
  );
  if (!verification.ok) return rejectedCreationExecution(verification.reason, attemptId);
  const inventory = await inspectSubaccount1(verification.authority, getJson);
  if (!inventory.ok || inventory.exists !== true ||
      inventory.exchangeIndex2Exists !== true) {
    return rejectedCreationExecution(inventory.reason, attemptId);
  }
  const restricted = await readVerifiedRoleAuthority(
    db,
    userId,
    resolved.context.providerConnectionId,
    "restricted_execution",
  );
  if (!restricted.ok) return rejectedCreationExecution(restricted.reason, attemptId);
  const probed = await probeAccountCredential(
    "restricted_execution",
    restricted.authority.expectedFingerprint,
    restricted.authority.material,
    getJson,
    verification.authority,
  );
  if (!probed.ok) return rejectedCreationExecution(probed.reason, attemptId);

  const [currentVerification, currentRestricted] = await Promise.all([
    readVerifiedRoleAuthority(db, userId, resolved.context.providerConnectionId, "verification"),
    readVerifiedRoleAuthority(db, userId, resolved.context.providerConnectionId, "restricted_execution"),
  ]);
  if (!sameAuthority(verification, currentVerification)) {
    return rejectedCreationExecution("verification_credential_rotated", attemptId);
  }
  if (!sameAuthority(restricted, currentRestricted)) {
    return rejectedCreationExecution("restricted_execution_credential_rotated", attemptId);
  }

  return executePreparedExecutionAccountProvisioning(database, {
    authenticatedUserId: userId,
    financialAccountId: resolved.context.financialAccountId,
    providerConnectionId: resolved.context.providerConnectionId,
    attemptId,
    confirmation,
    restrictedCredentialId: restricted.credentialId,
    restrictedFingerprint: restricted.authority.expectedFingerprint,
  });
}

async function verifiedProvisioningAuthority(
  db: UserScopeQuery,
  userId: string,
  providerConnectionId: string,
  getJson: (creds: { keyId: string; privateKey: string }, path: string, query?: string) => Promise<unknown>,
): Promise<VerifiedAuthorityResult> {
  let authority: VerifiedAuthorityResult;
  try {
    authority = await readVerifiedRoleAuthority(db, userId, providerConnectionId, "provisioning");
  } catch {
    return { ok: false, reason: "verified_provisioning_credential_required" };
  }
  if (!authority.ok) return authority;
  const inspected = await inspectProvisioningCredential(
    authority.authority.expectedFingerprint,
    authority.authority.material,
    getJson,
  );
  return inspected.ok ? authority : { ok: false, reason: inspected.reason };
}

function sameAuthority(
  first: VerifiedAuthorityResult,
  second: VerifiedAuthorityResult,
): boolean {
  return first.ok && second.ok &&
    first.credentialId === second.credentialId &&
    first.vaultSecretId === second.vaultSecretId &&
    first.authority.expectedFingerprint === second.authority.expectedFingerprint;
}

function credentialIsIndependent(
  fingerprint: string,
  keyId: string,
  other: VerifiedCredentialAuthority,
): boolean {
  return fingerprint !== other.expectedFingerprint &&
    keyId.trim() !== other.material.keyId.trim();
}

function credentialProbeResult(ok: boolean, reason: string) {
  return {
    ok,
    reason,
    evidenceMicros: null,
    subaccount1Exists: null,
    subaccount1Exchange2Exists: null,
    restrictedKeyMetadataVerified: null,
    nextRequirement: null,
  };
}

function replaceableRestrictedKeyReason(reason: string): boolean {
  return reason === "credential_permission_unproven" ||
    reason === "credential_permission_rejected" ||
    reason === "restricted_key_not_bound_to_subaccount_1" ||
    reason === "account_target_pair_mismatch" ||
    reason === "verification_credential_not_independent";
}

function rejectedPreparation(reason: string) {
  return {
    ok: false as const,
    reason,
    attempted: false as const,
    executable: false as const,
    idempotent: false,
    attempt: null,
  };
}

function rejectedCreationExecution(reason: string, attemptId: string | null = null) {
  return {
    ok: false as const,
    reason,
    attempted: false as const,
    executable: false as const,
    attemptId,
    state: null,
    subaccount1Exists: null,
    subaccount1Exchange2Exists: null,
  };
}

async function observeBalance(
  db: UserScopeQuery,
  commissioning: ReturnType<typeof createDatabaseAccountCommissioningPorts>,
  getJson: (creds: { keyId: string; privateKey: string }, path: string, query?: string) => Promise<unknown>,
  userId: string,
): Promise<{ ok: boolean; reason: string; evidenceMicros: string | null }> {
  const resolved = await resolveAccountCommissioningContext(userId, commissioning);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, evidenceMicros: null };
  const verified = await readVerifiedRoleAuthority(
    db,
    userId,
    resolved.context.providerConnectionId,
    "verification",
  );
  if (!verified.ok) return { ok: false, reason: verified.reason, evidenceMicros: null };
  const probed = await probeAccountCredential(
    "verification",
    verified.authority.expectedFingerprint,
    verified.authority.material,
    getJson,
  );
  return { ok: probed.ok, reason: probed.reason, evidenceMicros: probed.evidenceMicros };
}

function credentialBody(body: unknown): { role: string; apiKeyId: string; privateKey: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = { ...(body as Record<string, unknown>) };
  delete record.owner_user_id;
  delete record.target_user_id;
  delete record.provider_connection_id;
  const role = record.role;
  const apiKeyId = record.apiKeyId ?? record.api_key_id;
  const privateKey = record.privateKey ?? record.private_key;
  if (typeof role !== "string" || typeof apiKeyId !== "string" || typeof privateKey !== "string") return null;
  return { role, apiKeyId, privateKey };
}

function operationOf(body: unknown): FutureAccountOperation | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const operation = (body as Record<string, unknown>).operation;
  if (operation === "create_subaccount" || operation === "generate_api_key" ||
      operation === "provision_execution_account" ||
      operation === "transfer_funds" || operation === "qualifying_order") return operation;
  return null;
}

function isAccountSetupOperation(operation: FutureAccountOperation): operation is AccountSetupOperation {
  return Object.hasOwn(ACCOUNT_SETUP_CONFIRMATIONS, operation);
}

function accountSetupExecutionBody(body: unknown): {
  operation: AccountSetupOperation;
  attemptId: string;
  confirmation: string;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = { ...(body as Record<string, unknown>) };
  delete record.owner_user_id;
  delete record.target_user_id;
  delete record.provider_connection_id;
  const attemptId = record.attemptId ?? record.attempt_id;
  if (!isAccountSetupOperationValue(record.operation) ||
      typeof attemptId !== "string" || !attemptId.trim() ||
      typeof record.confirmation !== "string") return null;
  return {
    operation: record.operation,
    attemptId: attemptId.trim(),
    confirmation: record.confirmation,
  };
}

function isAccountSetupOperationValue(value: unknown): value is AccountSetupOperation {
  return value === "create_subaccount" ||
    value === "generate_api_key" ||
    value === "provision_execution_account";
}

function roleOf(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const role = (body as Record<string, unknown>).role;
  return typeof role === "string" ? role : null;
}

function parseSecret(value: unknown): { keyId: string; privateKey: string } | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.api_key_id !== "string" || typeof parsed.private_key !== "string") return null;
    if (!parsed.api_key_id || !parsed.private_key) return null;
    return { keyId: parsed.api_key_id, privateKey: parsed.private_key };
  } catch {
    return null;
  }
}

function fundingBody(body: unknown): { confirmation: unknown; authorizedMicros: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = { ...(body as Record<string, unknown>) };
  delete record.owner_user_id;
  delete record.target_user_id;
  const authorized = record.authorizedMicros ?? record.authorized_micros;
  if (typeof authorized !== "string" && typeof authorized !== "number") return null;
  return { confirmation: record.confirmation, authorizedMicros: String(authorized) };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

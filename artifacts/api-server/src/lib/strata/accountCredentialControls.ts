import { emptyUserExecutionView } from "./userExecutionScope";
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
  inspectRestrictedKeyMetadata,
  inspectSubaccount1,
  probeAccountCredential,
  restrictedMetadataNextRequirement,
  type AccountSetupNextRequirement,
  type VerifiedCredentialAuthority,
} from "./accountCredentialProbe";
import {
  authorizeFutureAccountOperation,
  persistAccountFundingAuthorization,
  persistAccountFundingEvidence,
  readAccountFunding,
  RECORD_FUNDING_EVIDENCE_CONFIRMATION,
  type FutureAccountOperation,
} from "./accountFunding";
import { operateAccountWorker, SAFETY_EXPOSURE_SQL, SCOPED_POLICY_SQL } from "./accountScopedExecution";

const CREDENTIAL_TABLE_SQL = `
  SELECT to_regclass('private.kalshi_connection_credentials') AS name
`;
const LEASE_TABLE_SQL = `
  SELECT to_regclass('private.kalshi_account_worker_lease') AS name
`;
const FUNDING_TABLE_SQL = `
  SELECT to_regclass('private.kalshi_account_funding') AS name
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
  } = {},
) {
  const database = executionDatabase(db);
  const ports = () => createDatabaseAccountCommissioningPorts(database);
  return {
    async safetyControl(userId: string, action: "STOP" | "DISARM" | "KILL") {
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
          if (action !== "KILL") return closed;
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
          if (role === "restricted_execution") {
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
          const probed = await probeAccountCredential(
            role,
            fingerprint,
            material,
            getJson,
            verifiedBinding?.authority,
          );
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
          return probed;
        },
      });
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
    async authorizeOperation(_userId: string, body: unknown) {
      const operation = operationOf(body);
      if (!operation) return { ok: false as const, reason: "explicit_authorization_required", attempted: false as const };
      return authorizeFutureAccountOperation({
        operation,
        confirmation: body && typeof body === "object" ? (body as Record<string, unknown>).confirmation : null,
      });
    },
    async commissioningStatus(userId: string) {
      if (!await credentialTablesReady(db)) {
        return {
          ready: false as const,
          executable: false as const,
          blockers: ["credential_migration_missing"],
          ...unknownAccountSetup("credential_migration_missing"),
        };
      }
      const commissioning = ports();
      const resolved = await resolveAccountCommissioningContext(userId, commissioning);
      const status = resolved.ok
        ? await listAccountCredentialStatus(database, commissioning, userId)
        : { roles: [] };
      let policyOwned = false;
      if (resolved.ok && resolved.context.executionAccountId) {
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
          resolved.context.credentials,
          status.roles,
          options.kalshiGet,
        )
        : unknownAccountSetup(resolved.reason);
      return { ...readiness, ...setup };
    },
  };
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
  subaccountEvidence: "kalshi_subaccount_balance_inventory" | null;
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
  role: "verification",
): Promise<VerifiedAuthorityResult> {
  const rows = await db.query(VERIFIED_ROLE_SECRET_SQL, [userId, providerConnectionId, role]);
  if (rows.rows.length !== 1) {
    return {
      ok: false,
      reason: rows.rows.length > 1
        ? "ambiguous_credential_role"
        : "verified_verification_credential_required",
    };
  }
  const credentialId = text(rows.rows[0]?.credential_id);
  const vaultSecretId = text(rows.rows[0]?.vault_secret_id);
  const fingerprint = text(rows.rows[0]?.key_fingerprint);
  const material = parseSecret(rows.rows[0]?.decrypted_secret);
  if (!credentialId || !vaultSecretId || !fingerprint || !material) {
    return { ok: false, reason: "verification_credential_invalid" };
  }
  if (dedicatedSignerFingerprint(material.keyId, material.privateKey) !== fingerprint) {
    return { ok: false, reason: "verification_credential_fingerprint_mismatch" };
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
  credentials: StoredCredentialRef[],
  statuses: AccountCredentialStatus[],
  getJson: ((creds: { keyId: string; privateKey: string }, path: string, query?: string) => Promise<unknown>) | undefined,
): Promise<AccountSetupStatus> {
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
  let nextRequirement: AccountSetupNextRequirement | null = null;
  if (subaccount.exists === false) {
    nextRequirement = "create_subaccount_1";
  } else if (subaccount.exists === true && subaccount.exchangeIndex2Exists === true) {
    if (metadataVerified !== true) nextRequirement = metadataNextRequirement;
    else if (!readVerified) nextRequirement = "verify_restricted_execution_credential";
    else if (!executionAccountId) nextRequirement = "provision_execution_account";
  }
  const setupReason = !subaccount.ok || !subaccount.exists || !subaccount.exchangeIndex2Exists
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
    subaccountEvidence: subaccount.exists === null ? null : "kalshi_subaccount_balance_inventory",
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
    subaccountEvidence: null,
    restrictedKeyMetadataVerified: null,
    restrictedKeyReadVerified: false,
    executionAccountExists,
    setupReason: reason,
    nextRequirement: null,
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
      operation === "transfer_funds" || operation === "qualifying_order") return operation;
  return null;
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

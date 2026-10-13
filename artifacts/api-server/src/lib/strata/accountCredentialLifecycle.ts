import { randomUUID } from "node:crypto";
import {
  PRODUCTION_EXCHANGE_INDEX,
  PRODUCTION_SUBACCOUNT,
  dedicatedSignerFingerprint,
} from "./commissioning";
import {
  resolveAccountCommissioningContext,
  type AccountCommissioningContext,
  type AccountCommissioningPorts,
} from "./accountCommissioningContext";
import type { AccountSetupNextRequirement } from "./accountCredentialProbe";
import {
  knownCredentialRole,
  replaceOwnedCredentialInTransaction,
  type CredentialClient,
  type CredentialDatabase,
} from "./accountCredentialStore";

export const ACCOUNT_FUNDING_CONFIRMATION = "AUTHORIZE_ACCOUNT_FUNDING";
export const VERIFY_CREDENTIAL_CONFIRMATION = "VERIFY_ACCOUNT_CREDENTIAL";

export interface AccountCredentialStatus {
  role: string;
  fingerprint: string | null;
  verified: boolean;
  revoked: boolean;
  verificationReason: string | null;
}

export interface AccountCredentialRegistration {
  ok: boolean;
  reason: string;
  executable: false;
  role: string | null;
  fingerprint: string | null;
  vaultSecretId: string | null;
  subaccount1Exists?: boolean | null;
  subaccount1Exchange2Exists?: boolean | null;
  restrictedKeyMetadataVerified?: boolean | null;
  nextRequirement?: AccountSetupNextRequirement | null;
}

const CREATE_VAULT_SECRET_SQL = `
  -- account-credential:create-secret
  SELECT vault.create_secret($1, $2, $3) AS id
`;

const REVOKE_ROLE_SQL = `
  -- account-credential:revoke
  UPDATE private.kalshi_connection_credentials
  SET revoked_at = now(), updated_at = now()
  WHERE owner_user_id = $1::uuid
    AND provider_connection_id = $2::uuid
    AND role = $3
    AND revoked_at IS NULL
  RETURNING id::text AS id
`;

const LIST_ROLE_SQL = `
  -- account-credential:list
  SELECT role,
         key_fingerprint,
         verified_at,
         verification_reason,
         revoked_at
  FROM private.kalshi_connection_credentials
  WHERE owner_user_id = $1::uuid
    AND provider_connection_id = $2::uuid
  ORDER BY created_at
`;

const LOCK_ROLE_SQL = `
  -- account-credential:lock-role
  SELECT id::text AS id,
         vault_secret_id::text AS vault_secret_id,
         key_fingerprint
  FROM private.kalshi_connection_credentials
  WHERE owner_user_id = $1::uuid
    AND provider_connection_id = $2::uuid
    AND role = $3
    AND revoked_at IS NULL
  FOR UPDATE
`;

const VERIFY_RECORD_SQL = `
  -- account-credential:verify-record
  UPDATE private.kalshi_connection_credentials
  SET verified_at = now(),
      verification_reason = $5,
      updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND vault_secret_id = $3::uuid
    AND key_fingerprint = $4
    AND revoked_at IS NULL
  RETURNING id::text AS id
`;

export async function registerAccountCredential(
  db: CredentialDatabase,
  ports: AccountCommissioningPorts,
  input: {
    authenticatedUserId: string;
    role: string;
    apiKeyId: string;
    privateKey: string;
  },
): Promise<AccountCredentialRegistration> {
  if (!knownCredentialRole(input.role)) {
    return registration(false, "credential_role_rejected", input.role);
  }
  const fingerprint = dedicatedSignerFingerprint(input.apiKeyId, input.privateKey);
  if (!fingerprint) return registration(false, "credential_invalid", input.role);
  const resolved = await resolveAccountCommissioningContext(input.authenticatedUserId, ports, {
    owner_user_id: "ignored",
  });
  if (!resolved.ok) return registration(false, resolved.reason, input.role);
  const payload = JSON.stringify({
    api_key_id: input.apiKeyId.trim(),
    private_key: input.privateKey.trim(),
  });
  const name = `kalshi:${input.authenticatedUserId}:${input.role}:${randomUUID()}`;
  try {
    const stored = await db.transaction(async (client) => {
      const created = await client.query(CREATE_VAULT_SECRET_SQL, [payload, name, "kalshi-account-credential"]);
      const vaultSecretId = text(created.rows[0]?.id);
      if (!vaultSecretId) throw Object.assign(new Error("vault_secret_not_created"), { code: "23503" });
      const replaced = await replaceOwnedCredentialInTransaction(client, {
        authenticatedUserId: input.authenticatedUserId,
        providerConnectionId: resolved.context.providerConnectionId,
        role: input.role,
        vaultSecretId,
        keyFingerprint: fingerprint,
      });
      if (!replaced.ok) throw Object.assign(new Error(replaced.reason), { code: "23503" });
      return { vaultSecretId, fingerprint };
    });
    return {
      ok: true,
      reason: "credential_registered",
      executable: false,
      role: input.role,
      fingerprint: stored.fingerprint,
      vaultSecretId: stored.vaultSecretId,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "credential_binding_rejected";
    if (reason === "vault_secret_reused_from_provider_connection" || reason === "vault_secret_reused" ||
        reason === "credential_not_owned" || reason === "ambiguous_credential_role") {
      return registration(false, reason, input.role);
    }
    return registration(false, "credential_binding_rejected", input.role);
  }
}

export async function revokeAccountCredential(
  db: CredentialDatabase,
  ports: AccountCommissioningPorts,
  input: { authenticatedUserId: string; role: string },
): Promise<AccountCredentialRegistration> {
  if (!knownCredentialRole(input.role)) return registration(false, "credential_role_rejected", input.role);
  const resolved = await resolveAccountCommissioningContext(input.authenticatedUserId, ports);
  if (!resolved.ok) return registration(false, resolved.reason, input.role);
  const revoked = await db.query(REVOKE_ROLE_SQL, [
    input.authenticatedUserId,
    resolved.context.providerConnectionId,
    input.role,
  ]);
  if (revoked.rows.length !== 1) return registration(false, "credential_not_active", input.role);
  return registration(true, "credential_revoked", input.role);
}

export async function listAccountCredentialStatus(
  db: CredentialClient,
  ports: AccountCommissioningPorts,
  authenticatedUserId: string,
): Promise<{ ok: boolean; reason: string; executable: false; roles: AccountCredentialStatus[] }> {
  const resolved = await resolveAccountCommissioningContext(authenticatedUserId, ports);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, executable: false, roles: [] };
  const listed = await db.query(LIST_ROLE_SQL, [
    authenticatedUserId,
    resolved.context.providerConnectionId,
  ]);
  return {
    ok: true,
    reason: "credential_status",
    executable: false,
    roles: listed.rows.map((row) => ({
      role: String(row.role),
      fingerprint: text(row.key_fingerprint),
      verified: row.verified_at != null,
      revoked: row.revoked_at != null,
      verificationReason: text(row.verification_reason),
    })),
  };
}

export async function verifyAccountCredential(
  db: CredentialDatabase,
  ports: AccountCommissioningPorts,
  input: {
    authenticatedUserId: string;
    role: string;
    confirmation: unknown;
    readSecret: (vaultSecretId: string) => Promise<{ keyId: string; privateKey: string } | null>;
    probe: (
      material: { keyId: string; privateKey: string },
      context: AccountCommissioningContext,
    ) => Promise<{
      ok: boolean;
      reason: string;
      subaccount1Exists?: boolean | null;
      subaccount1Exchange2Exists?: boolean | null;
      restrictedKeyMetadataVerified?: boolean | null;
      nextRequirement?: AccountSetupNextRequirement | null;
    }>;
  },
): Promise<AccountCredentialRegistration> {
  if (input.confirmation !== VERIFY_CREDENTIAL_CONFIRMATION) {
    return registration(false, "explicit_authorization_required", input.role);
  }
  if (!knownCredentialRole(input.role)) return registration(false, "credential_role_rejected", input.role);
  const resolved = await resolveAccountCommissioningContext(input.authenticatedUserId, ports);
  if (!resolved.ok) return registration(false, resolved.reason, input.role);
  const locked = await db.query(LOCK_ROLE_SQL, [
    input.authenticatedUserId,
    resolved.context.providerConnectionId,
    input.role,
  ]);
  if (locked.rows.length !== 1) return registration(false, "missing_credential", input.role);
  const credentialId = text(locked.rows[0]?.id);
  const vaultSecretId = text(locked.rows[0]?.vault_secret_id);
  const fingerprint = text(locked.rows[0]?.key_fingerprint);
  if (!credentialId || !vaultSecretId || !fingerprint) {
    return registration(false, "credential_fingerprint_invalid", input.role);
  }
  const material = await input.readSecret(vaultSecretId);
  if (!material) return registration(false, "vault_secret_missing", input.role);
  if (dedicatedSignerFingerprint(material.keyId, material.privateKey) !== fingerprint) {
    return registration(false, "credential_fingerprint_mismatch", input.role);
  }
  const probed = await input.probe(material, resolved.context);
  const reason = sanitizeReason(probed.ok ? "credential_verified" : probed.reason);
  const details = {
    subaccount1Exists: probed.subaccount1Exists ?? null,
    subaccount1Exchange2Exists: probed.subaccount1Exchange2Exists ?? null,
    restrictedKeyMetadataVerified: probed.restrictedKeyMetadataVerified ?? null,
    nextRequirement: probed.nextRequirement ??
      (input.role === "restricted_execution" && probed.ok && !resolved.context.executionAccountId
        ? "provision_execution_account" as const
        : null),
  };
  if (!probed.ok) return { ...registration(false, reason, input.role), ...details };
  const marked = await db.query(VERIFY_RECORD_SQL, [
    credentialId,
    input.authenticatedUserId,
    vaultSecretId,
    fingerprint,
    reason,
  ]);
  if (marked.rows.length !== 1) return registration(false, "credential_rotated", input.role);
  return {
    ok: true,
    reason,
    executable: false,
    role: input.role,
    fingerprint,
    vaultSecretId: null,
    ...details,
  };
}

export function accountFundingAuthorization(input: {
  confirmation: unknown;
  authorizedMicros: string;
  liveExecutionEnabled?: string;
  v13ProductionExecutionEnabled?: string;
}): { ok: boolean; reason: string; authorizedMicros: string | null; transferAttempted: false } {
  if (input.confirmation !== ACCOUNT_FUNDING_CONFIRMATION) {
    return { ok: false, reason: "explicit_authorization_required", authorizedMicros: null, transferAttempted: false };
  }
  if (input.liveExecutionEnabled === "true" || input.v13ProductionExecutionEnabled === "true") {
    return { ok: false, reason: "funding_refused_while_execution_enabled", authorizedMicros: null, transferAttempted: false };
  }
  if (!/^[1-9]\d*$/.test(input.authorizedMicros)) {
    return { ok: false, reason: "funding_amount_invalid", authorizedMicros: null, transferAttempted: false };
  }
  return {
    ok: true,
    reason: "funding_authorized_not_transferred",
    authorizedMicros: input.authorizedMicros,
    transferAttempted: false,
  };
}

export function userCommissioningReadiness(input: {
  roles: AccountCredentialStatus[];
  authorizedMicros: string | null;
  evidenceMicros: string | null;
  subaccount: number | null;
  exchangeIndex: number | null;
  policyOwned: boolean;
  evidenceSource?: string | null;
}): { ready: boolean; executable: false; blockers: string[] } {
  const blockers: string[] = [];
  const active = input.roles.filter((role) => !role.revoked);
  if (!active.some((role) => role.role === "restricted_execution" && role.verified)) {
    blockers.push("restricted_execution_unverified");
  }
  if (input.subaccount !== null && input.subaccount !== PRODUCTION_SUBACCOUNT) blockers.push("account_target_pair_mismatch");
  if (input.exchangeIndex !== null && input.exchangeIndex !== PRODUCTION_EXCHANGE_INDEX) blockers.push("account_target_pair_mismatch");
  if (!input.authorizedMicros) blockers.push("account_funding_not_authorized");
  else if (input.evidenceMicros !== input.authorizedMicros) blockers.push("account_funding_evidence_mismatch");
  else if (input.evidenceSource === "kalshi_transfer") blockers.push("account_funding_transfer_unproven");
  if (!input.policyOwned) blockers.push("policy_not_owned");
  return { ready: blockers.length === 0, executable: false, blockers };
}

function registration(ok: boolean, reason: string, role: string | null): AccountCredentialRegistration {
  return { ok, reason, executable: false, role, fingerprint: null, vaultSecretId: null };
}

function sanitizeReason(reason: string): string {
  const clean = reason.replace(/[^\w.-]/g, "_").slice(0, 80);
  return clean || "credential_verification_failed";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

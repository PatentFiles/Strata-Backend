import { emptySnapshot, type CommissioningSnapshot } from "./commissioning";
import {
  AccountCommissioningRefusal,
  KNOWN_CREDENTIAL_ROLES,
  type AccountCommissioningPorts,
  type ExecutionTarget,
  type KnownCredentialRole,
  type OwnedKalshiConnection,
  type StoredCredentialRef,
} from "./accountCommissioningContext";

export interface CredentialQuery {
  query(text: string, params?: unknown[]): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount?: number | null;
  }>;
}

const FINGERPRINT = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LIST_CONNECTIONS_SQL = `
  SELECT fa.user_id::text AS authenticated_user_id,
         fa.id::text AS financial_account_id,
         pc.id::text AS provider_connection_id
  FROM public.financial_accounts fa
  JOIN private.provider_connections pc ON pc.financial_account_id = fa.id
  WHERE fa.user_id = $1::uuid AND fa.provider = 'kalshi'
`;

const LIST_CREDENTIALS_SQL = `
  SELECT c.role,
         c.provider_connection_id::text AS provider_connection_id,
         c.vault_secret_id::text AS vault_secret_id,
         c.key_fingerprint
  FROM private.kalshi_connection_credentials c
  JOIN private.provider_connections pc ON pc.id = c.provider_connection_id
  JOIN public.financial_accounts fa
    ON fa.id = pc.financial_account_id AND fa.id = c.financial_account_id
  WHERE fa.user_id = $1::uuid
    AND c.owner_user_id = $1::uuid
    AND c.provider_connection_id = $2::uuid
    AND c.revoked_at IS NULL
`;

const EXECUTION_TARGET_SQL = `
  SELECT a.id AS execution_account_id,
         a.owner_user_id::text AS owner_user_id,
         pc.id::text AS provider_connection_id,
         a.subaccount,
         a.exchange_index,
         a.commissioned,
         a.execution_enabled,
         a.kill_switch,
         a.key_fingerprint
  FROM v13_production_account a
  JOIN public.financial_accounts fa
    ON fa.id = a.kalshi_connection_id AND fa.user_id = a.owner_user_id
  JOIN private.provider_connections pc ON pc.financial_account_id = fa.id
  WHERE a.owner_user_id = $1::uuid
    AND pc.id = $2::uuid
`;

const BINDING_PRECHECK_SQL = `
  SELECT fa.user_id::text AS owner_user_id,
         fa.id::text AS financial_account_id,
         pc.id::text AS provider_connection_id,
         pc.vault_secret_id::text AS connection_vault_secret_id,
         (
           SELECT count(*)::int
           FROM private.kalshi_connection_credentials active
           WHERE active.provider_connection_id = pc.id
             AND active.owner_user_id = fa.user_id
             AND active.role = $3
             AND active.revoked_at IS NULL
         ) AS active_count,
         EXISTS (
           SELECT 1 FROM private.kalshi_connection_credentials used
           WHERE used.vault_secret_id = $4::uuid
         ) AS vault_secret_used
  FROM public.financial_accounts fa
  JOIN private.provider_connections pc ON pc.financial_account_id = fa.id
  WHERE fa.user_id = $1::uuid
    AND fa.provider = 'kalshi'
    AND pc.id = $2::uuid
`;

const REPLACE_BINDING_SQL = `
  WITH owned AS (
    SELECT fa.user_id, fa.id AS financial_account_id, pc.id AS provider_connection_id
    FROM public.financial_accounts fa
    JOIN private.provider_connections pc ON pc.financial_account_id = fa.id
    WHERE fa.user_id = $1::uuid
      AND fa.provider = 'kalshi'
      AND pc.id = $2::uuid
      AND pc.vault_secret_id <> $4::uuid
  ),
  revoked AS (
    UPDATE private.kalshi_connection_credentials c
    SET revoked_at = now(), updated_at = now()
    FROM owned
    WHERE c.provider_connection_id = owned.provider_connection_id
      AND c.owner_user_id = owned.user_id
      AND c.financial_account_id = owned.financial_account_id
      AND c.role = $3
      AND c.revoked_at IS NULL
    RETURNING c.id
  ),
  inserted AS (
    INSERT INTO private.kalshi_connection_credentials (
      owner_user_id, financial_account_id, provider_connection_id, role,
      vault_secret_id, key_fingerprint, verified_at, verification_reason
    )
    SELECT owned.user_id, owned.financial_account_id, owned.provider_connection_id,
           $3, $4::uuid, $5, NULL, NULL
    FROM owned
    RETURNING id
  ),
  linked AS (
    UPDATE private.kalshi_connection_credentials old
    SET replaced_by = inserted.id, updated_at = now()
    FROM revoked, inserted
    WHERE old.id = revoked.id
    RETURNING old.id
  )
  SELECT inserted.id::text AS credential_id
  FROM inserted
`;

export function createDatabaseAccountCommissioningPorts(
  db: CredentialQuery,
  now = () => new Date().toISOString(),
): AccountCommissioningPorts {
  return {
    listOwnedConnections(authenticatedUserId) {
      return listOwnedConnections(db, authenticatedUserId);
    },
    listCredentialRefs(authenticatedUserId, providerConnectionId) {
      return listCredentialRefs(db, authenticatedUserId, providerConnectionId);
    },
    readExecutionTarget(authenticatedUserId, providerConnectionId) {
      return readExecutionTarget(db, authenticatedUserId, providerConnectionId);
    },
    readSnapshot(authenticatedUserId, providerConnectionId) {
      return readAccountSnapshot(db, authenticatedUserId, providerConnectionId, now());
    },
    openCredential() {
      return Promise.reject(new AccountCommissioningRefusal("operation_not_enabled"));
    },
  };
}

export async function listOwnedConnections(
  db: CredentialQuery,
  authenticatedUserId: string,
): Promise<OwnedKalshiConnection[]> {
  const result = await db.query(LIST_CONNECTIONS_SQL, [authenticatedUserId]);
  return result.rows.map((row) => ({
    authenticatedUserId: requiredText(row.authenticated_user_id, "foreign_connection"),
    financialAccountId: requiredText(row.financial_account_id, "foreign_connection"),
    providerConnectionId: requiredText(row.provider_connection_id, "foreign_connection"),
  })).filter((row) => row.authenticatedUserId === authenticatedUserId);
}

export async function listCredentialRefs(
  db: CredentialQuery,
  authenticatedUserId: string,
  providerConnectionId: string,
): Promise<StoredCredentialRef[]> {
  const result = await db.query(LIST_CREDENTIALS_SQL, [authenticatedUserId, providerConnectionId]);
  return result.rows.map((row) => {
    const fingerprint = text(row.key_fingerprint);
    if (fingerprint !== null && !FINGERPRINT.test(fingerprint)) {
      throw new AccountCommissioningRefusal("credential_fingerprint_invalid");
    }
    const role = requiredText(row.role, "foreign_credential");
    if (!(KNOWN_CREDENTIAL_ROLES as readonly string[]).includes(role)) {
      throw new AccountCommissioningRefusal("credential_role_rejected");
    }
    return {
      role,
      providerConnectionId: requiredText(row.provider_connection_id, "foreign_credential"),
      vaultSecretId: requiredText(row.vault_secret_id, "foreign_credential"),
      keyFingerprint: fingerprint,
      source: "vault_connection" as const,
    };
  });
}

export async function readExecutionTarget(
  db: CredentialQuery,
  authenticatedUserId: string,
  providerConnectionId: string,
): Promise<ExecutionTarget | null> {
  const result = await db.query(EXECUTION_TARGET_SQL, [authenticatedUserId, providerConnectionId]);
  if (result.rows.length === 0) return null;
  if (result.rows.length > 1) throw new AccountCommissioningRefusal("ambiguous_execution_account");
  const row = result.rows[0] ?? {};
  return {
    ownerUserId: requiredText(row.owner_user_id, "foreign_execution_account"),
    providerConnectionId: requiredText(row.provider_connection_id, "foreign_execution_account"),
    executionAccountId: text(row.execution_account_id),
    subaccount: integer(row.subaccount),
    exchangeIndex: integer(row.exchange_index),
  };
}

export async function readAccountSnapshot(
  db: CredentialQuery,
  authenticatedUserId: string,
  providerConnectionId: string,
  asOf: string,
): Promise<CommissioningSnapshot> {
  const snapshot = emptySnapshot(asOf);
  const result = await db.query(EXECUTION_TARGET_SQL, [authenticatedUserId, providerConnectionId]);
  if (result.rows.length !== 1) return snapshot;
  const row = result.rows[0] ?? {};
  snapshot.account = {
    count: 1,
    id: text(row.execution_account_id),
    subaccount: integer(row.subaccount),
    exchangeIndex: integer(row.exchange_index),
    fingerprint: text(row.key_fingerprint),
    commissioned: flag(row.commissioned),
    executionEnabled: flag(row.execution_enabled),
    killSwitch: flag(row.kill_switch),
  };
  snapshot.transportReady = false;
  snapshot.workerRunning = false;
  return snapshot;
}

export async function replaceOwnedCredentialBinding(
  db: CredentialQuery,
  input: {
    authenticatedUserId: string;
    providerConnectionId: string;
    role: string;
    vaultSecretId: string;
    keyFingerprint: string | null;
  },
): Promise<{ ok: true; credentialId: string } | { ok: false; reason: string }> {
  if (!(KNOWN_CREDENTIAL_ROLES as readonly string[]).includes(input.role)) {
    return { ok: false, reason: "credential_role_rejected" };
  }
  if (!UUID.test(input.vaultSecretId)) return { ok: false, reason: "vault_secret_invalid" };
  if (input.keyFingerprint !== null && !FINGERPRINT.test(input.keyFingerprint)) {
    return { ok: false, reason: "credential_fingerprint_invalid" };
  }
  const precheck = await db.query(BINDING_PRECHECK_SQL, [
    input.authenticatedUserId,
    input.providerConnectionId,
    input.role,
    input.vaultSecretId,
  ]);
  if (precheck.rows.length === 0) return { ok: false, reason: "credential_not_owned" };
  if (precheck.rows.length > 1) return { ok: false, reason: "owned_connection_ambiguous" };
  const row = precheck.rows[0] ?? {};
  if (text(row.owner_user_id) !== input.authenticatedUserId) {
    return { ok: false, reason: "credential_not_owned" };
  }
  if (text(row.connection_vault_secret_id) === input.vaultSecretId) {
    return { ok: false, reason: "vault_secret_reused_from_provider_connection" };
  }
  if (row.vault_secret_used === true || row.vault_secret_used === "t") {
    return { ok: false, reason: "vault_secret_reused" };
  }
  const activeCount = integer(row.active_count) ?? 0;
  if (activeCount > 1) return { ok: false, reason: "ambiguous_credential_role" };
  try {
    const replaced = await db.query(REPLACE_BINDING_SQL, [
      input.authenticatedUserId,
      input.providerConnectionId,
      input.role,
      input.vaultSecretId,
      input.keyFingerprint,
    ]);
    const credentialId = text(replaced.rows[0]?.credential_id);
    if (!credentialId) return { ok: false, reason: "credential_binding_rejected" };
    return { ok: true, credentialId };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "23505") return { ok: false, reason: "ambiguous_credential_role" };
    if (code === "23514") return { ok: false, reason: "vault_secret_reused_from_provider_connection" };
    if (code === "23503") return { ok: false, reason: "credential_binding_rejected" };
    throw error;
  }
}

export function knownCredentialRole(role: string): role is KnownCredentialRole {
  return (KNOWN_CREDENTIAL_ROLES as readonly string[]).includes(role);
}

function requiredText(value: unknown, reason: string): string {
  const parsed = text(value);
  if (!parsed) throw new AccountCommissioningRefusal(reason);
  return parsed;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  return null;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function flag(value: unknown): boolean | null {
  if (value === true || value === "t" || value === "true") return true;
  if (value === false || value === "f" || value === "false") return false;
  return null;
}

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

export interface CredentialClient {
  query(text: string, params?: unknown[]): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount?: number | null;
  }>;
}

/** Reads may use a pool. Replacement requires a transaction around one connection. */
export interface CredentialDatabase extends CredentialClient {
  transaction<T>(work: (client: CredentialClient) => Promise<T>): Promise<T>;
}

export interface PgClientLike extends CredentialClient {
  release(error?: unknown): void;
}

/** The same shape as node-postgres Pool.connect/query. */
export interface PgPoolLike extends CredentialClient {
  connect(): Promise<PgClientLike>;
}

export function credentialDatabaseFromPool(pool: PgPoolLike): CredentialDatabase {
  return {
    query: (text, params) => pool.query(text, params),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* the failed statement already aborted the transaction */
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
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

const LOCK_OWNED_CONNECTION_SQL = `
  -- credential-replacement:lock-connection
  SELECT pc.id::text AS provider_connection_id,
         fa.id::text AS financial_account_id,
         fa.user_id::text AS owner_user_id,
         pc.vault_secret_id::text AS connection_vault_secret_id
  FROM private.provider_connections pc
  JOIN public.financial_accounts fa ON fa.id = pc.financial_account_id
  WHERE fa.user_id = $1::uuid
    AND fa.provider = 'kalshi'
    AND pc.id = $2::uuid
  FOR UPDATE OF pc
`;

const VAULT_SECRET_USED_SQL = `
  -- credential-replacement:vault-used
  SELECT id::text AS id
  FROM private.kalshi_connection_credentials
  WHERE vault_secret_id = $1::uuid
  LIMIT 1
`;

const LOCK_ACTIVE_BINDING_SQL = `
  -- credential-replacement:lock-active
  SELECT id::text AS id
  FROM private.kalshi_connection_credentials
  WHERE provider_connection_id = $1::uuid
    AND owner_user_id = $2::uuid
    AND financial_account_id = $3::uuid
    AND role = $4
    AND revoked_at IS NULL
  FOR UPDATE
`;

const OWNED_EXECUTION_ACCOUNT_SQL = `
  -- credential-replacement:execution-account
  SELECT id
  FROM v13_production_account
  WHERE owner_user_id = $1::uuid
    AND kalshi_connection_id = $2::uuid
  LIMIT 1
`;

const REVOKE_ACTIVE_BINDING_SQL = `
  -- credential-replacement:revoke
  UPDATE private.kalshi_connection_credentials
  SET revoked_at = now(), updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $2::uuid
    AND provider_connection_id = $3::uuid
    AND financial_account_id = $4::uuid
    AND role = $5
    AND revoked_at IS NULL
  RETURNING id::text AS id
`;

const INSERT_BINDING_SQL = `
  -- credential-replacement:insert
  INSERT INTO private.kalshi_connection_credentials (
    owner_user_id, financial_account_id, provider_connection_id, role,
    vault_secret_id, key_fingerprint, verified_at, verification_reason
  ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, NULL, NULL)
  RETURNING id::text AS credential_id
`;

const LINK_REPLACED_BINDING_SQL = `
  -- credential-replacement:link
  UPDATE private.kalshi_connection_credentials
  SET replaced_by = $2::uuid, updated_at = now()
  WHERE id = $1::uuid
    AND owner_user_id = $3::uuid
    AND provider_connection_id = $4::uuid
    AND revoked_at IS NOT NULL
    AND replaced_by IS NULL
  RETURNING id::text AS id
`;

export function createDatabaseAccountCommissioningPorts(
  db: CredentialClient,
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
  db: CredentialClient,
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
  db: CredentialClient,
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
  db: CredentialClient,
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
    keyFingerprint: text(row.key_fingerprint),
  };
}

export async function readAccountSnapshot(
  db: CredentialClient,
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
  db: CredentialDatabase,
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
  try {
    return await db.transaction((client) => replaceOwnedCredentialInTransaction(client, input));
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "23505") return { ok: false, reason: "ambiguous_credential_role" };
    if (code === "23514") return { ok: false, reason: "vault_secret_reused_from_provider_connection" };
    if (code === "23503") return { ok: false, reason: "credential_binding_rejected" };
    throw error;
  }
}

export async function replaceOwnedCredentialInTransaction(
  client: CredentialClient,
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
  return replaceCredentialInTransaction(client, input);
}

async function replaceCredentialInTransaction(
  client: CredentialClient,
  input: {
    authenticatedUserId: string;
    providerConnectionId: string;
    role: string;
    vaultSecretId: string;
    keyFingerprint: string | null;
  },
): Promise<{ ok: true; credentialId: string } | { ok: false; reason: string }> {
  const locked = await client.query(LOCK_OWNED_CONNECTION_SQL, [
    input.authenticatedUserId,
    input.providerConnectionId,
  ]);
  if (locked.rows.length === 0) return { ok: false, reason: "credential_not_owned" };
  if (locked.rows.length > 1) return { ok: false, reason: "owned_connection_ambiguous" };
  const owned = locked.rows[0] ?? {};
  if (text(owned.owner_user_id) !== input.authenticatedUserId ||
      text(owned.provider_connection_id) !== input.providerConnectionId) {
    return { ok: false, reason: "credential_not_owned" };
  }
  const financialAccountId = requiredText(owned.financial_account_id, "credential_not_owned");
  if (input.role === "restricted_execution") {
    const executionAccount = await client.query(OWNED_EXECUTION_ACCOUNT_SQL, [
      input.authenticatedUserId,
      financialAccountId,
    ]);
    if (executionAccount.rows.length > 0) {
      return { ok: false, reason: "restricted_execution_rebinding_required" };
    }
  }
  if (text(owned.connection_vault_secret_id) === input.vaultSecretId) {
    return { ok: false, reason: "vault_secret_reused_from_provider_connection" };
  }
  const used = await client.query(VAULT_SECRET_USED_SQL, [input.vaultSecretId]);
  if (used.rows.length > 0) return { ok: false, reason: "vault_secret_reused" };
  const active = await client.query(LOCK_ACTIVE_BINDING_SQL, [
    input.providerConnectionId,
    input.authenticatedUserId,
    financialAccountId,
    input.role,
  ]);
  if (active.rows.length > 1) return { ok: false, reason: "ambiguous_credential_role" };
  const previousId = text(active.rows[0]?.id);
  if (previousId) {
    const revoked = await client.query(REVOKE_ACTIVE_BINDING_SQL, [
      previousId,
      input.authenticatedUserId,
      input.providerConnectionId,
      financialAccountId,
      input.role,
    ]);
    if (revoked.rows.length !== 1) throw bindingRejected("credential_binding_rejected");
  }
  const inserted = await client.query(INSERT_BINDING_SQL, [
    input.authenticatedUserId,
    financialAccountId,
    input.providerConnectionId,
    input.role,
    input.vaultSecretId,
    input.keyFingerprint,
  ]);
  const credentialId = text(inserted.rows[0]?.credential_id);
  if (!credentialId) throw bindingRejected("credential_binding_rejected");
  if (previousId) {
    const linked = await client.query(LINK_REPLACED_BINDING_SQL, [
      previousId,
      credentialId,
      input.authenticatedUserId,
      input.providerConnectionId,
    ]);
    if (linked.rows.length !== 1) throw bindingRejected("credential_binding_rejected");
  }
  return { ok: true, credentialId };
}

function bindingRejected(reason: string): Error & { code: string } {
  const error = new Error(reason) as Error & { code: string };
  error.code = "23503";
  return error;
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

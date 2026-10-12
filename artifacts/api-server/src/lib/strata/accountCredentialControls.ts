import { emptyUserExecutionView } from "./userExecutionScope";
import type { UserScopeQuery } from "./userScopeDatabase";
import { resolveAccountCommissioningContext } from "./accountCommissioningContext";
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
} from "./accountCredentialLifecycle";
import { operateAccountWorker, SAFETY_EXPOSURE_SQL, SCOPED_POLICY_SQL } from "./accountScopedExecution";

const CREDENTIAL_TABLE_SQL = `
  SELECT to_regclass('private.kalshi_connection_credentials') AS name
`;
const LEASE_TABLE_SQL = `
  SELECT to_regclass('private.kalshi_account_worker_lease') AS name
`;

export function accountCredentialControls(db: UserScopeQuery) {
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
      return verifyAccountCredential(database, ports(), {
        authenticatedUserId: userId,
        role,
        confirmation: body && typeof body === "object" ? (body as Record<string, unknown>).confirmation : null,
        async readSecret() { return null; },
        async probe() { return { ok: false, reason: "verification_transport_not_enabled" }; },
      });
    },
    async commissioningStatus(userId: string) {
      if (!await credentialTablesReady(db)) {
        return { ready: false as const, executable: false as const, blockers: ["credential_migration_missing"] };
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
      const readiness = userCommissioningReadiness({
        roles: status.roles,
        authorizedMicros: null,
        evidenceMicros: null,
        subaccount: resolved.ok ? resolved.context.subaccount : null,
        exchangeIndex: resolved.ok ? resolved.context.exchangeIndex : null,
        policyOwned,
      });
      if (!resolved.ok) readiness.blockers.unshift(resolved.reason);
      return readiness;
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

function roleOf(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const role = (body as Record<string, unknown>).role;
  return typeof role === "string" ? role : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

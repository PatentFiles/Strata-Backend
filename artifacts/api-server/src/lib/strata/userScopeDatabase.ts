import { randomUUID } from "node:crypto";
import { getScopedKalshiJson, KalshiApiError } from "../kalshiAccountClient";
import { classifyDiagnosticRead, readQualificationDiagnostics, type QualificationDiagnostic } from "./qualificationDiagnostics";
import {
  assembleKalshiUserRead,
  BOT_EXCHANGE_INDEX,
  BOT_SUBACCOUNT,
  emptyKalshiUserRead,
  normalizeKalshiMoney,
  type KalshiUserRead,
} from "./kalshiUserRead";
import { presetFieldError, type PolicyDraft, type SharedPreset } from "./sharedPresets";
import {
  changeConfiguredStake,
  emptyUserExecutionView,
  policyAuthorityChange,
  type ControlAction,
  type ScopedAccount,
  type UserExecutionView,
} from "./userExecutionScope";
import type { UserScopePort } from "../../routes/userExecutionRouter";
import { accountCredentialControls } from "./accountCredentialControls";
import {
  createLiveQualificationTransport,
  createSqlQualificationGuard,
  qualifyAdvancedApi,
  type QualificationGuard,
  type QualificationResult,
  type QualificationTransport,
} from "./qualifyAdvancedApi";

export interface UserScopeQuery {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

const MIGRATION_SQL = `
  SELECT (
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'v13_production_account' AND column_name = 'owner_user_id'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'v13_shared_preset'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'private' AND table_name = 'provider_connections' AND column_name = 'bot_eligible'
    )
  ) AS ready
`;

const ACCOUNT_SQL = `
  SELECT a.id, a.owner_user_id, a.kalshi_connection_id, a.subaccount, a.exchange_index,
         a.commissioned, a.execution_enabled, a.kill_switch,
         a.cash_micros::text AS cash_micros, a.reserved_micros::text AS reserved_micros,
         a.minimum_exit_micros, a.reconciled_at,
         p.state AS policy_state, p.version AS policy_version, p.max_entry_stake_cents,
         s.configured_stake_cents, s.revision AS stake_revision
  FROM v13_production_account a
  LEFT JOIN v13_live_money_policy p ON p.id = a.policy_id
  LEFT JOIN strata_configured_stake s ON s.execution_account_id = a.id
  WHERE a.owner_user_id = $1::uuid
`;

const CONNECTION_SQL = `
  SELECT fa.id::text AS financial_account_id, pc.id::text AS provider_connection_id,
         pc.vault_secret_id::text AS vault_secret_id, pc.key_fingerprint, pc.verified_at
  FROM public.financial_accounts fa
  LEFT JOIN private.provider_connections pc ON pc.financial_account_id = fa.id
  WHERE fa.user_id = $1::uuid AND fa.provider = 'kalshi'
`;

const VAULT_SQL = `
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE id = $1::uuid
`;

function text(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
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

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function microsToCents(value: unknown): number | null {
  const raw = text(value);
  if (raw === null || !/^-?\d+$/.test(raw)) return null;
  const micros = BigInt(raw);
  if (micros % 10000n !== 0n) return null;
  const cents = micros / 10000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < -BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

function rowsOf(payload: unknown, keys: string[]): unknown[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  return [];
}

function presetFrom(row: Record<string, unknown>): SharedPreset | null {
  const id = text(row.id);
  const creator = text(row.creator_user_id);
  const name = text(row.name);
  if (!id || !creator || !name) return null;
  return {
    id,
    name,
    description: text(row.description) ?? "",
    creatorUserId: creator,
    creatorDisplayName: text(row.creator_display_name),
    capitalLimitCents: integer(row.capital_limit_cents) ?? 0,
    maxEntryStakeCents: integer(row.max_entry_stake_cents) ?? 0,
    maxEntryAllInCents: integer(row.max_entry_all_in_cents) ?? 0,
    maxDailyLossCents: integer(row.max_daily_loss_cents) ?? 0,
    maxTotalLossCents: integer(row.max_total_loss_cents) ?? 0,
    maxQuoteAgeMs: integer(row.max_quote_age_ms) ?? 0,
    maxFeeEvidenceAgeMs: integer(row.max_fee_evidence_age_ms) ?? 0,
    minimumExitMicros: integer(row.minimum_exit_micros) ?? 0,
    revision: integer(row.revision) ?? 1,
    createdAt: text(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: text(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function accountFrom(userId: string, row: Record<string, unknown>): ScopedAccount | null {
  const id = text(row.id);
  const owner = text(row.owner_user_id);
  if (!id || owner !== userId) return null;
  const cash = microsToCents(row.cash_micros);
  const reserved = microsToCents(row.reserved_micros);
  return {
    id,
    ownerUserId: owner,
    connectionId: text(row.kalshi_connection_id),
    subaccount: integer(row.subaccount) ?? BOT_SUBACCOUNT,
    exchangeIndex: integer(row.exchange_index) ?? BOT_EXCHANGE_INDEX,
    commissioned: flag(row.commissioned),
    executionEnabled: flag(row.execution_enabled),
    killSwitch: row.kill_switch === null || row.kill_switch === undefined ? true : flag(row.kill_switch),
    cashCents: cash,
    reservedCents: reserved,
    capitalRemainingCents: cash !== null && reserved !== null ? cash - reserved : null,
    configuredStakeCents: integer(row.configured_stake_cents),
    stakeRevision: integer(row.stake_revision),
    approvedMaxEntryStakeCents: text(row.policy_state) === "APPROVED" ? integer(row.max_entry_stake_cents) : null,
    policyApproved: text(row.policy_state) === "APPROVED",
    policyVersion: integer(row.policy_version),
    workerRunning: false,
    openPositionCount: 0,
    preparedIntentCount: 0,
    dispatchedIntentCount: 0,
    unknownIntentCount: 0,
    unresolvedOrderCount: 0,
    realizedDailyLossCents: 0,
    realizedTotalLossCents: 0,
    realizedPnlCents: null,
    minimumExitApproved: (integer(row.minimum_exit_micros) ?? 0) > 0,
    primaryCashCents: null,
    primaryPortfolioValueCents: null,
    portfolioValueCents: null,
    positions: [],
    orders: [],
    fills: [],
    settlements: [],
    reconciledAt: text(row.reconciled_at),
    commissioningState: flag(row.commissioned) ? "commissioned" : "uncommissioned",
  };
}

function viewFrom(userId: string, account: ScopedAccount | null): UserExecutionView {
  const view = emptyUserExecutionView(userId);
  if (!account || account.ownerUserId !== userId) return view;
  return {
    ...view,
    executionAccountExists: true,
    botCashCents: account.cashCents,
    reservedBotCashCents: account.reservedCents,
    capitalRemainingCents: account.capitalRemainingCents,
    configuredStakeCents: account.configuredStakeCents,
    stakeRevision: account.stakeRevision,
    approvedMaxEntryStakeCents: account.approvedMaxEntryStakeCents,
    policyApproved: account.policyApproved,
    policyVersion: account.policyVersion,
    workerRunning: false,
    armed: account.executionEnabled === true && account.killSwitch === false,
    killSwitch: account.killSwitch,
    commissioningState: account.commissioningState,
    reconciledAt: account.reconciledAt,
    realizedDailyLossCents: 0,
    realizedTotalLossCents: 0,
    minimumExitApproved: account.minimumExitApproved,
  };
}

function unverified(reason: string): KalshiUserRead {
  return { ...emptyKalshiUserRead(), verificationReason: reason };
}

function primaryFailureReason(error: unknown): string {
  if (error instanceof KalshiApiError) {
    if (error.type === "HTTP_ERROR" && error.status === 401) return "PRIMARY_BALANCE_HTTP_401";
    if (error.type === "HTTP_ERROR" && error.status === 403) return "PRIMARY_BALANCE_HTTP_403";
    if (error.type === "INVALID_CREDENTIALS") return "PRIMARY_BALANCE_AUTH_FAILED";
    return "PRIMARY_BALANCE_INVALID_RESPONSE";
  }
  return "PRIMARY_BALANCE_AUTH_FAILED";
}

function balanceRecord(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const nested = (payload as Record<string, unknown>).balance;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  return payload;
}

function parseVaultSecret(secret: unknown): { keyId: string; privateKey: string } | null {
  const raw = typeof secret === "string" ? secret : null;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const keyId = parsed.api_key_id;
    const privateKey = parsed.private_key;
    if (typeof keyId !== "string" || typeof privateKey !== "string" || !keyId || !privateKey) return null;
    return { keyId, privateKey };
  } catch {
    return null;
  }
}

/** Database-backed scope. Missing migration fails closed and never reads the unassigned account. */
export function createDatabaseUserScopePort(
  db: UserScopeQuery,
  options: {
    kalshiGet?: (creds: { keyId: string; privateKey: string }, path: string, query?: string) => Promise<unknown>;
    qualifyTransport?: QualificationTransport;
    qualificationGuard?: QualificationGuard;
  } = {},
): UserScopePort {
  const kalshiGet = options.kalshiGet ?? ((creds, path, query) => getScopedKalshiJson(creds, path, query ?? ""));
  const qualifyTransport = options.qualifyTransport ?? createLiveQualificationTransport();
  const qualificationGuard = options.qualificationGuard ?? createSqlQualificationGuard(db);
  const loadKalshiConnection = async (userId: string): Promise<
    { creds: { keyId: string; privateKey: string }; connectionId: string } | QualificationResult
  > => {
    let connection: { rows: Array<Record<string, unknown>> };
    try {
      connection = await db.query(CONNECTION_SQL, [userId]);
    } catch {
      return { status: "NO_PROVIDER_CONNECTION" };
    }
    if (connection.rows.length === 0) return { status: "NO_FINANCIAL_ACCOUNT" };
    const linked = connection.rows.filter((row) => text(row.vault_secret_id));
    if (linked.length !== 1) return { status: "NO_PROVIDER_CONNECTION" };
    const connectionId = text(linked[0]?.provider_connection_id);
    const vaultId = text(linked[0]?.vault_secret_id);
    if (!connectionId || !vaultId) return { status: "NO_PROVIDER_CONNECTION" };
    let secretRow: { rows: Array<Record<string, unknown>> };
    try {
      secretRow = await db.query(VAULT_SQL, [vaultId]);
    } catch {
      return { status: "VAULT_SECRET_MISSING" };
    }
    if (secretRow.rows.length !== 1 || secretRow.rows[0]?.decrypted_secret == null) return { status: "VAULT_SECRET_MISSING" };
    const creds = parseVaultSecret(secretRow.rows[0]?.decrypted_secret);
    if (!creds) return { status: "VAULT_SECRET_FORMAT_INVALID" };
    return { creds, connectionId };
  };
  let ready = false;
  const migrationReady = async () => {
    if (ready) return true;
    try {
      const result = await db.query(MIGRATION_SQL);
      ready = result.rows[0]?.ready === true;
    } catch {
      ready = false;
    }
    return ready;
  };
  const ownedAccount = async (userId: string): Promise<ScopedAccount | null> => {
    const result = await db.query(ACCOUNT_SQL, [userId]);
    if (result.rows.length !== 1) return null;
    return accountFrom(userId, result.rows[0]!);
  };
  const refused = (userId: string, reason: string, account: ScopedAccount | null = null) => ({
    ok: false as const,
    reason,
    view: viewFrom(userId, account),
  });

  return {
    migrationReady,
    async settings(userId) {
      if (!await migrationReady()) return emptyUserExecutionView(userId);
      return viewFrom(userId, await ownedAccount(userId));
    },
    async wallet(userId) {
      let connection: { rows: Array<Record<string, unknown>> };
      try {
        connection = await db.query(CONNECTION_SQL, [userId]);
      } catch {
        return unverified("NO_PROVIDER_CONNECTION");
      }
      if (connection.rows.length === 0) return unverified("NO_FINANCIAL_ACCOUNT");
      const linked = connection.rows.filter((row) => text(row.vault_secret_id));
      if (linked.length !== 1) return unverified("NO_PROVIDER_CONNECTION");
      const vaultId = text(linked[0]?.vault_secret_id);
      if (!vaultId) return unverified("NO_PROVIDER_CONNECTION");
      let secretRow: { rows: Array<Record<string, unknown>> };
      try {
        secretRow = await db.query(VAULT_SQL, [vaultId]);
      } catch {
        return unverified("VAULT_SECRET_MISSING");
      }
      if (secretRow.rows.length !== 1 || secretRow.rows[0]?.decrypted_secret == null) {
        return unverified("VAULT_SECRET_MISSING");
      }
      const creds = parseVaultSecret(secretRow.rows[0]?.decrypted_secret);
      if (!creds) return unverified("VAULT_SECRET_FORMAT_INVALID");
      const read = async (path: string, query = "") => kalshiGet(creds, path, query);
      const settled = async (path: string, query = "") => {
        try {
          return await read(path, query);
        } catch {
          return null;
        }
      };
      const botQuery = `?subaccount=${BOT_SUBACCOUNT}&exchange_index=${BOT_EXCHANGE_INDEX}`;
      const activityQuery = `?limit=200&subaccount=${BOT_SUBACCOUNT}`;
      const primaryOutcome = await read("/trade-api/v2/portfolio/balance").then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (!primaryOutcome.ok) return unverified(primaryFailureReason(primaryOutcome.error));
      const primary = balanceRecord(primaryOutcome.value);
      const money = normalizeKalshiMoney(primary);
      if (money.cashCents === null && money.portfolioValueCents === null) {
        return unverified("PRIMARY_BALANCE_INVALID_RESPONSE");
      }
      const [limits, bot, positions, orders, fills, settlements, transfers] = await Promise.all([
        settled("/trade-api/v2/account/limits"),
        settled("/trade-api/v2/portfolio/balance", botQuery),
        settled("/trade-api/v2/portfolio/positions", activityQuery),
        settled("/trade-api/v2/portfolio/orders", activityQuery),
        settled("/trade-api/v2/portfolio/fills", activityQuery),
        settled("/trade-api/v2/portfolio/settlements", activityQuery),
        settled("/trade-api/v2/portfolio/subaccounts/transfers", activityQuery),
      ]);
      const assembled = assembleKalshiUserRead({
        credentialVerified: true,
        limits: limits ?? {},
        numberedSubaccountAvailable: bot !== null,
        primary,
        botSubaccount: bot,
        activity: {
          positions: rowsOf(positions, ["market_positions", "positions"]),
          orders: rowsOf(orders, ["orders"]),
          fills: rowsOf(fills, ["fills"]),
          settlements: rowsOf(settlements, ["settlements"]),
          subaccountTransfers: rowsOf(transfers, ["transfers"]),
        },
      });
      assembled.primary = money;
      if (limits === null) {
        assembled.apiUsageTier = null;
        assembled.botEligible = false;
        assembled.botEligibilityReason = "API_TIER_UNAVAILABLE";
        assembled.verificationReason = "API_TIER_UNAVAILABLE";
      }
      if (assembled.apiUsageTier === null) assembled.botEligible = false;
      return assembled;
    },
    async control(userId, action: ControlAction) {
      if (!await migrationReady()) return refused(userId, "user_scope_not_migrated");
      const account = await ownedAccount(userId);
      if (!account?.commissioned) return refused(userId, "user_execution_account_not_commissioned", account);
      void action;
      return refused(userId, "user_execution_signer_not_provisioned", account);
    },
    ...accountCredentialControls(db, { kalshiGet }),
    async stake(userId, cents, revision) {
      if (!await migrationReady()) return refused(userId, "user_scope_not_migrated");
      const account = await ownedAccount(userId);
      if (!account) return refused(userId, "execution_account_missing");
      const change = changeConfiguredStake(userId, account, cents);
      if (!change.ok) return refused(userId, change.reason, account);
      if (revision !== null && revision !== account.stakeRevision) return refused(userId, "stake_revision_conflict", account);
      const updated = await db.query(
        `UPDATE strata_configured_stake
         SET configured_stake_cents = $1, revision = revision + 1, updated_at = now()
         WHERE execution_account_id = $2 AND ($3::int IS NULL OR revision = $3)
           AND execution_account_id IN (
             SELECT id FROM v13_production_account WHERE owner_user_id = $4::uuid
           )`,
        [change.cents, account.id, revision, userId],
      );
      if ((updated.rowCount ?? 0) !== 1) return refused(userId, "stake_not_updated", account);
      return { ok: true, view: viewFrom(userId, { ...account, configuredStakeCents: change.cents }) };
    },
    async presets(userId) {
      if (!await migrationReady()) return [];
      void userId;
      const result = await db.query("SELECT * FROM v13_shared_preset ORDER BY created_at");
      return result.rows.flatMap((row) => {
        const preset = presetFrom(row);
        return preset ? [preset] : [];
      });
    },
    async savePreset(userId, body) {
      if (!await migrationReady()) return { ok: false, reason: "user_scope_not_migrated" };
      if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "preset_invalid" };
      const input = { ...(body as Record<string, unknown>) };
      delete input.owner_user_id;
      delete input.target_user_id;
      delete input.creator_user_id;
      const error = presetFieldError(input);
      if (error) return { ok: false, reason: error };
      const id = randomUUID();
      const inserted = await db.query(
        `INSERT INTO v13_shared_preset (
           id, name, description, creator_user_id, creator_display_name,
           capital_limit_cents, max_entry_stake_cents, max_entry_all_in_cents,
           max_daily_loss_cents, max_total_loss_cents, max_quote_age_ms,
           max_fee_evidence_age_ms, minimum_exit_micros
         ) VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          id, input.name, input.description ?? "", userId, input.creatorDisplayName ?? null,
          input.capitalLimitCents, input.maxEntryStakeCents, input.maxEntryAllInCents,
          input.maxDailyLossCents, input.maxTotalLossCents, input.maxQuoteAgeMs,
          input.maxFeeEvidenceAgeMs, input.minimumExitMicros,
        ],
      );
      const preset = presetFrom(inserted.rows[0] ?? {});
      return preset ? { ok: true, preset } : { ok: false, reason: "preset_not_stored" };
    },
    async updatePreset(userId, presetId, body) {
      if (!await migrationReady()) return { ok: false, reason: "user_scope_not_migrated" };
      if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "preset_invalid" };
      const input = { ...(body as Record<string, unknown>) };
      delete input.owner_user_id;
      delete input.target_user_id;
      delete input.creator_user_id;
      const error = presetFieldError(input);
      if (error) return { ok: false, reason: error };
      const updated = await db.query(
        `UPDATE v13_shared_preset SET
           name = $3, description = $4, capital_limit_cents = $5, max_entry_stake_cents = $6,
           max_entry_all_in_cents = $7, max_daily_loss_cents = $8, max_total_loss_cents = $9,
           max_quote_age_ms = $10, max_fee_evidence_age_ms = $11, minimum_exit_micros = $12,
           revision = revision + 1, updated_at = now()
         WHERE id = $1 AND creator_user_id = $2::uuid
         RETURNING *`,
        [
          presetId, userId, input.name, input.description ?? "",
          input.capitalLimitCents, input.maxEntryStakeCents, input.maxEntryAllInCents,
          input.maxDailyLossCents, input.maxTotalLossCents, input.maxQuoteAgeMs,
          input.maxFeeEvidenceAgeMs, input.minimumExitMicros,
        ],
      );
      const preset = presetFrom(updated.rows[0] ?? {});
      return preset ? { ok: true, preset } : { ok: false, reason: "not_preset_creator" };
    },
    async deletePreset(userId, presetId) {
      if (!await migrationReady()) return { ok: false, reason: "user_scope_not_migrated" };
      const deleted = await db.query(
        "DELETE FROM v13_shared_preset WHERE id = $1 AND creator_user_id = $2::uuid",
        [presetId, userId],
      );
      return (deleted.rowCount ?? 0) === 1 ? { ok: true } : { ok: false, reason: "not_preset_creator" };
    },
    async applyPreset(userId, presetId) {
      if (!await migrationReady()) return refused(userId, "user_scope_not_migrated");
      const account = await ownedAccount(userId);
      if (!account) return refused(userId, "execution_account_missing");
      const found = await db.query("SELECT * FROM v13_shared_preset WHERE id = $1", [presetId]);
      const preset = found.rows[0] ? presetFrom(found.rows[0]) : null;
      if (!preset) return refused(userId, "preset_not_found", account);
      const change = policyAuthorityChange(userId, account, preset);
      if (!change.ok) return refused(userId, change.reason, account);
      const version = await db.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM v13_live_money_policy WHERE execution_account_id = $1`,
        [account.id],
      );
      const draft: PolicyDraft = change.draft;
      await db.query(
        `INSERT INTO v13_live_money_policy (
           id, version, state, execution_account_id, created_by,
           capital_limit_cents, max_entry_stake_cents, max_entry_all_in_cents,
           max_open_positions, max_daily_loss_cents, max_total_loss_cents,
           max_quote_age_ms, max_fee_evidence_age_ms
         ) VALUES ($1,$2,'DRAFT',$3,$4,$5,$6,$7,1,$8,$9,$10,$11)`,
        [
          randomUUID(), integer(version.rows[0]?.next_version) ?? 1, account.id, userId,
          draft.capitalLimitCents, draft.maxEntryStakeCents, draft.maxEntryAllInCents,
          draft.maxDailyLossCents, draft.maxTotalLossCents, draft.maxQuoteAgeMs, draft.maxFeeEvidenceAgeMs,
        ],
      );
      return { ok: true, draft, view: viewFrom(userId, account) };
    },
    async qualify(userId, body): Promise<QualificationResult> {
      const confirm = body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).confirm
        : undefined;
      const loaded = await loadKalshiConnection(userId);
      if (!("creds" in loaded)) return loaded;
      try {
        return await qualifyAdvancedApi({
          creds: loaded.creds,
          connectionId: loaded.connectionId,
          confirm,
          guard: qualificationGuard,
          transport: qualifyTransport,
        });
      } catch {
        return { status: "QUALIFICATION_GUARD_UNAVAILABLE" };
      }
    },
    async diagnose(userId): Promise<QualificationDiagnostic> {
      let connection: { rows: Array<Record<string, unknown>> };
      try {
        connection = await db.query(CONNECTION_SQL, [userId]);
      } catch {
        return readQualificationDiagnostics({ guard: null });
      }
      if (connection.rows.length === 0) return { ...await readQualificationDiagnostics({ guard: null }), status: "NO_FINANCIAL_ACCOUNT" };
      const linked = connection.rows.filter((row) => text(row.vault_secret_id));
      const connectionId = text(linked[0]?.provider_connection_id);
      if (linked.length !== 1 || !connectionId) return { ...await readQualificationDiagnostics({ guard: null }), status: "NO_PROVIDER_CONNECTION" };
      let guard;
      try {
        guard = await qualificationGuard.read(connectionId);
      } catch {
        return { ...await readQualificationDiagnostics({ guard: null }), status: "QUALIFICATION_GUARD_UNAVAILABLE" };
      }
      let creds: { keyId: string; privateKey: string } | null = null;
      try {
        const secretRow = await db.query(VAULT_SQL, [text(linked[0]?.vault_secret_id)]);
        creds = secretRow.rows.length === 1 ? parseVaultSecret(secretRow.rows[0]?.decrypted_secret) : null;
      } catch {
        creds = null;
      }
      if (!creds) return readQualificationDiagnostics({ guard });
      return readQualificationDiagnostics({
        guard,
        get: async (path, query) => {
          try {
            return { outcome: "OK", body: await kalshiGet(creds, path, query) };
          } catch (error) {
            if (error instanceof KalshiApiError && error.type === "INVALID_JSON") return { outcome: "UNREADABLE" };
            if (error instanceof KalshiApiError && error.type === "HTTP_ERROR") {
              return { outcome: classifyDiagnosticRead(error.status ?? 0, false) };
            }
            return { outcome: "UNCERTAIN" };
          }
        },
      });
    },
  };
}

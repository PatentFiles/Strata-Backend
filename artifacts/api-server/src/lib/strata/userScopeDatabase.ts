import { randomUUID } from "node:crypto";
import {
  createScopedKalshiSubaccountOne,
  generateScopedKalshiSubaccountOneKey,
  getScopedKalshiJson,
  KalshiApiError,
} from "../kalshiAccountClient";
import type { SubaccountCreationTransport } from "./accountSubaccountCreation";
import type { RestrictedKeyGenerationTransport } from "./accountRestrictedKeyGeneration";
import { classifyDiagnosticRead, readQualificationDiagnostics, type QualificationDiagnostic } from "./qualificationDiagnostics";
import {
  assembleKalshiUserRead,
  BOT_EXCHANGE_INDEX,
  BOT_SUBACCOUNT,
  emptyKalshiUserRead,
  normalizeKalshiMoney,
  type KalshiUserRead,
} from "./kalshiUserRead";
import { presetFieldError, scaleSharedRiskPreset, STANDARD_PROPORTIONAL_PRESET, STANDARD_PROPORTIONAL_PRESET_ID, TEST_TWENTY_PERCENT_PRESET, TEST_TWENTY_PERCENT_PRESET_ID, type PolicyDraft, type SharedPreset } from "./sharedPresets";
import {
  changeConfiguredStake,
  stakeEditBlockers,
  emptyUserExecutionView,
  policyAuthorityChange,
  type ControlAction,
  type ScopedAccount,
  type UserExecutionView,
} from "./userExecutionScope";
import type { UserScopePort } from "../../routes/userExecutionRouter";
import { readOwnerFundingMaintenanceReadiness } from "./ownerFundingMaintenanceReadiness";
import {ownerTopupStatus,prepareOwnerTopup,executeOwnerTopup,reconcileOwnerTopup,cancelPreparedOwnerTopup} from "./ownerVariableTopup";
import { accountCredentialControls } from "./accountCredentialControls";
import type { PersonalSessionControl } from "./personalExecutionSupervisor";
import {
  approveOwnedPolicyForUser,
  readOwnedApprovedFeeEvidence,
  commissionOwnedAccount,
  enableOwnedAccountExecution,
  enableSharedLiveInfrastructure,
  reconcileOwnedSubaccountCash,
  reportOwnedActivation,
  requestOwnedAccountActivation,
} from "./personalAccountActivation";
import { createOwnedPolicyDraft, type OwnedPolicyLimits } from "./personalPolicyApproval";
import { amendOwnedStakePolicy, MIN_OWNER_STAKE_CENTS } from "./ownerStakePolicyAmendment";
import type { StrictPresetSelection } from "./strictPresetStake";
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

const CAN_MANAGE_SHARED_PRESETS_SQL = `
  SELECT 1 FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  JOIN private.role_assignments ra ON lower(ra.email) = lower(u.email)
  WHERE p.id = $1::uuid AND p.role = 'ADMIN' AND ra.role = 'ADMIN'
`;

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
         s.configured_stake_cents, s.revision AS stake_revision,
         s.risk_preset_id, s.risk_preset_revision, s.risk_capital_cents
  FROM v13_production_account a
  LEFT JOIN v13_live_money_policy p ON p.id = a.policy_id
  LEFT JOIN strata_configured_stake s ON s.execution_account_id = a.id
  WHERE a.owner_user_id = $1::uuid
`;

const CONNECTION_SQL = `
  SELECT fa.id::text AS financial_account_id, pc.id::text AS provider_connection_id,
         COALESCE(vc.vault_secret_id,pc.vault_secret_id)::text AS vault_secret_id,
         COALESCE(vc.key_fingerprint,pc.key_fingerprint) AS key_fingerprint,
         COALESCE(vc.verified_at,pc.verified_at) AS verified_at
  FROM public.financial_accounts fa
  LEFT JOIN private.provider_connections pc ON pc.financial_account_id = fa.id
  LEFT JOIN LATERAL (
    SELECT c.vault_secret_id,c.key_fingerprint,c.verified_at
    FROM private.kalshi_connection_credentials c
    WHERE c.owner_user_id = fa.user_id
      AND c.financial_account_id = fa.id
      AND c.provider_connection_id = pc.id
      AND c.role = 'account_setup_execution'
      AND c.revoked_at IS NULL
      AND c.verified_at IS NOT NULL
      AND c.verification_reason = 'credential_verified'
    ORDER BY c.verified_at DESC LIMIT 1
  ) vc ON true
  WHERE fa.user_id = $1::uuid AND fa.provider = 'kalshi'
`;

const VAULT_SQL = `
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE id = $1::uuid
`;
const STAKE_EXPOSURE_SQL = `
  -- account-stake:exposure
  SELECT
    (SELECT count(*)::int FROM v13_production_position p
      WHERE p.account_id = a.id AND p.quantity_hundredths > 0) AS open_positions,
    (SELECT count(*)::int FROM v13_production_intent i
      WHERE i.account_id = a.id AND i.state = 'PREPARED') AS prepared,
    (SELECT count(*)::int FROM v13_production_intent i
      WHERE i.account_id = a.id AND i.state = 'DISPATCHED') AS dispatched,
    (SELECT count(*)::int FROM v13_production_intent i
      WHERE i.account_id = a.id AND i.state = 'UNKNOWN') AS unknown,
    (SELECT count(*)::int FROM v13_production_intent i
      WHERE i.account_id = a.id AND i.state NOT IN ('TERMINAL','BLOCKED')) AS unresolved,
    (SELECT count(*)::int FROM private.kalshi_account_worker_lease l
      WHERE l.execution_account_id = a.id AND l.state = 'owned' AND l.heartbeat_at > now()-interval '30 seconds') AS running
  FROM v13_production_account a
  WHERE a.id = $1 AND a.owner_user_id = $2::uuid
`;
export const UPSERT_STAKE_SQL = `
  -- account-stake:upsert
  INSERT INTO strata_configured_stake (
    id, execution_account_id, configured_stake_cents, revision, updated_at
  )
  SELECT a.id, a.id, $1::int, CASE WHEN $3::int IS NULL THEN 1 ELSE $3::int + 1 END, now()
  FROM v13_production_account a
  WHERE a.id = $2
    AND a.owner_user_id = $4::uuid
    AND a.owner_user_id IS NOT NULL
    AND $1::int BETWEEN 150 AND 2500000
    AND a.cash_micros >= a.reserved_micros + ($1::bigint * 10000)
    AND a.reconciled_at IS NOT NULL
    AND ($3::int IS NULL OR EXISTS (
      SELECT 1 FROM strata_configured_stake existing
      WHERE existing.execution_account_id = a.id
    ))
  ON CONFLICT (execution_account_id) WHERE execution_account_id IS NOT NULL
  DO UPDATE SET
    configured_stake_cents = EXCLUDED.configured_stake_cents,
    revision = strata_configured_stake.revision + 1,
    updated_at = now()
  WHERE $3::int IS NOT NULL
    AND strata_configured_stake.revision = $3::int
    AND strata_configured_stake.execution_account_id IN (
      SELECT id FROM v13_production_account WHERE owner_user_id = $4::uuid
    )
  RETURNING revision
`;
const RESTRICTED_SIGNER_SQL = `
  -- account-control:restricted-signer
  SELECT c.key_fingerprint
  FROM private.kalshi_connection_credentials c
  JOIN v13_production_account a
    ON a.owner_user_id = c.owner_user_id
   AND a.kalshi_connection_id = c.financial_account_id
   AND a.key_fingerprint = c.key_fingerprint
  WHERE c.owner_user_id = $1::uuid
    AND a.id = $2
    AND c.role = 'restricted_execution'
    AND c.revoked_at IS NULL
    AND c.verified_at IS NOT NULL
    AND c.verification_reason = 'credential_verified'
    AND a.subaccount = 1
    AND a.exchange_index = 2
`;
const GLOBAL_SAFETY_SQL = `
  -- account-control:global-safety
  SELECT live_execution_enabled, manual_kill_switch
  FROM live_execution_config
  WHERE id = 'singleton'
`;
const KILL_OWNED_ACCOUNT_SQL = `
  -- account-control:kill
  UPDATE v13_production_account
  SET kill_switch = true, execution_enabled = false
  WHERE id = $1
    AND owner_user_id = $2::uuid
    AND owner_user_id IS NOT NULL
  RETURNING id
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
    riskPresetId: text(row.risk_preset_id),
    riskPresetRevision: integer(row.risk_preset_revision),
    riskCapitalCents: integer(row.risk_capital_cents),
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
    riskPresetId: account.riskPresetId ?? null,
    riskPresetRevision: account.riskPresetRevision ?? null,
    riskCapitalCents: account.riskCapitalCents ?? null,
    approvedMaxEntryStakeCents: account.approvedMaxEntryStakeCents,
    policyApproved: account.policyApproved,
    policyVersion: account.policyVersion,
    workerRunning: account.workerRunning === true,
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
    kalshiCreateSubaccount?: SubaccountCreationTransport;
    kalshiGenerateRestrictedKey?: RestrictedKeyGenerationTransport;
    qualifyTransport?: QualificationTransport;
    qualificationGuard?: QualificationGuard;
    session?: PersonalSessionControl;
  } = {},
): UserScopePort {
  const kalshiGet = options.kalshiGet ?? ((creds, path, query) => getScopedKalshiJson(creds, path, query ?? ""));
  const kalshiCreateSubaccount = options.kalshiCreateSubaccount ??
    ((creds) => createScopedKalshiSubaccountOne(creds));
  const kalshiGenerateRestrictedKey = options.kalshiGenerateRestrictedKey ??
    ((creds) => generateScopedKalshiSubaccountOneKey(creds));
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
      const account = await ownedAccount(userId);
      if (account && options.session?.isScheduled(userId, account.id) === true) account.workerRunning = true;
      return viewFrom(userId, account);
    },
    async ownerTopupStatus(userId){return ownerTopupStatus(db as never,userId);},
    async prepareOwnerTopup(userId,amountCents){return prepareOwnerTopup(db as never,userId,amountCents);},
    async executeOwnerTopup(userId,body){return executeOwnerTopup(db as never,userId,body);},
    async reconcileOwnerTopup(userId){return reconcileOwnerTopup(db as never,userId);},
    async cancelOwnerTopup(userId,confirmation){return cancelPreparedOwnerTopup(db as never,userId,confirmation);},
    async botTopupReadiness(userId) {
      // Read-only maintenance status for THIS owner. Never submits transfers.
      return readOwnerFundingMaintenanceReadiness(db,userId);
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
      // A deposit may settle into another exchange index of the PRIMARY wallet.
      // Kalshi's balance endpoint aggregates ALL exchange indexes when the
      // exchange_index query is omitted. This is still subaccount 0 only;
      // bot execution funds are read separately from subaccount 1/index 2.
      const primaryOutcome = await read("/trade-api/v2/portfolio/balance", "?subaccount=0").then(
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
      if (!account) return refused(userId, "execution_account_missing");
      if (!account.commissioned) return refused(userId, "user_execution_account_not_commissioned", account);
      // Human STOP/DISARM/KILL overrides any previously scheduled automatic
      // restart. Never let the withdrawal worker undo a deliberate stop.
      if (process.env.STRATA_AUTOMATIC_WITHDRAWALS_ENABLED === "true" &&
          (action === "STOP" || action === "DISARM" || action === "KILL")) {
        await db.query(
          "UPDATE private.strata_auto_withdrawal_maintenance SET operator_interrupted=true,last_reason='manual_stop_or_kill',changed_at=now() WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND state NOT IN ('completed','blocked')",
          [userId,account.id],
        ).catch(()=>null);
      }
      if (action === "KILL") {
        try {
          const killed = await db.query(KILL_OWNED_ACCOUNT_SQL, [account.id, userId]);
          if ((killed.rowCount ?? killed.rows.length) !== 1) {
            return refused(userId, "account_kill_not_recorded", account);
          }
        } catch {
          return refused(userId, "account_kill_not_recorded", account);
        }
        await options.session?.stop({ userId, accountId: account.id, action: "KILL" });
        const killedAccount = { ...account, killSwitch: true, executionEnabled: false, workerRunning: false };
        if (options.session?.isScheduled(userId, account.id) === true) {
          return refused(userId, "worker_still_scheduled", { ...killedAccount, workerRunning: true });
        }
        return {
          ok: true as const,
          reason: "account_killed",
          // KILL halts ALL automated transport, including protective SELLs.
          // It is not exchange liquidation or evidence of a flat position.
          exchangeFlatVerified: false as const,
          protectiveExitState: "MANUAL_EXCHANGE_RECONCILIATION_REQUIRED" as const,
          view: viewFrom(userId, killedAccount),
        };
      }
      let signer: { rows: Array<Record<string, unknown>> };
      try {
        signer = await db.query(RESTRICTED_SIGNER_SQL, [userId, account.id]);
      } catch {
        return refused(userId, "user_execution_signer_not_provisioned", account);
      }
      if (signer.rows.length !== 1) {
        return refused(userId, "user_execution_signer_not_provisioned", account);
      }
      if (action === "STOP" || action === "DISARM") {
        const stopped = options.session
          ? await options.session.stop({ userId, accountId: account.id, action: "STOP" })
          : { workerStopped: true };
        if (!stopped.workerStopped) {
          return refused(userId, "worker_still_scheduled", account);
        }
        return {
          ok: true as const,
          reason: "entries_stopped",
          // STOP is the safe entry-only pause: an exposure-bearing worker may
          // remain scheduled to reconcile and dispatch its reviewed exit path.
          // Neither branch claims the exchange position is flat.
          exchangeFlatVerified: false as const,
          protectiveExitState: stopped.managingExposure === true
            ? "MANAGING_EXISTING_EXPOSURE" as const : "EXCHANGE_RECONCILIATION_REQUIRED" as const,
          view: viewFrom(userId, { ...account, workerRunning: stopped.managingExposure === true }),
        };
      }
      if (action !== "START" && action !== "ARM") {
        return refused(userId, "control_action_rejected", account);
      }
      // A durable maintenance hold fences START/ARM independently of the
      // withdrawal quote ledger. It remains active throughout STOP and
      // protective-exit drain, not only after an exchange POST is attempted.
      if (process.env.STRATA_AUTOMATIC_WITHDRAWALS_ENABLED === "true") {
        try {
          const holds=await db.query(
            "SELECT state FROM private.strata_auto_withdrawal_maintenance WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND state <> 'completed' LIMIT 1",
            [userId,account.id],
          );
          if(holds.rows.length)return refused(userId,"automatic_withdrawal_maintenance_active",account);
        }catch{return refused(userId,"automatic_maintenance_safety_unavailable",account);}
      }
      // Do not arm or start while a cash withdrawal is quoted or unreconciled.
      // The legacy trading flow is unchanged while the feature is disabled.
      if (process.env.STRATA_MANUAL_WITHDRAWALS_ENABLED === "true") {
        try {
          const withdrawals = await db.query(
            "SELECT id FROM private.strata_manual_profit_withdrawals WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND state IN ('prepared','attempted','pending','uncertain') LIMIT 1",
            [userId, account.id],
          );
          if (withdrawals.rows.length > 0) return refused(userId, "withdrawal_in_progress", account);
        } catch {
          return refused(userId, "withdrawal_safety_unavailable", account);
        }
      }
      if (account.killSwitch) return refused(userId, "account_kill_switch", account);
      let safety: { rows: Array<Record<string, unknown>> };
      try {
        safety = await db.query(GLOBAL_SAFETY_SQL);
      } catch {
        return refused(userId, "global_kill_switch", account);
      }
      const gate = safety.rows[0];
      const killOff = gate?.manual_kill_switch === false || gate?.manual_kill_switch === "f" || gate?.manual_kill_switch === "false";
      if (safety.rows.length !== 1 || !killOff) {
        return refused(userId, "global_kill_switch", account);
      }
      if (!account.policyApproved) return refused(userId, "policy_not_approved", account);
      if (account.configuredStakeCents === null) return refused(userId, "configured_stake_missing", account);
      if (!account.reconciledAt) return refused(userId, "cash_not_reconciled", account);
      if (!flag(gate?.live_execution_enabled)) {
        return refused(userId, "live_execution_not_enabled", account);
      }
      if (!account.executionEnabled) {
        return refused(userId, "execution_not_enabled", account);
      }
      if (!options.session) return refused(userId, "worker_not_scheduled", account);
      if (action === "ARM") {
        // ARM is an authorization/readiness state, never a worker lifecycle
        // action. The previously shared START path could place orders on ARM.
        // Do not persist a forged approval or clear a kill switch here.
        return {
          ok: true as const,
          reason: "account_armed_ready_for_start",
          view: viewFrom(userId, {
            ...account,
            workerRunning: options.session?.isScheduled(userId, account.id) === true,
          }),
        };
      }
      const scheduled = await options.session.start({ userId, accountId: account.id, action });
      if (!scheduled.workerStarted || options.session.isScheduled(userId, account.id) !== true) {
        return refused(userId, scheduled.reason || "worker_not_scheduled", account);
      }
      return {
        ok: true as const,
        reason: "worker_scheduled",
        view: viewFrom(userId, { ...account, workerRunning: true }),
      };
    },
    ...accountCredentialControls(db, {
      kalshiGet,
      kalshiCreateSubaccount,
      kalshiGenerateRestrictedKey,
      session: options.session,
    }),
    async stake(userId, cents, revision, policyConfirmation, presetSelection) {
      if (!await migrationReady()) return refused(userId, "user_scope_not_migrated");
      const account = await ownedAccount(userId);
      if (!account) return refused(userId, "execution_account_missing");
      let exposure: { rows: Array<Record<string, unknown>> };
      try {
        exposure = await db.query(STAKE_EXPOSURE_SQL, [account.id, userId]);
      } catch {
        return refused(userId, "stake_exposure_unproven", account);
      }
      const counts = exposure.rows[0];
      const openPositionCount = integer(counts?.open_positions);
      const preparedIntentCount = integer(counts?.prepared);
      const dispatchedIntentCount = integer(counts?.dispatched);
      const unknownIntentCount = integer(counts?.unknown);
      const unresolvedOrderCount = integer(counts?.unresolved);
      const running = integer(counts?.running);
      if (exposure.rows.length !== 1 || openPositionCount === null || preparedIntentCount === null ||
          dispatchedIntentCount === null || unknownIntentCount === null ||
          unresolvedOrderCount === null || running === null) {
        return refused(userId, "stake_exposure_unproven", account);
      }
      const scoped = {
        ...account,
        workerRunning: running > 0,
        openPositionCount,
        preparedIntentCount,
        dispatchedIntentCount,
        unknownIntentCount,
        unresolvedOrderCount,
      };
      // A stake is the owner's maximum entry cash exposure, never authority
      // to spend more than the bot subaccount can cover. The SQL write repeats
      // the balance check so stale browser state cannot authorize an over-stake.
      if (!Number.isSafeInteger(cents) || cents < MIN_OWNER_STAKE_CENTS) {
        return refused(userId, "stake_below_minimum_150_cents", scoped);
      }
      if (cents > 2_500_000) return refused(userId, "above_hard_stake_ceiling", scoped);
      if (scoped.capitalRemainingCents === null) return refused(userId, "available_cash_unverified", scoped);
      if (cents > scoped.capitalRemainingCents) return refused(userId, "stake_exceeds_available_cash", scoped);
      if (!presetSelection && cents > (scoped.approvedMaxEntryStakeCents ?? 0)) {
        return refused(userId,"select_approved_proportional_preset_before_increasing_stake",scoped);
      }
      const editBlockers = stakeEditBlockers(scoped);
      if (editBlockers.length) return refused(userId, editBlockers[0]!, scoped);

      // Production always updates stake and any necessary policy revision in
      // ONE serializable transaction. This also updates the owner activation
      // digest after an ordinary decrease, avoiding stale Step-12 authority.
      // Test ports without a transactional connection retain the conservative
      // SQL upsert adapter and can never raise a production policy.
      const transactionalDb = db as UserScopeQuery & {
        connect?: () => Promise<{query:UserScopeQuery["query"];release():void}>;
      };
      if (transactionalDb.connect) {
        const amended = await amendOwnedStakePolicy(
          {connect:transactionalDb.connect.bind(transactionalDb)},userId,account.id,cents,revision,policyConfirmation,
          presetSelection as StrictPresetSelection | undefined,
        );
        if (!amended.ok) return refused(userId, amended.reason, scoped);
        const refreshed = await ownedAccount(userId);
        return refreshed
          ? {ok:true as const,view:viewFrom(userId,refreshed)}
          : refused(userId,"stake_transaction_refresh_unavailable",scoped);
      }
      if (scoped.approvedMaxEntryStakeCents !== null && cents > scoped.approvedMaxEntryStakeCents)
        return refused(userId,"stake_policy_transaction_unavailable",scoped);

      const change = changeConfiguredStake(userId, scoped, cents);
      if (!change.ok) return refused(userId, change.reason, scoped);
      if (account.stakeRevision === null ? revision !== null : revision !== account.stakeRevision) {
        return refused(userId, "stake_revision_conflict", account);
      }
      let updated: { rows: Array<Record<string, unknown>>; rowCount?: number | null };
      try {
        updated = await db.query(UPSERT_STAKE_SQL, [change.cents, account.id, revision, userId]);
      } catch {
        return refused(userId, "stake_not_updated", account);
      }
      const nextRevision = integer(updated.rows[0]?.revision);
      if ((updated.rowCount ?? updated.rows.length) !== 1 || nextRevision === null) {
        return refused(userId, account.stakeRevision === null ? "stake_not_initialized" : "stake_revision_conflict", account);
      }
      return {
        ok: true,
        view: viewFrom(userId, {
          ...scoped,
          configuredStakeCents: change.cents,
          stakeRevision: nextRevision,
          workerRunning: false,
        }),
      };
    },
    async presets(userId) {
      if (!await migrationReady()) return [];
      void userId;
      const result = await db.query("SELECT * FROM v13_shared_preset ORDER BY created_at");
      return [
        STANDARD_PROPORTIONAL_PRESET,
        TEST_TWENTY_PERCENT_PRESET,
        ...result.rows.flatMap((row) => {
          const preset = presetFrom(row);
          return preset ? [preset] : [];
        }),
      ];
    },
    async savePreset(userId, body) {
      if (!await migrationReady()) return { ok: false, reason: "user_scope_not_migrated" };
      const auth = await db.query(CAN_MANAGE_SHARED_PRESETS_SQL, [userId]);
      if (auth.rows.length !== 1) return { ok: false, reason: "admin_required_to_manage_shared_presets" };
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
      const auth = await db.query(CAN_MANAGE_SHARED_PRESETS_SQL, [userId]);
      if (auth.rows.length !== 1) return { ok: false, reason: "admin_required_to_manage_shared_presets" };
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
      const auth = await db.query(CAN_MANAGE_SHARED_PRESETS_SQL, [userId]);
      if (auth.rows.length !== 1) return { ok: false, reason: "admin_required_to_manage_shared_presets" };
      const deleted = await db.query(
        "DELETE FROM v13_shared_preset WHERE id = $1 AND creator_user_id = $2::uuid",
        [presetId, userId],
      );
      return (deleted.rowCount ?? 0) === 1 ? { ok: true } : { ok: false, reason: "not_preset_creator" };
    },
    async previewPreset(userId, body) {
      if (!await migrationReady()) return { ok: false, reason: "user_scope_not_migrated" };
      if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "preset_preview_invalid" };
      const fields = body as Record<string, unknown>;
      if (typeof fields.presetId !== "string" || typeof fields.capitalLimitCents !== "number") {
        return { ok: false, reason: "preset_preview_invalid" };
      }
      void userId; // Authenticated route; previews never mutate an owner account.
      let preset: SharedPreset | null;
      if (fields.presetId === STANDARD_PROPORTIONAL_PRESET_ID) {
        preset = STANDARD_PROPORTIONAL_PRESET;
      } else if (fields.presetId === TEST_TWENTY_PERCENT_PRESET_ID) {
        preset = TEST_TWENTY_PERCENT_PRESET;
      } else {
        const found = await db.query("SELECT * FROM v13_shared_preset WHERE id = $1", [fields.presetId]);
        preset = found.rows[0] ? presetFrom(found.rows[0]) : null;
      }
      if (!preset) return { ok: false, reason: "preset_not_found" };
      const scaled = scaleSharedRiskPreset(preset, fields.capitalLimitCents);
      if (!scaled.ok) return scaled;
      return {
        presetId: preset.id, presetRevision: preset.revision,
        referenceCapitalCents: preset.capitalLimitCents,
        ...scaled,
        approved: false as const, liveEnabled: false as const,
      };
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
    async personalReadiness(userId) {
      return reportOwnedActivation(db, userId);
    },
    async approvedPolicyFeeEvidence(userId) {
      return readOwnedApprovedFeeEvidence(db, userId);
    },
    async approvePolicy(userId, body) {
      const account = await ownedAccount(userId);
      if (!account) return { ok: false, reason: "execution_account_missing" };
      const connect = (db as { connect?: () => Promise<{ query: UserScopeQuery["query"]; release(): void }> }).connect;
      return approveOwnedPolicyForUser({
        query: (text, params) => db.query(text, params),
        connect: connect ? () => connect.call(db) : undefined,
      }, {
        ownerUserId: userId,
        executionAccountId: account.id,
        body,
      });
    },
    async reconcileCash(userId, body) {
      const confirmation = body && typeof body === "object" ? (body as Record<string, unknown>).confirmation : null;
      return reconcileOwnedSubaccountCash(db, {
        ownerUserId: userId,
        confirmation,
        nowMs: Date.now(),
        get: options.kalshiGet,
      });
    },
    async commissionAccount(userId, body) {
      const fields = body && typeof body === "object" ? body as Record<string, unknown> : {};
      return commissionOwnedAccount(db, {
        ownerUserId: userId,
        confirmation: fields.confirmation,
        feeArtifactDigest: fields.feeArtifactDigest,
        minimumExitMicros: fields.minimumExitMicros,
      });
    },
    async draftPolicy(userId, body) {
      const account = await ownedAccount(userId);
      if (!account) return { ok: false as const, reason: "execution_account_missing" };
      const fields = body && typeof body === "object" ? body as Record<string, unknown> : {};
      return createOwnedPolicyDraft(db, {
        ownerUserId: userId,
        executionAccountId: account.id,
        limits: fields.limits as OwnedPolicyLimits | null,
      });
    },
    async requestActivation(userId, body) {
      const confirmation = body && typeof body === "object" ? (body as Record<string, unknown>).confirmation : null;
      return requestOwnedAccountActivation(db, { ownerUserId: userId, confirmation });
    },
    async enableOwnedExecution(body) {
      const fields = body && typeof body === "object" ? body as Record<string, unknown> : {};
      return enableOwnedAccountExecution(db, {
        executionAccountId: fields.executionAccountId,
        confirmation: fields.confirmation,
      });
    },
    async enableSharedLive(body) {
      const confirmation = body && typeof body === "object" ? (body as Record<string, unknown>).confirmation : null;
      return enableSharedLiveInfrastructure(db, { confirmation });
    },
  };
}

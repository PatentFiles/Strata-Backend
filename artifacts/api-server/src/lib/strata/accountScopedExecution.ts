import {
  computeV13LiveMoneyPolicyHash,
  remainingLossBudgetAllowsEntry,
  type V13ApprovedLiveMoneyPolicy,
} from "../v13LiveMoneyRisk";
import {
  resolveAccountCommissioningContext,
  selectCredentialRef,
  useAccountCredential,
  type AccountCommissioningPorts,
} from "./accountCommissioningContext";
import {
  credentialDatabaseFromPool,
  type CredentialClient,
  type CredentialDatabase,
} from "./accountCredentialStore";
import { grossSpendWithinConfiguredStake } from "./userExecutionScope";

/**
 * Phase 3 binds a worker lease to one owned Kalshi account. It does not
 * construct the legacy production worker, open Vault material, or enable execution.
 */
export const PHASE3_EXECUTABLE = false;
export const ACCOUNT_WORKER_LEASE_TTL_MS = 30_000;

export { credentialDatabaseFromPool as executionDatabaseFromPool };
export type ExecutionDatabase = CredentialDatabase;

export type AccountWorkerAction = "ARM" | "DISARM" | "START" | "STOP" | "KILL";
export type AccountWorkerState = "absent" | "released" | "owned" | "killed";

export interface OwnedExecutionOrder {
  clientOrderId: string;
  state: string;
}

export interface OwnedExecutionAccount {
  executionAccountId: string;
  ownerUserId: string;
  financialAccountId: string;
  providerConnectionId: string;
  subaccount: number;
  exchangeIndex: number;
  keyFingerprint: string;
  commissioned: boolean;
  executionEnabled: boolean;
  killSwitch: boolean;
  configuredStakeCents: number;
  cashMicros: bigint;
  policy: V13ApprovedLiveMoneyPolicy & { executionAccountId: string };
  positions: Array<{ market: string; quantityHundredths: number }>;
  orders: OwnedExecutionOrder[];
  fillIds: string[];
  settlementIds: string[];
  realizedPnlMicros: bigint;
  realizedDailyLossCents: number;
  realizedTotalLossCents: number;
}

export interface AccountActivityPort {
  readOwnedAccount(authenticatedUserId: string, executionAccountId: string): Promise<OwnedExecutionAccount | null>;
}

export interface AccountExecutionDeps {
  commissioning: AccountCommissioningPorts;
  activity: AccountActivityPort;
  leases: ExecutionDatabase;
  safety?: AccountSafetyPort;
  globalKill(): Promise<boolean>;
  now(): number;
  leaseTtlMs?: number;
}

export interface SafetyAccountRef {
  executionAccountId: string;
  ownerUserId: string;
  financialAccountId: string;
  providerConnectionId: string;
  keyFingerprint: string | null;
  vaultSecretId: string | null;
  openPositionCount: number;
  unresolvedIntentCount: number;
}

export interface AccountSafetyPort {
  listAccounts(authenticatedUserId: string): Promise<SafetyAccountRef[]>;
  markKilled(authenticatedUserId: string, executionAccountId: string): Promise<void>;
}

export interface AccountExecutionResult {
  ok: boolean;
  reason: string;
  executable: false;
  workerStarted: false;
  /** True only when a real trading worker is scheduled. A lease is not enough. */
  executionActive: false;
  fencingToken: number | null;
  state: AccountWorkerState;
  armRequested: boolean;
  accountKill: boolean;
}

const LOCK_LEASE_SQL = `
  -- account-worker:lock
  SELECT execution_account_id,
         owner_user_id::text AS owner_user_id,
         holder_id,
         fencing_token::text AS fencing_token,
         state,
         heartbeat_at,
         account_kill,
         arm_requested,
         credential_fingerprint,
         vault_secret_id::text AS vault_secret_id
  FROM private.kalshi_account_worker_lease
  WHERE execution_account_id = $1
  FOR UPDATE
`;

const INSERT_LEASE_SQL = `
  -- account-worker:insert
  INSERT INTO private.kalshi_account_worker_lease (
    execution_account_id, owner_user_id, financial_account_id, provider_connection_id,
    holder_id, fencing_token, state, heartbeat_at, released_at, account_kill,
    arm_requested, credential_fingerprint, vault_secret_id
  ) VALUES (
    $1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::timestamptz, $9::timestamptz,
    $10, $11, $12, $13::uuid
  )
  RETURNING fencing_token::text AS fencing_token
`;

export const ACQUIRE_LEASE_SQL = `
  -- account-worker:acquire
  UPDATE private.kalshi_account_worker_lease
  SET holder_id = $2,
      fencing_token = fencing_token + 1,
      state = 'owned',
      heartbeat_at = $3::timestamptz,
      released_at = NULL,
      arm_requested = true,
      account_kill = false,
      credential_fingerprint = $4,
      vault_secret_id = $5::uuid,
      provider_connection_id = $6::uuid,
      financial_account_id = $7::uuid
  WHERE execution_account_id = $1
    AND owner_user_id = $8::uuid
    AND account_kill = false
    AND state <> 'killed'
    AND arm_requested = true
    AND (
      state <> 'owned'
      OR holder_id = $2
      OR heartbeat_at < $9::timestamptz
    )
  RETURNING fencing_token::text AS fencing_token
`;

const RELEASE_LEASE_SQL = `
  -- account-worker:release
  UPDATE private.kalshi_account_worker_lease
  SET state = 'released',
      released_at = $3::timestamptz,
      heartbeat_at = $3::timestamptz,
      arm_requested = false,
      fencing_token = fencing_token + 1
  WHERE execution_account_id = $1
    AND owner_user_id = $2::uuid
    AND state = 'owned'
    AND account_kill = false
  RETURNING fencing_token::text AS fencing_token
`;

const KILL_LEASE_SQL = `
  -- account-worker:kill
  UPDATE private.kalshi_account_worker_lease
  SET state = 'killed',
      account_kill = true,
      arm_requested = false,
      released_at = $3::timestamptz,
      heartbeat_at = $3::timestamptz,
      fencing_token = fencing_token + 1
  WHERE execution_account_id = $1
    AND owner_user_id = $2::uuid
  RETURNING fencing_token::text AS fencing_token
`;

const ARM_LEASE_SQL = `
  -- account-worker:arm
  UPDATE private.kalshi_account_worker_lease
  SET arm_requested = true,
      credential_fingerprint = $3,
      vault_secret_id = $4::uuid,
      heartbeat_at = $5::timestamptz,
      provider_connection_id = $6::uuid,
      financial_account_id = $7::uuid
  WHERE execution_account_id = $1
    AND owner_user_id = $2::uuid
    AND state = 'released'
    AND account_kill = false
  RETURNING fencing_token::text AS fencing_token
`;

const HOLD_LEASE_SQL = `
  -- account-worker:hold
  UPDATE private.kalshi_account_worker_lease
  SET arm_requested = false
  WHERE execution_account_id = $1
    AND owner_user_id = $2::uuid
    AND state = 'owned'
    AND account_kill = false
  RETURNING fencing_token::text AS fencing_token
`;

const DISARM_LEASE_SQL = `
  -- account-worker:disarm
  UPDATE private.kalshi_account_worker_lease
  SET arm_requested = false
  WHERE execution_account_id = $1
    AND owner_user_id = $2::uuid
    AND account_kill = false
  RETURNING fencing_token::text AS fencing_token
`;

const LOCK_OWNER_LEASES_SQL = `
  -- account-worker:lock-owner
  SELECT execution_account_id,
         owner_user_id::text AS owner_user_id,
         holder_id,
         fencing_token::text AS fencing_token,
         state,
         account_kill,
         arm_requested
  FROM private.kalshi_account_worker_lease
  WHERE owner_user_id = $1::uuid
  FOR UPDATE
`;

const HEARTBEAT_LEASE_SQL = `
  -- account-worker:heartbeat
  UPDATE private.kalshi_account_worker_lease
  SET heartbeat_at = $3::timestamptz
  WHERE execution_account_id = $1
    AND owner_user_id = $2::uuid
    AND holder_id = $4
    AND fencing_token = $5
    AND state = 'owned'
    AND account_kill = false
    AND credential_fingerprint = $6
  RETURNING fencing_token::text AS fencing_token
`;

export const SCOPED_ACCOUNT_SQL = `
  SELECT a.id::text AS execution_account_id,
         a.owner_user_id::text AS owner_user_id,
         a.kalshi_connection_id::text AS financial_account_id,
         a.subaccount,
         a.exchange_index,
         a.key_fingerprint,
         a.commissioned,
         a.execution_enabled,
         a.kill_switch,
         a.cash_micros::text AS cash_micros
  FROM v13_production_account a
  WHERE a.id = $1
    AND a.owner_user_id = $2::uuid
`;

export const SCOPED_POLICY_SQL = `
  SELECT p.id::text AS id,
         p.state,
         p.policy_hash,
         p.execution_account_id::text AS execution_account_id,
         p.max_entry_stake_cents,
         p.max_daily_loss_cents,
         p.max_total_loss_cents
  FROM v13_live_money_policy p
  JOIN v13_production_account a ON a.policy_id = p.id AND a.id = p.execution_account_id
  WHERE a.id = $1
    AND a.owner_user_id = $2::uuid
    AND p.state = 'APPROVED'
`;

export const SCOPED_STAKE_SQL = `
  SELECT s.configured_stake_cents
  FROM strata_configured_stake s
  JOIN v13_production_account a ON a.id = s.execution_account_id
  WHERE s.execution_account_id = $1
    AND a.owner_user_id = $2::uuid
`;

export const SAFETY_EXPOSURE_SQL = `
  SELECT a.id::text AS execution_account_id,
         a.kalshi_connection_id::text AS financial_account_id,
         (SELECT count(*)::int FROM v13_production_position p
           WHERE p.account_id = a.id AND p.quantity_hundredths > 0) AS open_positions,
         (SELECT count(*)::int FROM v13_production_intent i
           WHERE i.account_id = a.id AND i.state NOT IN ('TERMINAL', 'BLOCKED')) AS unresolved_intents
  FROM v13_production_account a
  WHERE a.owner_user_id = $1::uuid
`;

export const SCOPED_POSITIONS_SQL = `
  SELECT p.market, p.side, p.quantity_hundredths
  FROM v13_production_position p
  JOIN v13_production_account a ON a.id = p.account_id
  WHERE p.account_id = $1
    AND a.owner_user_id = $2::uuid
    AND p.quantity_hundredths > 0
`;

export const SCOPED_ORDERS_SQL = `
  SELECT i.client_order_id, i.state
  FROM v13_production_intent i
  JOIN v13_production_account a ON a.id = i.account_id
  WHERE i.account_id = $1
    AND a.owner_user_id = $2::uuid
`;

export const SCOPED_EVENTS_SQL = `
  SELECT e.event_id, e.pnl_micros::text AS pnl_micros
  FROM v13_production_event e
  JOIN v13_production_account a ON a.id = e.account_id
  WHERE e.account_id = $1
    AND a.owner_user_id = $2::uuid
`;

export const GLOBAL_KILL_SQL = `
  SELECT manual_kill_switch
  FROM live_execution_config
`;

export function acceptOwnedPolicy(
  policy: V13ApprovedLiveMoneyPolicy & { executionAccountId: string },
  executionAccountId: string,
): boolean {
  return policy.executionAccountId === executionAccountId &&
    policy.state === "APPROVED" &&
    policy.policyHash === computeV13LiveMoneyPolicyHash(policy);
}

export function accountRiskAllowsEntry(
  account: OwnedExecutionAccount,
  plannedGrossCents: number,
  reservedEntryFeeCents: number,
  reservedExitFeeCents: number,
): boolean {
  const plannedAllInCents = plannedGrossCents + reservedEntryFeeCents + reservedExitFeeCents;
  return grossSpendWithinConfiguredStake(account.configuredStakeCents, plannedGrossCents) &&
    plannedGrossCents <= account.policy.maxEntryStakeCents &&
    remainingLossBudgetAllowsEntry(
      plannedAllInCents,
      account.policy.maxDailyLossCents,
      account.realizedDailyLossCents,
      account.policy.maxTotalLossCents,
      account.realizedTotalLossCents,
    );
}

export function duplicateClientOrder(account: OwnedExecutionAccount, clientOrderId: string): boolean {
  return account.orders.some((order) => order.clientOrderId === clientOrderId);
}

export function scopedObservationMatches(
  account: OwnedExecutionAccount,
  observation: {
    executionAccountId: string;
    ownerUserId: string;
    subaccount: number;
    exchangeIndex: number;
    keyFingerprint: string;
  },
): { ok: true } | { ok: false; reason: string } {
  if (observation.ownerUserId !== account.ownerUserId ||
      observation.executionAccountId !== account.executionAccountId) {
    return { ok: false, reason: "foreign_execution_account" };
  }
  if (observation.subaccount !== account.subaccount || observation.exchangeIndex !== account.exchangeIndex) {
    return { ok: false, reason: "account_target_pair_mismatch" };
  }
  if (observation.keyFingerprint !== account.keyFingerprint) {
    return { ok: false, reason: "credential_fingerprint_mismatch" };
  }
  return { ok: true };
}

export function exposureBlocksStop(account: OwnedExecutionAccount): string | null {
  if (account.positions.some((position) => position.quantityHundredths > 0)) return "open_position";
  if (account.orders.some((order) => order.state === "DISPATCHED")) return "dispatched_intent";
  if (account.orders.some((order) => order.state === "UNKNOWN")) return "unknown_intent";
  if (account.orders.some((order) => order.state !== "TERMINAL" && order.state !== "BLOCKED")) {
    return "unresolved_intent";
  }
  return null;
}

export async function readScopedActivity(
  db: CredentialClient,
  authenticatedUserId: string,
  executionAccountId: string,
): Promise<{
  account: Record<string, unknown> | null;
  policy: Record<string, unknown> | null;
  configuredStakeCents: number | null;
  positions: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}> {
  const [account, policy, stake, positions, orders, events] = await Promise.all([
    db.query(SCOPED_ACCOUNT_SQL, [executionAccountId, authenticatedUserId]),
    db.query(SCOPED_POLICY_SQL, [executionAccountId, authenticatedUserId]),
    db.query(SCOPED_STAKE_SQL, [executionAccountId, authenticatedUserId]),
    db.query(SCOPED_POSITIONS_SQL, [executionAccountId, authenticatedUserId]),
    db.query(SCOPED_ORDERS_SQL, [executionAccountId, authenticatedUserId]),
    db.query(SCOPED_EVENTS_SQL, [executionAccountId, authenticatedUserId]),
  ]);
  const stakeCents = Number(stake.rows[0]?.configured_stake_cents);
  return {
    account: account.rows[0] ?? null,
    policy: policy.rows.length === 1 ? policy.rows[0]! : null,
    configuredStakeCents: Number.isSafeInteger(stakeCents) ? stakeCents : null,
    positions: positions.rows,
    orders: orders.rows,
    events: events.rows,
  };
}

export async function globalKillEnabled(db: CredentialClient): Promise<boolean> {
  const result = await db.query(GLOBAL_KILL_SQL);
  if (result.rows.length !== 1) return true;
  return result.rows[0]?.manual_kill_switch === true;
}

export async function operateAccountWorker(
  deps: AccountExecutionDeps,
  input: {
    authenticatedUserId: string;
    holderId: string;
    action: AccountWorkerAction;
    clientRequest?: unknown;
  },
): Promise<AccountExecutionResult> {
  if (!input.holderId.trim() || input.holderId.length > 200) {
    return refused("holder_invalid");
  }
  const safetyAction = input.action === "STOP" || input.action === "DISARM" || input.action === "KILL";
  const bound = await resolveBoundAccount(deps, input.authenticatedUserId, input.clientRequest);
  if (!bound.ok) {
    if (!safetyAction) return refused(bound.reason);
    return unboundSafety(deps, input);
  }
  const globalKill = await deps.globalKill();
  if (globalKill && (input.action === "ARM" || input.action === "START")) {
    return refused("global_kill_switch");
  }
  const now = new Date(deps.now()).toISOString();
  const staleBefore = new Date(deps.now() - (deps.leaseTtlMs ?? ACCOUNT_WORKER_LEASE_TTL_MS)).toISOString();
  return deps.leases.transaction((client) => applyLeaseAction(client, {
    action: input.action,
    holderId: input.holderId,
    account: bound.account,
    vaultSecretId: bound.vaultSecretId,
    now,
    staleBefore,
  }));
}

export async function renewAccountWorkerLease(
  deps: AccountExecutionDeps,
  input: {
    authenticatedUserId: string;
    executionAccountId: string;
    holderId: string;
    fencingToken: number;
    credentialFingerprint: string;
  },
): Promise<AccountExecutionResult> {
  if (await deps.globalKill()) return refused("global_kill_switch");
  const now = new Date(deps.now()).toISOString();
  return deps.leases.transaction(async (client) => {
    const renewed = await client.query(HEARTBEAT_LEASE_SQL, [
      input.executionAccountId,
      input.authenticatedUserId,
      now,
      input.holderId,
      input.fencingToken,
      input.credentialFingerprint,
    ]);
    if (renewed.rows.length !== 1) return refused("stale_worker_fence");
    return ownedResult("operation_not_enabled", Number(renewed.rows[0]?.fencing_token), true, false);
  });
}

async function unboundSafety(
  deps: AccountExecutionDeps,
  input: {
    authenticatedUserId: string;
    holderId: string;
    action: AccountWorkerAction;
  },
): Promise<AccountExecutionResult> {
  const accounts = deps.safety ? await deps.safety.listAccounts(input.authenticatedUserId) : [];
  if (!deps.safety) return refused("credential_unavailable");
  const now = new Date(deps.now()).toISOString();
  return deps.leases.transaction(async (client) => {
    const locked = await client.query(LOCK_OWNER_LEASES_SQL, [input.authenticatedUserId]);
    if (input.action === "KILL") {
      for (const row of locked.rows) {
        await client.query(KILL_LEASE_SQL, [row.execution_account_id, input.authenticatedUserId, now]);
      }
      for (const account of accounts) {
        if (!locked.rows.some((row) => row.execution_account_id === account.executionAccountId) &&
            account.keyFingerprint && account.vaultSecretId) {
          await client.query(INSERT_LEASE_SQL, [
            account.executionAccountId,
            account.ownerUserId,
            account.financialAccountId,
            account.providerConnectionId,
            input.holderId,
            1,
            "killed",
            now,
            now,
            true,
            false,
            account.keyFingerprint,
            account.vaultSecretId,
          ]);
        }
        await deps.safety?.markKilled(input.authenticatedUserId, account.executionAccountId);
      }
      return held("account_killed", null, "killed", false, true);
    }
    let stillOwned = false;
    for (const row of locked.rows) {
      const account = accounts.find((item) => item.executionAccountId === row.execution_account_id);
      const exposure = !account || account.openPositionCount > 0 || account.unresolvedIntentCount > 0;
      if (input.action === "STOP" && row.state === "owned" && exposure) {
        await client.query(HOLD_LEASE_SQL, [row.execution_account_id, input.authenticatedUserId]);
        stillOwned = true;
      } else if (input.action === "STOP" && row.state === "owned") {
        await client.query(RELEASE_LEASE_SQL, [row.execution_account_id, input.authenticatedUserId, now]);
      } else if (!flag(row.account_kill)) {
        await client.query(DISARM_LEASE_SQL, [row.execution_account_id, input.authenticatedUserId]);
        if (row.state === "owned") stillOwned = true;
      }
    }
    return held(
      input.action === "STOP" ? "entries_stopped" : "disarmed",
      null,
      stillOwned ? "owned" : "released",
      false,
      false,
    );
  });
}

export function executionBoundaryAllowsDispatch(input: {
  leaseState: string;
  armRequested: boolean;
  accountKill: boolean;
  globalKill: boolean;
  fencingToken: number;
  presentedToken: number;
  workerActuallyScheduled: boolean;
}): { allowed: false; reason: string } {
  if (input.presentedToken !== input.fencingToken) return { allowed: false, reason: "stale_worker_fence" };
  if (input.accountKill) return { allowed: false, reason: "account_kill_switch" };
  if (input.globalKill) return { allowed: false, reason: "global_kill_switch" };
  if (!input.armRequested || input.leaseState !== "owned") return { allowed: false, reason: "entries_stopped" };
  if (!input.workerActuallyScheduled) return { allowed: false, reason: "worker_not_started" };
  return { allowed: false, reason: "operation_not_enabled" };
}

async function resolveBoundAccount(
  deps: AccountExecutionDeps,
  authenticatedUserId: string,
  clientRequest: unknown,
): Promise<{ ok: true; account: OwnedExecutionAccount; vaultSecretId: string } | { ok: false; reason: string }> {
  const resolved = await resolveAccountCommissioningContext(authenticatedUserId, deps.commissioning, clientRequest);
  if (!resolved.ok) return resolved;
  const selected = selectCredentialRef(resolved.context, "restricted_execution");
  if (!selected.ok) return selected;
  const opened = await useAccountCredential(
    resolved.context,
    "restricted_execution",
    deps.commissioning,
    "account_worker",
    async () => {
      throw new Error("vault_material_refused");
    },
  );
  if (opened.ok) return { ok: false, reason: "vault_material_refused" };
  if (opened.reason !== "operation_not_enabled") return opened;
  if (!resolved.context.executionAccountId) return { ok: false, reason: "execution_account_missing" };
  const account = await deps.activity.readOwnedAccount(authenticatedUserId, resolved.context.executionAccountId);
  if (!account || account.ownerUserId !== authenticatedUserId) {
    return { ok: false, reason: "foreign_execution_account" };
  }
  if (account.executionAccountId !== resolved.context.executionAccountId ||
      account.providerConnectionId !== resolved.context.providerConnectionId ||
      account.financialAccountId !== resolved.context.financialAccountId) {
    return { ok: false, reason: "foreign_execution_account" };
  }
  if (account.subaccount !== 1 || account.exchangeIndex !== 2) {
    return { ok: false, reason: "account_target_pair_mismatch" };
  }
  if (!selected.ref.keyFingerprint || selected.ref.keyFingerprint !== account.keyFingerprint) {
    return { ok: false, reason: "credential_fingerprint_mismatch" };
  }
  if (!acceptOwnedPolicy(account.policy, account.executionAccountId)) {
    return { ok: false, reason: "policy_not_owned" };
  }
  if (!account.commissioned) return { ok: false, reason: "user_execution_account_not_commissioned" };
  if (account.killSwitch) return { ok: false, reason: "account_kill_switch" };
  return { ok: true, account, vaultSecretId: selected.ref.vaultSecretId };
}

async function applyLeaseAction(
  client: CredentialClient,
  input: {
    action: AccountWorkerAction;
    holderId: string;
    account: OwnedExecutionAccount;
    vaultSecretId: string;
    now: string;
    staleBefore: string;
  },
): Promise<AccountExecutionResult> {
  const locked = await client.query(LOCK_LEASE_SQL, [input.account.executionAccountId]);
  const current = locked.rows[0];
  if (current && text(current.owner_user_id) !== input.account.ownerUserId) {
    return refused("foreign_execution_account");
  }
  if (input.action === "KILL") return killLease(client, input, current);
  if (flag(current?.account_kill) || current?.state === "killed") {
    if (input.action === "STOP" || input.action === "DISARM") {
      return held("account_killed", tokenOf(current), "killed", false, true);
    }
    return refused("account_kill_switch");
  }
  if (input.action === "ARM") return armLease(client, input, current);
  if (input.action === "DISARM") return disarmLease(client, input, current);
  if (input.action === "STOP") return releaseLease(client, input, current);
  return acquireLease(client, input, current);
}

async function armLease(
  client: CredentialClient,
  input: ActionInput,
  current: Record<string, unknown> | undefined,
): Promise<AccountExecutionResult> {
  if (!current) {
    const inserted = await insertLease(client, input, "released", false, true);
    return held("operation_not_enabled", inserted, "released", true, false);
  }
  if (current.state === "owned") return held("operation_not_enabled", tokenOf(current), "owned", true, false);
  const armed = await client.query(ARM_LEASE_SQL, [
    input.account.executionAccountId,
    input.account.ownerUserId,
    input.account.keyFingerprint,
    input.vaultSecretId,
    input.now,
    input.account.providerConnectionId,
    input.account.financialAccountId,
  ]);
  if (armed.rows.length !== 1) return refused("arm_not_recorded");
  return held("operation_not_enabled", Number(armed.rows[0]?.fencing_token), "released", true, false);
}

async function disarmLease(
  client: CredentialClient,
  input: ActionInput,
  current: Record<string, unknown> | undefined,
): Promise<AccountExecutionResult> {
  if (!current) return refused("worker_absent");
  if (current.state === "owned") return held("worker_owned", tokenOf(current), "owned", true, false);
  const disarmed = await client.query(DISARM_LEASE_SQL, [
    input.account.executionAccountId,
    input.account.ownerUserId,
  ]);
  if (disarmed.rows.length !== 1) return refused("arm_not_recorded");
  const state = current.state === "owned" ? "owned" : "released";
  return held("disarmed", Number(disarmed.rows[0]?.fencing_token), state, false, false);
}

async function acquireLease(
  client: CredentialClient,
  input: ActionInput,
  current: Record<string, unknown> | undefined,
): Promise<AccountExecutionResult> {
  if (!current || !flag(current.arm_requested)) return refused("arm_required");
  const acquired = await client.query(ACQUIRE_LEASE_SQL, [
    input.account.executionAccountId,
    input.holderId,
    input.now,
    input.account.keyFingerprint,
    input.vaultSecretId,
    input.account.providerConnectionId,
    input.account.financialAccountId,
    input.account.ownerUserId,
    input.staleBefore,
  ]);
  if (acquired.rows.length !== 1) {
    return held("worker_already_owned", tokenOf(current), "owned", true, false);
  }
  return ownedResult("operation_not_enabled", Number(acquired.rows[0]?.fencing_token), true, false);
}

async function releaseLease(
  client: CredentialClient,
  input: ActionInput,
  current: Record<string, unknown> | undefined,
): Promise<AccountExecutionResult> {
  if (!current || current.state !== "owned") return held("entries_stopped", tokenOf(current), "released", false, false);
  const exposure = exposureBlocksStop(input.account);
  if (exposure) {
    const heldLease = await client.query(HOLD_LEASE_SQL, [
      input.account.executionAccountId,
      input.account.ownerUserId,
    ]);
    if (heldLease.rows.length !== 1) return refused("worker_release_failed");
    return held("entries_stopped", Number(heldLease.rows[0]?.fencing_token), "owned", false, false);
  }
  const released = await client.query(RELEASE_LEASE_SQL, [
    input.account.executionAccountId,
    input.account.ownerUserId,
    input.now,
  ]);
  if (released.rows.length !== 1) return refused("worker_release_failed");
  return held("entries_stopped", Number(released.rows[0]?.fencing_token), "released", false, false);
}

async function killLease(
  client: CredentialClient,
  input: ActionInput,
  current: Record<string, unknown> | undefined,
): Promise<AccountExecutionResult> {
  if (!current) {
    const inserted = await insertLease(client, input, "killed", true, false);
    return held("operation_not_enabled", inserted, "killed", false, true);
  }
  const killed = await client.query(KILL_LEASE_SQL, [
    input.account.executionAccountId,
    input.account.ownerUserId,
    input.now,
  ]);
  if (killed.rows.length !== 1) return refused("account_kill_failed");
  return held("operation_not_enabled", Number(killed.rows[0]?.fencing_token), "killed", false, true);
}

type ActionInput = {
  holderId: string;
  account: OwnedExecutionAccount;
  vaultSecretId: string;
  now: string;
  staleBefore: string;
};

async function insertLease(
  client: CredentialClient,
  input: ActionInput,
  state: "released" | "killed",
  accountKill: boolean,
  armRequested: boolean,
): Promise<number> {
  const inserted = await client.query(INSERT_LEASE_SQL, [
    input.account.executionAccountId,
    input.account.ownerUserId,
    input.account.financialAccountId,
    input.account.providerConnectionId,
    input.holderId,
    1,
    state,
    input.now,
    input.now,
    accountKill,
    armRequested,
    input.account.keyFingerprint,
    input.vaultSecretId,
  ]);
  return Number(inserted.rows[0]?.fencing_token);
}

function refused(reason: string): AccountExecutionResult {
  return held(reason, null, "absent", false, false);
}

function ownedResult(
  reason: string,
  fencingToken: number,
  armRequested: boolean,
  accountKill: boolean,
): AccountExecutionResult {
  return held(reason, fencingToken, "owned", armRequested, accountKill);
}

function held(
  reason: string,
  fencingToken: number | null,
  state: AccountWorkerState,
  armRequested: boolean,
  accountKill: boolean,
): AccountExecutionResult {
  return {
    ok: reason === "operation_not_enabled" || reason === "entries_stopped" ||
      reason === "account_killed" || reason === "disarmed" || reason === "safety_recorded",
    reason,
    executable: PHASE3_EXECUTABLE,
    workerStarted: false,
    executionActive: false,
    fencingToken,
    state,
    armRequested,
    accountKill,
  };
}

function tokenOf(row: Record<string, unknown> | undefined): number | null {
  const token = Number(row?.fencing_token);
  return Number.isSafeInteger(token) ? token : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

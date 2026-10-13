import type { Pool } from "@workspace/db";
import { getScopedKalshiJson } from "../kalshiAccountClient";
import { verifyCurrentFeeArtifact } from "../microLiveFeeArtifact";
import {
  openOwnedExecutionSession,
  scheduleOwnedAccountWorker,
  type AccountDispatchState,
  type SchedulableWorker,
} from "./accountProductionSession";
import { dedicatedSignerFingerprint } from "./commissioning";
import {
  emptySnapshot,
  ownedMarketEvidence,
  PERSONAL_KALSHI_HOST,
  PERSONAL_MARKET_METADATA_HOST,
  readOwnedKalshiFeeds,
} from "./personalExchangeRead";
import type { Identity } from "../v13-production/types";

export interface PersonalSessionControl {
  isScheduled(userId: string, accountId: string): boolean;
  start(input: {
    userId: string;
    accountId: string;
    action: "START" | "ARM";
  }): Promise<{ ok: boolean; reason: string; workerStarted: boolean }>;
  stop(input: { userId: string; accountId: string }): Promise<{ workerStopped: boolean }>;
  stopOwner(userId: string): Promise<{ workerStopped: boolean }>;
}

interface RunningWorker {
  ownerUserId: string;
  worker: SchedulableWorker;
}

const SIGNER_SQL = `
  -- personal-session:signer
  SELECT a.key_fingerprint, a.cash_micros::text AS cash_micros,
         a.commissioned, a.execution_enabled, a.kill_switch, a.fee_artifact_digest,
         a.cash_precision_verified, a.subaccount, a.exchange_index,
         c.key_fingerprint AS credential_fingerprint,
         s.decrypted_secret,
         p.policy_hash, p.fee_policy_version, p.fee_source_url, p.fee_formula_version, p.state AS policy_state,
         stake.configured_stake_cents
  FROM v13_production_account a
  JOIN private.kalshi_connection_credentials c
    ON c.owner_user_id = a.owner_user_id
   AND c.financial_account_id = a.kalshi_connection_id
   AND c.key_fingerprint = a.key_fingerprint
  JOIN vault.decrypted_secrets s ON s.id = c.vault_secret_id
  LEFT JOIN v13_live_money_policy p
    ON p.id = a.policy_id AND p.execution_account_id = a.id AND p.state = 'APPROVED'
  LEFT JOIN strata_configured_stake stake ON stake.execution_account_id = a.id
  WHERE a.owner_user_id = $1::uuid
    AND a.id = $2
    AND a.owner_user_id IS NOT NULL
    AND c.role = 'restricted_execution'
    AND c.revoked_at IS NULL
    AND c.verified_at IS NOT NULL
    AND c.verification_reason = 'credential_verified'
    AND a.subaccount = 1
    AND a.exchange_index = 2
`;

/** Distinct from global fetch, so a deployment cannot submit through the unbound global client. */
export async function personalProductionFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  return fetch(input, init);
}

export function createOwnedTradingSupervisor(
  open: (input: { userId: string; accountId: string; action: "START" | "ARM" }) => Promise<
    | { ok: true; worker: SchedulableWorker }
    | { ok: false; reason: string }
  >,
): PersonalSessionControl {
  const workers = new Map<string, RunningWorker>();
  return {
    isScheduled(userId, accountId) {
      const running = workers.get(accountId);
      return running?.ownerUserId === userId && running.worker.isScheduled();
    },
    async start(input) {
      const existing = workers.get(input.accountId);
      if (existing && existing.ownerUserId !== input.userId) {
        return { ok: false, reason: "foreign_execution_account", workerStarted: false };
      }
      if (existing?.worker.isScheduled()) {
        return { ok: true, reason: "worker_already_running", workerStarted: true };
      }
      const opened = await open(input);
      if (!opened.ok) return { ok: false, reason: opened.reason, workerStarted: false };
      if (!opened.worker.isScheduled()) {
        opened.worker.stop();
        return { ok: false, reason: "worker_not_scheduled", workerStarted: false };
      }
      workers.set(input.accountId, { ownerUserId: input.userId, worker: opened.worker });
      return { ok: true, reason: "worker_scheduled", workerStarted: true };
    },
    async stop(input) {
      return stopOne(workers, input.userId, input.accountId);
    },
    async stopOwner(userId) {
      for (const [accountId, running] of workers) {
        if (running.ownerUserId === userId) stopOne(workers, userId, accountId);
      }
      const stillRunning = [...workers.values()].some((running) => running.ownerUserId === userId && running.worker.isScheduled());
      return { workerStopped: !stillRunning };
    },
  };
}

export function createProductionPersonalSession(
  db: Pool | { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  options: {
    kalshiGet?: typeof getScopedKalshiJson;
    verifyFee?: typeof verifyCurrentFeeArtifact;
    now?: () => number;
  } = {},
): PersonalSessionControl {
  const get = options.kalshiGet ?? ((creds, path, query = "", fetchImpl = fetch) =>
    getScopedKalshiJson(creds, path, query, fetchImpl, PERSONAL_KALSHI_HOST));
  const verifyFee = options.verifyFee ?? verifyCurrentFeeArtifact;
  const now = options.now ?? Date.now;
  return createOwnedTradingSupervisor(async (input) => {
    const loaded = await loadSigner(db, input.userId, input.accountId);
    if (!loaded.ok) return loaded;
    const material = parseSecret(loaded.row.decrypted_secret);
    if (!material) return { ok: false, reason: "personal_signer_unavailable" };
    const fingerprint = dedicatedSignerFingerprint(material.keyId, material.privateKey);
    if (!fingerprint || fingerprint !== text(loaded.row.key_fingerprint) || fingerprint !== text(loaded.row.credential_fingerprint)) {
      return { ok: false, reason: "credential_fingerprint_mismatch" };
    }
    if (!flag(loaded.row.commissioned)) return { ok: false, reason: "user_execution_account_not_commissioned" };
    if (flag(loaded.row.kill_switch) || !flag(loaded.row.execution_enabled)) {
      return { ok: false, reason: "account_kill_switch" };
    }
    const live = await db.query(
      "SELECT live_execution_enabled, manual_kill_switch FROM live_execution_config WHERE id = 'singleton'",
    );
    const gate = live.rows[0];
    const killOff = gate?.manual_kill_switch === false || gate?.manual_kill_switch === "f" || gate?.manual_kill_switch === "false";
    if (!gate || !killOff) return { ok: false, reason: "global_kill_switch" };
    if (!(gate.live_execution_enabled === true || gate.live_execution_enabled === "t" || gate.live_execution_enabled === "true")) {
      return { ok: false, reason: "live_execution_not_enabled" };
    }
    if (!flag(loaded.row.cash_precision_verified)) return { ok: false, reason: "cash_not_reconciled" };
    const configuredStake = number(loaded.row.configured_stake_cents);
    if (configuredStake === null) return { ok: false, reason: "configured_stake_missing" };
    const digest = text(loaded.row.fee_artifact_digest);
    const policyHash = text(loaded.row.policy_hash);
    const policyVersion = text(loaded.row.fee_policy_version);
    const sourceUrl = text(loaded.row.fee_source_url);
    const formulaVersion = text(loaded.row.fee_formula_version);
    if (!digest || !policyHash || !policyVersion || !sourceUrl || !formulaVersion || loaded.row.policy_state !== "APPROVED") {
      return { ok: false, reason: "fee_evidence_missing" };
    }
    const observedAt = now();
    const feeds = await readOwnedKalshiFeeds(material, observedAt, get);
    if (!feeds.ok) return feeds;
    if (feeds.cashMicros !== text(loaded.row.cash_micros)) return { ok: false, reason: "cash_evidence_mismatch" };
    const snapshot = emptySnapshot(
      { subaccount: 1, exchangeIndex: 2, keyFingerprint: fingerprint },
      feeds,
    );
    if (!("identity" in snapshot)) return snapshot;
    const artifact = await verifyFee({ digest, policyVersion, sourceUrl, formulaVersion });
    if (!artifact.valid || artifact.digest !== digest || !artifact.verifiedAt) {
      return { ok: false, reason: "fee_evidence_missing" };
    }
    let feeVerifiedAt = artifact.verifiedAt;
    let feeCheckedAt = observedAt;
    const identity: Identity = snapshot.identity;
    const session = openOwnedExecutionSession({
      pool: db as Pool,
      ownerUserId: input.userId,
      executionAccountId: input.accountId,
      material,
      now,
      state: dispatchState(input.userId, fingerprint),
      readSnapshot: async () => {
        const latest = await readOwnedKalshiFeeds(material, now(), get);
        if (!latest.ok) throw new Error(latest.reason);
        const proven = emptySnapshot(identity, latest);
        if (!("identity" in proven)) throw new Error(proven.reason);
        return proven;
      },
      readMarket: async (market, side) => {
        const clock = now();
        if (clock - feeCheckedAt > 10_000) {
          const refreshed = await verifyFee({ digest, policyVersion, sourceUrl, formulaVersion });
          if (!refreshed.valid || refreshed.digest !== digest || !refreshed.verifiedAt) {
            throw new Error("fee_evidence_missing");
          }
          feeVerifiedAt = refreshed.verifiedAt;
          feeCheckedAt = clock;
        }
        const [bookPayload, seriesPayload, marketPayload] = await Promise.all([
          get(material, `/trade-api/v2/markets/${encodeURIComponent(market)}/orderbook`, "?depth=100"),
          publicKalshiObject(`/series/KXBTC15M`),
          publicKalshiObject(`/markets/${encodeURIComponent(market)}`),
        ]);
        return ownedMarketEvidence({
          market, side, bookPayload, seriesPayload, marketPayload,
          observedAtMs: clock, nowMs: clock, configuredStakeCents: configuredStake,
          policyVersion, sourceUrl, formulaVersion, artifactDigest: digest, policyHash,
          verifiedAtMs: feeVerifiedAt,
        });
      },
      fetchImpl: personalProductionFetch,
    });
    const scheduled = await scheduleOwnedAccountWorker(session, "entries");
    if (!scheduled.workerStarted) {
      session.worker.stop();
      return { ok: false, reason: scheduled.reason };
    }
    return { ok: true, worker: session.worker };
  });
}

export function productionPersonalSession(): PersonalSessionControl {
  return createOwnedTradingSupervisor(async () => ({ ok: false, reason: "personal_signer_unavailable" }));
}

function dispatchState(ownerUserId: string, fingerprint: string): AccountDispatchState {
  return {
    leaseState: "owned",
    armRequested: true,
    accountKill: false,
    globalKill: false,
    fencingToken: 1,
    presentedToken: 1,
    workerActuallyScheduled: true,
    authenticatedUserId: ownerUserId,
    ownerUserId,
    credentialFingerprint: fingerprint,
    presentedFingerprint: fingerprint,
    uncertainOrderCount: 0,
    duplicateClientOrder: false,
    liveExecutionEnabled: true,
  };
}

async function loadSigner(
  db: { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  userId: string,
  accountId: string,
): Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; reason: string }> {
  try {
    const found = await db.query(SIGNER_SQL, [userId, accountId]);
    if (found.rows.length !== 1) return { ok: false, reason: "personal_signer_unavailable" };
    return { ok: true, row: found.rows[0] ?? {} };
  } catch {
    return { ok: false, reason: "personal_signer_unavailable" };
  }
}

function parseSecret(secret: unknown): { keyId: string; privateKey: string } | null {
  if (typeof secret !== "string" || !secret) return null;
  try {
    const parsed = JSON.parse(secret) as Record<string, unknown>;
    const keyId = parsed.api_key_id;
    const privateKey = parsed.private_key;
    if (typeof keyId !== "string" || typeof privateKey !== "string" || !keyId || !privateKey) return null;
    return { keyId, privateKey };
  } catch {
    return null;
  }
}

function stopOne(
  workers: Map<string, RunningWorker>,
  userId: string,
  accountId: string,
): { workerStopped: boolean } {
  const running = workers.get(accountId);
  if (!running) return { workerStopped: true };
  if (running.ownerUserId !== userId) return { workerStopped: false };
  running.worker.stop();
  if (running.worker.isScheduled()) return { workerStopped: false };
  workers.delete(accountId);
  return { workerStopped: true };
}

async function publicKalshiObject(path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${PERSONAL_MARKET_METADATA_HOST}${path}`, { signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new Error("production_market_metadata_unavailable");
  }
  if (!response.ok) throw new Error("production_market_metadata_unavailable");
  return await response.json() as unknown;
}

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

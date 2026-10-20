import { constants, createPrivateKey, createSign } from "node:crypto";
import type { Pool, PoolClient } from "@workspace/db";
import { computeV13LiveMoneyPolicyHash } from "../v13LiveMoneyRisk";
import { ProductionExecutor } from "../v13-production/executor";
import { decodePolicy, ProductionLedger, type Account } from "../v13-production/ledger";
import { encodeProductionOrder } from "../v13-production/transport";
import { canonical, requireProof, type Exchange, type Identity, type MarketEvidence, type Request, type Snapshot } from "../v13-production/types";
import { ProductionWorker } from "../v13-production/worker";
import type { ProtectiveExitDispatch } from "../v13-production/consumer";
import { dedicatedSignerFingerprint, PRODUCTION_EXCHANGE_INDEX, PRODUCTION_SUBACCOUNT } from "./commissioning";
import { executionBoundaryAllowsDispatch } from "./accountScopedExecution";
import { validateMarketEvidence } from "./personalMarketAdapter";
import { institutionalReleaseMode } from "./institutionalCodeApproval";

export const PHASE5_EXECUTABLE = false;
const ORDER_PATH = "/trade-api/v2/portfolio/events/orders";

export interface AccountDispatchState {
  leaseState: string;
  armRequested: boolean;
  accountKill: boolean;
  globalKill: boolean;
  fencingToken: number;
  presentedToken: number;
  workerActuallyScheduled: boolean;
  authenticatedUserId: string;
  ownerUserId: string;
  credentialFingerprint: string;
  presentedFingerprint: string;
  uncertainOrderCount: number;
  duplicateClientOrder: boolean;
  liveExecutionEnabled?: boolean;
  /** False after STOP. Exit orders stay authorized while the lease remains owned. */
  entriesAuthorized?: boolean;
}

export interface AccountDispatchDecision {
  allowed: boolean;
  reason: string;
}

/** Final order boundary. Live submission still requires an explicit enablement flag. */
export function accountDispatchDecision(input: AccountDispatchState): AccountDispatchDecision {
  if (input.authenticatedUserId !== input.ownerUserId) {
    return { allowed: false, reason: "foreign_execution_account" };
  }
  if (input.presentedFingerprint !== input.credentialFingerprint) {
    return { allowed: false, reason: "credential_fingerprint_mismatch" };
  }
  const boundary = executionBoundaryAllowsDispatch(input);
  if (boundary.reason !== "operation_not_enabled") return boundary;
  if (input.uncertainOrderCount > 0) {
    return { allowed: false, reason: "production_uncertain_order_blocks_mutation" };
  }
  if (input.duplicateClientOrder) return { allowed: false, reason: "duplicate_client_order" };
  if (input.liveExecutionEnabled !== true) return { allowed: false, reason: "operation_not_enabled" };
  return { allowed: true, reason: "dispatch_authorized" };
}

export function scheduleAccountEntries(): {
  ok: false;
  reason: "operation_not_enabled";
  workerStarted: false;
  executionActive: false;
} {
  return { ok: false, reason: "operation_not_enabled", workerStarted: false, executionActive: false };
}

export function accountOrderTransmission(
  material: { keyId: string; privateKey: string },
  request: Request,
): { path: string; body: string; keyId: string } {
  const body = JSON.stringify(encodeProductionOrder(request));
  return { path: ORDER_PATH, body, keyId: material.keyId.trim() };
}

class OwnedAccountLedger extends ProductionLedger {
  constructor(pool: Pool, accountId: string, readonly ownerUserId: string) {
    super(pool, accountId);
  }
  override async policy(tx: PoolClient, account: Account) {
    const { rows } = await tx.query(
      `SELECT p.* FROM v13_live_money_policy p
       JOIN v13_production_account a ON a.policy_id = p.id AND a.id = p.execution_account_id
       WHERE p.id = $1 AND a.id = $2 AND a.owner_user_id = $3::uuid AND p.state = 'APPROVED'
       FOR SHARE OF p`,
      [account.policy_id, account.id, this.ownerUserId],
    );
    requireProof(rows.length === 1, "production_policy_missing");
    const policy = decodePolicy(rows[0]!);
    requireProof(policy.policyHash === computeV13LiveMoneyPolicyHash(policy),
      "production_policy_revoked_changed_or_ambiguous");
    return policy;
  }
}

export class AccountScopedExchange implements Exchange {
  readonly mode = "LIVE" as const;
  submitAttempts = 0;
  fetchCalls = 0;
  constructor(
    readonly state: AccountDispatchState,
    readonly material: { keyId: string; privateKey: string } | null = null,
    readonly readSnapshot: ((identity: Identity, historyFromMs: number) => Promise<Snapshot>) | null = null,
    readonly fetchImpl: typeof fetch | null = null,
    readonly orderMarket: ((orderId: string) => Promise<string | null>) | null = null,
    readonly readMarket: ((market: string, side: "YES" | "NO") => Promise<MarketEvidence>) | null = null,
    readonly finalEntryCodeApproval: (() => Promise<boolean>) | null = null,
  ) {}
  readonly #spent = new WeakSet<() => Promise<void>>();
  async market(market: string, side: "YES" | "NO"): Promise<MarketEvidence> {
    if (!this.readMarket) throw new Error("operation_not_enabled");
    requireProof(/^KXBTC15M[A-Za-z0-9._-]+$/.test(market), "production_market_invalid");
    requireProof(side === "YES" || side === "NO", "production_market_side_invalid");
    const evidence = await this.readMarket(market, side);
    validateMarketEvidence(evidence);
    return evidence;
  }
  async snapshot(id: Identity, historyFromMs: number): Promise<Snapshot> {
    if (id.subaccount !== PRODUCTION_SUBACCOUNT || id.exchangeIndex !== PRODUCTION_EXCHANGE_INDEX) {
      throw new Error("account_target_pair_mismatch");
    }
    if (id.keyFingerprint !== this.state.credentialFingerprint) throw new Error("credential_fingerprint_mismatch");
    if (!this.readSnapshot) throw new Error("snapshot_unavailable");
    const snapshot = await this.readSnapshot(id, historyFromMs);
    if (canonical(snapshot.identity) !== canonical(id)) throw new Error("production_account_mismatch");
    return snapshot;
  }
  async submit(request: Request, finalCheck: () => Promise<void>): Promise<{ orderId?: string }> {
    if (!request.reduceOnly && this.state.entriesAuthorized === false) {
      this.submitAttempts += 1;
      throw new Error("entries_stopped");
    }
    this.refuseBeforeWire();
    await this.mutate("POST", ORDER_PATH, JSON.stringify(encodeProductionOrder(request)), finalCheck, !request.reduceOnly);
    return {};
  }
  async cancel(orderId: string, finalCheck: () => Promise<void>): Promise<void> {
    this.refuseBeforeWire();
    requireProof(/^[A-Za-z0-9._:-]{1,128}$/.test(orderId), "production_cancel_id_invalid");
    const market = this.orderMarket ? await this.orderMarket(orderId) : null;
    if (market === null || !/^KXBTC15M[A-Za-z0-9._-]+$/.test(market)) {
      throw new Error("production_cancel_market_missing");
    }
    const path = `${ORDER_PATH}/${encodeURIComponent(orderId)}?market_ticker=${encodeURIComponent(market)}&subaccount=${PRODUCTION_SUBACCOUNT}&exchange_index=${PRODUCTION_EXCHANGE_INDEX}`;
    await this.mutate("DELETE", path, undefined, finalCheck);
  }
  private refuseBeforeWire(): void {
    this.submitAttempts += 1;
    const decision = accountDispatchDecision(this.state);
    if (!decision.allowed) throw new Error(decision.reason);
  }
  private async mutate(method: "POST" | "DELETE", path: string, body: string | undefined, finalCheck: () => Promise<void>, entry = false): Promise<void> {
    if (!ProductionExecutor.isFinalFence(finalCheck) || this.#spent.has(finalCheck)) {
      throw new Error("production_opaque_fence_required");
    }
    await finalCheck();
    if (entry && institutionalReleaseMode()==="DURABLE_CODE_V1") {
      if (!this.finalEntryCodeApproval || !await this.finalEntryCodeApproval())
        throw new Error("institutional_code_approval_revoked_or_unavailable");
    }
    this.#spent.add(finalCheck);
    if (!this.fetchImpl || this.fetchImpl === fetch) throw new Error("personal_submission_not_authorized");
    if (!this.material) throw new Error("credential_unavailable");
    const fingerprint = dedicatedSignerFingerprint(this.material.keyId, this.material.privateKey);
    if (!fingerprint || fingerprint !== this.state.credentialFingerprint) {
      throw new Error("credential_fingerprint_mismatch");
    }
    if (!this.fetchImpl) throw new Error("live_transport_not_enabled");
    const timestamp = String(Date.now());
    const signature = signOwnedKey(this.material, timestamp, method, path.split("?")[0] ?? path);
    this.fetchCalls += 1;
    const response = await this.fetchImpl(`https://external-api.kalshi.com${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "KALSHI-ACCESS-KEY": this.material.keyId.trim(),
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "KALSHI-ACCESS-SIGNATURE": signature,
      },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(10_000),
    });
    requireProof(response.ok, "production_mutation_response_unproven");
  }
}

export function bindAccountProductionWorker(input: {
  pool: Pool;
  ownerUserId: string;
  executionAccountId: string;
  credentialFingerprint: string;
  state: AccountDispatchState;
}): {
  executor: ProductionExecutor;
  worker: ProductionWorker;
  exchange: AccountScopedExchange;
  workerStarted: false;
  executionActive: false;
} {
  const exchange = new AccountScopedExchange({ ...input.state, liveExecutionEnabled: false });
  const ledger = new OwnedAccountLedger(input.pool, input.executionAccountId, input.ownerUserId);
  const executor = new ProductionExecutor(ledger, exchange);
  executor.accountOwnerUserId = input.ownerUserId;
  const worker = new ProductionWorker(executor);
  return { executor, worker, exchange, workerStarted: false, executionActive: PHASE5_EXECUTABLE };
}

export interface SchedulableWorker {
  isScheduled(): boolean;
  start(): Promise<void>;
  startRecovery(): Promise<void>;
  stop(): void;
}

/**
 * Starts the existing V13 worker loop. Entry mode still requires the caller's
 * dispatch state to have live execution enabled and a non-global mock or
 * separately injected transport. The global fetch implementation is refused.
 */
export async function scheduleOwnedAccountWorker(
  bound: { worker: SchedulableWorker; exchange: AccountScopedExchange },
  mode: "recovery" | "entries",
): Promise<{ ok: boolean; reason: string; workerStarted: boolean; executionActive: false }> {
  if (bound.worker.isScheduled()) {
    return { ok: false, reason: "worker_already_running", workerStarted: true, executionActive: false };
  }
  if (mode === "entries") {
    if (bound.exchange.state.liveExecutionEnabled !== true) {
      return { ok: false, reason: "live_execution_not_enabled", workerStarted: false, executionActive: false };
    }
    if (!bound.exchange.fetchImpl || bound.exchange.fetchImpl === fetch) {
      return { ok: false, reason: "personal_submission_not_authorized", workerStarted: false, executionActive: false };
    }
  }
  try {
    if (mode === "recovery") await bound.worker.startRecovery();
    else await bound.worker.start();
  } catch (error) {
    bound.worker.stop();
    const reason = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "worker_not_scheduled";
    return { ok: false, reason, workerStarted: false, executionActive: false };
  }
  const workerStarted = bound.worker.isScheduled();
  return {
    ok: workerStarted,
    reason: workerStarted ? "worker_scheduled" : "worker_not_scheduled",
    workerStarted,
    executionActive: false,
  };
}

/** Binds one owner to the existing executor. It does not start the loop or enable live submission. */
export function openOwnedExecutionSession(input: {
  pool: Pool;
  ownerUserId: string;
  executionAccountId: string;
  state: AccountDispatchState;
  material?: { keyId: string; privateKey: string } | null;
  readSnapshot?: ((identity: Identity, historyFromMs: number) => Promise<Snapshot>) | null;
  readMarket?: ((market: string, side: "YES" | "NO") => Promise<MarketEvidence>) | null;
  fetchImpl?: typeof fetch | null;
  now?: () => number;
  intervalMs?: number;
  fault?: (stage: string) => void;
  entriesOpen?: () => boolean;
  recoverProtectiveExits?: () => Promise<void>;
  dispatchProtectiveExit?: ProtectiveExitDispatch;
  finalEntryCodeApproval?: () => Promise<boolean>;
}): {
  executor: ProductionExecutor;
  worker: ProductionWorker;
  exchange: AccountScopedExchange;
  workerStarted: false;
  executionActive: false;
} {
  const exchange = new AccountScopedExchange(
    input.state,
    input.material ?? null,
    input.readSnapshot ?? null,
    input.fetchImpl ?? null,
    null,
    input.readMarket ?? null,
    input.finalEntryCodeApproval ?? null,
  );
  const ledger = new OwnedAccountLedger(input.pool, input.executionAccountId, input.ownerUserId);
  const executor = new ProductionExecutor(ledger, exchange, input.now, input.fault);
  executor.accountOwnerUserId = input.ownerUserId;
  const worker = new ProductionWorker(executor, input.intervalMs ?? 2_500, () => {},
    input.entriesOpen, input.recoverProtectiveExits, input.dispatchProtectiveExit);
  return { executor, worker, exchange, workerStarted: false, executionActive: PHASE5_EXECUTABLE };
}

function signOwnedKey(
  material: { keyId: string; privateKey: string },
  timestamp: string,
  method: string,
  path: string,
): string {
  const pem = material.privateKey.trim().replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
  const key = createPrivateKey(pem);
  requireProof(key.asymmetricKeyType === "rsa" || key.asymmetricKeyType === "rsa-pss", "credential_invalid");
  const signer = createSign("sha256");
  signer.update(`${timestamp}${method}${path}`);
  signer.end();
  return signer.sign({ key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString("base64");
}

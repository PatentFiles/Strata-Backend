import { randomUUID } from "node:crypto";
import type { Pool } from "@workspace/db";
import { getScopedKalshiJson } from "../kalshiAccountClient";
import { verifyCurrentFeeArtifact } from "../microLiveFeeArtifact";
import { STANDARD_QUADRATIC_FEE_FORMULA_VERSION } from "../microLiveFeeArtifact";
import { OPERATOR_FEE_SOURCE_POLICY } from "./operatorFeeSourceAuthorization";
import { parseOwnerFeeSource, verifyOwnerFeeSourceStage } from "./ownerFeeSourceStage";
import { createGuardedOwnerFeeFetch } from "./guardedOwnerFeeWire";
import {parseReviewedApiSource,verifyReviewedApiFeeSourceStage,API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION} from "./apiFeeSourceStage";
import {createGuardedReviewedApiFeeFetch} from "./guardedReviewedApiFeeWire";
import { verifyMonetaryFeeContract } from "./monetaryFeeContract";
import { createGuardedMonetaryFeeFetch } from "./guardedMonetaryFeeWire";
import { readUnresolvedIntentMode } from "./workerUncertainOrderGate";
import {reconcileOwnedProtectiveExits} from "./ownerFeeEmergencyExitWorkerRecovery";
import { sealedFinancialProtectiveExitOrder } from "./ownedProtectiveFinancialIntent";
import { reserveOwnedEmergencyExitProof } from "./ownerFeeEmergencyExitReserve";
import { dispatchReviewedProtectiveExitOnce } from "./ownerFeeEmergencyExitSignedDispatch";
import { verifyProtectiveExitStartupRelease } from "./protectiveExitStartupRelease";
import {
  openOwnedExecutionSession,
  scheduleOwnedAccountWorker,
  type AccountDispatchState,
  type SchedulableWorker,
} from "./accountProductionSession";
import {
  ACCOUNT_WORKER_LEASE_TTL_MS,
  ACQUIRE_LEASE_SQL,
  ARM_LEASE_SQL,
  HEARTBEAT_LEASE_SQL,
  HOLD_LEASE_SQL,
  INSERT_LEASE_SQL,
  KILL_LEASE_SQL,
  RELEASE_LEASE_SQL,
} from "./accountScopedExecution";
import { dedicatedSignerFingerprint } from "./commissioning";
import {
  emptySnapshot,
  ownedMarketEvidence,
  PERSONAL_KALSHI_HOST,
  PERSONAL_MARKET_METADATA_HOST,
  readOwnedKalshiFeeds,
} from "./personalExchangeRead";
import type { Identity, Request } from "../v13-production/types";

type LeaseAction = "STOP" | "KILL";

export interface PersonalSessionControl {
  isScheduled(userId: string, accountId: string): boolean;
  start(input: {
    userId: string;
    accountId: string;
    action: "START" | "ARM";
  }): Promise<{ ok: boolean; reason: string; workerStarted: boolean }>;
  stop(input: { userId: string; accountId: string; action?: LeaseAction }): Promise<{
    workerStopped: boolean;
    managingExposure?: boolean;
  }>;
  stopOwner(userId: string, action?: LeaseAction): Promise<{ workerStopped: boolean; managingExposure?: boolean }>;
}

interface RunningWorker {
  ownerUserId: string;
  worker: SchedulableWorker;
  state?: AccountDispatchState;
  disarm?: (action: LeaseAction) => Promise<{ entriesBlocked: boolean; managingExposure: boolean }>;
}

const SIGNER_SQL = `
  -- personal-session:signer
  SELECT a.key_fingerprint, a.cash_micros::text AS cash_micros,
         a.commissioned, a.execution_enabled, a.kill_switch, a.blocked_reason, a.fee_artifact_digest,
         a.cash_precision_verified, a.subaccount, a.exchange_index,
         c.key_fingerprint AS credential_fingerprint,
         c.financial_account_id::text AS financial_account_id,
         c.provider_connection_id::text AS provider_connection_id,
         c.vault_secret_id::text AS vault_secret_id,
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
    | { ok: true; worker: SchedulableWorker; state?: AccountDispatchState; disarm?: RunningWorker["disarm"] }
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
      workers.set(input.accountId, {
        ownerUserId: input.userId, worker: opened.worker, state: opened.state, disarm: opened.disarm,
      });
      return { ok: true, reason: "worker_scheduled", workerStarted: true };
    },
    async stop(input) {
      return stopOne(workers, input.userId, input.accountId, input.action ?? "STOP");
    },
    async stopOwner(userId, action = "STOP") {
      let workerStopped = true;
      let managingExposure = false;
      for (const [accountId, running] of workers) {
        if (running.ownerUserId !== userId) continue;
        const stopped = await stopOne(workers, userId, accountId, action);
        if (!stopped.workerStopped) workerStopped = false;
        if (stopped.managingExposure) managingExposure = true;
      }
      return { workerStopped, managingExposure };
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
    // Independent worker-level guard: outstanding cashier transfers must settle
    // before a live worker can acquire a lease, even if the controller races.
    if (process.env.STRATA_MANUAL_WITHDRAWALS_ENABLED === "true") {
      try {
        const withdrawals = await db.query(
          "SELECT id FROM private.strata_manual_profit_withdrawals WHERE execution_account_id=$1 AND owner_user_id=$2::uuid AND state IN ('prepared','attempted','pending','uncertain') LIMIT 1",
          [input.accountId, input.userId],
        );
        if (withdrawals.rows.length > 0) return { ok: false, reason: "withdrawal_in_progress" };
      } catch {
        return { ok: false, reason: "withdrawal_safety_unavailable" };
      }
    }
    if (process.env.STRATA_AUTOMATIC_WITHDRAWALS_ENABLED === "true") {
      try {
        const hold=await db.query(
          "SELECT state FROM private.strata_auto_withdrawal_maintenance WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND state <> 'completed' LIMIT 1",
          [input.userId,input.accountId],
        );
        if(hold.rows.length)return {ok:false,reason:"automatic_withdrawal_maintenance_active"};
      }catch{return {ok:false,reason:"automatic_maintenance_safety_unavailable"};}
    }
    // A historical commissioning marker or any other account risk hold must
    // be resolved using the authenticated owner reconciliation/repair workflow.
    // Commissioned=true and switches OFF are not sufficient to clear a hold.
    // Never create a worker lease, call Kalshi, or submit an order while held.
    if (loaded.row.blocked_reason !== null &&
        loaded.row.blocked_reason !== undefined) {
      return { ok: false, reason: "execution_account_risk_freeze_requires_reconciliation" };
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
    // New exposure is forbidden until the exact Railway build has a genuine,
    // unexpired independently reviewed protective EXIT release. The earlier
    // implementation only checked this when the EXIT itself was attempted,
    // which was too late for an already-opened position.
    const exitRelease=await verifyProtectiveExitStartupRelease(db,input.userId);
    if(!exitRelease.ok)return {ok:false,reason:exitRelease.reason};
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
    const identity: Identity = { subaccount: 1, exchangeIndex: 2, keyFingerprint: fingerprint };
    const requests = await loadRequests(db, input.accountId);
    const snapshot = emptySnapshot(identity, feeds, requests);
    if (!("identity" in snapshot)) return snapshot;
    const flat = snapshot.orders.length === 0 && snapshot.fills.length === 0 &&
      snapshot.settlements.length === 0 && snapshot.positions.length === 0;
    if (flat && feeds.cashMicros !== text(loaded.row.cash_micros)) return { ok: false, reason: "cash_evidence_mismatch" };
    const alternate=parseOwnerFeeSource(sourceUrl);
    const apiSource=parseReviewedApiSource(sourceUrl);
    if(alternate && (policyVersion!==OPERATOR_FEE_SOURCE_POLICY ||
       formulaVersion!==STANDARD_QUADRATIC_FEE_FORMULA_VERSION))
      return {ok:false,reason:"source_policy_identity_invalid"};
    if(apiSource && (policyVersion!==API_SOURCE_POLICY_VERSION ||
       formulaVersion!==API_SOURCE_FORMULA_VERSION))
      return {ok:false,reason:"api_source_policy_identity_invalid"};
    const operatorAtStart=alternate?
      await verifyOwnerFeeSourceStage(input.userId,"STEP_11",sourceUrl):null;
    if(alternate && (!operatorAtStart?.ok || operatorAtStart.identity.digest!==digest))
      return {ok:false,reason:"operator_source_release_unavailable"};
    const apiAtStart=apiSource?
      await verifyReviewedApiFeeSourceStage(input.userId,"STEP_11",sourceUrl):null;
    if(apiSource && (!apiAtStart?.ok || apiAtStart.identity.grantId!==apiSource.grantId))
      return {ok:false,reason:"reviewed_api_source_release_unavailable"};
    // The commissioning digest is a historical observation. Refresh the API
    // source for the exact target market at every readMarket and final POST.
    // The direct owner's standing policy has no human reviewer requirement,
    // but must prove authoritative monetary schedule + current Kalshi market.
    // Isolated test-injected fee verifiers never invoke the production source.
    const monetaryAtStart=!apiSource&&!alternate&&!options.verifyFee?
      await verifyMonetaryFeeContract("STEP_11"):null;
    if(monetaryAtStart && (!monetaryAtStart.ok||
       !monetaryAtStart.monetaryFeeAuthorized||monetaryAtStart.sourceDigest!==digest))
      return {ok:false,reason:monetaryAtStart.ok?"fee_artifact_unverified":monetaryAtStart.reason};
    const artifact=apiSource && apiAtStart?.ok?
      {valid:true,digest,verifiedAt:apiAtStart.identity.verifiedAtMs}:
      alternate && operatorAtStart?.ok?
      {valid:true,digest:operatorAtStart.identity.digest,
       verifiedAt:operatorAtStart.identity.verifiedAtMs}:
      monetaryAtStart?.ok?
      {valid:true,digest,
       verifiedAt:Date.parse(monetaryAtStart.verifiedAt??"")}:
      await verifyFee({ digest, policyVersion, sourceUrl, formulaVersion });
    if (!artifact.valid || artifact.digest !== digest || !artifact.verifiedAt) {
      return { ok: false, reason: "fee_evidence_missing" };
    }
    const holderId = `personal-${randomUUID()}`;
    const leaseIds = leaseIdentity(loaded.row);
    if (!leaseIds) return { ok: false, reason: "worker_lease_unavailable" };
    const claimed = await claimWorkerLease(db, {
      ...leaseIds, ownerUserId: input.userId, executionAccountId: input.accountId,
      holderId, fingerprint, now: new Date(observedAt).toISOString(),
      staleBefore: new Date(observedAt - ACCOUNT_WORKER_LEASE_TTL_MS).toISOString(),
    });
    if (!claimed.ok) return claimed;
    const state = dispatchState(input.userId, fingerprint, claimed.fencingToken);
    let feeVerifiedAt = artifact.verifiedAt;
    let feeCheckedAt = observedAt;
    const session = openOwnedExecutionSession({
      pool: db as Pool,
      ownerUserId: input.userId,
      executionAccountId: input.accountId,
      material,
      now,
      state,
      entriesOpen: () => state.entriesAuthorized !== false && !state.accountKill,
      // This is the only LIVE exit producer. The source selection comes from
      // the unchanged strategy and owned PostgreSQL position, NOT a browser.
      // The signer and lease are captured from this authenticated vault session.
      dispatchProtectiveExit: async selection => {
        if (process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE === "false") {
          state.entriesAuthorized = false;
          throw new Error("protective_exit_release_disabled");
        }
        if (state.accountKill || state.globalKill || state.presentedToken !== claimed.fencingToken) {
          state.entriesAuthorized = false;
          throw new Error("protective_exit_worker_lease_or_kill_changed");
        }
        try {
          // Fresh entries are halted as soon as an outbound EXIT intent is
          // prepared. Never initiate a second entry when exit evidence is
          // uncertain or the exchange account is being reduced.
          state.entriesAuthorized = false;
          // Financial preparation commits an accountable V13 SELL intent but
          // DOES NOT send an order. It independently rechecks position,
          // strategy, approved policy/fees, book, stake and exit floor.
          const financialId = await session.executor.prepareExit(
            selection.positionId,selection.minimumExitMicros/1_000_000,
          );
          const financialRows = await db.query(
            "SELECT request FROM public.v13_production_intent "+
            "WHERE id=$1 AND account_id=$2 AND parent_id=$3 "+
            "AND kind='EXIT' AND state='PREPARED' AND terminal=false",
            [financialId,input.accountId,selection.positionId],
          );
          const value=financialRows.rows[0]?.request;
          const request=(typeof value==="string"?JSON.parse(value):value) as Request;
          if(financialRows.rows.length!==1||!request||
             typeof request!=="object"||Array.isArray(request))
            throw Error("protective_exit_v13_intent_unverified");
          const market = await session.executor.exchange.market(selection.market, selection.side);
          const order = sealedFinancialProtectiveExitOrder(selection,request,market);
          const lease = { holderId, fencingToken: claimed.fencingToken };
          const reservation = await reserveOwnedEmergencyExitProof(
            input.userId, input.accountId, material, order, lease,
          );
          if (!reservation.reservationPrepared || !reservation.reservationId) {
            throw new Error(reservation.reason);
          }
          // Marker PREPARED -> UNKNOWN must COMMIT before a one-use signed POST;
          // all transport failures require exchange GET recovery, never retry.
          const outcome = await dispatchReviewedProtectiveExitOnce({
            ownerId: input.userId, accountId: input.accountId,
            reservationId: reservation.reservationId, material, order, lease,
          });
          if (outcome.state !== "RECONCILED") throw new Error(outcome.reason);
          // The one-use private reservation is not the V13 cash/fill ledger.
          // Verify the latter against signed provider history before treating
          // position/cash balances as authoritative or permitting new entries.
          await session.executor.reconcile();
        } catch (error) {
          // Exposure after an ambiguous IOC is never replaced by a new entry.
          state.entriesAuthorized = false;
          throw error;
        }
      },
      // Only the backend-held, authenticated vault signer can read UNKNOWN
      // protective-exit history. Browser routes never receive this callback
      // or the signer. No order submission is possible from this function.
      recoverProtectiveExits: async () => {
        const recovery=await reconcileOwnedProtectiveExits({
          ownerId:input.userId,accountId:input.accountId,material,
        },db);
        if(!recovery.ok){
          state.entriesAuthorized=false;
          throw new Error(recovery.reason);
        }
      },
      readSnapshot: async () => {
        // A protective reservation may become PREPARED/UNKNOWN while this
        // worker is already scheduled. Gate EVERY subsequent snapshot, not
        // just START, so another entry cannot race an unresolved exit.
        const unresolvedNow=await readUnresolvedIntentMode(
          (sql,params)=>db.query(sql,params),input.accountId,
        );
        if(!unresolvedNow.ok){
          state.entriesAuthorized=false;
          throw new Error("unresolved_intent_count_unverified");
        }
        if(unresolvedNow.mode==="recovery")state.entriesAuthorized=false;
        const beat = await heartbeatLease(db, {
          executionAccountId: input.accountId, ownerUserId: input.userId, holderId,
          fencingToken: state.fencingToken, fingerprint, now: new Date(now()).toISOString(),
        });
        if (!beat.ok) {
          state.presentedToken = -1;
          state.entriesAuthorized = false;
          throw new Error(beat.reason);
        }
        if (!beat.armRequested) state.entriesAuthorized = false;
        // If a process died between persisting a cash maintenance hold and
        // requesting STOP, the next heartbeat still disables new entries.
        // Protective reduce-only exit management is left to the worker.
        if (process.env.STRATA_AUTOMATIC_WITHDRAWALS_ENABLED === "true") {
          try {
            const maintenance=await db.query(
              "SELECT state FROM private.strata_auto_withdrawal_maintenance WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND state <> 'completed' LIMIT 1",
              [input.userId,input.accountId],
            );
            if(maintenance.rows.length)state.entriesAuthorized=false;
          }catch{state.entriesAuthorized=false;}
        }
        // Approvals are short-lived. Check on EVERY worker snapshot; no new
        // inventory when the last approved exit window nears expiry.
        // Keep reconciling existing inventory instead of treating revocation
        // as proof that a position has disappeared.
        const activeRelease=await verifyProtectiveExitStartupRelease(db,input.userId);
        if(!activeRelease.ok)state.entriesAuthorized=false;
        const latest = await readOwnedKalshiFeeds(material, now(), get);
        if (!latest.ok) throw new Error(latest.reason);
        const proven = emptySnapshot(identity, latest, await loadRequests(db, input.accountId));
        if (!("identity" in proven)) throw new Error(proven.reason);
        return proven;
      },
      readMarket: async (market, side) => {
        const clock = now();
        if(apiSource){
          const checked=await verifyReviewedApiFeeSourceStage(input.userId,"ORDER_ENTRY",
            sourceUrl,market);
          if(!checked.ok||checked.identity.marketTicker!==market)
            throw new Error("api_fee_exact_market_source_unavailable");
          feeVerifiedAt=checked.identity.verifiedAtMs;
          feeCheckedAt=clock;
        }else if(alternate){
          const checked=await verifyOwnerFeeSourceStage(input.userId,"ORDER_ENTRY",
            sourceUrl,market);
          if(!checked.ok || checked.identity.digest!==digest)
            throw new Error("owner_operator_fee_source_unavailable");
          feeVerifiedAt=checked.identity.verifiedAtMs;
          feeCheckedAt=clock;
        }else if(!options.verifyFee){
          const monetary=await verifyMonetaryFeeContract("ORDER_ENTRY",market);
          if(!monetary.ok||!monetary.monetaryFeeAuthorized||
             monetary.marketTicker!==market||monetary.sourceDigest!==digest)
            throw Error("monetary_fee_exact_market_unverified");
          feeVerifiedAt=Date.parse(monetary.verifiedAt??"");
          feeCheckedAt=clock;
        }else if (clock - feeCheckedAt > 10_000) {
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
        const eventTicker = (marketPayload as { market?: { event_ticker?: unknown } })?.market?.event_ticker;
        if (typeof eventTicker !== "string" || !/^KXBTC15M-[A-Za-z0-9-]+$/.test(eventTicker))
          throw new Error("production_event_fee_evidence_unverified");
        // Repeat these reads when executor re-invokes readMarket immediately
        // before POST. Missing, paginated or changed fee metadata fails closed.
        const [eventPayload, seriesChangesPayload, eventChangesPayload] = await Promise.all([
          publicKalshiObject(`/events/${encodeURIComponent(eventTicker)}`),
          publicKalshiObject("/series/fee_changes?series_ticker=KXBTC15M&show_historical=false&limit=100"),
          publicKalshiObject(`/events/fee_changes?event_ticker=${encodeURIComponent(eventTicker)}&show_historical=false&limit=100`),
        ]);
        return ownedMarketEvidence({
          market, side, bookPayload, seriesPayload, marketPayload,
          eventPayload, seriesChangesPayload, eventChangesPayload,
          observedAtMs: clock, nowMs: now(), configuredStakeCents: configuredStake,
          policyVersion, sourceUrl, formulaVersion, artifactDigest: digest, policyHash,
          verifiedAtMs: feeVerifiedAt,
        });
      },
      fetchImpl: apiSource ? createGuardedReviewedApiFeeFetch(input.userId,input.accountId,sourceUrl,personalProductionFetch,policyHash,fingerprint,claimed.fencingToken,holderId) :
        alternate ? createGuardedOwnerFeeFetch(input.userId,sourceUrl,personalProductionFetch) :
        !options.verifyFee ? createGuardedMonetaryFeeFetch(
          input.userId,input.accountId,personalProductionFetch,policyHash,
          fingerprint,claimed.fencingToken,holderId,digest,
        ) : personalProductionFetch,
    });
    const unresolved = await readUnresolvedIntentMode(
      (sql, params) => db.query(sql, params), input.accountId,
    );
    if (!unresolved.ok) {
      state.entriesAuthorized = false;
      state.presentedToken = -1;
      try {
        await releaseWorkerLease(db, input.userId, input.accountId, false, new Date(now()).toISOString());
      } finally {
        session.worker.stop();
      }
      return {ok:false,reason:unresolved.reason};
    }
    const recovery = unresolved.mode === "recovery";
    if (recovery) state.entriesAuthorized = false;
    const scheduled = await scheduleOwnedAccountWorker(session, unresolved.mode);
    if (!scheduled.workerStarted) {
      state.entriesAuthorized = false;
      state.presentedToken = -1;
      await releaseWorkerLease(db, input.userId, input.accountId, false, new Date(now()).toISOString());
      session.worker.stop();
      return { ok: false, reason: scheduled.reason };
    }
    return {
      ok: true,
      worker: session.worker,
      state,
      disarm: (action) => disarmWorkerLease(db, input.userId, input.accountId, action, new Date(now()).toISOString()),
    };
  });
}

export function productionPersonalSession(): PersonalSessionControl {
  return createOwnedTradingSupervisor(async () => ({ ok: false, reason: "personal_signer_unavailable" }));
}

function dispatchState(ownerUserId: string, fingerprint: string, fencingToken: number): AccountDispatchState {
  return {
    leaseState: "owned",
    armRequested: true,
    accountKill: false,
    globalKill: false,
    entriesAuthorized: true,
    fencingToken,
    presentedToken: fencingToken,
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

async function stopOne(
  workers: Map<string, RunningWorker>,
  userId: string,
  accountId: string,
  action: LeaseAction,
): Promise<{ workerStopped: boolean; managingExposure: boolean }> {
  const running = workers.get(accountId);
  if (!running) return { workerStopped: true, managingExposure: false };
  if (running.ownerUserId !== userId) return { workerStopped: false, managingExposure: false };
  if (running.state) {
    running.state.entriesAuthorized = false;
    if (action === "KILL") {
      running.state.accountKill = true;
      running.state.armRequested = false;
      running.state.presentedToken = -1;
    }
  }
  const authority = running.disarm
    ? await running.disarm(action)
    : { entriesBlocked: !running.state, managingExposure: false };
  if (!authority.entriesBlocked) return { workerStopped: false, managingExposure: false };
  const keepManaging = action === "STOP" && authority.managingExposure;
  if (!keepManaging) running.worker.stop();
  if (running.worker.isScheduled() && !keepManaging) return { workerStopped: false, managingExposure: false };
  if (!keepManaging) workers.delete(accountId);
  return { workerStopped: true, managingExposure: keepManaging };
}

async function loadRequests(
  db: { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  accountId: string,
): Promise<Request[]> {
  const found = await db.query(
    "SELECT request FROM v13_production_intent WHERE account_id = $1",
    [accountId],
  );
  return found.rows.flatMap((row) => {
    const request = typeof row.request === "string" ? JSON.parse(row.request) as Request : row.request as Request;
    return request && typeof request === "object" ? [request] : [];
  });
}

function leaseIdentity(row: Record<string, unknown>): {
  financialAccountId: string; providerConnectionId: string; vaultSecretId: string;
} | null {
  const financialAccountId = text(row.financial_account_id);
  const providerConnectionId = text(row.provider_connection_id);
  const vaultSecretId = text(row.vault_secret_id);
  if (!financialAccountId || !providerConnectionId || !vaultSecretId) return null;
  return { financialAccountId, providerConnectionId, vaultSecretId };
}

async function claimWorkerLease(
  db: { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  input: {
    ownerUserId: string; executionAccountId: string; holderId: string; fingerprint: string;
    financialAccountId: string; providerConnectionId: string; vaultSecretId: string;
    now: string; staleBefore: string;
  },
): Promise<{ ok: true; fencingToken: number } | { ok: false; reason: string }> {
  try {
    const present = await db.query("SELECT to_regclass('private.kalshi_account_worker_lease') AS name");
    if (!present.rows[0]?.name) return { ok: false, reason: "worker_lease_unavailable" };
    const current = await db.query(
      `SELECT state, account_kill FROM private.kalshi_account_worker_lease WHERE execution_account_id = $1`,
      [input.executionAccountId],
    );
    if (current.rows[0]?.state === "killed" || current.rows[0]?.account_kill === true) {
      return { ok: false, reason: "account_kill_switch" };
    }
    if (current.rows.length === 0) {
      await db.query(INSERT_LEASE_SQL, [
        input.executionAccountId, input.ownerUserId, input.financialAccountId, input.providerConnectionId,
        input.holderId, 1, "released", input.now, input.now, false, false, input.fingerprint, input.vaultSecretId,
      ]);
    }
    if (current.rows[0]?.state === "owned") {
      await db.query(
        `UPDATE private.kalshi_account_worker_lease
         SET arm_requested = true
         WHERE execution_account_id = $1 AND owner_user_id = $2::uuid
           AND state = 'owned' AND account_kill = false AND heartbeat_at < $3::timestamptz`,
        [input.executionAccountId, input.ownerUserId, input.staleBefore],
      );
    } else {
      const armed = await db.query(ARM_LEASE_SQL, [
        input.executionAccountId, input.ownerUserId, input.fingerprint, input.vaultSecretId, input.now,
        input.providerConnectionId, input.financialAccountId,
      ]);
      if (armed.rows.length !== 1) return { ok: false, reason: "worker_lease_unavailable" };
    }
    const acquired = await db.query(ACQUIRE_LEASE_SQL, [
      input.executionAccountId, input.holderId, input.now, input.fingerprint, input.vaultSecretId,
      input.providerConnectionId, input.financialAccountId, input.ownerUserId, input.staleBefore,
    ]);
    if (acquired.rows.length !== 1) return { ok: false, reason: "worker_lease_held" };
    const fencingToken = Number(acquired.rows[0]?.fencing_token);
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) return { ok: false, reason: "worker_lease_unavailable" };
    return { ok: true, fencingToken };
  } catch {
    return { ok: false, reason: "worker_lease_unavailable" };
  }
}

async function heartbeatLease(
  db: { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  input: {
    executionAccountId: string; ownerUserId: string; holderId: string;
    fencingToken: number; fingerprint: string; now: string;
  },
): Promise<{ ok: true; armRequested: boolean } | { ok: false; reason: string }> {
  try {
    const beat = await db.query(HEARTBEAT_LEASE_SQL, [
      input.executionAccountId, input.ownerUserId, input.now, input.holderId,
      input.fencingToken, input.fingerprint,
    ]);
    if (beat.rows.length !== 1) return { ok: false, reason: "stale_worker_fence" };
    const lease = await db.query(
      `SELECT arm_requested, account_kill, state FROM private.kalshi_account_worker_lease
       WHERE execution_account_id = $1 AND holder_id = $2 AND fencing_token = $3`,
      [input.executionAccountId, input.holderId, input.fencingToken],
    );
    const row = lease.rows[0];
    if (!row || row.state !== "owned" || row.account_kill === true) return { ok: false, reason: "stale_worker_fence" };
    return { ok: true, armRequested: row.arm_requested === true || row.arm_requested === "t" || row.arm_requested === "true" };
  } catch {
    return { ok: false, reason: "stale_worker_fence" };
  }
}

async function disarmWorkerLease(
  db: { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  ownerUserId: string,
  executionAccountId: string,
  action: LeaseAction,
  now: string,
): Promise<{ entriesBlocked: boolean; managingExposure: boolean }> {
  try {
    if (action === "KILL") {
      const killed = await db.query(KILL_LEASE_SQL, [executionAccountId, ownerUserId, now]);
      return { entriesBlocked: killed.rows.length === 1, managingExposure: false };
    }
    const exposure = await db.query(
      `SELECT
         (SELECT count(*) FROM v13_production_position WHERE account_id = $1 AND quantity_hundredths > 0) AS positions,
         (SELECT count(*) FROM v13_production_intent WHERE account_id = $1 AND exchange_order_id IS NOT NULL AND terminal = false) AS orders`,
      [executionAccountId],
    );
    const managingExposure = Number(exposure.rows[0]?.positions ?? 0) > 0 || Number(exposure.rows[0]?.orders ?? 0) > 0;
    const updated = managingExposure
      ? await db.query(HOLD_LEASE_SQL, [executionAccountId, ownerUserId])
      : await releaseWorkerLease(db, ownerUserId, executionAccountId, false, now);
    return { entriesBlocked: updated.rows.length === 1, managingExposure: managingExposure && updated.rows.length === 1 };
  } catch {
    return { entriesBlocked: false, managingExposure: false };
  }
}

async function releaseWorkerLease(
  db: { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  ownerUserId: string,
  executionAccountId: string,
  _unused: boolean,
  now: string,
): Promise<{ rows: Array<Record<string, unknown>> }> {
  return db.query(RELEASE_LEASE_SQL, [executionAccountId, ownerUserId, now]);
}

async function publicKalshiObject(path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${PERSONAL_MARKET_METADATA_HOST}${path}`, {
      method: "GET", redirect: "error", cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new Error("production_market_metadata_unavailable");
  }
  if (response.status !== 200 ||
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
      (response.url && response.url !== `${PERSONAL_MARKET_METADATA_HOST}${path}`)) {
    throw new Error("production_market_metadata_unavailable");
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(length) || length > 256_000) throw new Error("production_market_metadata_unavailable");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 2 || bytes.length > 256_000) throw new Error("production_market_metadata_unavailable");
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new Error("production_market_metadata_unavailable"); }
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

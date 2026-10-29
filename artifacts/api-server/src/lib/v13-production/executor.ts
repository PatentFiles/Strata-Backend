import {beginExecutionStage,type TimingObserver,type ExecutionStage,type StageContext} from "./stageTiming";
import {isEntryWireClockRefusal} from "../strata/entryWireClock";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "@workspace/db";
import { V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET, V13_ENTRY_POLICY_VERSION,
  V13_LEGACY_ENTRY_POLICY, previousBufferFromSide, evaluateV13Strategy } from "@workspace/v13-strategy";
import { remainingLossBudgetAllowsEntry } from "../v13LiveMoneyRisk";
import { preflightV13LiveMoneyEntry } from "../v13LiveMoneyEntryPreflight";
import {verifyWalletV4FinalSignedAdmission} from "../strata/walletV4FinalSignedAdmission";
import {DYNAMIC_FEE_POLICY_VERSION_V4} from "../strata/dynamicFeeOrderRiskV4";
import { planV13IocEntry, planV13IocExit } from "../v13ExecutionPlanner";
import { ProductionLedger, identity, type Account, type Intent } from "./ledger";
import { canonical, cents, digest, money, requireProof, type Exchange, type MarketEvidence, type Request, type Snapshot } from "./types";

/** Only a previously saved, verified integer revision can be signed. */
function stakeRevisionFromDecision(decision:unknown):number {
 const value=(decision as {stakeRevision?:unknown}|null)?.stakeRevision;
 requireProof(typeof value==="number"&&Number.isSafeInteger(value)&&value>=1,
   "wallet_v4_final_pinned_stake_revision_missing");
 return value;
}
/**
 * Never constructed or started by API startup. Production mutation authority
 * is separate from micro-live and never inherits paper positions or sizing.
 */
export class ProductionExecutor {
  static #fences = new WeakSet<() => Promise<void>>();
  static isFinalFence(check: () => Promise<void>): boolean { return this.#fences.has(check); }
  constructor(readonly ledger: ProductionLedger, readonly exchange: Exchange,
    readonly now: () => number = Date.now, readonly fault: (stage: string) => void = () => {}) {}
  /** Set only for an owned user account. The legacy singleton leaves this null. */
  accountOwnerUserId: string | null = null;
  timingObserver: TimingObserver | null = null;
  startTiming(stage:ExecutionStage,context:Partial<StageContext>={}) {
    return beginExecutionStage(this.timingObserver,stage,{...context,
      accountId:this.ledger.accountId,mode:this.exchange.mode});
  }

  /** Server-owned hooks; snapshot acquisition alone must never renew authority. */
  afterReconcile: ((snapshot: Snapshot) => Promise<void>) | null = null;
  authorizeFinalEntry: ((tx: PoolClient) => Promise<void>) | null = null;

  private async assertEntryPolicyWindow(tx: PoolClient, source: {
    market_ticker: string; target: number; crossing_key: string;
  }): Promise<void> {
    const w = (await tx.query(`SELECT entry_policy_version,target,crossing_key,
      crossing_consumed,starts_at,ends_at FROM forward_test_windows
      WHERE ticker=$1 FOR SHARE`, [source.market_ticker])).rows[0];
    requireProof(w && w.entry_policy_version === V13_ENTRY_POLICY_VERSION &&
      w.target === source.target && w.crossing_key === source.crossing_key &&
      w.crossing_consumed === true &&
      w.starts_at instanceof Date && w.starts_at.getTime() <= this.now() &&
      w.ends_at instanceof Date && w.ends_at.getTime() > this.now(),
      "production_entry_window_or_claim_not_current");
  }

  private async readConfiguredStake(tx: PoolClient): Promise<{ cents: number; revision: number }> {
    const row = this.accountOwnerUserId
      ? (await tx.query(`SELECT s.configured_stake_cents, s.revision
        FROM strata_configured_stake s
        JOIN v13_production_account a ON a.id = s.execution_account_id
        WHERE s.execution_account_id = $1 AND a.owner_user_id = $2::uuid
        FOR UPDATE OF s`, [this.ledger.accountId, this.accountOwnerUserId])).rows[0]
      : (await tx.query(`SELECT configured_stake_cents, revision
      FROM strata_configured_stake WHERE id='production' FOR UPDATE`)).rows[0];
    const cents = Number(row?.configured_stake_cents);
    const revision = Number(row?.revision);
    requireProof(Number.isSafeInteger(cents) && cents >= 1 &&
      Number.isSafeInteger(revision) && revision >= 1, "configured_stake_missing");
    return { cents, revision };
  }

  async gate(tx: PoolClient, a: Account, allowBlockedExit = false, ignoreIntentId: string | null = null, lifecycle = false): Promise<void> {
    requireProof(a.commissioned && !a.kill_switch && a.execution_enabled &&
      /^[0-9a-f]{64}$/.test(a.commissioning_digest ?? "") &&
      Number(a.subaccount) === 1 && Number(a.exchange_index) === 2, "production_authority_disabled_or_uncommissioned");
    requireProof(a.cash_precision_verified && /^[0-9a-f]{64}$/.test(a.fee_artifact_digest ?? ""),
      "production_fee_or_cash_precision_approval_missing");
    requireProof(!a.blocked_reason || allowBlockedExit || lifecycle, "production_account_frozen");
    requireProof(a.reconciled_at && a.reconciled_at.getTime() <= this.now() &&
      this.now() - a.reconciled_at.getTime() <= 15_000, "production_reconciliation_stale");
    const unknown = await tx.query(`SELECT id FROM v13_production_intent WHERE account_id=$1
      AND state IN ('DISPATCHED','UNKNOWN') AND ($2::text IS NULL OR id<>$2)`, [a.id, ignoreIntentId]);
    requireProof(lifecycle || unknown.rows.length === 0, "production_uncertain_order_blocks_mutation");
    if (this.accountOwnerUserId) {
      const owner = await tx.query(`SELECT owner_user_id::text AS owner_user_id
        FROM v13_production_account WHERE id=$1`, [a.id]);
      requireProof(owner.rows.length === 1 && owner.rows[0].owner_user_id === this.accountOwnerUserId,
        "foreign_execution_account");
      const master = await tx.query("SELECT manual_kill_switch, live_execution_enabled FROM live_execution_config");
      requireProof(master.rows.length === 1 && master.rows[0].manual_kill_switch === false &&
        master.rows[0].live_execution_enabled === true, "production_master_kill_switch_or_flag");
      const policy = await tx.query(`SELECT p.policy_hash
        FROM v13_live_money_policy p
        JOIN v13_production_account a ON a.policy_id = p.id AND a.id = p.execution_account_id
        WHERE a.id = $1 AND a.owner_user_id = $2::uuid AND p.state = 'APPROVED'`,
      [a.id, this.accountOwnerUserId]);
      requireProof(policy.rows.length === 1 && /^[0-9a-f]{64}$/.test(String(policy.rows[0].policy_hash ?? "")),
        "production_policy_missing");
      return;
    }
    if (this.exchange.mode === "SIMULATION") {
      const target = await tx.query("SELECT current_database() AS db,host(inet_server_addr()) AS host");
      requireProof(process.env.NODE_ENV === "test" &&
        /^v13_disposable_[a-z0-9_]+$/.test(target.rows[0].db) &&
        ["127.0.0.1", "::1"].includes(target.rows[0].host), "simulation_requires_disposable_postgres");
    } else {
      requireProof(process.env.NODE_ENV === "production" &&
        process.env.LIVE_EXECUTION_ENABLED === "true" &&
        process.env.V13_PRODUCTION_EXECUTION_ENABLED === "true" &&
        process.env.MICRO_LIVE_ACCOUNT_MODE === "exclusive" &&
        process.env.KALSHI_BOT_SUBACCOUNT === "1", "production_runtime_binding_or_flags_disabled");
      const master = await tx.query("SELECT manual_kill_switch,live_execution_enabled FROM live_execution_config FOR SHARE");
      requireProof(master.rows.length === 1 && master.rows[0].manual_kill_switch === false &&
        master.rows[0].live_execution_enabled === true, "production_master_kill_switch_or_flag");
      const boundary = await tx.query(`SELECT * FROM micro_live_pair_boundary WHERE subaccount_number=1
        AND exchange_index=2 FOR SHARE`);
      const b = boundary.rows[0];
      requireProof(boundary.rows.length === 1 && b.state === "initialized" && b.initialized_run_id &&
        b.restricted_key_fingerprint === a.key_fingerprint &&
        b.activity_checkpoint_digest === a.commissioning_digest, "production_commissioning_linkage_missing");
    }
  }

  async reconcile(): Promise<void> {
    const done=this.startTiming("reconciliation");
    try {
      const a = await this.ledger.readAccount();
      const floor = (await this.ledger.pool.query("SELECT min(created_at) AS earliest FROM v13_production_intent WHERE account_id=$1", [a.id])).rows[0].earliest;
      const signed=this.startTiming("signed_snapshot");
      let snapshot:Snapshot;
      try {snapshot=await this.exchange.snapshot(identity(a), floor ? new Date(floor).getTime() : this.now());signed("completed");}
      catch(error){signed("rejected",{error});throw error;}
      const commit=this.startTiming("ledger_reconcile_commit");
      try {await this.ledger.reconcile(snapshot,a.revision,this.now());commit("completed");}
      catch(error){commit("rejected",{error});throw error;}
      if(this.afterReconcile){
        const after=this.startTiming("after_reconcile");
        try{await this.afterReconcile(snapshot);after("completed");}
        catch(error){after("rejected",{error});throw error;}
      }
      done("completed");
    }catch(error){done("rejected",{error});throw error;}
  }

  async prepareEntry(evaluationId: string): Promise<string> {
    const done=this.startTiming("prepare_entry",{evaluationId});
    try{const id=await this.prepareEntryMeasured(evaluationId);done("completed");return id;}
    catch(error){done("rejected",{error});throw error;}
  }
  private async prepareEntryMeasured(evaluationId: string): Promise<string> {
    const source = (await this.ledger.pool.query("SELECT * FROM forward_test_evaluations WHERE id=$1", [evaluationId])).rows[0];
    requireProof(source && source.evaluation_source === "paper" &&
      source.strategy_parameter_set_id === V13_CHAMPION_PARAMETER_SET.id &&
      source.strategy_parameter_hash === V13_CHAMPION_PARAMETER_HASH &&
      source.qualifying_trigger && source.fresh_cross && !source.position_was_open &&
      source.crossing_key && source.feed_freshness === "current" &&
      ["SCOUT", "CONFIRM"].includes(source.signal) && ["UP", "DOWN"].includes(source.direction),
    "production_source_not_qualifying_champion");
    const side = source.direction === "UP" ? "YES" : "NO";
    const book = await this.exchange.market(source.market_ticker, side);
    return this.ledger.transaction(async (tx, a) => {
      const prior = await tx.query<Intent>("SELECT * FROM v13_production_intent WHERE account_id=$1 AND (evaluation_id=$2 OR crossing_key=$3)", [a.id, evaluationId, source.crossing_key]);
      if (prior.rows.length) return prior.rows[0]!.id; // duplicate event: no new reservation/capability
      await this.gate(tx, a);
      const p = await this.ledger.policy(tx, a);
      const sourcePolicy = source.entry_policy_version ?? V13_LEGACY_ENTRY_POLICY;
      requireProof(
        (sourcePolicy === V13_ENTRY_POLICY_VERSION || sourcePolicy === V13_LEGACY_ENTRY_POLICY) &&
        sourcePolicy === (p.entryPolicyVersion ?? V13_LEGACY_ENTRY_POLICY),
        "production_entry_policy_revision_not_approved",
      );
      if (sourcePolicy === V13_ENTRY_POLICY_VERSION) {
        requireProof(source.crossing_consumed &&
          source.crossing_key === `${source.market_ticker}:first`,
          "production_entry_policy_claim_not_proven");
        await this.assertEntryPolicyWindow(tx, source);
      }
      const sourceAge = this.now() - new Date(source.evaluated_at).getTime();
      const admission=this.startTiming("evaluation_age_admission",{evaluationId});
      const sourceCurrent=sourceAge >= 0 && sourceAge <= p.maxQuoteAgeMs;
      admission(sourceCurrent?"eligible":"rejected",{sourceAgeMs:sourceAge,
        ...(sourceCurrent?{}:{error:"production_evaluation_stale"})});
      requireProof(sourceCurrent, "production_evaluation_stale");
      const pinnedSource = (await tx.query("SELECT * FROM forward_test_evaluations WHERE id=$1 FOR SHARE", [evaluationId])).rows[0];
      requireProof(canonical(pinnedSource) === canonical(source) &&
        ["btc_provider_age_ms", "btc_receive_age_ms", "market_age_ms"].every(k =>
          typeof source[k] === "number" && Number.isFinite(source[k]) && source[k] >= 0 &&
          source[k] + sourceAge <= p.maxQuoteAgeMs), "production_source_feed_stale_or_changed");
      const classified = evaluateV13Strategy({
        marketTicker: source.market_ticker, btcPrice: source.btc_price, target: source.target,
        previousBuffer: previousBufferFromSide(source.previous_side),
        velocity: source.velocity, upOffer: source.up_offer, downOffer: source.down_offer,
        freshness: "current", position: null,
      });
      requireProof(classified.signal === source.signal && classified.direction === source.direction &&
        classified.qualifyingTrigger && classified.freshCross &&
        Math.abs(source.signed_buffer - (source.btc_price - source.target)) < 0.00001,
      "production_source_classification_mismatch");
      const pending = await tx.query("SELECT id FROM v13_production_intent WHERE account_id=$1 AND state='PREPARED'", [a.id]);
      requireProof(pending.rows.length === 0, "production_prepared_order_blocks_entry");
      const balances = await tx.query(`SELECT
        (SELECT count(*) FROM v13_production_position WHERE account_id=$1 AND quantity_hundredths>0) AS open,
        (SELECT coalesce(sum(basis_micros),0)::text FROM v13_production_position WHERE account_id=$1) AS basis,
        (SELECT coalesce(sum(-least(pnl_micros,0)),0)::text FROM v13_production_event WHERE account_id=$1) AS total_loss,
        (SELECT coalesce(sum(-least(pnl_micros,0)),0)::text FROM v13_production_event WHERE account_id=$1
          AND occurred_at >= $2) AS daily_loss`, [a.id, new Date(new Date(this.now()).toISOString().slice(0, 10))]);
      const b = balances.rows[0];
      const capital = BigInt(p.capitalLimitCents) * 10_000n - money(b.basis) - money(a.reserved_micros) - money(b.total_loss);
      requireProof(capital >= 0n, "production_capital_exhausted");
      const stake = await this.readConfiguredStake(tx);
      requireProof(stake.cents <= p.maxEntryStakeCents, "configured_stake_above_approved_maximum");
      const pf = preflightV13LiveMoneyEntry({
        policy: p, strategyParameterSetId: source.strategy_parameter_set_id, strategyParameterHash: source.strategy_parameter_hash,
        signal: source.signal, direction: source.direction, referenceOffer: source.entry_offer,
        bestAskDollars: book.bestAskDollars, askLevels: book.asks,
        quoteAgeMs: this.now() - book.observedAtMs, nowMs: this.now(), feeEvidence: book.fee,
        availableCashCents: cents(money(a.cash_micros) - money(a.reserved_micros)),
        capitalRemainingCents: cents(capital), openPositions: Number(b.open),
        realizedDailyLossCents: Math.ceil(Number(money(b.daily_loss)) / 10_000),
        realizedTotalLossCents: Math.ceil(Number(money(b.total_loss)) / 10_000),
        configuredStakeCents: stake.cents,
      });
      requireProof(pf.ok, pf.ok ? "" : pf.reason);
      const id = randomUUID(), clientOrderId = `v13p-${id}`;
      const request: Request = { market: source.market_ticker, side, action: "BUY", contracts: pf.plan.contracts,
        limitMicros: Math.round(pf.plan.limitPrice * 1_000_000), timeInForce: "IOC", reduceOnly: false, clientOrderId };
      const decision = {
        source, book, preflight: pf, policy: p, identity: identity(a),
        configuredStakeCents: stake.cents, stakeRevision: stake.revision,
      };
      const cap = digest({ id, request, decision, policyHash: pf.policyHash, fee: pf.feeEvidenceFingerprint });
      const reservation = BigInt(pf.plannedAllInCents) * 10_000n;
      a.reserved_micros = String(money(a.reserved_micros) + reservation);
      await tx.query(`INSERT INTO v13_production_intent(id,account_id,evaluation_id,crossing_key,kind,market,side,
        request,decision,policy_hash,fee_fingerprint,capability_digest,client_order_id,reserved_micros,exit_fee_micros)
        VALUES($1,$2,$3,$4,'ENTRY',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, a.id, evaluationId, source.crossing_key, request.market, side, JSON.stringify(request), JSON.stringify(decision),
        pf.policyHash, pf.feeEvidenceFingerprint, cap, clientOrderId, String(reservation), String(BigInt(book.fee.reservedExitFeeCents) * 10_000n)]);
      await tx.query("INSERT INTO v13_production_position(id,account_id,market,side) VALUES($1,$2,$3,$4)", [id, a.id, request.market, side]);
      this.fault("after_reservation");
      await this.ledger.persist(tx, a);
      await this.ledger.assertConservation(tx, a);
      return id;
    });
  }

  async prepareExit(parentId: string, minimumExitPrice: number): Promise<string> {
    const parent = (await this.ledger.pool.query<Intent>("SELECT * FROM v13_production_intent WHERE id=$1 AND account_id=$2", [parentId, this.ledger.accountId])).rows[0];
    requireProof(parent?.kind === "ENTRY", "production_exit_parent_missing");
    const book = await this.exchange.market(parent.market, parent.side);
    return this.ledger.transaction(async (tx, a) => {
      await this.gate(tx, a, true);
      const p = await this.ledger.policy(tx, a);
      requireProof(a.minimum_exit_micros === Math.round(minimumExitPrice * 1_000_000), "production_exit_floor_not_approved");
      requireProof(parent.terminal, "production_entry_not_terminal");
      const active = await tx.query("SELECT id FROM v13_production_intent WHERE parent_id=$1 AND state NOT IN ('TERMINAL','BLOCKED')", [parentId]);
      requireProof(active.rows.length === 0, "production_exit_already_pending");
      const pos = (await tx.query("SELECT * FROM v13_production_position WHERE id=$1 FOR UPDATE", [parentId])).rows[0];
      requireProof(pos && money(pos.quantity_hundredths) > 0n, "production_exit_not_owned");
      const source = (await tx.query(`SELECT * FROM forward_test_evaluations WHERE evaluation_source='paper'
        AND market_ticker=$1 ORDER BY evaluated_at DESC,id DESC LIMIT 1 FOR SHARE`, [parent.market])).rows[0];
      const age = source ? this.now() - new Date(source.evaluated_at).getTime() : Infinity;
      requireProof(source && source.strategy_parameter_set_id === V13_CHAMPION_PARAMETER_SET.id &&
        source.strategy_parameter_hash === V13_CHAMPION_PARAMETER_HASH &&
        source.feed_freshness === "current" && age >= 0 && age <= p.maxQuoteAgeMs &&
        ["btc_provider_age_ms", "btc_receive_age_ms", "market_age_ms"].every(k =>
          typeof source[k] === "number" && Number.isFinite(source[k]) && source[k] >= 0 &&
          source[k] + age <= p.maxQuoteAgeMs) &&
        Math.abs(source.signed_buffer - (source.btc_price - source.target)) < 0.00001,
      "production_exit_feed_unproven");
      const ownedDecision = evaluateV13Strategy({ marketTicker: pos.market, btcPrice: source.btc_price,
        target: source.target, previousBuffer: null, velocity: source.velocity,
        upOffer: source.up_offer, downOffer: source.down_offer, freshness: "current",
        position: { status: "open", direction: pos.side === "YES" ? "up" : "down" } });
      requireProof(ownedDecision.signal === "EXIT" && ownedDecision.positionExitReason, "production_owned_exit_not_eligible");
      const qty = money(pos.quantity_hundredths);
      // Exit only whole owned contracts. Fractional residuals remain owned and
      // persisted until settlement; never round quantity upward.
      const plan = planV13IocExit({ ownedContracts: Number(qty / 100n), bestBidDollars: book.bestBidDollars,
        bidLevels: book.bids, minimumExitPrice });
      requireProof(plan.ok, plan.ok ? "" : plan.reason);
      requireProof(this.now() - book.observedAtMs >= 0 && this.now() - book.observedAtMs <= p.maxQuoteAgeMs &&
        this.now() - book.fee.verifiedAtMs >= 0 && this.now() - book.fee.verifiedAtMs <= p.maxFeeEvidenceAgeMs &&
        book.fee.policyVersion === p.feePolicyVersion && book.fee.formulaVersion === p.feeFormulaVersion &&
        book.fee.sourceUrl === p.feeSourceUrl && book.fee.fingerprint.length >= 16 &&
        Number.isSafeInteger(book.fee.reservedExitFeeCents) && book.fee.reservedExitFeeCents >= 0 &&
        BigInt(book.fee.reservedExitFeeCents) * 10_000n <= money(parent.reserved_micros), "production_exit_fee_or_quote_unproven");
      const id = randomUUID();
      const request: Request = { market: parent.market, side: parent.side, action: "SELL",
        contracts: plan.plan.plannedContracts, limitMicros: Math.round(plan.plan.limitPrice * 1_000_000),
        timeInForce: "IOC", reduceOnly: true, clientOrderId: `v13p-${id}` };
      const decision = { book, plan: plan.plan, minimumExitPrice, policy: p, identity: identity(a), parentId,
        ownedEvaluation: { position: pos, source, sourcePaperEvaluationId: source.id, decision: ownedDecision } };
      await tx.query(`INSERT INTO v13_production_intent(id,account_id,parent_id,kind,market,side,request,decision,
        policy_hash,fee_fingerprint,capability_digest,client_order_id,reserved_micros,exit_fee_micros)
        VALUES($1,$2,$3,'EXIT',$4,$5,$6,$7,$8,$9,$10,$11,0,0)`,
      [id, a.id, parentId, parent.market, parent.side, JSON.stringify(request), JSON.stringify(decision),
        p.policyHash, book.fee.fingerprint, digest({ id, request, decision, policyHash: p.policyHash, fee: book.fee.fingerprint }), request.clientOrderId]);
      await this.ledger.persist(tx, a);
      return id;
    });
  }

  async dispatch(id: string): Promise<void> {
    // Precommit dispatch identity BEFORE any network side effect. A crash in
    // the gap is indistinguishable from an uncertain POST, so NEVER replay it.
    const claimed = await this.ledger.transaction(async (tx, a) => {
      const i = (await tx.query<Intent>("SELECT * FROM v13_production_intent WHERE id=$1 AND account_id=$2 FOR UPDATE", [id, a.id])).rows[0];
      requireProof(i, "production_intent_missing");
      if (i.state !== "PREPARED") return false;
      await this.gate(tx, a, i.kind === "EXIT");
      await tx.query("UPDATE v13_production_intent SET state='DISPATCHED',dispatch_at=$2 WHERE id=$1", [id, new Date(this.now())]);
      await this.ledger.persist(tx, a);
      return true;
    });
    if (!claimed) return;
    this.fault("after_dispatch_commit");
    const dispatchTiming=this.startTiming("dispatch",{intentId:id});
    let invoked = false;
    try {
      await this.ledger.transaction(async (tx, a) => {
        const i = (await tx.query<Intent>("SELECT * FROM v13_production_intent WHERE id=$1 FOR UPDATE", [id])).rows[0]!;
        // Lock and recheck the durable capability/authorization before entering
        // the transport. Network quote/account proof belongs at its final
        // pre-sign boundary; doing it here as well duplicates signed reads.
        await this.gate(tx, a, i.kind === "EXIT", id);
        const lockedPolicy = await this.ledger.policy(tx, a);
        requireProof(lockedPolicy.policyHash === i.policy_hash &&
          canonical(identity(a)) === canonical(i.decision.identity) &&
          i.capability_digest === digest({ id: i.id, request: i.request,
            decision: i.decision, policyHash: i.policy_hash, fee: i.fee_fingerprint }),
          "production_capability_or_policy_changed");
        if (i.kind === "ENTRY" && this.authorizeFinalEntry)
          await this.authorizeFinalEntry(tx);
        const final = async () => {
          const finalTiming=this.startTiming("final_preparation",{intentId:id,evaluationId:i.evaluation_id});
          try {
          // This intent itself is the ONLY allowed dispatched identity.
          const others = await tx.query("SELECT id FROM v13_production_intent WHERE account_id=$1 AND state IN ('DISPATCHED','UNKNOWN') AND id<>$2", [a.id, id]);
          requireProof(others.rows.length === 0, "production_other_uncertain_order");
          await this.gate(tx, a, i.kind === "EXIT", id);
          const p = await this.ledger.policy(tx, a);
          requireProof(p.policyHash === i.policy_hash && canonical(identity(a)) === canonical(i.decision.identity) &&
            i.capability_digest === digest({ id: i.id, request: i.request, decision: i.decision, policyHash: i.policy_hash, fee: i.fee_fingerprint }),
          "production_capability_or_policy_changed");
          const book = await this.exchange.market(i.market, i.side);
          const stored = i.decision.book as MarketEvidence;
          requireProof(book.fee.fingerprint === i.fee_fingerprint &&
            canonical({ ...book.fee, verifiedAtMs: 0 }) === canonical({ ...stored.fee, verifiedAtMs: 0 }) &&
            this.now() - book.observedAtMs >= 0 && this.now() - book.observedAtMs <= p.maxQuoteAgeMs &&
            this.now() - book.fee.verifiedAtMs >= 0 && this.now() - book.fee.verifiedAtMs <= p.maxFeeEvidenceAgeMs,
          "production_final_fee_or_quote_changed");
          let entryStake = p.maxEntryStakeCents;
          if (i.kind === "ENTRY") {
            const pinnedStake = i.decision.configuredStakeCents;
            const pinnedRevision = i.decision.stakeRevision;
            const stake = await this.readConfiguredStake(tx);
            requireProof(typeof pinnedStake === "number" && pinnedStake === stake.cents &&
              typeof pinnedRevision === "number" && pinnedRevision === stake.revision &&
              stake.cents <= p.maxEntryStakeCents, "production_pinned_stake_changed_or_unproven");
            entryStake = pinnedStake;
          }
          const plan = i.kind === "ENTRY" ? planV13IocEntry({
            signal: (i.decision.source as { signal: "SCOUT" | "CONFIRM" }).signal,
            direction: i.side === "YES" ? "UP" : "DOWN", referenceOffer: (i.decision.source as { entry_offer: number }).entry_offer,
            maxStakeCents: entryStake, bestAskDollars: book.bestAskDollars, askLevels: book.asks,
          }) : planV13IocExit({ ownedContracts: i.request.contracts,
            bestBidDollars: book.bestBidDollars, bidLevels: book.bids,
            minimumExitPrice: (i.decision.minimumExitPrice as number) });
          requireProof(plan.ok && (i.kind === "ENTRY" ? ("contracts" in plan.plan && plan.plan.contracts === i.request.contracts) :
            ("plannedContracts" in plan.plan && plan.plan.plannedContracts >= i.request.contracts)) &&
            Math.round(plan.plan.limitPrice * 1_000_000) === i.request.limitMicros, "production_final_depth_changed");
          if (i.kind === "EXIT") {
            requireProof(a.minimum_exit_micros === Math.round((i.decision.minimumExitPrice as number) * 1_000_000),
              "production_exit_floor_changed");
            const pos = (await tx.query("SELECT quantity_hundredths FROM v13_production_position WHERE id=$1 FOR UPDATE", [i.parent_id])).rows[0];
            requireProof(pos && money(pos.quantity_hundredths) >= BigInt(i.request.contracts) * 100n && i.request.reduceOnly,
              "production_exit_ownership_changed");
            const owned = i.decision.ownedEvaluation as { source: Record<string, unknown>; position: Record<string, unknown> };
            const source = (await tx.query("SELECT * FROM forward_test_evaluations WHERE id=$1 FOR SHARE", [owned.source.id])).rows[0];
            const age = this.now() - new Date(source?.evaluated_at ?? 0).getTime();
            requireProof(source && canonical(source) === canonical(owned.source) &&
              age >= 0 && age <= p.maxQuoteAgeMs &&
              ["btc_provider_age_ms", "btc_receive_age_ms", "market_age_ms"].every(k => source[k] + age <= p.maxQuoteAgeMs),
            "production_final_owned_feed_changed_or_stale");
          }
          const oldest = (await tx.query("SELECT min(created_at) earliest FROM v13_production_intent WHERE account_id=$1", [a.id])).rows[0].earliest;
          const snapshotTiming=this.startTiming("final_signed_snapshot",{intentId:id,evaluationId:i.evaluation_id});
          let snapshot:Snapshot;
          try{snapshot=await this.ledger.withFinalAccountSnapshot(i.kind === "ENTRY" ? i.id : null,
            () => this.exchange.snapshot(identity(a), new Date(oldest).getTime()));snapshotTiming("completed");}
          catch(error){snapshotTiming("rejected",{error});throw error;}
          await this.ledger.finalAccountProof(tx, a, snapshot, this.now());
          // Network reads above can consume the evidence lifetime. Recheck all
          // clocks immediately before returning to the synchronous signer.
          requireProof(this.now() - book.observedAtMs <= p.maxQuoteAgeMs &&
            this.now() - book.fee.verifiedAtMs <= p.maxFeeEvidenceAgeMs &&
            this.now() - a.reconciled_at!.getTime() <= 15_000, "production_final_evidence_expired");
          if (i.kind === "ENTRY") {
            const source = (await tx.query("SELECT * FROM forward_test_evaluations WHERE id=$1 FOR SHARE", [i.evaluation_id])).rows[0];
            requireProof(canonical(source) === canonical(i.decision.source) &&
              this.now() - new Date(source.evaluated_at).getTime() <= p.maxQuoteAgeMs &&
              ["btc_provider_age_ms", "btc_receive_age_ms", "market_age_ms"].every(k =>
                source[k] + this.now() - new Date(source.evaluated_at).getTime() <= p.maxQuoteAgeMs),
            "production_final_source_changed_or_expired");
            if (source.entry_policy_version === V13_ENTRY_POLICY_VERSION) {
              await this.assertEntryPolicyWindow(tx, source);
            }
            const losses = (await tx.query(`SELECT
              (SELECT coalesce(sum(-least(pnl_micros,0)),0)::text FROM v13_production_event WHERE account_id=$1) AS total_loss,
              (SELECT coalesce(sum(-least(pnl_micros,0)),0)::text FROM v13_production_event WHERE account_id=$1
                AND occurred_at >= $2) AS daily_loss`,
            [a.id, new Date(new Date(this.now()).toISOString().slice(0, 10))])).rows[0];
            const plannedAllInCents = Number(
              (i.decision.preflight as { plannedAllInCents?: unknown } | undefined)?.plannedAllInCents,
            );
            requireProof(remainingLossBudgetAllowsEntry(
              plannedAllInCents,
              p.maxDailyLossCents,
              Math.ceil(Number(money(losses.daily_loss)) / 10_000),
              p.maxTotalLossCents,
              Math.ceil(Number(money(losses.total_loss)) / 10_000),
            ), "live_money_entry_exceeds_remaining_loss_budget");
            if(p.feePolicyVersion===DYNAMIC_FEE_POLICY_VERSION_V4){
              requireProof(this.accountOwnerUserId, "wallet_v4_final_owner_required");
              const result=await verifyWalletV4FinalSignedAdmission(tx,{
                ownerId:this.accountOwnerUserId,accountId:a.id,
                policyHash:p.policyHash,stakeRevision:stakeRevisionFromDecision(i.decision),
                request:i.request,
                reservedExitFeeCents:Number(book.fee.reservedExitFeeCents),
                availableCashMicros:String(a.cash_micros),
                reservedCashMicros:String(a.reserved_micros),
                nowMs:this.now(),
              });
              requireProof(result.ok,result.ok?"wallet_v4_final_guard_unexpected":result.reason);
            }
            // Run after every asynchronous quote/account proof, on the SAME
            // transaction held through signing and sending. No cached grant.
            if (this.authorizeFinalEntry) await this.authorizeFinalEntry(tx);
            // Fee transports perform additional asynchronous verification.
            // Recheck the already pinned evidence synchronously at the actual
            // HTTP send, without repeating network proof or extending its age.
            this.ledger.setFinalWireClock(()=>{
              const now=this.now(),age=now-new Date(source.evaluated_at).getTime();
              const wireAdmission=this.startTiming("wire_source_admission",{intentId:id,evaluationId:i.evaluation_id});
              try {
              requireProof(age>=0&&age<=p.maxQuoteAgeMs&&
                ["btc_provider_age_ms","btc_receive_age_ms","market_age_ms"].every(k=>
                  typeof source[k]==="number"&&source[k]>=0&&source[k]+age<=p.maxQuoteAgeMs),
                "production_final_wire_source_expired");
              requireProof(now-book.observedAtMs>=0&&now-book.observedAtMs<=p.maxQuoteAgeMs&&
                now-book.fee.verifiedAtMs>=0&&now-book.fee.verifiedAtMs<=p.maxFeeEvidenceAgeMs&&
                a.reconciled_at&&now-a.reconciled_at.getTime()>=0&&now-a.reconciled_at.getTime()<=15000,
                "production_final_wire_evidence_expired");
              wireAdmission("eligible",{sourceAgeMs:age,sourceToDecisionAgeMs:
                Math.max(...["btc_provider_age_ms","btc_receive_age_ms","market_age_ms"].map(k=>source[k]+age))});
              }catch(error){wireAdmission("rejected",{error,sourceAgeMs:age,sourceToDecisionAgeMs:
                Math.max(...["btc_provider_age_ms","btc_receive_age_ms","market_age_ms"].map(k=>source[k]+age))});throw error;}
            });
          }
          // Trusted transports cannot send before this callback succeeds.
          // Earlier local failures therefore prove that no POST was attempted;
          // failures after success remain UNKNOWN and are never replayed.
          invoked = true;
          finalTiming("completed");
          }catch(error){finalTiming("rejected",{error});throw error;}
        };
        ProductionExecutor.#fences.add(final);
        // One full fresh proof at the transport's last asynchronous boundary.
        // Durable authorization locks remain held through signing and sending.
        await this.exchange.submit(i.request, final);
        this.fault("after_post_before_commit");
        await tx.query("UPDATE v13_production_intent SET state='UNKNOWN' WHERE id=$1", [id]);
        await this.ledger.observe(tx, "POST_ATTEMPT", { id, clientOrderId: i.client_order_id, outcome: "GET_RECONCILIATION_REQUIRED" });
        await this.ledger.persist(tx, a);
      });
      dispatchTiming("reconciliation_required");
    } catch (error) {
      // Even a rejected/timeout response is not terminal account evidence.
      await this.ledger.transaction(async (tx, a) => {
        const failed = (await tx.query<Intent>("SELECT * FROM v13_production_intent WHERE id=$1 FOR UPDATE", [id])).rows[0]!;
        if (!invoked || isEntryWireClockRefusal(error,failed.client_order_id)) {
          dispatchTiming("proven_not_posted",{error});
          const i = failed;
          requireProof(i.state === "DISPATCHED" && money(i.filled_hundredths) === 0n, "production_local_abort_identity_changed");
          a.reserved_micros = String(money(a.reserved_micros) - money(i.reserved_micros));
          await tx.query("UPDATE v13_production_intent SET state='BLOCKED',terminal=true,reserved_micros=0 WHERE id=$1", [id]);
          await this.ledger.observe(tx, "PROVEN_NOT_POSTED", { id, reason: (error as Error).message });
        } else {
          dispatchTiming("post_uncertain",{error});
          await tx.query("UPDATE v13_production_intent SET state='UNKNOWN' WHERE id=$1 AND state='DISPATCHED'", [id]);
          await this.ledger.observe(tx, "POST_UNCERTAIN", { id, reason: (error as Error).message });
        }
        await this.ledger.persist(tx, a);
        await this.ledger.assertConservation(tx, a);
      });
      throw error;
    }
  }

  async cancel(id: string): Promise<void> {
    // Cancellation is at most one LOCAL attempt; no claim of exchange exactly-once.
    const order = await this.ledger.transaction(async (tx, a) => {
      const i = (await tx.query<Intent>("SELECT * FROM v13_production_intent WHERE id=$1 AND account_id=$2 FOR UPDATE", [id, a.id])).rows[0];
      requireProof(i && i.exchange_order_id && !i.terminal, "production_cancel_identity_unproven");
      if (i.cancel_attempted) return null;
      // Cancellation of a known uncertain order is allowed, but all OTHER
      // uncertainty, ownership, approval and kill-switch barriers still apply.
      await this.gate(tx, a, i.kind === "EXIT", id);
      await this.ledger.policy(tx, a);
      await tx.query("UPDATE v13_production_intent SET cancel_attempted=true,state='UNKNOWN' WHERE id=$1", [id]);
      await this.ledger.persist(tx, a);
      return i;
    });
    if (!order) return;
    this.fault("after_cancel_commit");
    await this.ledger.transaction(async (tx, a) => {
      const final = async () => {
        await this.gate(tx, a, order.kind === "EXIT", id);
        requireProof(a.execution_enabled && !a.kill_switch && a.commissioned &&
          identity(a).keyFingerprint === (order.decision.identity as { keyFingerprint: string }).keyFingerprint,
        "production_cancel_gate_changed");
        const p = await this.ledger.policy(tx, a);
        requireProof(p.policyHash === order.policy_hash, "production_cancel_policy_changed");
        if (this.exchange.mode === "LIVE" && this.accountOwnerUserId) {
          const master = await tx.query("SELECT manual_kill_switch, live_execution_enabled FROM live_execution_config");
          requireProof(master.rows.length === 1 && master.rows[0].manual_kill_switch === false &&
            master.rows[0].live_execution_enabled === true, "production_cancel_runtime_disabled");
        } else if (this.exchange.mode === "LIVE") requireProof(process.env.LIVE_EXECUTION_ENABLED === "true" &&
          process.env.V13_PRODUCTION_EXECUTION_ENABLED === "true", "production_cancel_runtime_disabled");
      };
      ProductionExecutor.#fences.add(final);
      await this.exchange.cancel(order.exchange_order_id!, final);
      await this.ledger.observe(tx, "CANCEL_ATTEMPT", { id, exchangeOrderId: order.exchange_order_id, outcome: "GET_RECONCILIATION_REQUIRED" });
      await this.ledger.persist(tx, a);
    });
  }
}

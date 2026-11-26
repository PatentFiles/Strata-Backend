import {runtimeSettledExitReceipt} from '../strata/runtimeSettledExitGuard';
import {settledReserveReadinessEnabled} from '../strata/armSettledReserveScope';
import {OWNED_GATE_READ_SQL} from "./ownedGateRead";
import {DirectEntrySource,assertDirectEntryQuoteEvidence,type DirectEvaluation} from "./directEntrySource";
import {encodeProductionOrder} from "./transport";
import {readPrepareEntryCapacity} from "./prepareEntryCapacity";
import {captureEntrySizingDiagnostics,type EntrySizingDiagnostics} from "./entrySizingDiagnostics";
import {FeeAuthorityTimingCapture,withFeeAuthorityTimingPurpose,withoutFeeAuthorityTiming} from "../strata/feeAuthorityTiming";
import type {FinalPublicMetadataHooks,FinalPublicMetadataContext} from "../strata/finalPublicMetadataPhases";
import {getMarketEvidenceReadTiming,type MarketEvidenceReadTiming} from "../strata/marketEvidenceReadTiming";
import {getOwnedFeeFailureStage,type OwnedFeeFailureStage} from "../strata/ownedFeeFailureDiagnostic";
import {OwnedFeedTimingCapture} from "../strata/ownedFeedReadTiming";
import type {CommittedForwardSourceHint} from "../forwardTestSignalWake";
import {ExecutionSubtimings} from "./executionSubtimings";
import {captureFinalComparison,type FinalComparisonDiagnostics} from "./finalComparisonDiagnostics";
import {entryCashProof,validEntryCashRisk,samePinnedCashModel,pinnedEntryDepthAvailable,type V13EntryCashProof} from "../v13EntryCashRisk";
import {conservativeExitFeeMicros} from "./fractionalExitFee";
import {requestQuantityHundredths,EXIT_QUANTITY_VERSION} from "./requestQuantity";
import {planFractionalIocExit} from "./fractionalExitPlanner";
import {assertCanonicalEntryQuoteEvidence} from "./entryQuoteEvidence";
import {assertChampionSourceReference} from "./sourceReference";
import {captureEntryPriceDiagnostics, type EntryPriceDiagnostics} from "./entryPriceDiagnostics";
import {beginExecutionStage,type TimingObserver,type ExecutionStage,type StageContext} from "./stageTiming";
import {isEntryWireClockRefusal} from "../strata/entryWireClock";
import {isReviewedApiFeeWireRefusal} from "../strata/guardedReviewedApiFeeWire";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "@workspace/db";
import { V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET, V13_ENTRY_POLICY_VERSION,
  V13_LEGACY_ENTRY_POLICY, previousBufferFromSide, evaluateV13Strategy } from "@workspace/v13-strategy";
import { remainingLossBudgetAllowsEntry } from "../v13LiveMoneyRisk";
import { preflightV13LiveMoneyEntry } from "../v13LiveMoneyEntryPreflight";
import {verifyWalletV4FinalSignedAdmission} from "../strata/walletV4FinalSignedAdmission";
import {DYNAMIC_FEE_POLICY_VERSION_V4} from "../strata/dynamicFeeOrderRiskV4";
import { planV13IocEntry, signalCap } from "../v13ExecutionPlanner";
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
/** Scheduling metadata only: never substitutes for entry/exit authorization. */
export type ReconcileSchedulingContext = Readonly<{
  origin: "normal" | "committed_signal";
  allowEarlyTechnicalLeaseReuse: boolean;
}>;
export type ReconcileSchedulingResult = {technicalRenewal: "deferred" | "settled"} | void;

/** Diagnostic, process-local proof of the exact first market read boundary.
 * Not a durable receipt, a replacement permission, or an order capability.
 */
export type FirstOwnedMarketFeeRefusal = Readonly<{
  accountId:string;
  sourceId:string;
  crossingKey:string;
  sourceSha256:string;
  failureStage:OwnedFeeFailureStage;
}>;
export type FirstReadReceiptWorkerPin = Readonly<{
 ownerId:string; releaseSha:string; holderId:string; fencingToken:string; credentialFingerprint:string;
}>;
/** Explicit trusted bootstrap only, never a route, flag or the ordinary ledger pool. */
export type FirstReadReceiptWriter = Readonly<{
 pin:FirstReadReceiptWorkerPin;
 database:Pick<ProductionLedger["pool"],"query">;
}>;
export class ProductionExecutor {
  static #fences = new WeakSet<() => Promise<void>>();
  static readonly #seenFirstReadErrors = new WeakSet<object>();
  static readonly #ambiguousFirstReadErrors = new WeakSet<object>();
  static readonly #simulationFirstRead = new WeakMap<object,FirstOwnedMarketFeeRefusal>();
  readonly #liveFirstRead = new WeakMap<object,FirstOwnedMarketFeeRefusal>();
  #firstReadWriter:FirstReadReceiptWriter|null=null;
  static readFirstMarketFeeRefusal(error:unknown):FirstOwnedMarketFeeRefusal|undefined{
    if(error===null||typeof error!=="object")return undefined;
    const receipt=this.#simulationFirstRead.get(error);
    this.#simulationFirstRead.delete(error);
    return this.#ambiguousFirstReadErrors.has(error)?undefined:receipt;
  }
  /** Set by actual production factories until independent source qualification. */
  private independentEntryHold = false;
  #directSource:DirectEntrySource|null=null;
  /** Test-only binding. Real factories remain contained; a source label or
   * environment flag alone cannot turn on independent live orders. */
  bindIndependentSimulationSource(source:DirectEntrySource):void {
    requireProof(this.exchange.mode==="SIMULATION"&&!this.#directSource&&source instanceof DirectEntrySource,
      "direct_entry_simulation_binding_invalid");
    source.assertSimulationBinding({accountId:this.ledger.accountId,ownerId:this.accountOwnerUserId});
    this.#directSource=source;
  }
  /** The actual owner factory supplies the source after existing release and
   * startup checks. The general unbound network transport stays contained. */
  bindIndependentLiveSource(source:DirectEntrySource):void{
    requireProof(this.exchange.mode==="LIVE"&&this.accountOwnerUserId&&!this.#directSource&&source instanceof DirectEntrySource,
      "direct_live_source_binding_invalid");
    source.assertExecutorBinding("LIVE",{accountId:this.ledger.accountId,ownerId:this.accountOwnerUserId});
    this.#directSource=source;
  }
  /** Disabled unless a trusted server bootstrap explicitly supplies a scoped writer.
   * No known production entry point calls this method. The SQL wrapper checks the
   * actual session ACL, current owner/lease/fence and exact release independently.
   */
  bindFirstReadReceiptWriter(binding:FirstReadReceiptWriter):void{
    const source=this.#directSource;
    requireProof(source&&this.exchange.mode==="LIVE"&&
      !this.#firstReadWriter&&binding.database!==this.ledger.pool,
      "direct_fee_refusal_writer_binding_invalid");
    this.assertDirectBinding(source);
    source.assertFirstReadReceiptWorkerPin(binding.pin);
    this.#firstReadWriter=Object.freeze({database:binding.database,pin:Object.freeze({...binding.pin})});
  }
  async recordPinnedFirstReadReceipt(error:unknown):Promise<boolean>{
    if(error===null||typeof error!=="object")return false;
    const receipt=this.#liveFirstRead.get(error);
    // Consume before any await. Lost result, rejection or expired lease can
    // never turn into a source-replacement retry on an ambiguous outcome.
    this.#liveFirstRead.delete(error);
    const source=this.#directSource,writer=this.#firstReadWriter;
    if(ProductionExecutor.#ambiguousFirstReadErrors.has(error)||!receipt||!source||!writer||this.exchange.mode!=="LIVE"||
      receipt.accountId!==this.ledger.accountId)return false;
    this.assertDirectBinding(source);
    const pin=writer.pin;
    source.assertFirstReadReceiptWorkerPin(pin);
    const result=await writer.database.query(
      "SELECT CASE WHEN current_user='strata_direct_retry_receipt_writer' AND session_user='strata_direct_retry_receipt_writer' "+
      "THEN private.strata_record_worker_first_market_fee_refusal($1,$2::uuid,$3,$4,$5::bigint,$6,$7,$8,$9) ELSE false END AS recorded",
      [receipt.accountId,pin.ownerId,pin.releaseSha,pin.holderId,pin.fencingToken,pin.credentialFingerprint,
       receipt.crossingKey,receipt.sourceId,receipt.sourceSha256]);
    return result.rows.length===1&&result.rows[0]?.recorded===true;
  }
  get independentSourceBound():boolean{return this.#directSource!==null;}
  get independentSimulationBound():boolean{return this.independentSourceBound&&this.exchange.mode==="SIMULATION";}
  private assertDirectBinding(source:DirectEntrySource):void{
    source.assertExecutorBinding(this.exchange.mode,{accountId:this.ledger.accountId,ownerId:this.accountOwnerUserId});
  }
  private assertLiveSourceQuote(source:unknown):void{
    if(this.exchange.mode!=="LIVE")return;
    if(this.#directSource)assertDirectEntryQuoteEvidence(source,this.now());
    else assertCanonicalEntryQuoteEvidence(source,this.now());
  }
  async captureIndependentEntry():Promise<string|null>{
    const source=this.#directSource;
    requireProof(source,"direct_entry_source_binding_invalid");
    this.assertDirectBinding(source);
    return source.capture(this.ledger.pool);
  }
  async captureIndependentExit(parentId:string):Promise<string|null>{
    const source=this.#directSource;
    requireProof(source,"direct_held_source_binding_invalid");
    this.assertDirectBinding(source);
    return source.captureHeld(this.ledger.pool,parentId);
  }
  private assertIntentSourceKind(i:Intent):void {
    if(i.kind==="EXIT"){
      const owned=i.decision?.ownedEvaluation as {sourceDirectHeldId?:unknown}|undefined;
      if(this.#directSource||owned?.sourceDirectHeldId!=null){
        requireProof(this.#directSource&&typeof owned?.sourceDirectHeldId==="string","direct_held_intent_source_mismatch");
        this.assertDirectBinding(this.#directSource);
      }
      return;
    }
    if(i.kind!=="ENTRY")return;
    if(this.#directSource||i.direct_source_id!=null){
      requireProof(this.#directSource&&i.direct_source_id&&i.evaluation_id===null,
        "direct_entry_intent_source_mismatch");
      this.assertDirectBinding(this.#directSource);
    }
  }
  containLiveEntries():void { this.independentEntryHold=true; }
  get liveEntryContained():boolean { return this.independentEntryHold; }
  private assertEntrySourceAvailable():void {
    requireProof(!this.independentEntryHold, "production_independent_entry_source_unavailable");
  }
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
  afterReconcile: ((snapshot: Snapshot, subtimings?:ExecutionSubtimings, scheduling?:ReconcileSchedulingContext) => Promise<ReconcileSchedulingResult>) | null = null;
  /** Sticky same-session recovery. Server-owned closure always uses native held
   * ledger reconciliation; presence suppresses authority renewal permanently. */
  heldReconcile: ((snapshot:Snapshot,revision:string)=>Promise<{accountId:string;observationId:string}>)|null=null;
  /** Public-only optional scheduling hook. Never fee/account/order authority. */
  prefetchCommittedPublicMetadata: ((hint:CommittedForwardSourceHint)=>{
    source:CommittedForwardSourceHint;pause?():void;discard(reason?:string):void;drained:Promise<void>;
  }|null)|null=null;
  finalPublicMetadata:FinalPublicMetadataHooks|null=null;
  /** Internal opt-in scheduling only; no client or authority input. */
  overlapFinalAccountSnapshot = false;
  private phaseContext(i:Intent,invocation:symbol|undefined):FinalPublicMetadataContext|null {
    if(!invocation)return null;
    const source=i.decision?.source as Record<string,any>|undefined;
    if(!source||typeof source!=="object")return null;
    try{return {intentId:i.id,invocation,source:{evaluationId:(i.direct_source_id??i.evaluation_id)!,marketTicker:i.market,
      evaluatedAtMs:new Date(source.evaluated_at).getTime(),btcProviderAgeMs:source.btc_provider_age_ms,
      btcReceiveAgeMs:source.btc_receive_age_ms,marketAgeMs:source.market_age_ms}};}catch{return null;}
  }
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

  #committedSettlementSnapshot:Snapshot|null=null;
  private async settledExitGuard(tx:PoolClient,a:Account,currentIntentId:string|null,snapshot=this.#committedSettlementSnapshot){
    if(!snapshot||!this.accountOwnerUserId||this.exchange.mode!=="LIVE")return null;
    const receipt=await runtimeSettledExitReceipt(tx,{accountId:a.id,ownerId:this.accountOwnerUserId,snapshot,
      nowMs:this.now(),currentIntentId,lock:true});
    const age=this.now()-snapshot.observedAtMs;
    return receipt&&age>=0&&age<=5000?receipt:null;
  }
  async gate(tx: PoolClient, a: Account, allowBlockedExit = false, ignoreIntentId: string | null = null, lifecycle = false,
    settledOrderProofAllowed=true): Promise<void> {
    requireProof(a.commissioned && !a.kill_switch && a.execution_enabled &&
      /^[0-9a-f]{64}$/.test(a.commissioning_digest ?? "") &&
      Number(a.subaccount) === 1 && Number(a.exchange_index) === 2, "production_authority_disabled_or_uncommissioned");
    requireProof(a.cash_precision_verified && /^[0-9a-f]{64}$/.test(a.fee_artifact_digest ?? ""),
      "production_fee_or_cash_precision_approval_missing");
    requireProof(!a.blocked_reason || allowBlockedExit || lifecycle, "production_account_frozen");
    requireProof(a.reconciled_at && a.reconciled_at.getTime() <= this.now() &&
      this.now() - a.reconciled_at.getTime() <= 15_000, "production_reconciliation_stale");
    // Preserve each gate boundary and refusal order. Only its independent
    // non-locking reads are batched; locked policy decoding remains separate.
    let ownedGate = this.accountOwnerUserId ? (await tx.query(OWNED_GATE_READ_SQL,
      [a.id,ignoreIntentId,lifecycle,this.accountOwnerUserId])).rows[0] : null;
    if(ownedGate?.has_uncertain_order===true&&!lifecycle&&settledOrderProofAllowed&&this.accountOwnerUserId){
      const proved=await this.settledExitGuard(tx,a,ignoreIntentId);
      if(proved){
        // Only the signed, exact retired pair was checked. Re-read the
        // original master and policy gates; lifecycle mode is only a SQL
        // projection here and never permits skipping any other gate.
        const facts=(await tx.query(OWNED_GATE_READ_SQL,[a.id,ignoreIntentId,true,this.accountOwnerUserId])).rows[0];
        if(facts)ownedGate={...facts,has_uncertain_order:false};
      }
    }
    const unknown = ownedGate ? null : await tx.query(`SELECT id FROM v13_production_intent WHERE account_id=$1
      AND state IN ('DISPATCHED','UNKNOWN') AND ($2::text IS NULL OR id<>$2)`, [a.id, ignoreIntentId]);
    requireProof(lifecycle || (ownedGate ? ownedGate.has_uncertain_order === false : unknown!.rows.length === 0),
      "production_uncertain_order_blocks_mutation");
    if (this.accountOwnerUserId) {
      requireProof(ownedGate && ownedGate.owner_user_id === this.accountOwnerUserId,
        "foreign_execution_account");
      const master = {rows:Array.isArray(ownedGate.master_rows)?ownedGate.master_rows:[]};
      requireProof(master.rows.length === 1 && master.rows[0]?.manual_kill_switch === false &&
        master.rows[0]?.live_execution_enabled === true, "production_master_kill_switch_or_flag");
      const policy = {rows:Array.isArray(ownedGate.policy_rows)?ownedGate.policy_rows:[]};
      requireProof(policy.rows.length === 1 && /^[0-9a-f]{64}$/.test(String(policy.rows[0]?.policy_hash ?? "")),
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

  async reconcile(): Promise<void>;
  async reconcile(scheduling:ReconcileSchedulingContext): Promise<ReconcileSchedulingResult>;
  async reconcile(scheduling:ReconcileSchedulingContext = Object.freeze({origin:"normal",allowEarlyTechnicalLeaseReuse:false})): Promise<ReconcileSchedulingResult> {
    const done=this.startTiming("reconciliation");
    let schedulingResult:ReconcileSchedulingResult=undefined;
    try {
      this.#committedSettlementSnapshot=null;
      const { account: a, earliest: floor } = await this.ledger.readReconcileAccount();
      const signed=this.startTiming("signed_snapshot"),feedTiming=new OwnedFeedTimingCapture();
      let snapshot:Snapshot;
      try {snapshot=await feedTiming.run(()=>this.exchange.snapshot(identity(a), floor ? new Date(floor).getTime() : this.now()));signed("completed",{signedFeedReads:feedTiming.snapshot(),signedSnapshotPhases:feedTiming.snapshotPhases()});}
      catch(error){signed("rejected",{error,signedFeedReads:feedTiming.snapshot(),signedSnapshotPhases:feedTiming.snapshotPhases()});throw error;}
      const commit=this.startTiming("ledger_reconcile_commit");
      try {const reconciliationReceipt=this.heldReconcile
          ?await this.heldReconcile(snapshot,a.revision)
          :await this.ledger.reconcile(snapshot,a.revision,this.now());
        if(!this.heldReconcile&&this.accountOwnerUserId&&this.exchange.mode==="LIVE"&&settledReserveReadinessEnabled())
          this.#committedSettlementSnapshot=structuredClone(snapshot);
        commit("completed",{reconciliationReceipt});}
      catch(error){commit("rejected",{error});throw error;}
      if(this.afterReconcile&&!this.heldReconcile){
        const after=this.startTiming("after_reconcile"),subtimings=new ExecutionSubtimings();
        try{schedulingResult=await this.afterReconcile(snapshot,subtimings,scheduling);after("completed",{substageTimings:subtimings.snapshot(true)});}
        catch(error){after("rejected",{error,substageTimings:subtimings.snapshot(false)});throw error;}
      }
      done("completed");
      return schedulingResult;
    }catch(error){this.#committedSettlementSnapshot=null;done("rejected",{error});throw error;}
  }

  async prepareEntry(evaluationId: string): Promise<string> {
    this.assertEntrySourceAvailable();
    const done=this.startTiming("prepare_entry",{evaluationId});
    const diagnostics: {price?: EntryPriceDiagnostics;sizing?:EntrySizingDiagnostics;subtimings:ExecutionSubtimings} = {subtimings:new ExecutionSubtimings()};
    try{const id=await this.prepareEntryMeasured(evaluationId, diagnostics);done("completed",{entryPrice:diagnostics.price,entrySizing:diagnostics.sizing,substageTimings:diagnostics.subtimings.snapshot(true)});return id;}
    catch(error){done("rejected",{error,entryPrice:diagnostics.price,entrySizing:diagnostics.sizing,substageTimings:diagnostics.subtimings.snapshot(false)});throw error;}
  }
  private async prepareEntryMeasured(evaluationId: string, diagnostics: {price?: EntryPriceDiagnostics;sizing?:EntrySizingDiagnostics;subtimings:ExecutionSubtimings}): Promise<string> {
    const subtimings=diagnostics.subtimings;subtimings.mark("source_read_and_validation");
    const direct=this.#directSource;
    if(direct)this.assertDirectBinding(direct);
    const source = direct?await direct.readExact(this.ledger.pool,evaluationId,this.now()):
      (await this.ledger.pool.query("SELECT * FROM forward_test_evaluations WHERE id=$1", [evaluationId])).rows[0];
    requireProof(source && source.evaluation_source === (direct?(direct.environment==="SIMULATION"?"direct_simulation_v1":"direct_live_v1"):"paper") &&
      source.strategy_parameter_set_id === V13_CHAMPION_PARAMETER_SET.id &&
      source.strategy_parameter_hash === V13_CHAMPION_PARAMETER_HASH &&
      source.qualifying_trigger && source.fresh_cross && !source.position_was_open &&
      source.crossing_key && source.feed_freshness === "current" &&
      ["SCOUT", "CONFIRM"].includes(source.signal) && ["UP", "DOWN"].includes(source.direction),
    "production_source_not_qualifying_champion");
    assertChampionSourceReference(source);
    // Reuse the existing canonical-evidence clock sample; never refresh a source
    // timestamp. This only avoids provider work for an already-expired LIVE feed.
    let feedAlreadyExpired = false;
    let initialSourceElapsed: number | null = null;
    if(this.exchange.mode==="LIVE") {
      const sampledNow = this.now();
      if(direct)assertDirectEntryQuoteEvidence(source,sampledNow);else assertCanonicalEntryQuoteEvidence(source,sampledNow);
      const elapsed = sampledNow - new Date(source.evaluated_at).getTime();
      initialSourceElapsed = elapsed;
      const ages = [source.btc_provider_age_ms,source.btc_receive_age_ms,source.market_age_ms];
      feedAlreadyExpired = ages.every(age => typeof age === "number" && Number.isFinite(age) && age >= 0) &&
        ages.some(age => age + elapsed > 5000);
    }
    const side = source.direction === "UP" ? "YES" : "NO";
    subtimings.mark("market_evidence");
    const readBook = () => this.exchange.market(source.market_ticker, side, {
      stage:"prepare",evaluationId,marketTicker:source.market_ticker,
      evaluatedAtMs:new Date(source.evaluated_at).getTime(),
      btcProviderAgeMs:source.btc_provider_age_ms,btcReceiveAgeMs:source.btc_receive_age_ms,marketAgeMs:source.market_age_ms,
    });
    let book:MarketEvidence|null;
    try{book=feedAlreadyExpired?null:await readBook();}
    catch(error){
      // Only this await is before transaction acquisition. The later
      // compatibility read and FINAL/dispatch must never mark this proof.
      const failureStage=getOwnedFeeFailureStage(error);
      const sourceSha256=direct&&failureStage?DirectEntrySource.validatedSourceDigest(source):undefined;
      if(error!==null&&typeof error==="object"&&failureStage&&sourceSha256){
        const seen=ProductionExecutor.#seenFirstReadErrors;
        if(seen.has(error)){
          ProductionExecutor.#ambiguousFirstReadErrors.add(error);
          ProductionExecutor.#simulationFirstRead.delete(error);
          this.#liveFirstRead.delete(error);
        }else{
          seen.add(error);
          const receipt=Object.freeze({accountId:this.ledger.accountId,sourceId:evaluationId,
            crossingKey:source.crossing_key,sourceSha256,failureStage});
          // A LIVE diagnostic never escapes through the simulation accessor.
          if(this.exchange.mode==="SIMULATION")ProductionExecutor.#simulationFirstRead.set(error,receipt);
          else if(this.#firstReadWriter)this.#liveFirstRead.set(error,receipt);
        }
      }
      throw error;
    }
    // Diagnostics are bounded, best-effort, and never feed admission or sizing.
    if(book) diagnostics.price = captureEntryPriceDiagnostics(source, book);
    subtimings.mark("transaction_acquire");
    const prepare = () => this.ledger.transaction(async (tx, a) => {
      subtimings.mark("duplicate_and_authority");
      const prior = await tx.query<Intent>(direct?"SELECT * FROM v13_production_intent WHERE account_id=$1 AND (direct_source_id=$2 OR crossing_key=$3)":"SELECT * FROM v13_production_intent WHERE account_id=$1 AND (evaluation_id=$2 OR crossing_key=$3)", [a.id, evaluationId, source.crossing_key]);
      if (prior.rows.length) {this.assertIntentSourceKind(prior.rows[0]!);return prior.rows[0]!.id;} // duplicate event: no new reservation/capability
      await this.gate(tx, a);
      subtimings.mark("policy_and_window");
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
        if(!direct)await this.assertEntryPolicyWindow(tx, source);
      }
      subtimings.mark("source_pin_and_classification");
      const sourceAge = this.now() - new Date(source.evaluated_at).getTime();
      const admission=this.startTiming("evaluation_age_admission",{evaluationId});
      const sourceCurrent=sourceAge >= 0 && sourceAge <= p.maxQuoteAgeMs;
      admission(sourceCurrent?"eligible":"rejected",{sourceAgeMs:sourceAge,
        ...(sourceCurrent?{}:{error:"production_evaluation_stale"})});
      requireProof(sourceCurrent, "production_evaluation_stale");
      const pinnedSource = direct?await direct.readExact(tx,evaluationId,this.now()):(await tx.query("SELECT * FROM forward_test_evaluations WHERE id=$1 FOR SHARE", [evaluationId])).rows[0];
      // Preserve prior-intent replay and all authority/policy/window checks above.
      // An expired observation cannot become eligible after a wall-clock rollback.
      // Provider-error precedence is intentionally omitted on this stale-only path.
      requireProof(canonical(pinnedSource) === canonical(source) &&
        ["btc_provider_age_ms", "btc_receive_age_ms", "market_age_ms"].every(k =>
          typeof source[k] === "number" && Number.isFinite(source[k]) && source[k] >= 0 &&
          source[k] + sourceAge <= p.maxQuoteAgeMs &&
          (!feedAlreadyExpired || source[k] + initialSourceElapsed! <= p.maxQuoteAgeMs)), "production_source_feed_stale_or_changed");
      // Wider legacy policies may still admit this observation. Release locks
      // before real provider reads, then repeat all authoritative checks below.
      if(book === null) return null;
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
      assertChampionSourceReference(source);
      this.assertLiveSourceQuote(source);
      subtimings.mark("exposure_and_stake");
      const b = await readPrepareEntryCapacity((sql,params)=>tx.query(sql,params),a.id,
        new Date(new Date(this.now()).toISOString().slice(0,10)));
      const capital = BigInt(p.capitalLimitCents) * 10_000n - money(b.basis) - money(a.reserved_micros) - money(b.total_loss);
      requireProof(capital >= 0n, "production_capital_exhausted");
      const stake = await this.readConfiguredStake(tx);
      requireProof(stake.cents <= p.maxEntryStakeCents, "configured_stake_above_approved_maximum");
      const preflightInput = {
        policy: p, strategyParameterSetId: source.strategy_parameter_set_id, strategyParameterHash: source.strategy_parameter_hash,
        signal: source.signal, direction: source.direction, referenceOffer: source.entry_offer,
        bestAskDollars: book.bestAskDollars, askLevels: book.asks,
        quoteAgeMs: this.now() - book.observedAtMs, nowMs: this.now(), feeEvidence: book.fee,
        availableCashCents: cents(money(a.cash_micros) - money(a.reserved_micros)),
        capitalRemainingCents: cents(capital), openPositions: Number(b.open),
        realizedDailyLossCents: Math.ceil(Number(money(b.daily_loss)) / 10_000),
        realizedTotalLossCents: Math.ceil(Number(money(b.total_loss)) / 10_000),
        configuredStakeCents: stake.cents, requireCashRisk:this.exchange.mode==="LIVE",
      };
      const pf=preflightV13LiveMoneyEntry(preflightInput);
      diagnostics.sizing=captureEntrySizingDiagnostics(preflightInput,pf);
      requireProof(pf.ok, pf.ok ? "" : pf.reason);
      if(pf.cashRisk)requireProof(book.fee.cashRisk&&book.fee.cashRisk.marketTicker===source.market_ticker&&book.fee.cashRisk.side===side&&
        book.fee.cashRisk.policyHash===p.policyHash,"production_cash_risk_identity_invalid");
      const id = randomUUID(), clientOrderId = `v13p-${id}`;
      const request: Request = { market: source.market_ticker, side, action: "BUY", contracts: pf.plan.contracts,
        limitMicros: Math.round(pf.plan.limitPrice * 1_000_000), timeInForce: "IOC", reduceOnly: false, clientOrderId };
      const preparedBook=pf.selectedFeeEvidence?{...book,fee:pf.selectedFeeEvidence}:book;
      const decision = {
        source, book:preparedBook, preflight: pf, policy: p, identity: identity(a),
        configuredStakeCents: stake.cents, stakeRevision: stake.revision,
      };
      const cap = digest({ id, request, decision, policyHash: pf.policyHash, fee: pf.feeEvidenceFingerprint });
      const reservation = BigInt(pf.plannedAllInCents) * 10_000n;
      a.reserved_micros = String(money(a.reserved_micros) + reservation);
      subtimings.mark("reservation_and_conservation");
      // Fixed server-side column choice. Existing paper-linked records remain intact.
      await tx.query(`INSERT INTO v13_production_intent(id,account_id,${direct?"direct_source_id":"evaluation_id"},crossing_key,kind,market,side,
        request,decision,policy_hash,fee_fingerprint,capability_digest,client_order_id,reserved_micros,exit_fee_micros)
        VALUES($1,$2,$3,$4,'ENTRY',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, a.id, evaluationId, source.crossing_key, request.market, side, JSON.stringify(request), JSON.stringify(decision),
        pf.policyHash, pf.feeEvidenceFingerprint, cap, clientOrderId, String(reservation), String(BigInt(pf.cashRisk?.reservedExitFeeCents??book.fee.reservedExitFeeCents) * 10_000n)]);
      await tx.query("INSERT INTO v13_production_position(id,account_id,market,side) VALUES($1,$2,$3,$4)", [id, a.id, request.market, side]);
      this.fault("after_reservation");
      await this.ledger.persist(tx, a);
      await this.ledger.assertConservation(tx, a);
      return id;
    });
    const prepared = await prepare();
    if(prepared !== null) return prepared;
    subtimings.mark("market_evidence");
    book = await readBook();
    diagnostics.price = captureEntryPriceDiagnostics(source,book);
    subtimings.mark("transaction_acquire");
    const retried = await prepare();
    requireProof(retried !== null, "production_source_feed_stale_or_changed");
    return retried;
  }

  async prepareExit(parentId: string, minimumExitPrice: number, directHeldId?:string): Promise<string> {
    const direct=this.#directSource;
    requireProof((direct!==null)=== (directHeldId!==undefined),"direct_held_intent_source_mismatch");
    if(direct)this.assertDirectBinding(direct);
    const parent = (await this.ledger.pool.query<Intent>("SELECT * FROM v13_production_intent WHERE id=$1 AND account_id=$2", [parentId, this.ledger.accountId])).rows[0];
    requireProof(parent?.kind === "ENTRY", "production_exit_parent_missing");
    const book = await this.exchange.market(parent.market, parent.side, undefined, "EXIT");
    return this.ledger.transaction(async (tx, a) => {
      await this.gate(tx, a, true);
      const p = await this.ledger.policy(tx, a);
      requireProof(a.minimum_exit_micros === Math.round(minimumExitPrice * 1_000_000), "production_exit_floor_not_approved");
      requireProof(parent.terminal, "production_entry_not_terminal");
      const active = await tx.query("SELECT id FROM v13_production_intent WHERE parent_id=$1 AND state NOT IN ('TERMINAL','BLOCKED')", [parentId]);
      requireProof(active.rows.length === 0, "production_exit_already_pending");
      const pos = (await tx.query("SELECT * FROM v13_production_position WHERE id=$1 FOR UPDATE", [parentId])).rows[0];
      requireProof(pos && money(pos.quantity_hundredths) > 0n, "production_exit_not_owned");
      const source = direct?await direct.readHeldExact(tx,directHeldId!,parentId,this.now()):(await tx.query(`SELECT * FROM forward_test_evaluations WHERE evaluation_source='paper'
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
      // Exact hundredths protect partial fills without increasing entry sizing.
      const plan = planFractionalIocExit({ ownedHundredths:qty.toString(),bestBidDollars:book.bestBidDollars,
        bidLevels:book.bids,minimumExitMicros:Math.round(minimumExitPrice*1_000_000) });
      requireProof(plan.ok, plan.ok ? "" : plan.reason);
      requireProof(this.now() - book.observedAtMs >= 0 && this.now() - book.observedAtMs <= p.maxQuoteAgeMs &&
        this.now() - book.fee.verifiedAtMs >= 0 && this.now() - book.fee.verifiedAtMs <= p.maxFeeEvidenceAgeMs &&
        book.fee.policyVersion === p.feePolicyVersion && book.fee.formulaVersion === p.feeFormulaVersion &&
        book.fee.sourceUrl === p.feeSourceUrl && book.fee.fingerprint.length >= 16 &&
        Number.isSafeInteger(book.fee.reservedExitFeeCents) && book.fee.reservedExitFeeCents >= 0 &&
        conservativeExitFeeMicros(book.fee,plan.plan.plannedHundredths) <= money(parent.reserved_micros), "production_exit_fee_or_quote_unproven");
      const id = randomUUID();
      const request: Request = { market: parent.market, side: parent.side, action: "SELL",
        quantityVersion:EXIT_QUANTITY_VERSION,quantityHundredths:plan.plan.plannedHundredths,limitMicros:plan.plan.limitMicros,
        timeInForce: "IOC", reduceOnly: true, clientOrderId: `v13p-${id}` };
      const decision = { book, plan: plan.plan, minimumExitPrice, policy: p, identity: identity(a), parentId,
        ownedEvaluation: { position: pos, source, ...(direct?{sourceDirectHeldId:source.id}:{sourcePaperEvaluationId:source.id}), decision: ownedDecision } };
      await tx.query(`INSERT INTO v13_production_intent(id,account_id,parent_id,kind,market,side,request,decision,
        policy_hash,fee_fingerprint,capability_digest,client_order_id,reserved_micros,exit_fee_micros)
        VALUES($1,$2,$3,'EXIT',$4,$5,$6,$7,$8,$9,$10,$11,0,0)`,
      [id, a.id, parentId, parent.market, parent.side, JSON.stringify(request), JSON.stringify(decision),
        p.policyHash, book.fee.fingerprint, digest({ id, request, decision, policyHash: p.policyHash, fee: book.fee.fingerprint }), request.clientOrderId]);
      await this.ledger.persist(tx, a);
      return id;
    });
  }

  dispatch(id: string): Promise<void> {
    // A nested dispatch must not contribute pre-submit authorization to its parent.
    // Scope exit is synchronous and returns the exact existing promise.
    return withoutFeeAuthorityTiming(()=>{
    if(!this.finalPublicMetadata)return this.dispatchWithPhases(id);
    const invocation=Symbol("dispatch-metadata");
    const operation=()=>this.dispatchWithPhases(id,invocation);
    return (this.finalPublicMetadata.dispatch?this.finalPublicMetadata.dispatch(id,invocation,operation):operation()).finally(()=>this.finalPublicMetadata?.finish(id,invocation));
    });
  }
  private async dispatchWithPhases(id:string,invocation?:symbol):Promise<void> {
    // Precommit dispatch identity BEFORE any network side effect. A crash in
    // the gap is indistinguishable from an uncertain POST, so NEVER replay it.
    const claimed = await this.ledger.transaction(async (tx, a) => {
      const i = (await tx.query<Intent>("SELECT * FROM v13_production_intent WHERE id=$1 AND account_id=$2 FOR UPDATE", [id, a.id])).rows[0];
      requireProof(i, "production_intent_missing");
      if (i.state !== "PREPARED") return false;
      requireProof(!(this.#directSource&&this.exchange.mode==="LIVE"&&i.kind==="EXIT"),"direct_live_exit_requires_signed_protective_dispatch");
      this.assertIntentSourceKind(i);
      if(i.kind==="ENTRY")this.assertEntrySourceAvailable();
      if(i.kind==="ENTRY"&&this.finalPublicMetadata){const context=this.phaseContext(i,invocation);if(context)this.finalPublicMetadata.start("FINAL_MARKET",context);}
      await this.gate(tx, a, i.kind === "EXIT");
      await tx.query("UPDATE v13_production_intent SET state='DISPATCHED',dispatch_at=$2 WHERE id=$1", [id, new Date(this.now())]);
      await this.ledger.persist(tx, a);
      return true;
    });
    if (!claimed) {
      this.startTiming("dispatch",{intentId:id})("noop_not_prepared");
      return;
    }
    this.fault("after_dispatch_commit");
    const dispatchTiming=this.startTiming("dispatch",{intentId:id});
    const feeAuthorityTiming={capture:null as FeeAuthorityTimingCapture|null};
    let invoked = false;
    try {
      await this.ledger.transaction(async (tx, a) => {
        const i = (await tx.query<Intent>("SELECT * FROM v13_production_intent WHERE id=$1 FOR UPDATE", [id])).rows[0]!;
        if(i?.kind==="ENTRY"&&this.timingObserver)feeAuthorityTiming.capture=new FeeAuthorityTimingCapture();
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
        if (i.kind === "ENTRY") {
          if(this.exchange.mode==="LIVE")requireProof((i.decision.preflight as {cashRisk?:unknown}|undefined)?.cashRisk&&
            (i.decision.book as MarketEvidence).fee.cashRisk,"production_cash_risk_unproven");
          assertChampionSourceReference(i.decision.source);
          this.assertLiveSourceQuote(i.decision.source);
        }
        if (i.kind === "ENTRY" && this.authorizeFinalEntry)
          await this.authorizeFinalEntry(tx);
        const final = async () => {
          const finalTiming=this.startTiming("final_preparation",{intentId:id,evaluationId:i.direct_source_id??i.evaluation_id});
          let finalComparison:FinalComparisonDiagnostics|undefined;
          let finalMarketReads:MarketEvidenceReadTiming|undefined;
          let pendingSnapshot:Promise<{ok:true;snapshot:Snapshot}|{ok:false;error:unknown}>|undefined;
          let snapshotHistoryFloor:Date|null|undefined;
          const readFinalSnapshot=async(oldest:Date|null)=>{
            const snapshotTiming=this.startTiming("final_signed_snapshot",{intentId:id,evaluationId:i.direct_source_id??i.evaluation_id}),feedTiming=new OwnedFeedTimingCapture();
            try{const snapshot=await feedTiming.run(()=>this.ledger.withFinalAccountSnapshot(i.kind === "ENTRY" ? i.id : null,
              () => this.exchange.snapshot(identity(a), new Date(oldest as Date).getTime())));
              snapshotTiming("completed",{signedFeedReads:feedTiming.snapshot(),signedSnapshotPhases:feedTiming.snapshotPhases()});return snapshot;}
            catch(error){snapshotTiming("rejected",{error,signedFeedReads:feedTiming.snapshot(),signedSnapshotPhases:feedTiming.snapshotPhases()});throw error;}
          };
          try {
          if(i.kind==="ENTRY")this.assertEntrySourceAvailable();
          // This intent itself is the ONLY allowed dispatched identity.
          const others = await tx.query("SELECT id FROM v13_production_intent WHERE account_id=$1 AND state IN ('DISPATCHED','UNKNOWN') AND id<>$2", [a.id, id]);
          const retired=others.rows.length?await this.settledExitGuard(tx,a,id):null;
          requireProof(others.rows.length===0||others.rows.length===1&&others.rows[0]?.id===retired?.exitId,
            "production_other_uncertain_order");
          await this.gate(tx, a, i.kind === "EXIT", id);
          const p = await this.ledger.policy(tx, a);
          requireProof(p.policyHash === i.policy_hash && canonical(identity(a)) === canonical(i.decision.identity) &&
            i.capability_digest === digest({ id: i.id, request: i.request, decision: i.decision, policyHash: i.policy_hash, fee: i.fee_fingerprint }),
          "production_capability_or_policy_changed");
          if(i.kind==="ENTRY"&&this.overlapFinalAccountSnapshot){
            snapshotHistoryFloor=(await tx.query("SELECT min(created_at) earliest FROM v13_production_intent WHERE account_id=$1",[a.id])).rows[0].earliest;
            // Only fresh read-only proof is overlapped. The child snapshot ALS
            // exemption never reaches the market sibling. Attach both handlers
            // immediately; every exit below drains before this transaction ends.
            pendingSnapshot=readFinalSnapshot(snapshotHistoryFloor!).then(snapshot=>({ok:true as const,snapshot}),error=>({ok:false as const,error}));
          }
          const phaseContext=i.kind==="ENTRY"&&this.finalPublicMetadata?this.phaseContext(i,invocation):null;
          const book = phaseContext&&this.finalPublicMetadata
            ?await this.finalPublicMetadata.finalMarket(phaseContext,()=>this.exchange.market(i.market,i.side,undefined,i.kind))
            :await this.exchange.market(i.market, i.side,undefined,i.kind);
          finalMarketReads=getMarketEvidenceReadTiming(book);
          const stored = i.decision.book as MarketEvidence;
          const pinnedCash=(i.decision.preflight as {cashRisk?:V13EntryCashProof}|undefined)?.cashRisk;
          if(i.kind==="ENTRY"&&this.exchange.mode==="LIVE")requireProof(pinnedCash,"production_cash_risk_unproven");
          const cashEntry=i.kind==="ENTRY"&&pinnedCash!==undefined;
          if(cashEntry){
            const source=i.decision.source as {market_ticker:string;signal:"SCOUT"|"CONFIRM";direction:"UP"|"DOWN";entry_offer:number};
            const preparedPlan=(i.decision.preflight as {plan:{contracts:number;limitPrice:number}}).plan;
            // Admissibility is not reoptimization. Pin the originally approved
            // request, while independently retaining its source price ceiling.
            requireProof(i.request.action==="BUY"&&!i.request.reduceOnly&&i.request.timeInForce==="IOC"&&
              i.request.market===source.market_ticker&&i.request.side===(source.direction==="UP"?"YES":"NO")&&
              i.request.limitMicros<=Math.round(Math.min(signalCap(source.signal),source.entry_offer)*1_000_000)&&
              preparedPlan?.contracts===i.request.contracts&&Math.round(preparedPlan.limitPrice*1_000_000)===i.request.limitMicros,
              "production_pinned_entry_request_changed");
            requireProof(validEntryCashRisk(stored.fee)&&stored.fee.cashRisk.marketTicker===i.market&&stored.fee.cashRisk.side===i.side&&
              stored.fee.cashRisk.policyHash===p.policyHash&&typeof i.request.contracts==="number"&&
              canonical(entryCashProof(stored.fee,i.request.contracts,pinnedCash.budgetCents))===canonical(pinnedCash)&&
              pinnedCash.limitMicros===i.request.limitMicros&&pinnedCash.feeFingerprint===i.fee_fingerprint&&
              BigInt(pinnedCash.plannedAllInCents)*10000n===money(i.reserved_micros),"production_pinned_cash_bound_changed");
          }
          try {
          requireProof((cashEntry?samePinnedCashModel(stored.fee,book.fee):book.fee.fingerprint === i.fee_fingerprint &&
            canonical({ ...book.fee, verifiedAtMs: 0 }) === canonical({ ...stored.fee, verifiedAtMs: 0 })) &&
            this.now() - book.observedAtMs >= 0 && this.now() - book.observedAtMs <= p.maxQuoteAgeMs &&
            this.now() - book.fee.verifiedAtMs >= 0 && this.now() - book.fee.verifiedAtMs <= p.maxFeeEvidenceAgeMs,
          "production_final_fee_or_quote_changed");
          }catch(error){
            // Diagnostics follow the unchanged short-circuit guard. No extra
            // this.now() call, changed timestamp, provider read or authority.
            try{finalComparison=captureFinalComparison({cashEntry,stored,fresh:book,
              pinnedFingerprint:i.fee_fingerprint,requestContracts:i.request.contracts,
              pinnedLimitMicros:i.request.limitMicros,source:i.decision.source,
              maxQuoteAgeMs:p.maxQuoteAgeMs,maxFeeEvidenceAgeMs:p.maxFeeEvidenceAgeMs,sampledAtMs:Date.now()});}catch{/* Optional evidence only. */}
            throw error;
          }
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
          const plan = i.kind === "ENTRY" ? (cashEntry?{ok:true as const,plan:{contracts:i.request.contracts!,limitPrice:i.request.limitMicros/1_000_000}}:planV13IocEntry({
            signal: (i.decision.source as { signal: "SCOUT" | "CONFIRM" }).signal,
            direction: i.side === "YES" ? "UP" : "DOWN", referenceOffer: (i.decision.source as { entry_offer: number }).entry_offer,
            maxStakeCents: entryStake, bestAskDollars: book.bestAskDollars, askLevels: book.asks,
          })) : planFractionalIocExit({ownedHundredths:requestQuantityHundredths(i.request).toString(),
            bestBidDollars:book.bestBidDollars,bidLevels:book.bids,
            minimumExitMicros:Math.round((i.decision.minimumExitPrice as number)*1_000_000)});
          if(cashEntry)requireProof(pinnedEntryDepthAvailable(book.bestAskDollars,book.asks,i.request.contracts!,i.request.limitMicros),"production_final_depth_changed");
          requireProof(plan.ok && (i.kind === "ENTRY" ? ("contracts" in plan.plan && plan.plan.contracts === i.request.contracts) :
            ("plannedHundredths" in plan.plan && BigInt(plan.plan.plannedHundredths) === requestQuantityHundredths(i.request))) &&
            ("limitMicros" in plan.plan?plan.plan.limitMicros:Math.round(plan.plan.limitPrice * 1_000_000)) === i.request.limitMicros, "production_final_depth_changed");
          if (i.kind === "EXIT") {
            const feeParent=(await tx.query("SELECT reserved_micros FROM v13_production_intent WHERE id=$1 AND account_id=$2 FOR SHARE",[i.parent_id,a.id])).rows[0];
            requireProof(feeParent&&conservativeExitFeeMicros(book.fee,requestQuantityHundredths(i.request).toString())<=money(feeParent.reserved_micros),"production_exit_fee_reservation_insufficient");
            requireProof(a.minimum_exit_micros === Math.round((i.decision.minimumExitPrice as number) * 1_000_000),
              "production_exit_floor_changed");
            const pos = (await tx.query("SELECT quantity_hundredths FROM v13_production_position WHERE id=$1 FOR UPDATE", [i.parent_id])).rows[0];
            requireProof(pos && money(pos.quantity_hundredths) >= requestQuantityHundredths(i.request) && i.request.reduceOnly,
              "production_exit_ownership_changed");
            const owned = i.decision.ownedEvaluation as { source: Record<string, unknown>; position: Record<string, unknown>; sourceDirectHeldId?:string };
            this.assertIntentSourceKind(i);
            const direct=this.#directSource;
            const source = direct?await direct.readHeldExact(tx,owned.sourceDirectHeldId!,i.parent_id!,this.now()):(await tx.query("SELECT * FROM forward_test_evaluations WHERE id=$1 FOR SHARE", [owned.source.id])).rows[0];
            const age = this.now() - new Date(source?.evaluated_at ?? 0).getTime();
            requireProof(source && canonical(source) === canonical(owned.source) &&
              age >= 0 && age <= p.maxQuoteAgeMs &&
              ["btc_provider_age_ms", "btc_receive_age_ms", "market_age_ms"].every(k => source[k] + age <= p.maxQuoteAgeMs),
            "production_final_owned_feed_changed_or_stale");
          }
          const oldest = pendingSnapshot ? snapshotHistoryFloor! : (await tx.query("SELECT min(created_at) earliest FROM v13_production_intent WHERE account_id=$1", [a.id])).rows[0].earliest;
          if(i.kind==="ENTRY"&&this.finalPublicMetadata){const context=this.phaseContext(i,invocation);if(context)this.finalPublicMetadata.start("WIRE_FEE",context);}
          let snapshot:Snapshot;
          if(pendingSnapshot){const outcome=await pendingSnapshot;if(!outcome.ok)throw outcome.error;snapshot=outcome.snapshot;}
          else snapshot=await readFinalSnapshot(oldest);
          await this.ledger.finalAccountProof(tx, a, snapshot, this.now());
          if(retired){
            const current=await this.settledExitGuard(tx,a,id,snapshot);
            requireProof(current?.receiptDigest===retired.receiptDigest,"production_other_uncertain_order");
            // The independent protective sender has separate reservation and
            // wire guards. Never create new exposure until that lane is proven
            // on this same exact receipt. Orders-off diagnostics may test the
            // proof above, but it isn't permission to invoke the transport.
            if(i.kind==="ENTRY")throw new Error("production_settled_disposition_exit_not_qualified");
          }
          // Network reads above can consume the evidence lifetime. Recheck all
          // clocks immediately before returning to the synchronous signer.
          requireProof(this.now() - book.observedAtMs <= p.maxQuoteAgeMs &&
            this.now() - book.fee.verifiedAtMs <= p.maxFeeEvidenceAgeMs &&
            this.now() - a.reconciled_at!.getTime() <= 15_000, "production_final_evidence_expired");
          if (i.kind === "ENTRY") {
            this.assertIntentSourceKind(i);
            const direct=this.#directSource;
            const source = direct?await direct.readExact(tx,i.direct_source_id!,this.now()):(await tx.query("SELECT * FROM forward_test_evaluations WHERE id=$1 FOR SHARE", [i.evaluation_id])).rows[0];
            requireProof(canonical(source) === canonical(i.decision.source) &&
              this.now() - new Date(source.evaluated_at).getTime() <= p.maxQuoteAgeMs &&
              ["btc_provider_age_ms", "btc_receive_age_ms", "market_age_ms"].every(k =>
                source[k] + this.now() - new Date(source.evaluated_at).getTime() <= p.maxQuoteAgeMs),
            "production_final_source_changed_or_expired");
            assertChampionSourceReference(source);
            this.assertLiveSourceQuote(source);
            if (source.entry_policy_version === V13_ENTRY_POLICY_VERSION) {
              if(!direct)await this.assertEntryPolicyWindow(tx, source);
            }
            const losses = (await tx.query(`SELECT
              (SELECT coalesce(sum(basis_micros),0)::text FROM v13_production_position WHERE account_id=$1) AS basis,
              (SELECT coalesce(sum(-least(pnl_micros,0)),0)::text FROM v13_production_event WHERE account_id=$1) AS total_loss,
              (SELECT coalesce(sum(-least(pnl_micros,0)),0)::text FROM v13_production_event WHERE account_id=$1
                AND occurred_at >= $2) AS daily_loss`,
            [a.id, new Date(new Date(this.now()).toISOString().slice(0, 10))])).rows[0];
            const plannedAllInCents = Number(
              (i.decision.preflight as { plannedAllInCents?: unknown } | undefined)?.plannedAllInCents,
            );
            if(cashEntry){
              const otherReserved=money(a.reserved_micros)-money(i.reserved_micros);
              requireProof(otherReserved>=0n&&plannedAllInCents===pinnedCash.plannedAllInCents&&
                plannedAllInCents<=p.maxEntryAllInCents&&i.request.contracts!*i.request.limitMicros<=entryStake*10000&&
                money(a.cash_micros)-otherReserved>=BigInt(plannedAllInCents)*10000n&&
                BigInt(p.capitalLimitCents)*10000n-money(losses.basis)-otherReserved-money(losses.total_loss)>=BigInt(plannedAllInCents)*10000n,
                "production_final_cash_bound_unaffordable");
            }
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
              const wireAdmission=this.startTiming("wire_source_admission",{intentId:id,evaluationId:i.direct_source_id??i.evaluation_id});
              try {
              assertChampionSourceReference(source);
              if(direct)requireProof(Number.isSafeInteger(source.original_oldest_ms)&&now>=source.original_oldest_ms&&now-source.original_oldest_ms<=5000&&now<source.market_close_ms,"direct_entry_original_source_expired");
              this.assertLiveSourceQuote(source);
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
            if(direct&&this.exchange.mode==="LIVE"){
              requireProof(this.authorizeFinalEntry&&this.accountOwnerUserId,"direct_live_final_release_authority_missing");
              this.ledger.pinIndependentEntryWire(a,i,source as DirectEvaluation,encodeProductionOrder(i.request));
            }
          }
          // Trusted transports cannot send before this callback succeeds.
          // Earlier local failures therefore prove that no POST was attempted;
          // failures after success remain UNKNOWN unless an exact, private
          // downstream refusal proves its transport was never invoked.
          if(i.kind==="ENTRY"&&this.#directSource){
            const s=i.decision.source as {original_oldest_ms:number;market_close_ms:number};
            const now=this.now();
            requireProof(Number.isSafeInteger(s.original_oldest_ms)&&now>=s.original_oldest_ms&&now-s.original_oldest_ms<=Math.min(5000,p.maxQuoteAgeMs)&&now<s.market_close_ms,"direct_entry_original_source_expired");
          }
          if(i.kind==="EXIT"&&this.#directSource){
            const s=(i.decision.ownedEvaluation as {source:{original_oldest_ms:number;market_close_ms:number}}).source;
            const now=this.now();
            requireProof(Number.isSafeInteger(s.original_oldest_ms)&&now>=s.original_oldest_ms&&now-s.original_oldest_ms<=Math.min(5000,p.maxQuoteAgeMs)&&now<s.market_close_ms,"direct_held_original_source_expired");
          }
          invoked = true;
          finalTiming("completed",{finalMarketReads});
          }catch(error){if(pendingSnapshot)await pendingSnapshot;finalTiming("rejected",{error,finalComparison,finalMarketReads:finalMarketReads??getMarketEvidenceReadTiming(error)});throw error;}
          finally{if(pendingSnapshot)await pendingSnapshot;}
        };
        ProductionExecutor.#fences.add(final);
        // One full fresh proof at the transport's last asynchronous boundary.
        // Durable authorization locks remain held through signing and sending.
        await (i.kind==="ENTRY"&&feeAuthorityTiming.capture?feeAuthorityTiming.capture.run(()=>withFeeAuthorityTimingPurpose("FINAL_MARKET",()=>this.exchange.submit(i.request,final))):withoutFeeAuthorityTiming(()=>this.exchange.submit(i.request, final)));
        this.fault("after_post_before_commit");
        await tx.query("UPDATE v13_production_intent SET state='UNKNOWN' WHERE id=$1", [id]);
        await this.ledger.observe(tx, "POST_ATTEMPT", { id, clientOrderId: i.client_order_id, outcome: "GET_RECONCILIATION_REQUIRED" });
        await this.ledger.persist(tx, a);
      });
      dispatchTiming("reconciliation_required",{feeAuthorityReads:feeAuthorityTiming.capture?.snapshot()});
    } catch (error) {
      // Even a rejected/timeout response is not terminal account evidence.
      await this.ledger.transaction(async (tx, a) => {
        const failed = (await tx.query<Intent>("SELECT * FROM v13_production_intent WHERE id=$1 FOR UPDATE", [id])).rows[0]!;
        if (!invoked || isEntryWireClockRefusal(error,failed.client_order_id) ||
            isReviewedApiFeeWireRefusal(error,failed.client_order_id)) {
          dispatchTiming("proven_not_posted",{error,feeAuthorityReads:feeAuthorityTiming.capture?.snapshot()});
          const i = failed;
          requireProof(i.state === "DISPATCHED" && money(i.filled_hundredths) === 0n, "production_local_abort_identity_changed");
          a.reserved_micros = String(money(a.reserved_micros) - money(i.reserved_micros));
          await tx.query("UPDATE v13_production_intent SET state='BLOCKED',terminal=true,reserved_micros=0 WHERE id=$1", [id]);
          await this.ledger.observe(tx, "PROVEN_NOT_POSTED", { id, reason: (error as Error).message });
        } else {
          dispatchTiming("post_uncertain",{error,feeAuthorityReads:feeAuthorityTiming.capture?.snapshot()});
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
      await this.gate(tx, a, i.kind === "EXIT", id,false,false);
      await this.ledger.policy(tx, a);
      await tx.query("UPDATE v13_production_intent SET cancel_attempted=true,state='UNKNOWN' WHERE id=$1", [id]);
      await this.ledger.persist(tx, a);
      return i;
    });
    if (!order) return;
    this.fault("after_cancel_commit");
    await this.ledger.transaction(async (tx, a) => {
      const final = async () => {
        await this.gate(tx, a, order.kind === "EXIT", id,false,false);
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

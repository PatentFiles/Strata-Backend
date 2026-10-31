import {signalTraceSourceAgeMs} from "./signalTraceSourceAge";
import {onCommittedForwardSignal} from "../forwardTestSignalWake";
import { ProductionExecutor } from "./executor";
import { consumeOwnedPosition, type ProtectiveExitDispatch } from "./consumer";
import {sanitizedDecisionReason,type LiveSignalPhase} from "./signalDecisionTrace";

export type SignalTracePort={
 record(input:{accountId:string;evaluationId:string;phase:LiveSignalPhase;sourceAgeMs?:number|null;reason?:string}):Promise<boolean>;
 sweep(accountId:string):Promise<number>;
};

/** Explicit lifecycle only. API startup neither constructs nor starts this worker. */
/** Rate-limit sequential reconciliation cycles while avoiding an extra full
 * poll interval AFTER each slow signed exchange reconciliation. The 250ms
 * minimum prevents a back-to-back hot loop on a delayed provider response.
 * This does not extend source ages or loosen order admission limits.
 */
export function nextSequentialPollDelayMs(intervalMs:number,elapsedMs:number):number {
  return Math.max(250,Math.ceil(intervalMs - Math.max(0,elapsedMs)));
}

export class ProductionWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private recoveryOnly = false;
  private detachWake:(()=>void)|null=null;
  private entryHoldReported = false;
  private lastTraceSweepAt = 0;
  private readonly tracedEvaluations = new Set<string>();
  constructor(readonly executor: ProductionExecutor, readonly intervalMs = 2_500,
    readonly report: (error: unknown) => void = () => {},
    readonly entriesOpen: () => boolean = () => true,
    /** Trusted, never-submitting UNKNOWN protective-exit recovery pass. */
    readonly recoverProtectiveExits: () => Promise<void> = async () => {},
    /** Trusted owner-scoped IOC exit, never obtained from user requests. */
    readonly dispatchProtectiveExit?: ProtectiveExitDispatch,
    readonly signalTrace: SignalTracePort|null=null) {}
  private async recordDecision(input:Parameters<SignalTracePort["record"]>[0]):Promise<boolean>{
    return this.signalTrace?this.signalTrace.record(input):true;
  }
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Resolve or retain UNKNOWN protective exits BEFORE ordinary reconciliation
      // and before any chance of a new entry. Failures stop this tick; never POST.
      await this.recoverProtectiveExits();
      await this.executor.reconcile(); // restart first; never replay dispatched POSTs
      if (this.recoveryOnly) return;
      await consumeOwnedPosition(this.executor, this.dispatchProtectiveExit);
      if (!this.entriesOpen()) {
        // A healthy reconciliation heartbeat does not prove entries are open.
        // Report this once per suspended interval without attempting an order.
        if (!this.entryHoldReported) {
          this.entryHoldReported = true;
          this.report(new Error("production_entries_not_authorized"));
        }
        return;
      }
      this.entryHoldReported = false;
      const observedAt = new Date(this.executor.now());
      // The owner account's approved quote-age window, not an arbitrary
      // 15-second replay window, determines which paper signals remain
      // executable. Newest first: do not spend a slow Kalshi/fee fetch on an
      // older crossing while a newer qualifying entry expires.
      const query = this.executor.accountOwnerUserId
        ? `SELECT e.id,e.evaluated_at FROM forward_test_evaluations e
          JOIN v13_production_account a ON a.id=$1
          JOIN v13_live_money_policy p ON p.id=a.policy_id
            AND p.execution_account_id=a.id AND p.state='APPROVED'
          WHERE e.evaluation_source='paper' AND e.qualifying_trigger=true
            AND e.fresh_cross=true AND e.signal IN ('SCOUT','CONFIRM')
            AND e.evaluated_at BETWEEN $2::timestamptz -
              (p.max_quote_age_ms * interval '1 millisecond') AND $2::timestamptz
          ORDER BY e.evaluated_at DESC,e.id DESC LIMIT 100`
        : `SELECT id,evaluated_at FROM forward_test_evaluations
          WHERE evaluation_source='paper' AND qualifying_trigger=true
            AND fresh_cross=true AND signal IN ('SCOUT','CONFIRM')
            AND evaluated_at >= $1
          ORDER BY evaluated_at DESC,id DESC LIMIT 100`;
      const args = this.executor.accountOwnerUserId
        ? [this.executor.ledger.accountId, observedAt]
        : [new Date(observedAt.getTime() - 15_000)];
      const discovery=this.executor.startTiming("signal_discovery");
      let ids;
      try{ids=(await this.executor.ledger.pool.query(query,args)).rows;discovery("completed");}
      catch(error){discovery("rejected",{error});throw error;}
      for (const { id, evaluated_at } of ids) {
        if (!this.entriesOpen()) break;
        // Trace only: preserve pg Date milliseconds; unknown/future ages are not zero.
        const ageMs=()=>signalTraceSourceAgeMs(evaluated_at,this.executor.now());
        if (!this.tracedEvaluations.has(String(id))) {
          const recorded=await this.recordDecision({accountId:this.executor.ledger.accountId,
            evaluationId:String(id),phase:"QUALIFYING_SEEN",sourceAgeMs:ageMs()});
          if(!recorded)throw new Error("production_signal_trace_unavailable");
          this.tracedEvaluations.add(String(id));
          if(this.tracedEvaluations.size>500){
            const oldest=this.tracedEvaluations.values().next().value;
            if(oldest)this.tracedEvaluations.delete(oldest);
          }
        }
        let prepared=false;
        try {
          const intent=await this.executor.prepareEntry(id);
          prepared=true;
          if(!await this.recordDecision({accountId:this.executor.ledger.accountId,
            evaluationId:String(id),phase:"ENTRY_PREPARED",sourceAgeMs:ageMs()}))
            throw new Error("production_signal_trace_unavailable");
          await this.executor.dispatch(intent);
          if(!await this.recordDecision({accountId:this.executor.ledger.accountId,
            evaluationId:String(id),phase:"DISPATCH_COMPLETED",sourceAgeMs:ageMs()})){
            // A missing audit receipt does not mean the order was rejected.
            // Leave order recovery to the durable intent/UNKNOWN ledger.
            this.report(new Error("production_dispatch_trace_unavailable"));
            break;
          }
        }catch(error){
          const recorded=await this.recordDecision({accountId:this.executor.ledger.accountId,
            evaluationId:String(id),phase:prepared?"DISPATCH_REJECTED":"PREPARE_REJECTED",
            sourceAgeMs:ageMs(),reason:sanitizedDecisionReason(error)});
          if(!recorded)this.report(new Error("production_rejection_trace_unavailable"));
          this.report({error,evaluationId:id});
        }
      }
    } finally {
      try {
      // Scan even while entry authority is held or reconciliation fails.
      // Never infer a past block reason from the worker's current state.
      const observedAt=this.signalTrace?this.executor.now():0;
      if(this.signalTrace&&observedAt-this.lastTraceSweepAt>=30_000){
        this.lastTraceSweepAt=observedAt;
        await this.signalTrace.sweep(this.executor.ledger.accountId);
      }
      } finally {this.running = false;}
    }
  }
  async start(): Promise<void> {
    if (this.timer) return;
    await this.recoverProtectiveExits();
    await this.executor.reconcile();
    await this.executor.ledger.transaction((tx, a) => this.executor.gate(tx, a, false, null, true));
    this.recoveryOnly = false;
    this.schedule();
  }
  async startRecovery(): Promise<void> {
    if (this.timer) return;
    await this.executor.ledger.readAccount();
    this.recoveryOnly = true;
    try { await this.recoverProtectiveExits(); await this.executor.reconcile(); }
    catch (error) { this.report(error); }
    this.schedule();
  }
  private schedule(): void {
    let active=false,pending=false;
    const loop = async () => {
      active=true;
      const tickStartedAt = Date.now();
      try { await this.tick(); } catch (error) {
        this.report(error);
        if (error instanceof Error && (error.message === "personal_exchange_history_unreconciled" ||
          error.message === "stale_worker_fence" || error.message === "account_kill_switch")) this.stop();
      }
      // A committed qualifying signal already waited for this serialized tick;
      // dispatch its coalesced wake immediately. Ordinary polling retains the
      // minimum delay and every recovery/reconciliation/entry gate is unchanged.
      // Schedule by tick START time rather than sleeping a full interval
      // AFTER the signed exchange read. Tick itself serializes all actions.
      active=false;
      if (this.timer) this.timer = setTimeout(loop,
        pending?0:nextSequentialPollDelayMs(this.intervalMs, Date.now()-tickStartedAt));
      pending=false;
    };
    this.detachWake=onCommittedForwardSignal(()=>{
      if(!this.timer||this.recoveryOnly)return;
      if(active){pending=true;return;}
      clearTimeout(this.timer);this.timer=setTimeout(loop,0);
    });
    this.timer = setTimeout(loop, 0);
  }
  stop(): void { this.detachWake?.();this.detachWake=null; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  /** True only after start() has scheduled the loop. Database flags are not a substitute. */
  isScheduled(): boolean { return this.timer !== null; }
}

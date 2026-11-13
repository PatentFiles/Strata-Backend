import {transactionConnectionFence} from "./transactionConnectionFence";
import {reconciledIntentState,reconciliationIntentChanged} from "./reconciliationIntentPersistence";
import {reconciliationObservation} from "./reconciliationObservation";
import {entryCashProof,entryFillFeeUpperMicros,validEntryCashRisk,type V13EntryCashProof} from "../v13EntryCashRisk";
import {requestQuantityHundredths} from "./requestQuantity";
import type { Pool, PoolClient } from "@workspace/db";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { computeV13LiveMoneyPolicyHash, type V13ApprovedLiveMoneyPolicy } from "../v13LiveMoneyRisk";
import { canonical, digest, money, requireProof, type Identity, type Snapshot, type Request } from "./types";

export const TERMINAL_POSITION_BATCH_SQL = "SELECT position.id,position.quantity_hundredths FROM (SELECT DISTINCT unnest($1::text[]) AS id) AS requested CROSS JOIN LATERAL (SELECT id,quantity_hundredths FROM v13_production_position WHERE id=requested.id LIMIT 1) AS position";

// Reconciliation's account and history floor share one statement snapshot. The
// scalar history subquery is correlated to the matching account, so no history
// is read for a missing account. This is not authority: reconciliation still
// checks the captured revision under the existing final account lock.
export const RECONCILE_ACCOUNT_HISTORY_SQL = `SELECT a.*,
  (SELECT min(i.created_at) FROM v13_production_intent i WHERE i.account_id=a.id) AS reconciliation_history_floor
  FROM v13_production_account a WHERE a.id=$1`;

export type Account = {
  id: string; policy_id: string; subaccount: string; exchange_index: string; owner_user_id?: string | null;
  key_fingerprint: string; commissioning_digest: string | null;
  kill_switch: boolean; execution_enabled: boolean; commissioned: boolean;
  minimum_exit_micros: number | null;
  fee_artifact_digest: string | null; cash_precision_verified: boolean;
  cash_micros: string; reserved_micros: string; initial_cash_micros: string;
  blocked_reason: string | null; reconciled_at: Date | null; revision: string;
};
export type Intent = {
  id: string; account_id: string; evaluation_id: string | null; parent_id: string | null;
  kind: "ENTRY" | "EXIT"; market: string; side: "YES" | "NO"; state: string;
  request: Request; decision: Record<string, unknown>; policy_hash: string; fee_fingerprint: string;
  capability_digest: string; client_order_id: string; exchange_order_id: string | null;
  reserved_micros: string; exit_fee_micros: string; filled_hundredths: string;
  terminal: boolean; cancel_attempted: boolean; created_at: Date; dispatch_at: Date | null;
};
/** Reconciliation alone may omit the unused decision of a terminal BLOCKED row.
 * Hooks must keep this nullable contract; PREPARED and attributed-fill branches
 * retain their original full decision, including malformed stored JSON.
 */
export type ReconciliationIntent = Omit<Intent, "decision"> & { decision: Intent["decision"] | null };
export const identity = (a: Account): Identity => ({
  subaccount: Number(a.subaccount), exchangeIndex: Number(a.exchange_index), keyFingerprint: a.key_fingerprint,
});

export function decodePolicy(row: Record<string, unknown>): V13ApprovedLiveMoneyPolicy {
  const decoded: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) decoded[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  for (const k of ["approvedAt", "championSelectedAt"]) if (decoded[k]) decoded[k] = new Date(decoded[k] as string);
  return decoded as V13ApprovedLiveMoneyPolicy;
}

/** Server-owned callbacks only, never request JSON. The lock hook must pin the
 * exact held lease, policy, credential and independent financial writers using
 * this client. beforeCommit revalidates that authority without renewing it.
 * This opt-in primitive provides accounting evidence, never execution authority. */
export type HeldReconciliationGuard = {
  lock(tx: PoolClient, account: Account): Promise<void>;
  beforeCommit(tx: PoolClient, account: Account): Promise<void>;
  now(): number;
  deadlineMs: number;
};
export type HeldReconciliationReceipt = {
  accountId: string; observationId: string; receiptId: string;
  revision: string; financialDigest: string;
};
export class HeldReconciliationCommitUncertain extends Error {
  constructor() { super("production_held_reconciliation_commit_uncertain");
    this.name = "HeldReconciliationCommitUncertain"; }
}

export class ProductionLedger {
  private readonly context = new AsyncLocalStorage<PoolClient>();
  private readonly finalSnapshotIntent = new AsyncLocalStorage<{ active: boolean; entryIntentId: string | null }>();
  private readonly wireContext = new AsyncLocalStorage<{active:boolean;check:(()=>void)|null;connection:ReturnType<typeof transactionConnectionFence>}>();
  constructor(readonly pool: Pool, readonly accountId: string) {}
  // Read providers invoked inside a final fence MUST use its existing client,
  // not open another transaction/connection behind the held account lock.
  query: Pool["query"] = ((...args: unknown[]) => {
    const client = this.context.getStore() ?? this.pool;
    return Reflect.apply(client.query, client, args);
  }) as Pool["query"];
  /** Trusted transport may borrow the current final fence, never commit it. */
  currentTransaction(): PoolClient|null {return this.context.getStore()??null;}
  private readonly wireTokens=new WeakMap<object,Readonly<object>>();
  /** Opaque identity unique to one active transaction, never the reusable pooled client. */
  currentWireScopeToken():Readonly<object>|null {
    const scope=this.wireContext.getStore();
    if(!this.currentTransaction()||!scope?.active)return null;
    let token=this.wireTokens.get(scope);if(!token){token=Object.freeze({});this.wireTokens.set(scope,token);}return token;
  }
  /** Synchronous freshness check for the LAST HTTP boundary, after fee reads.
   * Evidence is pinned by this transaction, not reusable authority or a lease.
   */
  setFinalWireClock(check:()=>void):void {
    const scope=this.wireContext.getStore();
    requireProof(this.currentTransaction()&&scope?.active,"production_wire_transaction_required");
    scope.check=check;
  }
  assertFinalWireClock():void {
    const scope=this.wireContext.getStore();
    requireProof(this.currentTransaction()&&scope?.active&&scope.check,"production_final_wire_clock_missing");
    scope.connection.assertLive();
    // Original source clock remains the final check before raw transport.
    scope.check();
  }
  /** Only the currently locked ENTRY may be discounted from its own final
   * snapshot uncertainty check. This context never survives the callback and
   * never applies to ordinary reconciliation or restarted workers. */
  async withFinalAccountSnapshot<T>(entryIntentId: string | null, read: () => Promise<T>): Promise<T> {
    requireProof(this.currentTransaction() && this.wireContext.getStore()?.active,
      "production_final_snapshot_transaction_required");
    const scope = { active: true, entryIntentId };
    try { return await this.finalSnapshotIntent.run(scope, read); }
    finally { scope.active = false; }
  }
  currentFinalSnapshotEntry(): string | null {
    const scope = this.finalSnapshotIntent.getStore();
    return this.currentTransaction() && this.wireContext.getStore()?.active && scope?.active
      ? scope.entryIntentId : null;
  }
  async readAccount(): Promise<Account> {
    const { rows } = await this.query<Account>("SELECT * FROM v13_production_account WHERE id=$1", [this.accountId]);
    requireProof(rows.length === 1, "production_account_missing");
    return rows[0]!;
  }
  async readReconcileAccount(): Promise<{ account: Account; earliest: Date | null }> {
    const { rows } = await this.query<Account & { reconciliation_history_floor: Date | null }>(
      RECONCILE_ACCOUNT_HISTORY_SQL, [this.accountId]);
    requireProof(rows.length === 1, "production_account_missing");
    // Do not leak the synthetic projection into account serialization/digests.
    const { reconciliation_history_floor: earliest, ...account } = rows[0]!;
    return { account, earliest };
  }
  async transaction<T>(body: (tx: PoolClient, account: Account) => Promise<T>,
    options: { lockTimeoutMs?: number } = {}): Promise<T> {
    const tx = await this.pool.connect();
    const connection=transactionConnectionFence(tx);
    const wireScope={active:true,check:null as (()=>void)|null,connection};
    let discard=false,failed=false;
    const close=()=>{wireScope.active=false;wireScope.check=null;connection.close();};
    try {
      let rows: Account[];
      // No application decision occurs between BEGIN and the first lock. Send
      // the same ordered statements as one simple-query message for validated
      // identifier text only; all other inputs retain parameterized SQL.
      if(options.lockTimeoutMs===undefined&&typeof this.accountId==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(this.accountId)){
        const results=await tx.query(`BEGIN; SELECT * FROM v13_production_account WHERE id='${this.accountId}' FOR UPDATE`);
        requireProof(Array.isArray(results)&&results.length===2&&results[0].command==='BEGIN'&&results[1].command==='SELECT'&&Array.isArray(results[1].rows),
          "production_transaction_start_result_invalid");
        rows=results[1].rows;
      }else{
        await tx.query("BEGIN");
        if (options.lockTimeoutMs !== undefined) {
          requireProof(Number.isSafeInteger(options.lockTimeoutMs) && options.lockTimeoutMs > 0 &&
            options.lockTimeoutMs <= 5000, "production_lock_timeout_invalid");
          // Recovery must bound the FIRST account lock, not just later queries.
          await tx.query("SELECT set_config('lock_timeout',$1,true)", [`${options.lockTimeoutMs}ms`]);
        }
        rows=(await tx.query<Account>("SELECT * FROM v13_production_account WHERE id=$1 FOR UPDATE", [this.accountId])).rows;
      }
      requireProof(rows.length === 1, "production_account_missing");
      const result = await this.context.run(tx, () => this.wireContext.run(wireScope,()=>body(tx, rows[0]!)));
      close();
      if(connection.broken())throw new Error("production_transaction_connection_lost");
      try { await tx.query("COMMIT"); } catch(error) { discard=true;throw error; }
      return result;
    } catch (error) {
      failed=true;close();
      try { await tx.query("ROLLBACK"); } catch { discard=true; }
      throw error;
    } finally {
      close();discard=discard||connection.broken();
      try { tx.release(discard?new Error("production_transaction_connection_discarded"):undefined); }
      catch(error) { discard=true;if(!failed)throw error; }
      finally { connection.cleanup(discard); }
    }
  }
  async policy(tx: PoolClient, a: Account): Promise<V13ApprovedLiveMoneyPolicy> {
    // Lock the immutable approval row through the final network fence. Never
    // trust the copy included in an earlier decision or capability.
    const { rows } = await tx.query("SELECT * FROM v13_live_money_policy WHERE id=$1 FOR SHARE", [a.policy_id]);
    requireProof(rows.length === 1, "production_policy_missing");
    const p = decodePolicy(rows[0]!);
    const approvals = await tx.query("SELECT id FROM v13_live_money_policy WHERE state='APPROVED'");
    requireProof(approvals.rows.length === 1 && p.state === "APPROVED" &&
      p.policyHash === computeV13LiveMoneyPolicyHash(p), "production_policy_revoked_changed_or_ambiguous");
    return p;
  }
  async persist(tx: PoolClient, a: Account): Promise<void> {
    await tx.query(`UPDATE v13_production_account SET cash_micros=$2,reserved_micros=$3,
      blocked_reason=$4,revision=revision+1 WHERE id=$1`,
    [a.id, a.cash_micros, a.reserved_micros, a.blocked_reason]);
  }
  async observe(tx: PoolClient, kind: string, value: unknown): Promise<string> {
    const observationId = randomUUID();
    await tx.query(`INSERT INTO v13_production_observation(id,account_id,kind,payload,digest)
      VALUES($1,$2,$3,$4,$5)`, [observationId, this.accountId, kind, JSON.stringify(value), digest(value)]);
    return observationId;
  }
  async freeze(reason: string): Promise<void> {
    await this.transaction(async (tx, a) => {
      a.blocked_reason = reason;
      await this.observe(tx, "BLOCK", { reason });
      await this.persist(tx, a);
    });
  }
  async assertConservation(tx: PoolClient, a: Account): Promise<void> {
    // Three independent, one-row aggregates in one statement. Do not join raw
    // history rows: that would multiply amounts. Account lock and every
    // conservation equation remain unchanged; no history is omitted/cached.
    const {rows:[totals]} = await tx.query(`SELECT e.cash,e.pnl,p.basis,p.position_pnl,r.amount
      FROM (SELECT coalesce(sum(cash_delta_micros),0)::text cash,
        coalesce(sum(pnl_micros),0)::text pnl FROM v13_production_event WHERE account_id=$1) e
      CROSS JOIN (SELECT coalesce(sum(basis_micros),0)::text basis,
        coalesce(sum(realized_pnl_micros),0)::text position_pnl FROM v13_production_position WHERE account_id=$1) p
      CROSS JOIN (SELECT coalesce(sum(reserved_micros),0)::text amount
        FROM v13_production_intent WHERE account_id=$1) r`, [a.id]);
    requireProof(money(a.cash_micros) === money(a.initial_cash_micros) + money(totals.cash) &&
      money(a.cash_micros) + money(totals.basis) === money(a.initial_cash_micros) + money(totals.pnl) &&
      money(totals.position_pnl) === money(totals.pnl) &&
      money(a.reserved_micros) === money(totals.amount), "production_money_conservation_failed");
  }

  async finalAccountProof(tx: PoolClient, a: Account, snapshot: Snapshot, nowMs: number): Promise<void> {
    requireProof(canonical(snapshot.identity) === canonical(identity(a)) && snapshot.authenticated &&
      snapshot.complete && snapshot.cashExact && !snapshot.unexplainedCashActivity &&
      snapshot.observedAtMs <= nowMs && nowMs - snapshot.observedAtMs <= 15_000 &&
      money(snapshot.cashMicros) === money(a.cash_micros), "production_final_account_changed_or_unproven");
    // Final signed-account comparison needs every intent, but never reads its
    // decision/capability JSON. Reconciliation retains its full locked history.
    const known = (await tx.query<Pick<Intent,
      "created_at" | "client_order_id" | "request" | "exchange_order_id" | "terminal" | "filled_hundredths">>(
      "SELECT created_at,client_order_id,request,exchange_order_id,terminal,filled_hundredths FROM v13_production_intent WHERE account_id=$1", [a.id])).rows;
    requireProof(snapshot.historyFromMs <= Math.min(...known.map(i => i.created_at.getTime()), nowMs),
      "production_final_history_gap");
    for (const o of snapshot.orders) {
      const i = known.find(i => i.client_order_id === o.request.clientOrderId);
      requireProof(i && canonical(i.request) === canonical(o.request) &&
        i.exchange_order_id === o.orderId && i.terminal === o.terminal &&
        money(i.filled_hundredths) === money(o.filledHundredths), "production_final_order_changed");
    }
    for (const f of snapshot.fills) {
      const r = (await tx.query("SELECT digest FROM v13_production_event WHERE account_id=$1 AND event_id=$2",
        [a.id, `fill:${f.id}`])).rows[0];
      requireProof(r && r.digest === digest(f), "production_final_unreconciled_fill");
    }
    for (const s of snapshot.settlements) {
      const r = (await tx.query("SELECT digest FROM v13_production_event WHERE account_id=$1 AND event_id=$2",
        [a.id, `settlement:${s.id}`])).rows[0];
      requireProof(r && r.digest === digest(s), "production_final_unreconciled_settlement");
    }
    const pos = (await tx.query(`SELECT market,side,quantity_hundredths FROM v13_production_position
      WHERE account_id=$1 AND quantity_hundredths>0 ORDER BY market,side`, [a.id])).rows;
    const actual = snapshot.positions.filter(p => money(p.quantityHundredths) !== 0n)
      .map(p => ({ market: p.market, side: p.side, quantity_hundredths: String(money(p.quantityHundredths)) }))
      .sort((x, y) => x.market.localeCompare(y.market) || x.side.localeCompare(y.side));
    requireProof(canonical(pos) === canonical(actual), "production_final_position_changed");
  }

  /** Owned-account subclasses may recover coupled never-sent EXIT markers.
   * Legacy ledgers have no private reservation authority. */
  protected async recoverPreparedExits(_tx: PoolClient, _account: Account,
    _intents: ReconciliationIntent[], _snapshot: Snapshot): Promise<void> {}

  async reconcile(snapshot: Snapshot, expectedRevision: string, nowMs: number): Promise<{accountId:string;observationId:string}> {
    return this.reconcileInternal(snapshot, expectedRevision, nowMs);
  }

  /** Same financial validation as reconcile, with no out-of-transaction freeze
   * on failure. Caller must abandon a refused/uncertain held session, retain its
   * entry hold and inspect durable state; it must never automatically replay. */
  async reconcileHeld(snapshot: Snapshot, expectedRevision: string,
    guard: HeldReconciliationGuard): Promise<HeldReconciliationReceipt> {
    // Pin references and authenticated evidence before the first await.
    const held = { lock: guard.lock.bind(guard), beforeCommit: guard.beforeCommit.bind(guard),
      now: guard.now.bind(guard), deadlineMs: guard.deadlineMs };
    const evidence = structuredClone(snapshot);
    const started = held.now();
    requireProof(Number.isSafeInteger(started) && Number.isSafeInteger(held.deadlineMs) &&
      held.deadlineMs > started && held.deadlineMs - started <= 15_000,
      "production_held_reconciliation_deadline_invalid");
    let last = started;
    const check = () => {
      const now = held.now();
      requireProof(Number.isSafeInteger(now) && now >= last && now < held.deadlineMs &&
        evidence.observedAtMs <= now && now - evidence.observedAtMs <= 15_000,
        "production_held_reconciliation_expired_or_clock_invalid");
      last = now;
      return now;
    };
    return this.reconcileInternal(evidence, expectedRevision, started,
      { ...held, check }) as Promise<HeldReconciliationReceipt>;
  }

  /** Disabled opt-in candidate: collect complete signed history while holding
   * the actual account/guard locks, then reuse full existing reconciliation.
   * No release, approval, gate reset or entry authority is granted here. */
  async reconcileHeldReaderCandidate(expectedRevision:string,guard:HeldReconciliationGuard,
    reader:(tx:PoolClient,a:Account)=>Promise<Snapshot>,enabled=false):Promise<HeldReconciliationReceipt>{
    requireProof(enabled===true,"production_held_reader_candidate_disabled");
    const clock=guard.now.bind(guard),deadlineMs=guard.deadlineMs;
    let evidence:Snapshot|null=null,last=clock();
    const held={lock:guard.lock.bind(guard),beforeCommit:guard.beforeCommit.bind(guard),now:clock,deadlineMs,
      check:()=>{const n=clock();requireProof(Number.isSafeInteger(n)&&n>=last&&n<deadlineMs,"production_held_reader_deadline");if(evidence)requireProof(evidence.observedAtMs<=n&&n-evidence.observedAtMs<5000,"production_held_reader_evidence_stale");last=n;return n;}};
    requireProof(Number.isSafeInteger(last)&&Number.isSafeInteger(held.deadlineMs)&&held.deadlineMs>last&&held.deadlineMs-last<=5000,"production_held_reader_deadline");
    return this.reconcileInternal(null as unknown as Snapshot,expectedRevision,last,held,async(tx,a)=>{
      requireProof(a.revision===expectedRevision,"production_observation_raced");
      // Refuse large retained accounts before the existing complete accounting
      // pass. Bound positions/events too: conservation covers their full history.
      for(const table of ["v13_production_intent","v13_production_position","v13_production_event"]){
        const rows=await tx.query(`SELECT 1 FROM ${table} WHERE account_id=$1 LIMIT 1001`,[a.id]);
        requireProof(rows.rows.length<=1000,"production_held_reader_history_budget");
      }
      held.check();evidence=structuredClone(await reader(tx,a));held.check();return evidence;
    }) as Promise<HeldReconciliationReceipt>;
  }

  private async heldReconciliationTransaction(
    body: (tx: PoolClient, account: Account) => Promise<{accountId:string;observationId:string}>,
    held: HeldReconciliationGuard & {check():number}, evidenceDigest: string | (()=>string),
  ): Promise<HeldReconciliationReceipt> {
    requireProof(!this.currentTransaction(), "production_held_reconciliation_nested_transaction");
    held.check();
    const tx = await this.pool.connect();
    const connection = transactionConnectionFence(tx);
    let discard = false, commitAttempted = false;
    try {
      const now = held.check();
      connection.assertLive();
      await tx.query("BEGIN");
      await tx.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
        ["750ms", `${held.deadlineMs - now}ms`]);
      const {rows} = await tx.query<Account>("SELECT * FROM v13_production_account WHERE id=$1 FOR UPDATE", [this.accountId]);
      requireProof(rows.length === 1, "production_account_missing");
      const a = rows[0]!;
      return await this.context.run(tx, async () => {
        held.check(); connection.assertLive();
        await held.lock(tx, a);
        held.check(); connection.assertLive();
        const result = await body(tx, a);
        const actualEvidenceDigest=typeof evidenceDigest==='function'?evidenceDigest():evidenceDigest;
        const revision = (result as {persistedRevision?:string}).persistedRevision;
        requireProof(typeof revision === 'string' && /^(0|[1-9][0-9]*)$/.test(revision) &&
          BigInt(revision) > BigInt(a.revision), "production_held_persisted_revision_unverified");
        const financialDigest = digest({accountId: a.id, revision, cashMicros: a.cash_micros,
          reservedMicros: a.reserved_micros, blockedReason: a.blocked_reason, evidenceDigest:actualEvidenceDigest});
        const receiptId = await this.observe(tx, "HELD_RECONCILIATION_RECEIPT",
          {...result, revision, financialDigest, evidenceDigest:actualEvidenceDigest});
        held.check(); connection.assertLive();
        await held.beforeCommit(tx, a);
        // No asynchronous work between the final clock/liveness checks and the
        // COMMIT send. All receipt and financial writes are still uncommitted.
        held.check(); connection.assertLive();
        commitAttempted = true;
        await tx.query("COMMIT");
        return {accountId:result.accountId,observationId:result.observationId,receiptId,revision,financialDigest};
      });
    } catch (error) {
      if (commitAttempted) {
        // A rejection cannot prove the server did not commit. Never retry or
        // issue another freeze/rollback transaction against changed ownership.
        discard = true;
        throw new HeldReconciliationCommitUncertain();
      }
      try { await tx.query("ROLLBACK"); } catch { discard = true; }
      throw error;
    } finally {
      connection.close();
      discard = discard || connection.broken();
      // Cleanup failure after acknowledged COMMIT does not erase its receipt.
      try { tx.release(discard ? new Error("production_held_connection_discarded") : undefined); }
      catch { discard = true; }
      finally { connection.cleanup(discard); }
    }
  }

  private async reconcileInternal(snapshot: Snapshot, expectedRevision: string, nowMs: number,
    held?: HeldReconciliationGuard & {check():number},reader?: (tx:PoolClient,a:Account)=>Promise<Snapshot>): Promise<{accountId:string;observationId:string}> {
    try {
      // transaction() returns only after COMMIT succeeds; a rejected/uncertain
      // commit never exposes a durable reconciliation pointer.
      const transact = held
        ? (body: (tx: PoolClient, a: Account) => Promise<{accountId:string;observationId:string}>) =>
          this.heldReconciliationTransaction(body, held, ()=>digest(snapshot))
        : (body: (tx: PoolClient, a: Account) => Promise<{accountId:string;observationId:string}>) => this.transaction(body);
      return await transact(async (tx, a) => {
        if(reader)snapshot=await reader(tx,a);
        const originalFreeze = a.blocked_reason;
        const block = (reason: string, overwrite = true) => {
          // Held recovery cannot certify a successful financial receipt after
          // detecting ANY new risk, even when an old freeze would mask ??=.
          // Roll back all accounting writes and retain the persisted freeze.
          if (held) throw new Error(reason);
          if (overwrite) a.blocked_reason = reason;
          else a.blocked_reason ??= reason;
        };
        if (held) nowMs = held.check();
        requireProof(a.revision === expectedRevision, "production_observation_raced");
        requireProof(canonical(snapshot.identity) === canonical(identity(a)), "production_account_mismatch");
        requireProof(snapshot.authenticated && snapshot.complete && snapshot.cashExact &&
          !snapshot.unexplainedCashActivity && snapshot.observedAtMs <= nowMs &&
          nowMs - snapshot.observedAtMs <= 15_000, "production_history_incomplete_stale_or_cash_unproven");
        // Every intent remains locked and reconciled, including never-posted
        // history. A terminal BLOCKED row is rejected by the order-attribution
        // pass before fill/capability reads and cannot enter PREPARED recovery.
        // Keep full decisions for all other states, especially late-filled
        // TERMINAL entries. Only unused BLOCKED decision payload is omitted.
        const intents = (await tx.query<ReconciliationIntent>(`SELECT id,account_id,evaluation_id,crossing_key,parent_id,
          kind,market,side,state,request,
          CASE WHEN state='BLOCKED' AND terminal IS TRUE THEN NULL ELSE decision END AS decision,
          policy_hash,fee_fingerprint,capability_digest,client_order_id,exchange_order_id,
          reserved_micros,exit_fee_micros,filled_hundredths,terminal,cancel_attempted,dispatch_at,created_at
          FROM v13_production_intent WHERE account_id=$1 ORDER BY created_at,id FOR UPDATE`, [a.id])).rows;
        // Snapshot the persisted fields under the existing account/intent locks.
        const priorIntentStates = new Map(intents.map(i => [i.id, reconciledIntentState(i)]));
        const earliest = Math.min(...intents.map(i => i.created_at.getTime()), nowMs);
        requireProof(snapshot.historyFromMs <= earliest, "production_history_coverage_gap");
        const byClient = new Map(intents.map(i => [i.client_order_id, i]));
        const byOrder = new Map(snapshot.orders.map(o => [o.orderId, o]));
        requireProof(byOrder.size === snapshot.orders.length, "production_duplicate_order_evidence");
        for (const o of snapshot.orders) {
          const i = byClient.get(o.request.clientOrderId);
          requireProof(i && canonical(i.request) === canonical(o.request) &&
            (!i.exchange_order_id || i.exchange_order_id === o.orderId) &&
            i.state !== "PREPARED" && i.state !== "BLOCKED", "production_unattributed_order");
          if (i.exchange_order_id === null) i.exchange_order_id = o.orderId;
        }
        const entrySpent=new Map<string,bigint>();
        const fills = snapshot.fills.slice().sort((x, y) => x.occurredAtMs - y.occurredAtMs || x.id.localeCompare(y.id));
        requireProof(new Set(fills.map(f => f.id)).size === fills.length, "production_duplicate_fill_in_scan");
        for (const f of fills) {
          const i = byClient.get(f.clientOrderId);
          const o = byOrder.get(f.orderId);
          requireProof(i && o && o.request.clientOrderId === f.clientOrderId &&
            f.market === i.market && f.side === i.side &&
            f.action === i.request.action, "production_unattributed_fill");
          const prior = await tx.query("SELECT digest FROM v13_production_event WHERE account_id=$1 AND event_id=$2", [a.id, `fill:${f.id}`]);
          if (prior.rows.length) {
            requireProof(prior.rows[0].digest === digest(f), "production_changed_fill_evidence");
            continue;
          }
          requireProof(Number.isSafeInteger(f.priceMicros) && f.priceMicros > 0 && f.priceMicros < 1_000_000 &&
            Number.isSafeInteger(f.occurredAtMs) && f.occurredAtMs <= snapshot.observedAtMs, "production_fill_precision_or_time_invalid");
          const qty = money(f.quantityHundredths), gross = money(f.grossMicros), fee = money(f.feeMicros);
          requireProof(qty > 0n && fee >= 0n && gross === qty * BigInt(f.priceMicros) / 100n &&
            qty * BigInt(f.priceMicros) % 100n === 0n &&
            (f.action === "BUY" ? f.priceMicros <= i.request.limitMicros : f.priceMicros >= i.request.limitMicros),
          "production_fill_limit_or_amount_invalid");
          const filled = money(i.filled_hundredths) + qty;
          requireProof(filled <= requestQuantityHundredths(i.request), "production_overfill");
          let pnl = 0n, delta: bigint;
          if (i.kind === "ENTRY") {
            // The complete order-attribution pass already rejects BLOCKED rows.
            // This type-only assertion preserves malformed-data error precedence.
            // Validate the stored capability even for historical entries, so
            // accidental removal of both version fields cannot hide corruption.
            requireProof(i.capability_digest===digest({id:i.id,request:i.request,decision:i.decision,
              policyHash:i.policy_hash,fee:i.fee_fingerprint}),"production_entry_capability_corrupt");
            if (i.terminal) block("late_fill_after_terminal"); // still account for owned money/contracts
            const pos = (await tx.query("SELECT * FROM v13_production_position WHERE id=$1 FOR UPDATE", [i.id])).rows[0];
            requireProof(pos, "production_entry_position_missing");
            const cashProof=(i.decision!.preflight as {cashRisk?:V13EntryCashProof}|undefined)?.cashRisk;
            const cashBasis=(i.decision!.book as import("./types").MarketEvidence)?.fee?.cashRisk;
            // Only history with neither versioned field is legacy. Partial
            // stripping may not downgrade an authenticated fill's checks.
            requireProof(Boolean(cashBasis)===Boolean(cashProof),"production_entry_cash_bound_corrupt");
            if(cashProof){
              const pinned=(i.decision!.book as import("./types").MarketEvidence).fee;
              requireProof(i.request.action==="BUY"&&typeof i.request.contracts==="number"&&validEntryCashRisk(pinned)&&
                canonical(entryCashProof(pinned,i.request.contracts,cashProof.budgetCents))===canonical(cashProof)&&
                cashProof.limitMicros===i.request.limitMicros&&cashProof.feeFingerprint===i.fee_fingerprint,
                "production_entry_cash_bound_corrupt");
              const oneFillCap=entryFillFeeUpperMicros(pinned,qty,f.priceMicros);
              if(oneFillCap===null||fee>oneFillCap)block("entry_fill_fee_bound_exceeded", false);
              if(!entrySpent.has(i.id)){
                const spent=(await tx.query("SELECT coalesce(sum(-cash_delta_micros),0)::text AS amount FROM v13_production_event WHERE account_id=$1 AND intent_id=$2 AND kind='FILL'",[a.id,i.id])).rows[0];
                entrySpent.set(i.id,money(spent.amount));
              }
              const spent=entrySpent.get(i.id)!+gross+fee;entrySpent.set(i.id,spent);
              const joint=BigInt(pinned.cashRisk.entryCashDebitPerContractMicros)*filled/100n;
              if(spent>joint)block("entry_cash_bound_exceeded", false);
            }
            delta = -(gross + fee);
            let release = gross + fee;
            if (release > money(i.reserved_micros)) {
              block("entry_cost_exceeded_remaining_reservation", false);
              release = money(i.reserved_micros);
            }
            i.reserved_micros = String(money(i.reserved_micros) - release);
            a.reserved_micros = String(money(a.reserved_micros) - release);
            await tx.query("UPDATE v13_production_position SET quantity_hundredths=quantity_hundredths+$2,basis_micros=basis_micros+$3 WHERE id=$1",
              [i.id, String(qty), String(gross + fee)]);
          } else {
            const parent = intents.find(p => p.id === i.parent_id);
            requireProof(parent, "production_exit_parent_missing");
            const pos = (await tx.query("SELECT * FROM v13_production_position WHERE id=$1 FOR UPDATE", [parent.id])).rows[0];
            requireProof(pos && qty <= money(pos.quantity_hundredths), "production_exit_not_owned");
            const basis = money(pos.basis_micros) * qty / money(pos.quantity_hundredths);
            delta = gross - fee; pnl = delta - basis;
            const release = fee < money(parent.reserved_micros) ? fee : money(parent.reserved_micros);
            if (fee > release) block("exit_fee_exceeded_reservation");
            parent.reserved_micros = String(money(parent.reserved_micros) - release);
            a.reserved_micros = String(money(a.reserved_micros) - release);
            await tx.query(`UPDATE v13_production_position SET quantity_hundredths=quantity_hundredths-$2,
              basis_micros=basis_micros-$3,realized_pnl_micros=realized_pnl_micros+$4 WHERE id=$1`,
            [parent.id, String(qty), String(basis), String(pnl)]);
          }
          a.cash_micros = String(money(a.cash_micros) + delta);
          i.filled_hundredths = String(filled);
          await tx.query(`INSERT INTO v13_production_event(account_id,event_id,intent_id,kind,digest,payload,cash_delta_micros,pnl_micros,occurred_at)
            VALUES($1,$2,$3,'FILL',$4,$5,$6,$7,$8)`,
          [a.id, `fill:${f.id}`, i.id, digest(f), JSON.stringify(f), String(delta), String(pnl), new Date(f.occurredAtMs)]);
        }
        for (const o of snapshot.orders) {
          const i = byClient.get(o.request.clientOrderId)!;
          // Terminal status without complete exact fill totals cannot release funds.
          requireProof(money(o.filledHundredths) === money(i.filled_hundredths), "production_order_fill_total_incomplete");
          if (i.terminal && !o.terminal) block("terminal_order_reopened");
          if (o.terminal) { i.terminal = true; i.state = "TERMINAL"; }
        }
        for (const s of snapshot.settlements) {
          requireProof(Number.isSafeInteger(s.occurredAtMs)&&s.occurredAtMs>=0&&s.occurredAtMs<=snapshot.observedAtMs, "production_settlement_time_invalid");
          const old = await tx.query("SELECT digest FROM v13_production_event WHERE account_id=$1 AND event_id=$2", [a.id, `settlement:${s.id}`]);
          if (old.rows.length) { requireProof(old.rows[0].digest === digest(s), "production_changed_settlement"); continue; }
          const pos = (await tx.query(`SELECT * FROM v13_production_position WHERE account_id=$1 AND market=$2
            AND side=$3 AND quantity_hundredths>0 FOR UPDATE`, [a.id, s.market, s.side])).rows[0];
          requireProof(pos && money(s.quantityHundredths) === money(pos.quantity_hundredths), "production_settlement_ownership_mismatch");
          const parent = intents.find(i => i.id === pos.id)!;
          requireProof(parent && parent.terminal && !intents.some(i => i.parent_id === parent.id && !i.terminal && i.state !== "BLOCKED"),
            "production_settlement_has_uncertain_order");
          const payout = money(s.payoutMicros), fee = money(s.feeMicros);
          requireProof(fee >= 0n && payout === (s.side === s.result ? money(s.quantityHundredths) * 10_000n : 0n),
            "production_settlement_payout_invalid");
          const delta = payout - fee, pnl = delta - money(pos.basis_micros);
          a.cash_micros = String(money(a.cash_micros) + delta);
          await tx.query("UPDATE v13_production_position SET quantity_hundredths=0,basis_micros=0,realized_pnl_micros=realized_pnl_micros+$2 WHERE id=$1",
            [parent.id, String(pnl)]);
          await tx.query(`INSERT INTO v13_production_event(account_id,event_id,intent_id,kind,digest,payload,cash_delta_micros,pnl_micros,occurred_at)
            VALUES($1,$2,$3,'SETTLEMENT',$4,$5,$6,$7,$8)`,
          [a.id, `settlement:${s.id}`, parent.id, digest(s), JSON.stringify(s), String(delta), String(pnl), new Date(s.occurredAtMs)]);
        }
        // These intent IDs were read under FOR UPDATE and the account lock is
        // retained. The retention loop mutates only local reservation values,
        // so read its exact position quantities once in bounded primary-key batches.
        // Do not use the later positive-position projection: zero/missing rows
        // have distinct recovery meanings and must not disappear from this proof.
        // Correlated LIMIT 1 keeps each lookup a point probe instead of allowing
        // ANY(array) to become a whole-history scan on PostgreSQL 16. DISTINCT
        // retains ANY semantics for duplicate keys; absent/null keys return no row.
        const terminalEntries = intents.filter(i => i.kind === "ENTRY" && i.terminal);
        const terminalPositions = new Map<string, {id:string;quantity_hundredths:string}>();
        for (let offset=0;offset<terminalEntries.length;offset+=100) {
          const ids=terminalEntries.slice(offset,offset+100).map(i=>i.id);
          const rows=(await tx.query<{id:string;quantity_hundredths:string}>(
            TERMINAL_POSITION_BATCH_SQL,[ids])).rows;
          for(const row of rows)terminalPositions.set(row.id,row);
        }
        for (const i of terminalEntries) {
          const pos = terminalPositions.get(i.id)!;
          const retain = money(pos.quantity_hundredths) > 0n ? money(i.exit_fee_micros) : 0n;
          if (money(i.reserved_micros) < retain) {
            const add = retain - money(i.reserved_micros);
            requireProof(money(a.cash_micros) - money(a.reserved_micros) >= add, "production_exit_reservation_insufficient");
            a.reserved_micros = String(money(a.reserved_micros) + add);
          } else a.reserved_micros = String(money(a.reserved_micros) - (money(i.reserved_micros) - retain));
          i.reserved_micros = String(retain);
        }
        const positions = (await tx.query(`SELECT market,side,quantity_hundredths FROM v13_production_position
          WHERE account_id=$1 AND quantity_hundredths>0 ORDER BY market,side`, [a.id])).rows;
        if (positions.length > 1) block("overlap_ownership_after_late_fill");
        const actualPositions = snapshot.positions.filter(p => money(p.quantityHundredths) !== 0n)
          .map(p => ({ market: p.market, side: p.side, quantity_hundredths: String(money(p.quantityHundredths)) }))
          .sort((x, y) => x.market.localeCompare(y.market) || x.side.localeCompare(y.side));
        requireProof(canonical(positions) === canonical(actualPositions), "production_external_position_mismatch");
        requireProof(money(snapshot.cashMicros) === money(a.cash_micros), "production_external_cash_mismatch");
        // A crash (or failed audit receipt) between reservation and dispatch
        // can leave a PREPARED entry outside the worker's fresh-signal window.
        // Only complete signed recovery evidence plus the original immutable
        // expired source can prove this never-dispatched reservation releasable.
        // The intent and crossing remain consumed; nothing is replayed.
        for (const i of intents.filter(i => i.kind === "ENTRY" && i.state === "PREPARED")) {
          // PREPARED is never projected to null; do not add a new runtime guard.
          const source = i.decision!.source as { evaluated_at?: unknown } | undefined;
          const policy = i.decision!.policy as { maxQuoteAgeMs?: unknown } | undefined;
          const sourceAt = typeof source?.evaluated_at === "string" ? Date.parse(source.evaluated_at) : NaN;
          const lifetime = policy?.maxQuoteAgeMs;
          requireProof(Number.isSafeInteger(sourceAt) && typeof lifetime === "number" &&
            Number.isSafeInteger(lifetime) && lifetime >= 1 && lifetime <= 15_000 &&
            i.capability_digest === digest({ id: i.id, request: i.request, decision: i.decision,
              policyHash: i.policy_hash, fee: i.fee_fingerprint }), "production_prepared_expiry_evidence_invalid");
          if (snapshot.observedAtMs <= sourceAt + lifetime) continue;
          const pos = (await tx.query("SELECT quantity_hundredths,basis_micros FROM v13_production_position WHERE id=$1 FOR UPDATE", [i.id])).rows[0];
          requireProof(i.dispatch_at === null && i.exchange_order_id === null && !i.terminal &&
            money(i.filled_hundredths) === 0n && pos && money(pos.quantity_hundredths) === 0n &&
            money(pos.basis_micros) === 0n, "production_prepared_expiry_not_proven_unsent");
          a.reserved_micros = String(money(a.reserved_micros) - money(i.reserved_micros));
          i.reserved_micros = "0"; i.state = "BLOCKED"; i.terminal = true;
          await this.observe(tx, "PROVEN_NOT_POSTED", { id: i.id, reason: "production_prepared_entry_expired",
            sourceAtMs: sourceAt, maxQuoteAgeMs: lifetime, evidenceObservedAtMs: snapshot.observedAtMs });
        }
        await this.recoverPreparedExits(tx, a, intents, snapshot);
        // Historical rows with identical reconciled values need no UPDATE. All
        // reads, locks, transitions, conservation and audit writes still run.
        for (const i of intents) {
          if (!reconciliationIntentChanged(priorIntentStates.get(i.id)!, i)) continue;
          await tx.query(`UPDATE v13_production_intent SET state=$2,exchange_order_id=$3,
          filled_hundredths=$4,reserved_micros=$5,terminal=$6 WHERE id=$1`,
        [i.id, i.state, i.exchange_order_id, i.filled_hundredths, i.reserved_micros, i.terminal]);
        }
        // Subclass recovery hooks must not silently change or clear a freeze.
        if (held) requireProof(a.blocked_reason === originalFreeze,
          "production_held_reconciliation_freeze_changed");
        await this.assertConservation(tx, a);
        const observationId = await this.observe(tx, "RECONCILIATION", reconciliationObservation(snapshot));
        // The same account row remains locked. Persist reconciliation state and
        // its evidence together: no check/read separated these adjacent writes.
        // Keep the single revision increment and observation-before-write order.
        const persisted=await tx.query<{revision:string}>(`UPDATE v13_production_account SET cash_micros=$2,reserved_micros=$3,
          blocked_reason=$4,revision=revision+1,reconciled_at=$5,evidence_digest=$6 WHERE id=$1 RETURNING revision::text AS revision`,
          [a.id, a.cash_micros, a.reserved_micros, a.blocked_reason,
            new Date(snapshot.observedAtMs), digest(snapshot)]);
        if(held){requireProof(persisted.rows.length===1,"production_held_persisted_revision_unverified");return {accountId:this.accountId,observationId,persistedRevision:persisted.rows[0]!.revision};}
        return {accountId:this.accountId,observationId};
      });
    } catch (error) {
      if (!held && (error as Error).message !== "production_observation_raced") await this.freeze((error as Error).message);
      throw error;
    }
  }
}

import type { Pool, PoolClient } from "@workspace/db";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { computeV13LiveMoneyPolicyHash, type V13ApprovedLiveMoneyPolicy } from "../v13LiveMoneyRisk";
import { canonical, digest, money, requireProof, type Identity, type Snapshot, type Request } from "./types";

export type Account = {
  id: string; policy_id: string; subaccount: string; exchange_index: string;
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
  terminal: boolean; cancel_attempted: boolean; created_at: Date;
};
export const identity = (a: Account): Identity => ({
  subaccount: Number(a.subaccount), exchangeIndex: Number(a.exchange_index), keyFingerprint: a.key_fingerprint,
});

export function decodePolicy(row: Record<string, unknown>): V13ApprovedLiveMoneyPolicy {
  const decoded: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) decoded[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  for (const k of ["approvedAt", "championSelectedAt"]) if (decoded[k]) decoded[k] = new Date(decoded[k] as string);
  return decoded as V13ApprovedLiveMoneyPolicy;
}

export class ProductionLedger {
  private readonly context = new AsyncLocalStorage<PoolClient>();
  private readonly wireContext = new AsyncLocalStorage<{active:boolean;check:(()=>void)|null}>();
  constructor(readonly pool: Pool, readonly accountId: string) {}
  // Read providers invoked inside a final fence MUST use its existing client,
  // not open another transaction/connection behind the held account lock.
  query: Pool["query"] = ((...args: unknown[]) => {
    const client = this.context.getStore() ?? this.pool;
    return Reflect.apply(client.query, client, args);
  }) as Pool["query"];
  /** Trusted transport may borrow the current final fence, never commit it. */
  currentTransaction(): PoolClient|null {return this.context.getStore()??null;}
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
    scope.check();
  }
  async readAccount(): Promise<Account> {
    const { rows } = await this.query<Account>("SELECT * FROM v13_production_account WHERE id=$1", [this.accountId]);
    requireProof(rows.length === 1, "production_account_missing");
    return rows[0]!;
  }
  async transaction<T>(body: (tx: PoolClient, account: Account) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    const wireScope={active:true,check:null as (()=>void)|null};
    try {
      await tx.query("BEGIN");
      const { rows } = await tx.query<Account>("SELECT * FROM v13_production_account WHERE id=$1 FOR UPDATE", [this.accountId]);
      requireProof(rows.length === 1, "production_account_missing");
      const result = await this.context.run(tx, () => this.wireContext.run(wireScope,()=>body(tx, rows[0]!)));
      await tx.query("COMMIT");
      return result;
    } catch (error) { await tx.query("ROLLBACK"); throw error; }
    finally { wireScope.active=false;wireScope.check=null;tx.release(); }
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
  async observe(tx: PoolClient, kind: string, value: unknown): Promise<void> {
    await tx.query(`INSERT INTO v13_production_observation(id,account_id,kind,payload,digest)
      VALUES($1,$2,$3,$4,$5)`, [randomUUID(), this.accountId, kind, JSON.stringify(value), digest(value)]);
  }
  async freeze(reason: string): Promise<void> {
    await this.transaction(async (tx, a) => {
      a.blocked_reason = reason;
      await this.observe(tx, "BLOCK", { reason });
      await this.persist(tx, a);
    });
  }
  async assertConservation(tx: PoolClient, a: Account): Promise<void> {
    const events = await tx.query(`SELECT coalesce(sum(cash_delta_micros),0)::text cash,
      coalesce(sum(pnl_micros),0)::text pnl FROM v13_production_event WHERE account_id=$1`, [a.id]);
    const positions = await tx.query(`SELECT coalesce(sum(basis_micros),0)::text basis,
      coalesce(sum(realized_pnl_micros),0)::text pnl FROM v13_production_position WHERE account_id=$1`, [a.id]);
    const reservations = await tx.query(`SELECT coalesce(sum(reserved_micros),0)::text amount
      FROM v13_production_intent WHERE account_id=$1`, [a.id]);
    requireProof(money(a.cash_micros) === money(a.initial_cash_micros) + money(events.rows[0].cash) &&
      money(a.cash_micros) + money(positions.rows[0].basis) === money(a.initial_cash_micros) + money(events.rows[0].pnl) &&
      money(positions.rows[0].pnl) === money(events.rows[0].pnl) &&
      money(a.reserved_micros) === money(reservations.rows[0].amount), "production_money_conservation_failed");
  }

  async finalAccountProof(tx: PoolClient, a: Account, snapshot: Snapshot, nowMs: number): Promise<void> {
    requireProof(canonical(snapshot.identity) === canonical(identity(a)) && snapshot.authenticated &&
      snapshot.complete && snapshot.cashExact && !snapshot.unexplainedCashActivity &&
      snapshot.observedAtMs <= nowMs && nowMs - snapshot.observedAtMs <= 15_000 &&
      money(snapshot.cashMicros) === money(a.cash_micros), "production_final_account_changed_or_unproven");
    const known = (await tx.query<Intent>("SELECT * FROM v13_production_intent WHERE account_id=$1", [a.id])).rows;
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

  async reconcile(snapshot: Snapshot, expectedRevision: string, nowMs: number): Promise<void> {
    try {
      await this.transaction(async (tx, a) => {
        requireProof(a.revision === expectedRevision, "production_observation_raced");
        requireProof(canonical(snapshot.identity) === canonical(identity(a)), "production_account_mismatch");
        requireProof(snapshot.authenticated && snapshot.complete && snapshot.cashExact &&
          !snapshot.unexplainedCashActivity && snapshot.observedAtMs <= nowMs &&
          nowMs - snapshot.observedAtMs <= 15_000, "production_history_incomplete_stale_or_cash_unproven");
        const intents = (await tx.query<Intent>("SELECT * FROM v13_production_intent WHERE account_id=$1 ORDER BY created_at,id FOR UPDATE", [a.id])).rows;
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
          requireProof(filled <= BigInt(i.request.contracts) * 100n, "production_overfill");
          let pnl = 0n, delta: bigint;
          if (i.kind === "ENTRY") {
            if (i.terminal) a.blocked_reason = "late_fill_after_terminal"; // still account for owned money/contracts
            const pos = (await tx.query("SELECT * FROM v13_production_position WHERE id=$1 FOR UPDATE", [i.id])).rows[0];
            requireProof(pos, "production_entry_position_missing");
            delta = -(gross + fee);
            let release = gross + fee;
            if (release > money(i.reserved_micros)) {
              a.blocked_reason ??= "entry_cost_exceeded_remaining_reservation";
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
            if (fee > release) a.blocked_reason = "exit_fee_exceeded_reservation";
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
          if (i.terminal && !o.terminal) a.blocked_reason = "terminal_order_reopened";
          if (o.terminal) { i.terminal = true; i.state = "TERMINAL"; }
        }
        for (const s of snapshot.settlements) {
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
        for (const i of intents.filter(i => i.kind === "ENTRY" && i.terminal)) {
          const pos = (await tx.query("SELECT quantity_hundredths FROM v13_production_position WHERE id=$1", [i.id])).rows[0];
          const retain = money(pos.quantity_hundredths) > 0n ? money(i.exit_fee_micros) : 0n;
          if (money(i.reserved_micros) < retain) {
            const add = retain - money(i.reserved_micros);
            requireProof(money(a.cash_micros) - money(a.reserved_micros) >= add, "production_exit_reservation_insufficient");
            a.reserved_micros = String(money(a.reserved_micros) + add);
          } else a.reserved_micros = String(money(a.reserved_micros) - (money(i.reserved_micros) - retain));
          i.reserved_micros = String(retain);
        }
        for (const i of intents) await tx.query(`UPDATE v13_production_intent SET state=$2,exchange_order_id=$3,
          filled_hundredths=$4,reserved_micros=$5,terminal=$6 WHERE id=$1`,
        [i.id, i.state, i.exchange_order_id, i.filled_hundredths, i.reserved_micros, i.terminal]);
        const positions = (await tx.query(`SELECT market,side,quantity_hundredths FROM v13_production_position
          WHERE account_id=$1 AND quantity_hundredths>0 ORDER BY market,side`, [a.id])).rows;
        if (positions.length > 1) a.blocked_reason = "overlap_ownership_after_late_fill";
        const actualPositions = snapshot.positions.filter(p => money(p.quantityHundredths) !== 0n)
          .map(p => ({ market: p.market, side: p.side, quantity_hundredths: String(money(p.quantityHundredths)) }))
          .sort((x, y) => x.market.localeCompare(y.market) || x.side.localeCompare(y.side));
        requireProof(canonical(positions) === canonical(actualPositions), "production_external_position_mismatch");
        requireProof(money(snapshot.cashMicros) === money(a.cash_micros), "production_external_cash_mismatch");
        await this.assertConservation(tx, a);
        await this.observe(tx, "RECONCILIATION", snapshot);
        await this.persist(tx, a);
        await tx.query("UPDATE v13_production_account SET reconciled_at=$2,evidence_digest=$3 WHERE id=$1",
          [a.id, new Date(snapshot.observedAtMs), digest(snapshot)]);
      });
    } catch (error) {
      if ((error as Error).message !== "production_observation_raced") await this.freeze((error as Error).message);
      throw error;
    }
  }
}

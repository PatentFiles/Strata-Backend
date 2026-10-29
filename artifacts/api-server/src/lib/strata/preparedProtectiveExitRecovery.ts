import { createHash } from "node:crypto";
import type { PoolClient } from "@workspace/db";
import type { Account, Intent } from "../v13-production/ledger";
import { canonical, digest, money, requireProof, type Snapshot } from "../v13-production/types";

/** Called only by the owned ledger, inside its account/intent transaction AFTER
 * complete authenticated account reconciliation. No transport, retry authority,
 * position reduction or release of parent cash/exit-fee reservations occurs.
 */
export async function recoverPreparedOwnedExitIntents(tx: PoolClient, input: {
  ownerId: string; account: Account; intents: Intent[]; snapshot: Snapshot;
  observe: (kind: string, value: unknown) => Promise<void>;
}): Promise<void> {
  const { account, intents, snapshot, ownerId } = input;
  for (const intent of intents.filter(i => i.kind === "EXIT" && i.state === "PREPARED")) {
    const owned = intent.decision.ownedEvaluation as { source?: { evaluated_at?: unknown } } | undefined;
    const policy = intent.decision.policy as { maxQuoteAgeMs?: unknown } | undefined;
    const at = typeof owned?.source?.evaluated_at === "string" ? Date.parse(owned.source.evaluated_at) : NaN;
    const ttl = policy?.maxQuoteAgeMs;
    requireProof(account.owner_user_id === ownerId && snapshot.authenticated && snapshot.complete && snapshot.cashExact &&
      !snapshot.unexplainedCashActivity && Number.isSafeInteger(at) &&
      typeof ttl === "number" && Number.isSafeInteger(ttl) && ttl >= 1 && ttl <= 15_000 &&
      intent.capability_digest === digest({ id: intent.id, request: intent.request,
        decision: intent.decision, policyHash: intent.policy_hash, fee: intent.fee_fingerprint }),
      "protective_prepared_expiry_evidence_invalid");
    if (snapshot.observedAtMs <= at + ttl) continue;
    requireProof(intent.account_id === account.id && intent.dispatch_at === null &&
      intent.exchange_order_id === null && !intent.terminal && money(intent.filled_hundredths) === 0n &&
      money(intent.reserved_micros) === 0n && money(intent.exit_fee_micros) === 0n &&
      intent.request.action === "SELL" && intent.request.reduceOnly === true &&
      intent.request.timeInForce === "IOC" && intent.request.clientOrderId === intent.client_order_id,
      "protective_prepared_expiry_not_proven_unsent");
    const parent = intents.find(i => i.id === intent.parent_id && i.kind === "ENTRY");
    const position = (await tx.query("SELECT * FROM v13_production_position WHERE id=$1 AND account_id=$2 FOR UPDATE",
      [intent.parent_id,account.id])).rows[0];
    requireProof(parent && parent.terminal && position && position.market === intent.market &&
      position.side === intent.side && money(position.quantity_hundredths) > 0n &&
      money(position.basis_micros) >= 0n, "protective_prepared_expiry_ownership_unproven");
    // Query by client identity even if a corrupt row names a different owner
    // or account. Such a row must block clearance, not appear absent.
    const reservations = (await tx.query(`SELECT * FROM private.strata_emergency_exit_reservations
      WHERE client_order_id=$1 FOR UPDATE`,[intent.client_order_id])).rows;
    requireProof(reservations.length <= 1, "protective_prepared_expiry_marker_ambiguous");
    const marker = reservations[0];
    if (marker) {
      const raw = marker.order_request_json;
      let request: Record<string,unknown> | null = null;
      try { if(typeof raw === "string") request=JSON.parse(raw); } catch { /* fail closed below */ }
      const expected = {
        ticker:intent.market,side:intent.side === "YES" ? "ask" : "bid",
        count:intent.request.contracts.toFixed(2),
        price:((intent.side === "YES" ? intent.request.limitMicros : 1_000_000-intent.request.limitMicros)/1_000_000).toFixed(4),
        client_order_id:intent.client_order_id,time_in_force:"immediate_or_cancel",
        self_trade_prevention_type:"taker_at_cross",post_only:false,reduce_only:true,subaccount:1,exchange_index:2,
      };
      requireProof(marker.state === "PREPARED" && marker.trading_authorized === false &&
        marker.owner_user_id === ownerId && marker.execution_account_id === account.id &&
        marker.market_ticker === intent.market && marker.reducing_side === intent.side &&
        money(marker.quantity_hundredths) === BigInt(intent.request.contracts)*100n &&
        typeof raw === "string" && createHash("sha256").update(raw).digest("hex") === marker.order_digest &&
        canonical(request) === canonical(expected), "protective_prepared_expiry_marker_not_proven_unsent");
      const changed=await tx.query(`UPDATE private.strata_emergency_exit_reservations
        SET state='VOID',updated_at=now() WHERE reservation_id=$1 AND state='PREPARED'
        RETURNING reservation_id`,[marker.reservation_id]);
      requireProof(changed.rows.length === 1, "protective_prepared_expiry_marker_raced");
    }
    intent.state="BLOCKED";intent.terminal=true;
    await input.observe("PROVEN_NOT_POSTED",{id:intent.id,reason:"production_prepared_exit_expired",
      reservationId:marker?.reservation_id??null,sourceAtMs:at,maxQuoteAgeMs:ttl,
      evidenceObservedAtMs:snapshot.observedAtMs,ownedQuantityHundredths:position.quantity_hundredths});
  }
}

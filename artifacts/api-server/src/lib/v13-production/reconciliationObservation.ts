import {digest,type Snapshot} from './types';

/** Persistence-only receipt, NOT replayable reconciliation evidence. All authority
 * checks continue using the full signed Snapshot; account evidence_digest remains
 * its digest. No historical observations or financial events are rewritten. */
export function reconciliationObservation(snapshot:Snapshot){
 const exposure=snapshot.positions.filter(p=>p.quantityHundredths!=='0');
 const sample=exposure.slice(0,8).map(p=>({
  market:p.market.length<=128?p.market:null,side:p.side==="YES"||p.side==="NO"?p.side:null,
  quantityHundredths:p.quantityHundredths.length<=32?p.quantityHundredths:null,
 }));
 return {
  version:'RECONCILIATION_SUMMARY_V1',replayable:false,
  fullSnapshotDigest:digest(snapshot),
  identity:{subaccount:snapshot.identity.subaccount,exchangeIndex:snapshot.identity.exchangeIndex,
   keyFingerprintDigest:digest(snapshot.identity.keyFingerprint)},
  observedAtMs:snapshot.observedAtMs,historyFromMs:snapshot.historyFromMs,
  complete:snapshot.complete,authenticated:snapshot.authenticated,cashExact:snapshot.cashExact,
  cashMicros:snapshot.cashMicros.length<=64?snapshot.cashMicros:null,
  unexplainedCashActivity:snapshot.unexplainedCashActivity,
  counts:{orders:snapshot.orders.length,fills:snapshot.fills.length,
   settlements:snapshot.settlements.length,positions:snapshot.positions.length,
   nonzeroPositions:exposure.length,nonterminalOrders:snapshot.orders.filter(o=>!o.terminal).length},
  exposure:{digest:digest(exposure),sample,omittedCount:Math.max(0,exposure.length-sample.length)},
 };
}

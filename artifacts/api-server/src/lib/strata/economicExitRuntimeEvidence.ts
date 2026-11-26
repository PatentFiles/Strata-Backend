import {canonical,digest,money,requireProof,type Snapshot} from '../v13-production/types';
import {identity,type Account} from '../v13-production/ledger';
import {economicExitFinalityEnabled,readEconomicExitDischarges,assertNoEconomicExitContradiction} from './economicExitDischargeScope';
type Query=Parameters<typeof readEconomicExitDischarges>[0];
type Row=Record<string,unknown>;
type Scope={account:Account;ownerId:string;snapshot:Snapshot;nowMs:number;currentIntentId:string|null};
/** A durable accounting receipt is not order authority. Every exception to an
 * UNKNOWN gate additionally needs a fresh, complete, same-key signed snapshot.
 * The caller still checks its own policy, fee, source, kill, lease and order gates.
 * This helper does not change cash, transport history, approvals or controls. */
export function verifyEconomicRuntimeEvidence(rows:Row[],scope:Scope){
 const {account:a,ownerId,snapshot:s,nowMs,currentIntentId}=scope;
 const fail='economic_discharge_runtime_evidence_unverified';
 requireProof(rows.length>0&&rows.length<=1000&&a.owner_user_id===ownerId&&
  Number(a.subaccount)===1&&Number(a.exchange_index)===2&&
  canonical(s.identity)===canonical(identity(a))&&s.authenticated&&s.complete&&s.cashExact&&
  !s.unexplainedCashActivity&&Number.isSafeInteger(nowMs)&&Number.isSafeInteger(s.observedAtMs)&&
  s.observedAtMs<=nowMs&&nowMs-s.observedAtMs<=5000&&
  Number.isSafeInteger(s.historyFromMs)&&s.historyFromMs<=s.observedAtMs&&
  money(s.cashMicros)===money(a.cash_micros),fail);
 assertNoEconomicExitContradiction(rows,s);
 const ids:string[]=[];
 for(const d of rows){
  const p=(typeof d.payload==='string'?JSON.parse(d.payload):d.payload) as Row;
  const settlement=p.settlement as Snapshot['settlements'][number];
  const dispatch=d.exit_dispatch_at instanceof Date?d.exit_dispatch_at.getTime():Date.parse(String(d.exit_dispatch_at));
  requireProof(d.execution_account_id===a.id&&d.owner_user_id===ownerId&&p.keyFingerprint===a.key_fingerprint&&
   p.accountId===a.id&&p.ownerId===ownerId&&p.exitId===d.exit_intent_id&&p.transportOutcome==='UNKNOWN'&&
   p.tradingAuthorized===false&&digest(p)===d.payload_digest&&
   typeof d.exit_intent_id==='string'&&d.exit_intent_id!==currentIntentId&&!ids.includes(d.exit_intent_id)&&
   settlement&&'settlement:'+settlement.id===d.settlement_event_id&&digest(settlement)===d.settlement_digest&&
   Number.isSafeInteger(dispatch)&&s.historyFromMs<=dispatch&&
   settlement.occurredAtMs<=s.observedAtMs&&s.historyFromMs<=settlement.occurredAtMs,fail);
  const exact=s.settlements.filter(x=>'settlement:'+x.id===d.settlement_event_id);
  requireProof(exact.length===1&&canonical(exact[0])===canonical(settlement)&&
   !s.positions.some(x=>x.market===settlement.market&&money(x.quantityHundredths)!==0n),fail);
  ids.push(d.exit_intent_id);
 }
 return Object.freeze({exitIds:Object.freeze(ids.sort()),receiptDigest:digest(rows.map(d=>({id:d.request_id,digest:d.payload_digest}))),observedAtMs:s.observedAtMs});
}
/** Caller holds the account lock. Immutable receipts need no UPDATE privilege. */
export async function readEconomicRuntimeEvidence(db:Query,scope:Scope){
 if(!economicExitFinalityEnabled())return null;
 const rows=await readEconomicExitDischarges(db,scope.account.id,true);
 return rows.length?verifyEconomicRuntimeEvidence(rows,scope):null;
}

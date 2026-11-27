import {orderedOwnerReads} from './economicRecoveryReadBatch';
import {assertOwnerArmFence} from './ownerArmContext';
import {performance} from "node:perf_hooks";
import {pool,type Pool,type PoolClient} from "@workspace/db";
import {ProductionLedger,type Account} from "../v13-production/ledger";
import {digest} from "../v13-production/types";
import {getScopedKalshiJson} from "../kalshiAccountClient";
import {collectCommissioningCashEvidence,OWNER_SIGNED_PROOF_ACCOUNT_SQL,type MatchingCommissioningEvidence} from "./ownerSignedExchangeReleaseProof";
import {persistVerifiedOwnedCashMicros,RECORD_OWNED_CASH_CONFIRMATION} from "./personalCashReconciliation";
import {readNeverPostedReleaseHistory} from "./neverPostedReleaseHistory";
import {registeredReceipt,proveRegisteredOpeningEvidence,type RegisteredReceipt} from "./registeredOpeningCapitalProof";
import {readCapitalTransfers} from "./capitalCreditTransfers";
import {loadCapitalTransferSigner} from "./capitalCreditTransferSigner";
import type {Query} from "./capitalCreditProof";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[a-f0-9]{12}$/i;
type InitialProof={receipt:RegisteredReceipt;signerDigest:string};
const refused=(reason:string)=>({ok:false as const,reason,recordPersisted:false as const,transferAttempted:false as const});
const recordUnknown=()=>({ok:false as const,reason:"commissioning_cash_commit_unknown_refresh_records",recordPersisted:false as const,transferAttempted:false as const});
function ensure(ok:unknown,reason:string):asserts ok{if(!ok)throw Error(reason);}
// Only explicit, account-independent refusal codes may cross the owner API.
const CASH_REFUSALS=new Set([
 "commissioning_cash_account_not_stopped","commissioning_cash_event_history_mismatch","commissioning_cash_evidence_expired",
 "commissioning_cash_history_changed","commissioning_cash_mismatch","commissioning_cash_owner_scope_changed",
 "commissioning_cash_persistence_refused","commissioning_cash_post_state_changed","commissioning_cash_scope_changed",
 "commissioning_cash_signed_history_unverified","commissioning_cash_signer_or_policy_changed","commissioning_cash_unexpected_capital_change",
 "commissioning_initial_funding_unverified","commissioning_initial_receipt_ambiguous","commissioning_initial_receipt_changed",
 "commissioning_initial_transfer_signer_changed","owner_arm_scope_changed","owner_arm_interrupted","owner_arm_expired_or_interrupted",
 "production_money_conservation_failed","production_funding_receipts_inconsistent","production_final_account_changed_or_unproven",
 "production_final_history_gap","production_final_order_changed","production_final_event_history_ambiguous","production_final_unreconciled_fill",
 "production_final_unreconciled_settlement","production_final_position_changed","economic_discharge_final_snapshot_expired",
 "economic_discharge_final_settlement_unverified","economic_discharge_history_capacity","economic_discharge_receipt_unverified",
 "economic_discharge_financial_contradiction","economic_discharge_late_order_or_fill_requires_review",
 "release_history_bound_exceeded","release_history_client_identity_ambiguous","financial_intent_unreadable",
 "release_never_posted_financial_event_conflict","release_never_posted_evidence_invalid_or_contradictory",
 "release_never_posted_exit_evidence_invalid_or_contradictory","release_local_exit_no_send_evidence_invalid_or_contradictory",
 "economic_discharge_batch_read_unverified",
]);
function cashFailure(error:unknown,fallback:string):string{
 return error instanceof Error&&CASH_REFUSALS.has(error.message)?error.message:fallback;
}
async function receiptFor(db:Query,owner:string,evidence:MatchingCommissioningEvidence,lock:boolean){
 const id=String(evidence.account.id);
 const tail=lock?" FOR SHARE":"";
 const pilot=(await db.query("SELECT * FROM private.kalshi_owner_pilot_transfers WHERE execution_account_id=$1 LIMIT 2"+tail,[id])).rows;
 const historical=(await db.query("SELECT * FROM private.kalshi_owner_historical_funding WHERE execution_account_id=$1 LIMIT 2"+tail,[id])).rows;
 const receipt=registeredReceipt(pilot,historical,owner,evidence.account);
 const registrations=await db.query(`SELECT 1 FROM private.kalshi_owner_pilot_transfers WHERE verified_exchange_transfer_id=$1
 UNION ALL SELECT 1 FROM private.kalshi_owner_historical_funding WHERE exchange_transfer_id=$1
 UNION ALL SELECT 1 FROM private.kalshi_owner_topup_legs WHERE exchange_transfer_id=$1`,[receipt.receiptId]);
 ensure(registrations.rows.length===1,"commissioning_initial_receipt_ambiguous");
 return receipt;
}

/** Same existing signed-history, accounting and funding services; no parallel
 * ledger. Called only after versioned financial continuation consent. All
 * HTTP is complete before this short transaction; a stale or changed account
 * is refused. The only permitted cash change is establishing an unfunded
 * pre-commissioning basis from the original registered transfer. */
export async function commitCommissioningCashEvidence(owner:string,evidence:MatchingCommissioningEvidence,
 initial:InitialProof|null,db:Pool=pool,now=Date.now,monoDeadline=performance.now()+15000){
 if(!UUID.test(owner)||evidence.account.owner_id!==owner)return refused("commissioning_cash_owner_scope_changed");
 const observed=evidence.snapshot.observedAtMs,id=String(evidence.account.id);
 const check=()=>{
  const at=now();
  ensure(Number.isSafeInteger(observed)&&observed>0&&Number.isSafeInteger(at)&&at>=observed&&at-observed<=15000&&performance.now()<=monoDeadline,
   "commissioning_cash_evidence_expired");
  return at;
 };
 let tx:PoolClient|undefined,committed=false,commitSent=false,discard:Error|undefined;
 try{
  check();tx=await db.connect();
  await tx.query("BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL lock_timeout='1500ms'; SET LOCAL statement_timeout='12000ms'");
  const discharge=evidence.verifiedEconomicHistory===true;
  await assertOwnerArmFence(tx,owner,discharge);
  // Preserve account → signing chain → lease → revision lock order and all
  // per-result checks. The verified discharge hint selects transport only.
  const held=await orderedOwnerReads(tx,discharge,[
   ["SELECT * FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid AND subaccount=1 AND exchange_index=2 FOR UPDATE",[id,owner]],
   [`SELECT p.id FROM public.v13_production_account a
   JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id AND p.created_by=a.owner_user_id::text
   JOIN public.financial_accounts f ON f.id=a.kalshi_connection_id AND f.user_id=a.owner_user_id AND f.provider='kalshi'
   JOIN private.provider_connections pc ON pc.financial_account_id=f.id
   JOIN private.kalshi_connection_credentials c ON c.financial_account_id=f.id AND c.provider_connection_id=pc.id AND c.owner_user_id=a.owner_user_id
   WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND p.state='APPROVED'
   AND c.role='restricted_execution' AND c.key_fingerprint=a.key_fingerprint AND c.revoked_at IS NULL
   AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified' FOR SHARE OF p,f,pc,c`,[id,owner]],
   ["SELECT execution_account_id FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 FOR UPDATE",[id]],
   [OWNER_SIGNED_PROOF_ACCOUNT_SQL,[owner]]
  ]);
  const locked=await held(0);
  ensure(locked.rows.length===1,"commissioning_cash_owner_scope_changed");
  const a=locked.rows[0] as Account;
  ensure(a.kill_switch===true&&a.execution_enabled===false&&(a.blocked_reason===null||a.blocked_reason==="awaiting_account_commissioning")&&String(a.reserved_micros)==="0",
   "commissioning_cash_account_not_stopped");
  // Lock the real account-scoped policy and signing chain; account ownership is
  // never inferred from an email, a client identifier or a global key.
  const pins=await held(1);
  ensure(pins.rows.length===1,"commissioning_cash_signer_or_policy_changed");
  await held(2);
  const final=(await held(3)).rows;
  ensure(final.length===1&&final[0]!.id===id&&final[0]!.diagnostic_held===true&&
   digest(final[0]!.hold_revision)===digest(evidence.account.hold_revision),"commissioning_cash_scope_changed");
  const history=await readNeverPostedReleaseHistory(tx,id,true,{expiredExitOwnerId:owner,batchDischargeEvidence:true});
  ensure(history.historyDigest===evidence.historyDigest,"commissioning_cash_history_changed");
  const snapshot=evidence.snapshot;
  ensure(snapshot.authenticated&&snapshot.complete&&snapshot.cashExact&&!snapshot.unexplainedCashActivity&&snapshot.positions.length===0&&snapshot.orders.every(o=>o.terminal),
   "commissioning_cash_signed_history_unverified");
  // No omitted local fill or settlement may be hidden by a matching balance.
  const eventIds=[...snapshot.fills.map(f=>"fill:"+f.id),...snapshot.settlements.map(s=>"settlement:"+s.id)].sort();
  const recordedEvents=(await tx.query("SELECT event_id FROM public.v13_production_event WHERE account_id=$1 ORDER BY event_id FOR SHARE",[id])).rows.map(r=>String(r.event_id)).sort();
  ensure(digest(eventIds)===digest(recordedEvents),"commissioning_cash_event_history_mismatch");
  const ledger=new ProductionLedger(db,id);
  await ledger.assertConservation(tx,a);
  if(evidence.initialFundingCandidate){
   ensure(initial&&a.commissioned===false&&String(a.cash_micros)==="0"&&String(a.initial_cash_micros)==="0"&&history.rows.length===0&&eventIds.length===0,
    "commissioning_initial_funding_unverified");
   const receipt=await receiptFor(tx,owner,evidence,true);
   ensure(receipt.registryDigest===initial.receipt.registryDigest,"commissioning_initial_receipt_changed");
   const signer=await loadCapitalTransferSigner(tx,evidence.account,true);
   ensure(digest(signer.bindings)===initial.signerDigest,"commissioning_initial_transfer_signer_changed");
  }else{
   ensure(initial===null&&String(a.cash_micros)===snapshot.cashMicros,"commissioning_cash_mismatch");
   await ledger.finalAccountProof(tx,a,snapshot,check(),Boolean(history.economicDischarges?.length));
  }
  const stored=await persistVerifiedOwnedCashMicros(tx,{
   ownerUserId:owner,executionAccountId:id,confirmation:RECORD_OWNED_CASH_CONFIRMATION,subaccount:1,exchangeIndex:2,
   observedAtMs:observed,nowMs:check(),maxAgeMs:15000,cashMicros:snapshot.cashMicros,
  });
  ensure(stored.ok,"commissioning_cash_persistence_refused");
  const updated=(await tx.query<Account>("SELECT * FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid",[id,owner])).rows[0];
  ensure(updated&&updated.execution_enabled===false&&updated.kill_switch===true&&updated.blocked_reason===a.blocked_reason&&
   updated.policy_id===a.policy_id&&updated.key_fingerprint===a.key_fingerprint&&updated.commissioned===a.commissioned,
   "commissioning_cash_post_state_changed");
  if(!evidence.initialFundingCandidate)ensure(String(updated.cash_micros)===String(a.cash_micros)&&String(updated.initial_cash_micros)===String(a.initial_cash_micros),"commissioning_cash_unexpected_capital_change");
  await ledger.finalAccountProof(tx,updated,snapshot,check(),Boolean(history.economicDischarges?.length));
  await ledger.assertConservation(tx,updated);
  check();commitSent=true;await tx.query("COMMIT");committed=true;
  return {ok:true as const,reason:"commissioning_signed_cash_recorded",recordPersisted:true as const,transferAttempted:false as const,
   observedAt:new Date(observed).toISOString(),initialFundingEstablished:evidence.initialFundingCandidate};
 }catch(error){
  if(commitSent){discard=Error("commissioning_cash_commit_unknown");return recordUnknown();}
  return refused(cashFailure(error,"commissioning_cash_reconciliation_refused"));
 }finally{
  if(tx){if(!committed&&!discard)try{await tx.query("ROLLBACK");}catch{discard=Error("commissioning_cash_rollback_unknown");}tx.release(discard);}
 }
}
export async function refreshOwnerCommissioningCash(owner:string){
 if(!UUID.test(owner))return refused("commissioning_cash_owner_scope_changed");
 const deadline=performance.now()+15000;
 try{
  const {proof,evidence}=await collectCommissioningCashEvidence(owner);
  if(!proof.ok||!evidence)return refused(proof.ok?"commissioning_cash_signed_history_or_matching_balance_unverified":proof.reason);
  let initial:InitialProof|null=null;
  if(evidence.initialFundingCandidate){
   const receipt=await receiptFor(pool,owner,evidence,false);
   const signer=await loadCapitalTransferSigner(pool,evidence.account);
   ensure(!receipt.providerConnectionId||receipt.providerConnectionId===signer.bindings.setup.providerConnectionId,
    "commissioning_initial_transfer_signer_changed");
   const remaining=Math.floor(deadline-performance.now());
   ensure(remaining>0,"commissioning_cash_evidence_expired");
   const signal=AbortSignal.timeout(remaining);
   const transfers=await readCapitalTransfers((path,query)=>getScopedKalshiJson(signer.material,path,query,fetch,"https://external-api.kalshi.com",owner,signal),evidence.snapshot.observedAtMs);
   proveRegisteredOpeningEvidence(receipt,evidence.snapshot.cashMicros,evidence.feeds,transfers,evidence.snapshot.observedAtMs);
   initial={receipt,signerDigest:digest(signer.bindings)};
  }
  return commitCommissioningCashEvidence(owner,evidence,initial,pool,Date.now,deadline);
 }catch(error){
  return refused(cashFailure(error,"commissioning_cash_signed_evidence_unavailable"));
 }
}

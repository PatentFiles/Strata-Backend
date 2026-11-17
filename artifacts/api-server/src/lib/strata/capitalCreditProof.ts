import {capitalStage} from './capitalCreditDiagnostic';
import {approvedFromRow} from './ownerStakePolicyAmendment';
import {computeV13LiveMoneyPolicyHash} from '../v13LiveMoneyRisk';
import {performance} from 'node:perf_hooks';
import {pool} from '@workspace/db';
import type {Pool,PoolClient} from '@workspace/db';
import {ProductionLedger,type Account} from '../v13-production/ledger';
import {digest} from '../v13-production/types';
import {loadedMaterial} from './inAppProtectiveRelease';
import {getScopedKalshiJson} from '../kalshiAccountClient';
import {readOwnedKalshiFeeds,personalAccountSnapshot} from './personalExchangeRead';
import {readNeverPostedReleaseHistory} from './neverPostedReleaseHistory';
import {v3MigrationFlatHistoryCheck} from './ownerFeeV3Migration';
import {readCapitalTransfers,uniqueCapitalTransfer} from './capitalCreditTransfers';
export type Row=Record<string,unknown>;
export type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
export type Db=Query&{connect():Promise<Query&{release(error?:Error):void}>};
export type ProofDeps={db?:Db;read?:typeof readOwnedKalshiFeeds;get?:typeof getScopedKalshiJson;load?:typeof loadedMaterial;now?:()=>number};
const HASH=/^[a-f0-9]{64}$/;
const integer=(x:unknown)=>typeof x==='string'&&/^\d+$/.test(x);
export type CreditScope={ownerId:string;accountId:string;sha:string;policyHash:string;checkpointId:string;checkpointDigest:string;receiptId:string;receiptDigest:string;receiptCreatedAt:string;amountCents:number;oldInitialCashMicros:string;newInitialCashMicros:string;cashMicros:string;accountRevision:string;scopeDigest:string};
export function scopeDigest(s:Omit<CreditScope,'scopeDigest'>){return digest(s);}
export function validCreditScope(v:unknown):v is CreditScope{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;const s=v as CreditScope;
 if(Object.keys(s).sort().join(',')!=='accountId,accountRevision,amountCents,cashMicros,checkpointDigest,checkpointId,newInitialCashMicros,oldInitialCashMicros,ownerId,policyHash,receiptCreatedAt,receiptDigest,receiptId,scopeDigest,sha')return false;
 const {scopeDigest:hash,...core}=s;
 return typeof s.ownerId==='string'&&/^[a-f0-9-]{36}$/i.test(s.ownerId)&&typeof s.accountId==='string'&&s.accountId.length>0&&s.accountId.length<=200&&
 /^[a-f0-9]{40}$/.test(s.sha)&&[s.policyHash,s.checkpointDigest,s.receiptDigest,hash].every(x=>typeof x==='string'&&HASH.test(x))&&
 typeof s.checkpointId==='string'&&s.checkpointId.length>0&&s.checkpointId.length<=128&&typeof s.receiptId==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(s.receiptId)&&
 typeof s.receiptCreatedAt==='string'&&Number.isFinite(Date.parse(s.receiptCreatedAt))&&new Date(s.receiptCreatedAt).toISOString()===s.receiptCreatedAt&&
 Number.isSafeInteger(s.amountCents)&&s.amountCents>0&&s.amountCents<=2500000&&[s.oldInitialCashMicros,s.newInitialCashMicros,s.cashMicros,s.accountRevision].every(x=>integer(x)&&BigInt(x)<=9223372036854775807n)&&
 BigInt(s.newInitialCashMicros)===BigInt(s.oldInitialCashMicros)+BigInt(s.amountCents)*10000n&&digest(core)===hash;
}
export async function creditLocal(db:Query,owner:string,account:string,lock=false){
 const rows=await db.query(`SELECT a.*,a.owner_user_id::text AS owner_id,a.cash_micros::text AS cash_text,a.initial_cash_micros::text AS initial_text,a.revision::text AS revision_text,p.policy_hash,to_jsonb(p) AS policy
 FROM public.v13_production_account a JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 WHERE a.owner_user_id=$1::uuid AND a.id=$2 AND a.subaccount=1 AND a.exchange_index=2 AND p.created_by=$1::text AND p.state='APPROVED' ${lock?'FOR UPDATE OF a FOR SHARE OF p':''}`,[owner,account]);
 if(rows.rows.length!==1)throw Error('capital_account_scope_unverified');const a=rows.rows[0];
 if(a.commissioned!==true||a.cash_precision_verified!==true||a.kill_switch!==true||a.execution_enabled!==false||a.blocked_reason!==null||String(a.reserved_micros)!=='0'||!HASH.test(String(a.policy_hash))||!integer(a.cash_text)||!integer(a.initial_text)||!integer(a.revision_text))throw Error('capital_stopped_account_required');
 const policy=approvedFromRow(a.policy as Row);if(!policy||policy.policyHash!==computeV13LiveMoneyPolicyHash(policy))throw Error('capital_policy_unverified');
 const leases=await db.query(`SELECT owner_user_id::text,state,account_kill,arm_requested FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 ${lock?'FOR UPDATE':''}`,[account]);
 if(leases.rows.length!==1||leases.rows[0].owner_user_id!==owner||leases.rows[0].state!=='killed'||leases.rows[0].account_kill!==true||leases.rows[0].arm_requested!==false)throw Error('capital_stopped_worker_required');
 const history=await capitalStage('retained_history',()=>readNeverPostedReleaseHistory(db,account,lock,{expiredExitOwnerId:owner}));
 const events=(await db.query(`SELECT event_id,intent_id,kind,digest,payload,cash_delta_micros::text,pnl_micros::text,occurred_at FROM public.v13_production_event WHERE account_id=$1 ORDER BY event_id ${lock?'FOR SHARE':''}`,[account])).rows;
 const positions=(await db.query(`SELECT market,side,quantity_hundredths::text,basis_micros::text,realized_pnl_micros::text FROM public.v13_production_position WHERE account_id=$1 ORDER BY market,side ${lock?'FOR SHARE':''}`,[account])).rows;
 const exits=(await db.query(`SELECT reservation_id FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND state IN('PREPARED','DISPATCHED','UNKNOWN') ${lock?'FOR SHARE':''}`,[account])).rows;
 if(exits.length||history.rows.some(i=>i.terminal!==true||String(i.reserved_micros)!=='0')||positions.some(p=>String(p.quantity_hundredths)!=='0'||String(p.basis_micros)!=='0'))throw Error('capital_open_exposure');
 const checkpoints=(await db.query(`SELECT id,payload,digest,observed_at FROM public.v13_production_observation WHERE account_id=$1 AND kind='RECONCILIATION' ORDER BY observed_at DESC,id DESC LIMIT 2 ${lock?'FOR SHARE':''}`,[account])).rows;
 if(!checkpoints.length||checkpoints.length>1&&String(checkpoints[0].observed_at)===String(checkpoints[1].observed_at))throw Error('capital_checkpoint_missing_or_ambiguous');
 const checkpoint=checkpoints[0],p=checkpoint.payload as Row,identity=p?.identity as Row;const summary=p?.version==='RECONCILIATION_SUMMARY_V1';
 if(!p||digest(p)!==checkpoint.digest||p.authenticated!==true||p.complete!==true||p.cashExact!==true||p.unexplainedCashActivity!==false||!identity||identity.subaccount!==1||identity.exchangeIndex!==2||
 (summary?identity.keyFingerprintDigest!==digest(a.key_fingerprint):identity.keyFingerprint!==a.key_fingerprint)||!Number.isSafeInteger(p.observedAtMs)||Number(p.observedAtMs)<=0||Number(p.observedAtMs)>new Date(String(checkpoint.observed_at)).getTime()+10000||!integer(p.cashMicros))throw Error('capital_checkpoint_unverified');
 const cash=events.reduce((n,e)=>n+BigInt(String(e.cash_delta_micros)),0n),pnl=events.reduce((n,e)=>n+BigInt(String(e.pnl_micros)),0n),positionPnl=positions.reduce((n,p)=>n+BigInt(String(p.realized_pnl_micros)),0n);
 if(events.some(e=>!Number.isFinite(new Date(String(e.occurred_at)).getTime())||new Date(String(e.occurred_at)).getTime()>Number(p.observedAtMs))||cash!==pnl||pnl!==positionPnl||BigInt(String(p.cashMicros))!==BigInt(String(a.initial_text))+cash)throw Error('capital_checkpoint_ledger_not_conserved');
 return {a,history,checkpoint,checkpointMs:Number(p.observedAtMs),checkpointCash:String(p.cashMicros),localDigest:digest({account:a,history:history.historyDigest,events,positions,checkpoint})};
}
async function rejectRegisteredCapitalReceipt(db:Query,owner:string,receiptId:string){
 const registered=await db.query(`SELECT 1 FROM private.kalshi_owner_historical_funding WHERE owner_user_id=$1::uuid AND exchange_transfer_id=$2
 UNION ALL SELECT 1 FROM private.kalshi_owner_pilot_transfers WHERE owner_user_id=$1::uuid AND verified_exchange_transfer_id=$2
 UNION ALL SELECT 1 FROM private.kalshi_owner_topup_legs l JOIN private.kalshi_owner_topups t ON t.id=l.topup_id WHERE t.owner_user_id=$1::uuid AND l.exchange_transfer_id=$2
 UNION ALL SELECT 1 FROM private.strata_capital_credit_repair WHERE owner_user_id=$1::uuid AND receipt_id=$2 AND state='RECORDED'`,[owner,receiptId]);
 if(registered.rows.length)throw Error('capital_receipt_already_registered');
}
export async function capitalCreditProof(owner:string,account:string,sha:string,d:ProofDeps={}){
 const db=d.db??pool,now=d.now??Date.now,start=now(),mono=performance.now(),local=await capitalStage('local_ledger',()=>creditLocal(db,owner,account));
 const material=await capitalStage('restricted_signer',()=>(d.load??loadedMaterial)(db,local.a));if(!material)throw Error('capital_signer_unavailable');
 const [feeds,transfers]=await Promise.all([capitalStage('signed_trade_history',()=>(d.read??readOwnedKalshiFeeds)(material,start)),capitalStage('transfer_history',()=>readCapitalTransfers((path,q)=>(d.get??getScopedKalshiJson)(material,path,q,fetch,'https://external-api.kalshi.com',owner),start))]);
 if(!feeds.ok||feeds.observedAtMs!==start||now()<start||now()-start>15000||performance.now()-mono>15000)throw Error('capital_signed_evidence_unavailable_or_stale');
 const snapshot=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:String(local.a.key_fingerprint)},feeds,local.history.requests);
 if(!('identity'in snapshot)||feeds.historicalCoverageComplete!==true||!v3MigrationFlatHistoryCheck(snapshot,local.history.expectedRequests).ok||snapshot.orders.some(o=>local.history.neverPosted.some(n=>n.clientOrderId===o.request.clientOrderId))||String(snapshot.cashMicros)!==local.a.cash_text)throw Error('capital_signed_history_unverified');
 const receipt=uniqueCapitalTransfer(transfers,local.checkpointMs),amount=BigInt(receipt.amountCents)*10000n;
 if(BigInt(String(local.a.cash_text))!==BigInt(local.checkpointCash)+amount)throw Error('capital_receipt_does_not_explain_cash');
 // Existing registered funding must never be credited a second time.
 await capitalStage('receipt_registry',()=>rejectRegisteredCapitalReceipt(db,owner,receipt.transferId));
 const core={ownerId:owner,accountId:account,sha,policyHash:String(local.a.policy_hash),checkpointId:String(local.checkpoint.id),checkpointDigest:String(local.checkpoint.digest),receiptId:receipt.transferId,receiptDigest:receipt.receiptDigest,receiptCreatedAt:new Date(receipt.createdAtMs).toISOString(),amountCents:receipt.amountCents,oldInitialCashMicros:String(local.a.initial_text),newInitialCashMicros:String(BigInt(String(local.a.initial_text))+amount),cashMicros:String(local.a.cash_text),accountRevision:String(local.a.revision_text)};
 return {...local,snapshot,scope:{...core,scopeDigest:scopeDigest(core)},start,mono,deadline:new Date(start+15000).toISOString()};
}
export async function verifyCreditFinal(db:Db,tx:Query,proof:Awaited<ReturnType<typeof capitalCreditProof>>,owner:string,account:string,now:number){
 const local=await capitalStage('locked_scope',()=>creditLocal(tx,owner,account,true));if(local.localDigest!==proof.localDigest)throw Error('capital_account_or_history_changed');
 await capitalStage('receipt_registry',()=>rejectRegisteredCapitalReceipt(tx,owner,proof.scope.receiptId));
 const credential=await tx.query("SELECT 1 FROM private.kalshi_connection_credentials WHERE owner_user_id=$1::uuid AND financial_account_id=$2 AND key_fingerprint=$3 AND role='restricted_execution' AND revoked_at IS NULL AND verified_at IS NOT NULL AND verification_reason='credential_verified' FOR SHARE",[owner,local.a.kalshi_connection_id,local.a.key_fingerprint]);if(credential.rows.length!==1)throw Error('capital_signer_changed');
 if(now<proof.start||now-proof.start>15000||performance.now()-proof.mono>15000)throw Error('capital_signed_evidence_expired');
 const ledger=new ProductionLedger(db as unknown as Pool,account);await capitalStage('final_ledger',()=>ledger.finalAccountProof(tx as unknown as PoolClient,local.a as unknown as Account,proof.snapshot,now));return {local,ledger};
}

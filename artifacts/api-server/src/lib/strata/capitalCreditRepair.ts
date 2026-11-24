import {resolveOwnerSelfScope} from './ownerSelfServiceEligibility';
import {logCapitalFailure,capitalPublicReason} from './capitalCreditDiagnostic';
import {performance} from 'node:perf_hooks';
import {pool} from '@workspace/db';
import type {PoolClient} from '@workspace/db';
import type {Account} from '../v13-production/ledger';
import {deployedGitSha} from './deployedGitSha';
import {configuredOwnerSelfScope,ownerSelfEnrollmentAllowed} from './ownerSelfReviewMode';
import {CREDIT_CONFIRM,CREDIT_CANCEL} from './capitalCreditTransfers';
import {capitalCreditProof,verifyCreditFinal,validCreditScope,type CreditScope,type ProofDeps,type Db,type Row,type Query} from './capitalCreditProof';
export {CREDIT_CONFIRM,CREDIT_CANCEL};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,SHA=/^[a-f0-9]{40}$/;
export const capitalNoAuthority={transferAttempted:false as const,tradingAuthorized:false as const,workerStarted:false as const,ordersSubmitted:false as const,retryAuthorized:false as const};
const no=(reason:string)=>({ok:false as const,reason,...capitalNoAuthority});
const unknown=()=>({outcome:'UNKNOWN' as const,...capitalNoAuthority});
type Deps=ProofDeps&{sha?:()=>string;scope?:typeof configuredOwnerSelfScope};
const str=(x:unknown)=>typeof x==='string'?x:'';
async function context(owner:string,d:Deps){if(process.env.NODE_ENV!=='test'&&Object.keys(d).length)throw Error('capital_production_override_forbidden');const sha=(d.sha??deployedGitSha)(),c=d.scope?d.scope():await resolveOwnerSelfScope(pool,owner,sha,'recovery');if(!UUID.test(owner)||!c||!SHA.test(sha)||!ownerSelfEnrollmentAllowed(owner,c.accountId,c))throw Error('capital_owner_scope_unavailable');return {account:c.accountId,sha};}
const safeReason=capitalPublicReason;
export async function capitalCreditPreview(owner:string,d:Deps={}){try{const c=await context(owner,d);const pending=await(d.db??pool).query("SELECT repair_id FROM private.strata_capital_credit_repair WHERE execution_account_id=$1 AND owner_user_id=$2::uuid AND state='PENDING' LIMIT 1",[c.account,owner]);if(pending.rows.length)return no('capital_existing_attempt_requires_readback');const proof=await capitalCreditProof(owner,c.account,c.sha,d);return {ok:true as const,...proof.scope,confirmation:CREDIT_CONFIRM,observedAt:new Date(proof.start).toISOString(),expiresAt:proof.deadline,...capitalNoAuthority};}catch(e){const diagnostic=logCapitalFailure(e,'preview');return {...no(safeReason(e)),diagnostic};}}
export async function capitalCreditOutcome(owner:string,id:string,sha:string,db:Query=pool){
 if(!UUID.test(owner)||!UUID.test(id)||!SHA.test(sha))return unknown();
 try{const r=await db.query('SELECT * FROM private.strata_capital_credit_repair WHERE repair_id=$1::uuid AND owner_user_id=$2::uuid AND release_commit_sha=$3',[id,owner,sha]);if(r.rows.length!==1)return unknown();const row=r.rows[0];if(!validCreditScope(row.scope))return unknown();const scope=row.scope;
 if(row.state==='RECORDED')return {outcome:'RECORDED' as const,repairId:id,...scope,confirmation:CREDIT_CONFIRM,...capitalNoAuthority};
 if(row.state==='REJECTED')return {outcome:'REJECTED' as const,repairId:id,...scope,confirmation:CREDIT_CONFIRM,reason:row.reason,noCommit:true,...capitalNoAuthority};return unknown();}catch{return unknown();}
}
async function terminalize(db:Db,owner:string,id:string,scope?:{account:string;sha:string;value:CreditScope}){
 let tx:Awaited<ReturnType<Db['connect']>>|undefined,done=false,commit=false,discard:Error|undefined;
 try{tx=await db.connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1500ms'");await tx.query("SET LOCAL statement_timeout='12000ms'");
 if(scope){const s=scope.value;await tx.query(`INSERT INTO private.strata_capital_credit_repair(repair_id,owner_user_id,execution_account_id,release_commit_sha,receipt_id,scope_digest,scope,confirmation,state,reason,resolved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'REJECTED','capital_owner_canceled_exact_repair',clock_timestamp()) ON CONFLICT DO NOTHING`,[id,owner,scope.account,scope.sha,s.receiptId,s.scopeDigest,s,CREDIT_CONFIRM]);}
 const r=await tx.query(`SELECT repair_id FROM private.strata_capital_credit_repair WHERE repair_id=$1::uuid AND owner_user_id=$2::uuid ${scope?'AND execution_account_id=$3 AND release_commit_sha=$4 AND scope_digest=$5':''} FOR UPDATE`,scope?[id,owner,scope.account,scope.sha,scope.value.scopeDigest]:[id,owner]);if(r.rows.length!==1)return false;
 await tx.query("UPDATE private.strata_capital_credit_repair SET state='REJECTED',reason='capital_pending_repair_canceled_or_refused',resolved_at=clock_timestamp() WHERE repair_id=$1 AND state='PENDING'",[id]);commit=true;await tx.query('COMMIT');done=true;return true;
 }catch{if(commit)discard=Error('capital_finalization_unknown');return false;}finally{if(tx){if(!done&&!discard)try{await tx.query('ROLLBACK')}catch{discard=Error('capital_rollback_unknown')}tx.release(discard);}}
}
export async function applyCapitalCredit(owner:string,raw:unknown,d:Deps={}){
 let ctx;try{ctx=await context(owner,d);}catch(e){return no(safeReason(e));}
 const b=raw as Row;if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='confirmation,repairId,scope'||!UUID.test(str(b.repairId))||b.confirmation!==CREDIT_CONFIRM||!validCreditScope(b.scope))return no('capital_explicit_scope_consent_required');
 const scope=b.scope;if(scope.ownerId!==owner||scope.accountId!==ctx.account||scope.sha!==ctx.sha)return no('capital_scope_changed');const db=d.db??pool;
 try{const r=await db.query(`INSERT INTO private.strata_capital_credit_repair(repair_id,owner_user_id,execution_account_id,release_commit_sha,receipt_id,scope_digest,scope,confirmation) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING repair_id`,[b.repairId,owner,ctx.account,ctx.sha,scope.receiptId,scope.scopeDigest,scope,CREDIT_CONFIRM]);if(r.rows.length!==1)return no('capital_existing_attempt_requires_readback');}catch{return no('capital_claim_unknown');}
 let tx:Awaited<ReturnType<Db['connect']>>|undefined,done=false,commit=false,discard:Error|undefined,reason='capital_credit_refused';
 try{const proof=await capitalCreditProof(owner,ctx.account,ctx.sha,d);if(proof.scope.scopeDigest!==scope.scopeDigest)throw Error('capital_preview_scope_changed');
 tx=await db.connect();await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await tx.query("SET LOCAL lock_timeout='1500ms'");await tx.query("SET LOCAL statement_timeout='12000ms'");
 const pending=await tx.query("SELECT repair_id FROM private.strata_capital_credit_repair WHERE repair_id=$1 AND owner_user_id=$2 AND scope_digest=$3 AND state='PENDING' FOR UPDATE",[b.repairId,owner,scope.scopeDigest]);if(pending.rows.length!==1)throw Error('capital_attempt_not_pending');
 const {local,ledger}=await verifyCreditFinal(db,tx,proof,owner,ctx.account,(d.now??Date.now)());
 const changed=await tx.query(`UPDATE public.v13_production_account SET initial_cash_micros=$3::bigint,revision=revision+1 WHERE id=$1 AND owner_user_id=$2::uuid AND initial_cash_micros=$4::bigint AND revision=$5::bigint AND cash_micros=$6::bigint AND kill_switch=true AND execution_enabled=false AND reserved_micros=0 RETURNING *`,[ctx.account,owner,scope.newInitialCashMicros,scope.oldInitialCashMicros,scope.accountRevision,scope.cashMicros]);if(changed.rows.length!==1)throw Error('capital_account_cas_failed');
 await ledger.assertConservation(tx as unknown as PoolClient,changed.rows[0] as unknown as Account);
 const saved=await tx.query("UPDATE private.strata_capital_credit_repair SET state='RECORDED',reason='capital_verified_provider_receipt_recorded',resolved_at=clock_timestamp(),evidence_deadline=$2::timestamptz WHERE repair_id=$1 AND state='PENDING' RETURNING repair_id",[b.repairId,proof.deadline]);if(saved.rows.length!==1)throw Error('capital_receipt_write_failed');
 const finalNow=(d.now??Date.now)();if(finalNow<proof.start||finalNow-proof.start>15000||performance.now()-proof.mono>15000)throw Error('capital_signed_evidence_expired');
 commit=true;await tx.query('COMMIT');done=true;
 }catch(e){logCapitalFailure(e,commit?'commit':'apply');reason=commit?'capital_commit_unknown':safeReason(e);if(commit)discard=Error(reason);}finally{if(tx){if(!done&&!discard)try{await tx.query('ROLLBACK')}catch{discard=Error('capital_rollback_unknown')}tx.release(discard);}}
 if(done)return {ok:true as const,reason:'capital_credit_recorded',repairId:b.repairId,...capitalNoAuthority};
 if(!commit)await terminalize(db,owner,str(b.repairId));return no(reason);
}
export async function cancelCapitalCredit(owner:string,raw:unknown,db:Db=pool){const b=raw as Row;if(!UUID.test(owner)||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='accountId,confirmation,expectedSha,repairId,scope'||!UUID.test(str(b.repairId))||!SHA.test(str(b.expectedSha))||typeof b.accountId!=='string'||b.confirmation!==CREDIT_CANCEL||!validCreditScope(b.scope)||b.scope.ownerId!==owner||b.scope.accountId!==b.accountId||b.scope.sha!==b.expectedSha)return unknown();
 if(!await terminalize(db,owner,str(b.repairId),{account:b.accountId,sha:str(b.expectedSha),value:b.scope}))return unknown();return capitalCreditOutcome(owner,str(b.repairId),str(b.expectedSha),db);}

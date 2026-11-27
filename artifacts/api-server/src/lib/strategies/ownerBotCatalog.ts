import {randomUUID} from 'node:crypto';
import {WARREN_BOT,WARREN_BOT_HASH} from './warrenBotIdentity';
export {WARREN_BOT,WARREN_BOT_HASH} from './warrenBotIdentity';

import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET} from '@workspace/v13-strategy';
import {WARREN_BUFFETT_SPEC} from './warrenBuffett';
import {deployedGitSha} from '../strata/deployedGitSha';

export const CHAMPION_BOT=V13_CHAMPION_PARAMETER_SET.id;
export const BOT_SELECT_CONFIRM='I_SELECT_THIS_EXACT_BOT_FOR_MY_OWN_STOPPED_ACCOUNT_V1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HEX=/^[a-f0-9]{64}$/;
const SHA=/^[a-f0-9]{40}$/;
const digest=(bot:string)=>bot===WARREN_BOT?WARREN_BOT_HASH:bot===CHAMPION_BOT?V13_CHAMPION_PARAMETER_HASH:null;
type Q={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[],rowCount?:number|null}>};
type Db=Q&{connect():Promise<Q&{release(err?:Error):void}>};
const error=(reason:string)=>({ok:false as const,reason,selectionChanged:false as const,workerStarted:false as const,ordersSubmitted:false as const});
export function qualifiedWarrenRelease(sha=deployedGitSha(),env=process.env):boolean{
 return env.NODE_ENV==='production'&&env.STRATA_WARREN_BUFFETT_LIVE_ENABLED==='true'&&
  SHA.test(sha)&&env.STRATA_WARREN_BUFFETT_LIVE_SHA===sha&&env.RAILWAY_GIT_COMMIT_SHA===sha;
}
export async function readRuntimeBotChoice(db:Q,owner:string,account:string,policyHash:string,sha:string):Promise<typeof CHAMPION_BOT|typeof WARREN_BOT>{
 if(!UUID.test(owner)||!HEX.test(policyHash)||!SHA.test(sha))throw Error('bot_runtime_scope_invalid');
 const r=await db.query(`SELECT bot_id,bot_fingerprint,policy_hash,release_sha FROM private.strata_owner_bot_selection WHERE owner_user_id=$1::uuid AND execution_account_id=$2 LIMIT 2`,[owner,account]);
 if(!r.rows.length)return CHAMPION_BOT; // Historical owners remain on the immutable original champion.
 if(r.rows.length!==1)throw Error('bot_runtime_selection_ambiguous');
 const s=r.rows[0]!,hash=digest(String(s.bot_id));
 if(!hash||s.bot_fingerprint!==hash||s.policy_hash!==policyHash||s.release_sha!==sha)throw Error('bot_runtime_selection_stale');
 if(s.bot_id===WARREN_BOT&&!qualifiedWarrenRelease(sha))throw Error('bot_warren_release_not_qualified');
 return s.bot_id as typeof CHAMPION_BOT|typeof WARREN_BOT;
}
export async function assertOwnedBotAtOrder(db:Q,owner:string,account:string,policyHash:string,sha:string,bot:string):Promise<void>{
 const live=await readRuntimeBotChoice(db,owner,account,policyHash,sha);
 if(live!==bot)throw Error('bot_selection_changed_before_order');
}
export async function readOwnerBotCatalog(owner:string,db:Q){
 if(!UUID.test(owner))return error('authenticated_owner_required');
 let rows:Record<string,unknown>[];
 try{rows=(await db.query(`SELECT a.id,a.kill_switch,a.execution_enabled,a.blocked_reason,a.reserved_micros::text,
 a.reconciled_at,a.policy_id,p.state policy_state,p.policy_hash,p.strategy_parameter_set_id,p.strategy_parameter_hash,
 (SELECT count(*)::int FROM public.v13_production_position x WHERE x.account_id=a.id AND x.quantity_hundredths<>0) open_positions,
 (SELECT count(*)::int FROM public.v13_production_intent i WHERE i.account_id=a.id AND
  (i.terminal IS DISTINCT FROM TRUE OR i.state IN ('PREPARED','DISPATCHED','UNKNOWN') OR i.reserved_micros<>0)) unresolved_intents,
 (SELECT count(*)::int FROM private.strata_emergency_exit_reservations x WHERE x.execution_account_id=a.id AND
  x.state IN ('PREPARED','DISPATCHED','UNKNOWN')) pending_exits,
 w.state worker_state,w.arm_requested,w.account_kill,
 s.bot_id selected_bot,s.bot_fingerprint selected_fingerprint,s.policy_hash selected_policy_hash,
 s.release_sha selection_sha,s.revision selection_revision
 FROM public.v13_production_account a
 LEFT JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 AND p.created_by=a.owner_user_id::text AND p.approved_by=a.owner_user_id::text
 LEFT JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
 LEFT JOIN private.strata_owner_bot_selection s ON s.execution_account_id=a.id AND s.owner_user_id=a.owner_user_id
 WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2 LIMIT 2`,[owner])).rows;}catch{return error('owner_bot_catalog_schema_unavailable');}
 if(rows.length!==1)return error('owned_account_missing_or_ambiguous');
 const a=rows[0]!,sha=deployedGitSha();
 const policyOk=a.policy_state==='APPROVED'&&a.strategy_parameter_set_id===CHAMPION_BOT&&
   a.strategy_parameter_hash===V13_CHAMPION_PARAMETER_HASH&&HEX.test(String(a.policy_hash));
 const selected=typeof a.selected_bot==='string'?a.selected_bot:CHAMPION_BOT;
 const selectionValid=!a.selected_bot||digest(selected)===a.selected_fingerprint;
 // Changing approved financial terms requires a fresh *separate* owner review.
 // Only a release SHA rotation with the exact unchanged policy is eligible
 // for automatic reauthorization from the owner's deliberate ARM click.
 const selectionPolicyChanged=Boolean(a.selected_bot&&selectionValid&&a.selected_policy_hash!==a.policy_hash);
 // Explicit proof for mixed-version frontend/backend rollout: older backends
 // do not expose this flag and therefore cannot authorize automatic renewal.
 const releaseOnlyReauthorization=Boolean(policyOk&&a.selected_bot&&selectionValid&&!selectionPolicyChanged&&a.selection_sha!==sha);
 const requiresReauthorization=Boolean(a.selected_bot&&selectionValid&&
   (a.selected_policy_hash!==a.policy_hash||a.selection_sha!==sha));
 const botId=policyOk&&selectionValid?selected:null;
 // A lease state is not sufficient on its own. An inconsistent account/lease pair
 // must never be presented as safely stopped or eligible to select a live bot.
 const killed=a.kill_switch===true&&a.execution_enabled===false&&
   (a.worker_state===null||
    (a.worker_state==='killed'&&a.arm_requested===false&&a.account_kill===true));
 const released=a.worker_state==='released'&&a.arm_requested===false&&a.account_kill===false&&
   ((a.kill_switch===false&&a.execution_enabled===true)||
    (a.kill_switch===true&&a.execution_enabled===false));
 const stopped=killed||released;
 const protectiveStopping=a.worker_state==='owned'&&a.arm_requested===false&&a.account_kill===false;
 const protectiveExposure=Number(a.open_positions)>0||Number(a.unresolved_intents)>0||
  Number(a.pending_exits)>0||String(a.reserved_micros)!=='0';
 const readTime=Date.parse(String(a.reconciled_at??''));
 const fresh=Number.isFinite(readTime)&&readTime<=Date.now()&&Date.now()-readTime<900_000;
 const flat=Number(a.open_positions)===0&&Number(a.unresolved_intents)===0&&Number(a.pending_exits)===0;
 const eligible=policyOk&&selectionValid&&stopped&&a.blocked_reason===null&&
  String(a.reserved_micros)==='0'&&flat&&fresh;
 const warrenLive=qualifiedWarrenRelease(sha);
 return {ok:true as const,version:'OWNER_BOT_CATALOG_V2' as const,accountId:String(a.id),
  releaseSha:sha,policyHash:policyOk?String(a.policy_hash):null,
  selectionRevision:Number(a.selection_revision??0),currentBotId:botId,
  currentPolicyVerified:policyOk&&selectionValid&&!requiresReauthorization,requiresReauthorization,
  releaseOnlyReauthorization,workerMayBeActive:!stopped,
  openPositions:Number(a.open_positions),unresolvedIntents:Number(a.unresolved_intents),
  pendingProtectiveExits:Number(a.pending_exits),
  protectiveManagementPending:protectiveStopping&&protectiveExposure,
  selectionEnabled:eligible,executionAuthority:'ACCOUNT_OWNER_ONLY' as const,
   reason:eligible?(requiresReauthorization?
    (selectionPolicyChanged?'owner_bot_changed_financial_policy_requires_review':'owner_bot_requires_exact_release_reauthorization'):
    'owner_can_review_strategy_change'):
   !policyOk?'owner_bot_policy_not_approved':!selectionValid?'owner_bot_selection_invalid':
    !stopped?(protectiveStopping
     ?(protectiveExposure?'owner_bot_protective_exposure_pending':'owner_bot_worker_releasing')
     :'owner_bot_worker_not_stopped'):a.blocked_reason!==null?'owner_bot_financial_hold':
   String(a.reserved_micros)!=='0'?'owner_bot_cash_reserved':!flat?'owner_bot_unresolved_exposure':
   !fresh?'owner_bot_cash_reconciliation_stale':'owner_bot_change_not_ready',
  bots:[{id:CHAMPION_BOT,name:'C52/C53',parameterHash:V13_CHAMPION_PARAMETER_HASH,status:'LIVE_QUALIFIED',description:'Brady original: immutable C52/C53.'},
  {id:WARREN_BOT,name:'Warren Buffett',parameterHash:WARREN_BOT_HASH,status:warrenLive?'LIVE_QUALIFIED':'RESEARCH_ONLY',description:'15-second delayed-cross confirmation; original fees, price ceilings and exits.'}]};
}

export async function selectOwnedBot(owner:string,raw:unknown,db:Db){
 const b=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 const sha=deployedGitSha(),bot=String(b.botId??''),hash=digest(bot);
 if(!UUID.test(owner)||!hash||!UUID.test(String(b.requestId??''))||!HEX.test(String(b.expectedPolicyHash??''))||
  !SHA.test(String(b.expectedSha??''))||b.expectedSha!==sha||!Number.isSafeInteger(b.expectedRevision)||
  Number(b.expectedRevision)<0||b.confirmation!==BOT_SELECT_CONFIRM||
  Object.keys(b).sort().join(',')!=='botId,confirmation,expectedPolicyHash,expectedRevision,expectedSha,requestId')
  return error('bot_exact_owner_selection_consent_required');
 if(bot===WARREN_BOT&&!qualifiedWarrenRelease(sha))return error('bot_warren_release_not_qualified');
 let tx:Awaited<ReturnType<Db['connect']>>|null=null,committed=false,commitAttempted=false;
 try{
  tx=await db.connect();await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await tx.query("SET LOCAL lock_timeout='1500ms'");await tx.query("SET LOCAL statement_timeout='12000ms'");
  const a=(await tx.query(`SELECT a.id,a.owner_user_id,a.policy_id,a.blocked_reason,a.kill_switch,a.execution_enabled,
 a.reserved_micros::text,a.reconciled_at,a.owner_control_epoch,a.revision,
 p.state policy_state,p.policy_hash,p.strategy_parameter_set_id,p.strategy_parameter_hash
 FROM public.v13_production_account a JOIN public.v13_live_money_policy p
 ON p.id=a.policy_id AND p.execution_account_id=a.id AND p.created_by=a.owner_user_id::text
 AND p.approved_by=a.owner_user_id::text WHERE a.owner_user_id=$1::uuid
 AND a.subaccount=1 AND a.exchange_index=2 FOR UPDATE OF a,p`,[owner])).rows;
  if(a.length!==1)return error('bot_account_scope_unverified');
  const row=a[0]!;
  if(row.policy_state!=='APPROVED'||row.policy_hash!==b.expectedPolicyHash||
   row.strategy_parameter_set_id!==CHAMPION_BOT||row.strategy_parameter_hash!==V13_CHAMPION_PARAMETER_HASH||
   row.blocked_reason!==null||String(row.reserved_micros)!=='0')return error('bot_policy_or_financial_hold');
  const prior=(await tx.query('SELECT * FROM private.strata_owner_bot_selection WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[row.id,owner])).rows;
  if(prior.length>1)return error('bot_selection_ambiguous');
  const s=prior[0],old=s?String(s.bot_id):CHAMPION_BOT,revision=s?Number(s.revision):0;
  const requiresReauth=Boolean(s&&(s.policy_hash!==row.policy_hash||s.release_sha!==sha));
  // One exact lost-ack replay may read its original saved revision. It never writes.
  if(s&&!requiresReauth&&s.request_id===b.requestId&&s.bot_id===bot&&s.bot_fingerprint===hash)return {ok:true as const,reason:'selection_previously_recorded',botId:bot,selectionRevision:revision,workerStarted:false,ordersSubmitted:false};
  if(revision!==b.expectedRevision)return error('bot_review_changed');
  if(old===bot&&!requiresReauth)return {ok:true as const,reason:'already_selected',botId:bot,selectionRevision:revision,workerStarted:false,ordersSubmitted:false};
  const lease=(await tx.query('SELECT state,arm_requested,account_kill FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[row.id,owner])).rows;
  // Ordinary STOP leaves execution eligibility enabled without an owned lease.
  // Accept only a coherent safely stopped lease/account pair; never clear
  // unknown exposure or treat a stale owned heartbeat as STOP authority.
  const safeStopped=lease.length===0
   ? row.kill_switch===true&&row.execution_enabled===false
   : lease.length===1&&lease[0]!.arm_requested===false&&(
      (lease[0]!.state==='released'&&lease[0]!.account_kill===false&&
       ((row.kill_switch===false&&row.execution_enabled===true)||
        (row.kill_switch===true&&row.execution_enabled===false)))||
      (lease[0]!.state==='killed'&&lease[0]!.account_kill===true&&
       row.kill_switch===true&&row.execution_enabled===false));
  if(!safeStopped)return error('bot_worker_must_be_stopped');
  const fresh=Date.parse(String(row.reconciled_at??'')),now=Date.now();
  if(!Number.isFinite(fresh)||now-fresh<0||now-fresh>900_000)return error('bot_fresh_cash_reconciliation_required');
  const risk=(await tx.query(`SELECT
   (SELECT count(*)::int FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths<>0) positions,
   (SELECT count(*)::int FROM public.v13_production_intent WHERE account_id=$1 AND
    (terminal IS DISTINCT FROM TRUE OR state IN ('PREPARED','DISPATCHED','UNKNOWN') OR reserved_micros<>0)) intents,
   (SELECT count(*)::int FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND
    state IN ('PREPARED','DISPATCHED','UNKNOWN')) exits`,[row.id])).rows[0]!;
  if(Number(risk.positions)!==0||Number(risk.intents)!==0||Number(risk.exits)!==0)return error('bot_position_or_uncertain_order_present');
  // Explicit selection closes old START authority. ARM later re-verifies signed cash and risk.
  const newRevision=revision+1,requestId=String(b.requestId);
  await tx.query(`INSERT INTO private.strata_owner_bot_selection
   (execution_account_id,owner_user_id,bot_id,bot_fingerprint,policy_hash,release_sha,revision,request_id)
   VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$8::uuid)
   ON CONFLICT (execution_account_id) DO UPDATE SET
    bot_id=excluded.bot_id,bot_fingerprint=excluded.bot_fingerprint,policy_hash=excluded.policy_hash,
    release_sha=excluded.release_sha,revision=excluded.revision,request_id=excluded.request_id,
    approved_at=clock_timestamp()`,[row.id,owner,bot,hash,row.policy_hash,sha,newRevision,requestId]);
  await tx.query(`INSERT INTO private.strata_owner_bot_selection_history
   (id,execution_account_id,owner_user_id,revision,from_bot_id,to_bot_id,bot_fingerprint,policy_hash,release_sha)
   VALUES($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9)`,
   [randomUUID(),row.id,owner,newRevision,old,bot,hash,row.policy_hash,sha]);
  await tx.query('UPDATE public.v13_production_account SET owner_control_epoch=owner_control_epoch+1,execution_enabled=false,kill_switch=true,revision=revision+1 WHERE id=$1 AND owner_user_id=$2::uuid',[row.id,owner]);
  if(lease.length===1)await tx.query(`UPDATE private.kalshi_account_worker_lease
   SET state='killed',account_kill=true,arm_requested=false,fencing_token=fencing_token+1,
   released_at=clock_timestamp(),heartbeat_at=clock_timestamp()
   WHERE execution_account_id=$1 AND owner_user_id=$2::uuid`,[row.id,owner]);
  commitAttempted=true;await tx.query('COMMIT');committed=true;
  return {ok:true as const,reason:'bot_selected_requires_new_arm',botId:bot,selectionRevision:newRevision,workerStarted:false,ordersSubmitted:false};
 }catch{return error(commitAttempted?'bot_selection_commit_uncertain_read_outcome':'bot_selection_not_recorded');}
 finally{if(tx){if(!committed&&!commitAttempted)try{await tx.query('ROLLBACK');}catch{/* never retry uncertain transaction */}tx.release(commitAttempted&&!committed?Error('uncertain_bot_selection_commit'):undefined);}}
}


/** Shared for DISARM maintenance and owner-requested change preparation.
 * Signed Kalshi balance evidence is fetched only via the existing no-transfer
 * reconciliation port; no strategy, account control, exposure or policy is mutated.
 * This routine cannot release a hold or make an unsafe state look stopped. */
export async function prepareOwnerBotChange(
 owner:string,raw:unknown,db:Q,
 reconcile:(owner:string,body:{confirmation:string})=>Promise<{ok:boolean;reason:string}>,
){
 const fail=(reason:string)=>({ok:false as const,reason,workerStarted:false as const,ordersSubmitted:false as const,transferAttempted:false as const});
 if(!UUID.test(owner)||!raw||typeof raw!=='object'||Array.isArray(raw)||
  Object.keys(raw as Record<string,unknown>).join(',')!=='confirmation'||
  (raw as Record<string,unknown>).confirmation!=='PREPARE_STOPPED_OWNER_BOT_CHANGE_V1')
  return fail('owner_change_confirmation_required');
 try{
  const before=await readOwnerBotCatalog(owner,db);
  if(!before.ok)return fail(before.reason);
  if(before.workerMayBeActive)return fail(before.reason);
  if(!before.policyHash)return fail('bot_policy_not_approved');
  if(!before.selectionEnabled&&before.reason!=='owner_bot_cash_reconciliation_stale')return fail(before.reason);
  const observed=await reconcile(owner,{confirmation:'RECORD_OWNED_SUBACCOUNT_CASH'});
  if(!observed.ok)return fail(observed.reason);
  const after=await readOwnerBotCatalog(owner,db);
  if(!after.ok||after.accountId!==before.accountId||after.policyHash!==before.policyHash||
     after.selectionRevision!==before.selectionRevision||after.currentBotId!==before.currentBotId||
     after.workerMayBeActive||!after.selectionEnabled)
   return fail(after.ok?after.reason:'bot_change_readback_unverified');
  return {ok:true as const,reason:'bot_change_cash_reconciled',catalog:after,
   workerStarted:false as const,ordersSubmitted:false as const,transferAttempted:false as const};
 }catch{return fail('bot_change_preparation_unavailable');}
}

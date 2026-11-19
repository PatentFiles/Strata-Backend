import type { RequestHandler } from 'express';
import {pool} from '@workspace/db';
import {deployedGitSha} from '../lib/strata/deployedGitSha';
import {OWNER_SETTLED_CASH_RECOVERY_CONFIRM,recoverOwnerSettledCashFreeze} from '../lib/strata/ownerSettledCashFreezeRecovery';
import {personalTradingSession} from '../lib/strata/sharedPersonalTradingControls';
import {sanitizePublic} from '../lib/v13-production/sanitize';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
type Input=Parameters<typeof recoverOwnerSettledCashFreeze>[1];
type Result=Awaited<ReturnType<typeof recoverOwnerSettledCashFreeze>>;
type RouteDeps={
 approved:()=>boolean;
 migrationReady:()=>Promise<boolean>;
 recover:(owner:string,input:Input)=>Promise<Result>;
};
const no=(reason:string)=>({ok:false,reason,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false,riskFreezeCleared:false});

export const OWNER_SETTLED_CASH_RECOVERY_MIGRATION_READY_SQL=`
WITH expected(table_name,trigger_name,function_name,trigger_type,updated_column) AS (VALUES
 ('public.v13_production_observation','owner_settled_cash_recovery_commit_fence','enforce_owner_settled_cash_recovery_commit_fence',5,NULL::text),
 ('public.v13_production_account','owner_settled_cash_recovery_transition_fence','enforce_owner_settled_cash_recovery_transition_fence',17,'blocked_reason'))
SELECT count(*)=2 AS ready
FROM expected e
JOIN pg_catalog.pg_trigger t ON t.tgrelid=pg_catalog.to_regclass(e.table_name) AND t.tgname=e.trigger_name
JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid AND p.proname=e.function_name
JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
JOIN pg_catalog.pg_constraint c ON c.oid=t.tgconstraint AND c.conrelid=t.tgrelid
WHERE t.tgtype=e.trigger_type AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled='A'
AND t.tgqual IS NOT NULL
AND ((e.updated_column IS NULL AND t.tgattr::text='') OR
 t.tgattr::text=(SELECT a.attnum::text FROM pg_catalog.pg_attribute a WHERE a.attrelid=t.tgrelid
  AND a.attname=e.updated_column AND NOT a.attisdropped))
AND c.contype='t' AND c.condeferrable AND c.condeferred
AND n.nspname='private' AND p.pronargs=0 AND p.prorettype='pg_catalog.trigger'::regtype AND NOT p.prosecdef
AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
AND NOT EXISTS (
 SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
 WHERE a.privilege_type='EXECUTE' AND a.grantee<>p.proowner
)`;

export function ownerSettledCashRecoveryReleaseApproved(env:NodeJS.ProcessEnv=process.env){
 const expected=env.STRATA_OWNER_SETTLED_CASH_RECOVERY_SHA??'';
 return env.NODE_ENV==='production'&&env.STRATA_OWNER_SETTLED_CASH_RECOVERY_ENABLED==='true'&&
  env.STRATA_OWNER_SETTLED_CASH_RECOVERY_DEPLOYMENT_REVIEWED==='true'&&SHA.test(expected)&&deployedGitSha(env)===expected;
}

const defaults:RouteDeps={
 approved:ownerSettledCashRecoveryReleaseApproved,
 migrationReady:async()=>{
  const result=await pool.query(OWNER_SETTLED_CASH_RECOVERY_MIGRATION_READY_SQL);
  return result.rows.length===1&&result.rows[0]?.ready===true;
 },
 recover:(owner,input)=>recoverOwnerSettledCashFreeze(owner,input,{
  isScheduled:(ownerId,accountId)=>personalTradingSession.isScheduled(ownerId,accountId),
 }),
};

/** Mounted only behind production's authenticated AAL2 requireUser middleware.
 * Dependencies are code-owned; this route parses and copies a closed field set. */
export function createOwnerSettledCashRecoveryHandler(deps:RouteDeps=defaults):RequestHandler{
 return async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  const owner=res.locals.strata?.subject;
  if(typeof owner!=='string'||!UUID.test(owner)){
   res.status(401).json(no('authenticated_execution_owner_required'));return;
  }
  if(!deps.approved()){
   res.status(409).json(no('owner_settled_cash_recovery_release_disabled'));return;
  }
  const body:unknown=req.body;
  if(!body||typeof body!=='object'||Array.isArray(body)){
   res.status(400).json(no('explicit_owner_settled_cash_recovery_scope_required'));return;
  }
  const b=body as Record<string,unknown>;
  if(Object.keys(req.query).length!==0||
   Object.keys(b).sort().join('|')!=='accountId|confirmation|exchangeIndex|expectedRevision|settlementEventId|subaccount'||
   b.subaccount!==1||b.exchangeIndex!==2||b.confirmation!==OWNER_SETTLED_CASH_RECOVERY_CONFIRM||
   typeof b.accountId!=='string'||!/^[A-Za-z0-9:_-]{1,128}$/.test(b.accountId)||
   typeof b.expectedRevision!=='string'||!/^(0|[1-9]\d{0,18})$/.test(b.expectedRevision)||
   typeof b.settlementEventId!=='string'||!/^settlement:[A-Za-z0-9:._-]{1,200}$/.test(b.settlementEventId)){
   res.status(400).json(no('explicit_owner_settled_cash_recovery_scope_required'));return;
  }
  let ready=false;
  try{ready=await deps.migrationReady();}catch{/* fail closed */}
  if(!ready){
   res.status(409).json(no('owner_settled_cash_recovery_migration_not_ready'));return;
  }
  try{
   const out=await deps.recover(owner,{confirmation:b.confirmation,accountId:b.accountId,
    expectedRevision:b.expectedRevision,settlementEventId:b.settlementEventId});
   res.status(out.ok?200:409).json(sanitizePublic(out));
  }catch{
   // A handler/dependency failure is not proof that no commit occurred.
   res.status(503).json({...no('owner_settled_cash_recovery_outcome_unverified'),riskFreezeCleared:null,outcomeUnknown:true});
  }
 };
}

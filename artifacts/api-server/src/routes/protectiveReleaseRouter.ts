import {deployedGitSha} from '../lib/strata/deployedGitSha';
import {createOwnerRecoveryRuntimeRouter,type OwnerRecoveryRuntimeDependencies} from '../lib/strata/ownerRecoveryRuntimeCandidate';
import {ownerOnlyRecoveryAdmission} from '../lib/strata/ownerOnlyRecoveryAdmission';
import {recoverOwnerTransientFreeze} from '../lib/strata/ownerTransientFreezeRecovery';
import {recordStandingExecutionReview,revokeStandingExecutionReview,standingExecutionStatus} from '../lib/strata/standingExecutionReview';
import { Router, type IRouter, type RequestHandler } from "express";
import {
  authorizeProtectiveRelease,attestProtectiveReleaseReview,readReleaseOwner,
  pendingReleaseOwners,protectiveReleaseStatus,qualifyProtectiveRelease,
} from "../lib/strata/inAppProtectiveRelease";
import {authorizeOwnerShaRelease,revokeOwnerShaRelease,ownerRestoreStatus} from "../lib/strata/ownerShaRelease";
import {recoverOwnerStaleLease} from "../lib/strata/ownerStaleLeaseRecovery";
import {enrollContinuousGrant,revokeContinuousGrant,checkContinuousBootstrap,checkContinuousEligibility,hasContinuousGrantHistory} from "../lib/strata/continuousExecutionAuthorization";
import {personalTradingSession} from "../lib/strata/sharedPersonalTradingControls";
import {sanitizePublic} from "../lib/v13-production/sanitize";
import {pool,type PoolClient} from "@workspace/db";

type Identity={subject:string;role:string|null};
const identify=(locals:Record<string,unknown>):Identity|null=>{
 const i=locals.strata as Identity|undefined;
 return i&&typeof i.subject==="string"?i:null;
};
const isOperator=(role:string|null)=>role==="DEVELOPER"||role==="ADMIN";
/** All paths pass through the existing Supabase AAL2 identity and live role
 * middleware. No client-supplied actor id, key, digest or trade POST accepted.
 */
export function createProtectiveReleaseRouter(requireUser:RequestHandler,ownerRecovery?:OwnerRecoveryRuntimeDependencies):IRouter{
 const router=Router();
 router.use(requireUser);
 router.get('/owner-only/scope',async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  const actor=identify(res.locals);if(!actor)return void res.status(401).json({status:'authenticated_owner_required'});
  if(Object.keys(req.query??{}).length)return void res.status(400).json({status:'owner_scope_takes_no_parameters'});
  let tx:PoolClient|undefined,discard:Error|undefined;
  try{
   tx=await pool.connect();await tx.query('BEGIN READ ONLY');await tx.query("SET LOCAL statement_timeout='1500ms'");await tx.query("SET LOCAL lock_timeout='500ms'");
   const result=await readReleaseOwner(tx,actor.subject);await tx.query('ROLLBACK');
   const releaseSha=deployedGitSha();
   if(!result.ok||!/^[a-f0-9]{40}$/.test(releaseSha))return void res.status(409).json({status:result.ok?'deployed_commit_unverified':result.reason,recoveryAuthorized:false,tradingAuthorized:false});
   res.json({status:'owner_scope_verified',accountId:result.account.id,ownerId:actor.subject,releaseSha,recoveryAuthorized:false,tradingAuthorized:false});
  }catch{discard=Error('owner_scope_unavailable');if(tx)try{await tx.query('ROLLBACK');}catch{}res.status(503).json({status:'owner_scope_unavailable',recoveryAuthorized:false,tradingAuthorized:false});}
  finally{tx?.release(discard);}
 });
 router.use('/owner-only',createOwnerRecoveryRuntimeRouter(ownerRecovery));
 router.get("/status",async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:"unauthorized"});
  const target=isOperator(actor.role)&&typeof req.query.ownerUserId==="string"
   ?req.query.ownerUserId:actor.subject;
  const state=await protectiveReleaseStatus(actor.subject,target);
  // Only authenticated users can inspect the owner-selected release scope.
  const statusSha=state.ok&&"sha" in state&&typeof state.sha==="string"?state.sha:null;
  const standingGrantActive=statusSha!==null
    ?await checkContinuousBootstrap({query:(q,params)=>pool.query(q,params)},target,statusSha):false;
  const standingTechnicalLeaseCurrent=standingGrantActive&&statusSha!==null
    ?await checkContinuousEligibility({query:(q,params)=>pool.query(q,params)},target,statusSha):false;
  let standingHistory=false;
  if(statusSha)try{standingHistory=await hasContinuousGrantHistory(pool,target,statusSha);}catch{standingHistory=true;}
  const ownerRestore=target===actor.subject&&statusSha
    ?await ownerRestoreStatus(target,statusSha):{available:false,reason:"owner_restore_owner_only"};
  let pendingOwners:string[]=[];
  if(isOperator(actor.role))try{pendingOwners=await pendingReleaseOwners()}catch{}
  res.status(state.ok?200:409).json(sanitizePublic({...state,
    standingGrantActive,standingTechnicalLeaseCurrent,ownerRestore,
    ...(standingHistory?{releaseMode:'STANDING_V1',releaseActive:standingGrantActive,releaseExpiresAt:null}:{}),
    pendingOwners,viewerIsOperator:isOperator(actor.role),
    viewerIsOwner:target===actor.subject}));
 });
 router.post('/owner-only-recover',(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:'unauthorized'});
  const result=ownerOnlyRecoveryAdmission(actor.subject,req.body);
  res.setHeader('Cache-Control','private, no-store');
  res.status(result.reason==='exact_owner_recovery_request_required'?400:409).json(result);
 });
 router.post("/qualify",async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:"unauthorized"});
  const requested=(req.body as {ownerUserId?:unknown}|undefined)?.ownerUserId;
  const target=isOperator(actor.role)&&typeof requested==="string"?requested:actor.subject;
  const result=await qualifyProtectiveRelease(target);
  res.status(result.ok?200:409).json(sanitizePublic(result));
 });
 router.post("/review",async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:"unauthorized"});
  if(!isOperator(actor.role))return void res.status(403).json({reason:"independent_operator_role_required"});
  const result=await attestProtectiveReleaseReview(actor.subject,actor.role??"",req.body);
  res.status(result.ok?200:409).json(sanitizePublic(result));
 });
 router.post("/authorize",async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:"unauthorized"});
  const result=await authorizeProtectiveRelease(actor.subject,req.body);
  res.status(result.ok?200:409).json(sanitizePublic(result));
 });
 // Issue #155: explicit signed read-only Kalshi flat proof, short CAS lease
 // fence and post-fence qualification. Never ARM, START or clear a freeze.
 router.post("/owner-stale-lease-recover",async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:"unauthorized"});
  const result=await recoverOwnerStaleLease(actor.subject,req.body?.confirmation,{isScheduled:(ownerId,accountId)=>personalTradingSession.isScheduled(ownerId,accountId)});
  res.setHeader("Cache-Control","private, no-store");
  res.status(result.ok?200:409).json(sanitizePublic(result));
 });
 router.post('/owner-transient-freeze-recover',async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:'unauthorized'});
  const result=await recoverOwnerTransientFreeze(actor.subject,req.body?.confirmation,
   {isScheduled:(owner,account)=>personalTradingSession.isScheduled(owner,account)});
  res.setHeader('Cache-Control','private, no-store');
  res.status(result.ok?200:409).json(sanitizePublic(result));
 });
 // Explicit owner opt-in for continuous technical renewal. No orders or
 // releases are created from this endpoint; it requires an existing reviewed
 // exact-SHA release and durable owner approval.
 router.get('/continuous-status',async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:'unauthorized'});
  const owner=isOperator(actor.role)&&typeof req.query.ownerUserId==='string'?req.query.ownerUserId:actor.subject;
  const result=await standingExecutionStatus(owner);
  const eligible=result.ok?await checkContinuousEligibility(pool,owner,result.sha):false;
  res.setHeader('Cache-Control','private, no-store');
  res.status(result.ok?200:409).json(sanitizePublic({...result,technicalLeaseCurrent:eligible,
    viewerIsOwner:owner===actor.subject,viewerIsOperator:isOperator(actor.role)}));
 });
 router.post('/standing-review',async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor||!isOperator(actor.role))return void res.status(403).json({reason:'independent_operator_role_required'});
  const result=await recordStandingExecutionReview(actor.subject,actor.role!,req.body);
  res.setHeader('Cache-Control','private, no-store');
  res.status(result.ok?200:409).json(sanitizePublic(result));
 });
 router.post('/standing-review-revoke',async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor||!isOperator(actor.role))return void res.status(403).json({reason:'independent_operator_role_required'});
  const result=await revokeStandingExecutionReview(actor.subject,actor.role!,req.body);
  res.setHeader('Cache-Control','private, no-store');
  res.status(result.ok?200:409).json(sanitizePublic(result));
 });
 router.post("/continuous-owner-authorize",async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:"unauthorized"});
  const outcome=await enrollContinuousGrant(actor.subject,req.body);
  res.setHeader("Cache-Control","private, no-store");
  res.status(outcome.ok?200:409).json(sanitizePublic(outcome));
 });
 router.post("/continuous-owner-revoke",async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:"unauthorized"});
  const outcome=await revokeContinuousGrant(actor.subject,req.body);
  res.setHeader("Cache-Control","private, no-store");
  res.status(outcome.ok?200:409).json(sanitizePublic(outcome));
 });
 // Owner-only AAL2 routes: owner identity comes from the signed JWT, never
 // from a submitted account selector, and cannot clear shared safety gates.
 router.post("/owner-authorize",async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:"unauthorized"});
  const result=await authorizeOwnerShaRelease(actor.subject,req.body);
  res.status(result.ok?200:409).json(sanitizePublic(result));
 });
 router.post("/owner-revoke",async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:"unauthorized"});
  const result=await revokeOwnerShaRelease(actor.subject,req.body);
  res.status(result.ok?200:409).json(sanitizePublic(result));
 });
 return router;
}

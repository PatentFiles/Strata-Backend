import {ownerSelfReviewOutcome} from '../lib/strata/ownerSelfReviewOutcome';
import {recordOwnerSelfStandingReview,revokeOwnerSelfStandingReview} from '../lib/strata/ownerSelfStandingReview';
import {activateOwnerSelfAccount,ownerSelfActivationOutcome} from '../lib/strata/ownerSelfAccountActivation';
import {heldHistoryConsentOutcome} from '../lib/strata/ownerNeverPostedReleaseRenewal';
import {recoverOwnerTransientFreeze} from '../lib/strata/ownerTransientFreezeRecovery';
import {createOwnerSettledCashRecoveryHandler,createOwnerSettledCashRecoveryReadHandler} from './ownerSettledCashRecoveryHandler';
import {recordStandingExecutionReview,revokeStandingExecutionReview,standingExecutionStatus} from '../lib/strata/standingExecutionReview';
import { Router, type IRouter, type RequestHandler } from "express";
import {
  authorizeProtectiveRelease,attestProtectiveReleaseReview,
  pendingReleaseOwners,protectiveReleaseStatus,qualifyProtectiveRelease,lookupProtectiveReleaseAuthorization,
} from "../lib/strata/inAppProtectiveRelease";
import {authorizeOwnerShaRelease,revokeOwnerShaRelease,ownerRestoreStatus} from "../lib/strata/ownerShaRelease";
import {recoverOwnerStaleLease} from "../lib/strata/ownerStaleLeaseRecovery";
import {enrollContinuousGrant,revokeContinuousGrant,checkContinuousBootstrap,checkContinuousEligibility,hasContinuousGrantHistory} from "../lib/strata/continuousExecutionAuthorization";
import {personalTradingSession} from "../lib/strata/sharedPersonalTradingControls";
import {sanitizePublic} from "../lib/v13-production/sanitize";
import {pool} from "@workspace/db";

type Identity={subject:string;role:string|null};
const identify=(locals:Record<string,unknown>):Identity|null=>{
 const i=locals.strata as Identity|undefined;
 return i&&typeof i.subject==="string"?i:null;
};
const isOperator=(role:string|null)=>role==="DEVELOPER"||role==="ADMIN";
/** All paths pass through the existing Supabase AAL2 identity and live role
 * middleware. No client-supplied actor id, key, digest or trade POST accepted.
 */
export function createProtectiveReleaseRouter(requireUser:RequestHandler):IRouter{
 const router=Router();
 router.use(requireUser);
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
 // Separate exact-settlement recovery. Default disabled; never invokes transient fallback.
 router.post('/owner-settled-cash-freeze-recover',createOwnerSettledCashRecoveryHandler());
 router.get('/owner-settled-cash-freeze-preview',createOwnerSettledCashRecoveryReadHandler('preview'));
 router.get('/owner-settled-cash-freeze-outcome',createOwnerSettledCashRecoveryReadHandler('outcome'));
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
 // New owner-only authority is separate from immutable historical independent reviews.
 // Require signed AAL2 owner session and server-configured exact owner/account scope.
 router.get('/owner-standing-review-outcome',async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:'unauthorized'});
  const result=await ownerSelfReviewOutcome(actor.subject,req.query);
  res.setHeader('Cache-Control','private, no-store');
  res.status(200).json(sanitizePublic(result));
 });
 router.post('/owner-standing-review',async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:'unauthorized'});
  const result=await recordOwnerSelfStandingReview(actor.subject,req.body);
  res.setHeader('Cache-Control','private, no-store');
  res.status(result.ok?200:409).json(sanitizePublic(result));
 });
 // Explicit AAL2 owner-only activation. Uses signed Kalshi history,
 // issuer monetary evidence, exact-SHA technical review, ledger conservation,
 // worker CAS and deferred five-second freshness. No ARM or START.
 router.get('/owner-self-activation-outcome',async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:'unauthorized'});
  const sha=typeof req.query.sha==='string'?req.query.sha:'';
  const result=await ownerSelfActivationOutcome(actor.subject,sha);
  res.setHeader('Cache-Control','private, no-store');
  res.status(200).json(sanitizePublic(result));
 });
 router.post('/owner-self-activate',async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:'unauthorized'});
  const result=await activateOwnerSelfAccount(actor.subject,req.body);
  res.setHeader('Cache-Control','private, no-store');
  res.status(result.ok?200:409).json(sanitizePublic(result));
 });
 router.post('/owner-standing-review-revoke',async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:'unauthorized'});
  const result=await revokeOwnerSelfStandingReview(actor.subject,req.body);
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
 router.get("/authorization-outcome",async(req,res)=>{
  const actor=identify(res.locals);if(!actor)return void res.status(401).json({reason:'unauthorized'});
  const reviewId=typeof req.query.reviewId==='string'?req.query.reviewId:'';
  const result=await lookupProtectiveReleaseAuthorization(actor.subject,reviewId);
  res.setHeader('Cache-Control','private, no-store');res.status(200).json(sanitizePublic(result));
 });
 router.get("/owner-consent-outcome",async(req,res)=>{
  const actor=identify(res.locals);
  if(!actor)return void res.status(401).json({reason:'unauthorized'});
  const qualification=typeof req.query.qualificationId==='string'?req.query.qualificationId:'';
  const sha=typeof req.query.sha==='string'?req.query.sha:'';
  const account=typeof req.query.accountId==='string'?req.query.accountId:undefined;
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(qualification)||!/^[a-f0-9]{40}$/.test(sha)||(account!==undefined&&(!account||account.length>200)))
   return void res.status(400).json({reason:'held_consent_readback_scope_invalid'});
  const result=await heldHistoryConsentOutcome(actor.subject,qualification,sha,pool,account);
  res.setHeader('Cache-Control','private, no-store');
  res.status(result.ok?200:409).json(sanitizePublic(result));
 });
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

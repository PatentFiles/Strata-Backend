import { Router, type IRouter, type RequestHandler } from "express";
import {
  authorizeProtectiveRelease,attestProtectiveReleaseReview,
  pendingReleaseOwners,protectiveReleaseStatus,qualifyProtectiveRelease,
} from "../lib/strata/inAppProtectiveRelease";
import {authorizeOwnerShaRelease,revokeOwnerShaRelease} from "../lib/strata/ownerShaRelease";
import {recoverOwnerStaleLease} from "../lib/strata/ownerStaleLeaseRecovery";
import {enrollContinuousGrant,revokeContinuousGrant,checkContinuousBootstrap,checkContinuousEligibility} from "../lib/strata/continuousExecutionAuthorization";
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
  const standingGrantActive=state.ok&&typeof state.sha==="string"
    ?await checkContinuousBootstrap({query:(q,params)=>pool.query(q,params)},target,state.sha):false;
  const standingTechnicalLeaseCurrent=standingGrantActive&&state.ok&&typeof state.sha==="string"
    ?await checkContinuousEligibility({query:(q,params)=>pool.query(q,params)},target,state.sha):false;
  let pendingOwners:string[]=[];
  if(isOperator(actor.role))try{pendingOwners=await pendingReleaseOwners()}catch{}
  res.status(state.ok?200:409).json(sanitizePublic({...state,
    standingGrantActive,standingTechnicalLeaseCurrent,
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
 // Explicit owner opt-in for continuous technical renewal. No orders or
 // releases are created from this endpoint; it requires an existing reviewed
 // exact-SHA release and durable owner approval.
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

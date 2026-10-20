import { Router, type IRouter, type RequestHandler } from "express";
import {
  authorizeProtectiveRelease,attestProtectiveReleaseReview,
  pendingReleaseOwners,protectiveReleaseStatus,qualifyProtectiveRelease,
} from "../lib/strata/inAppProtectiveRelease";
import {sanitizePublic} from "../lib/v13-production/sanitize";

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
  let pendingOwners:string[]=[];
  if(isOperator(actor.role))try{pendingOwners=await pendingReleaseOwners()}catch{}
  res.status(state.ok?200:409).json(sanitizePublic({...state,
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
 return router;
}

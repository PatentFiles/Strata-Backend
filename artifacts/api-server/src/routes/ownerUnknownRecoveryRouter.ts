import {Router,type IRouter,type RequestHandler} from 'express';
import {sanitizePublic} from '../lib/v13-production/sanitize';
import {OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION} from '../lib/strata/ownerUnknownRecoveryPlan';
import {OWNER_UNKNOWN_PROTECTION_ACKNOWLEDGMENT,type OwnerUnknownRecoveryPort} from '../lib/strata/ownerUnknownRecoveryService';

/** Mounted only behind the existing Supabase AAL2 verifier. No body identity,
 * account selector, evidence, credentials, cash override or order is accepted. */
export function createOwnerUnknownRecoveryRouter(requireUser:RequestHandler,port?:OwnerUnknownRecoveryPort):IRouter {
 const router=Router();
 router.use(requireUser);
 router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
 router.get('/',(_req,res)=>res.json({
  purpose:'UNKNOWN entry accounting only',
  warning:'KILL halts protective automation. It does not cancel orders or liquidate positions. Incomplete history or open exposure keeps all holds in place.',
  confirmation:OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION,
  protectiveAutomationAcknowledgment:OWNER_UNKNOWN_PROTECTION_ACKNOWLEDGMENT,
  executionMustRemainKilled:true,restartAuthorized:false,
  uncertainOutcomeInstruction:'Read the exact receipt and current state before considering a retry. A missing receipt does not prove rollback.',
 }));
 const owner=(res:{locals:Record<string,unknown>})=>{
  const s=res.locals.strata as {subject?:unknown}|undefined;
  return typeof s?.subject==='string'?s.subject:null;
 };
 for(const action of ['fence','reconcile'] as const)router.post('/'+action,async(req,res)=>{
  const identity=owner(res);if(!identity)return void res.status(401).json({error:'Unauthorized'});
  if(!port)return void res.status(503).json({ok:false,reason:'recovery_service_unavailable'});
  try{
   const out=await port[action](identity,req.body);
   res.status(out.ok?200:409).json(sanitizePublic(out));
  }catch{res.status(503).json({ok:false,reason:'recovery_request_outcome_unverified',outcomeUnknown:true,
   retryAuthorized:false,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false});}
 });
 router.get('/receipts/:receiptId',async(req,res)=>{
  const identity=owner(res);if(!identity)return void res.status(401).json({error:'Unauthorized'});
  if(!port)return void res.status(503).json({ok:false,reason:'recovery_service_unavailable'});
  try{
   const out=await port.receipt(identity,String(req.params.receiptId));
   res.status(out.ok?200:409).json(sanitizePublic(out));
  }catch{res.status(503).json({ok:false,reason:'recovery_receipt_read_unavailable',outcomeUnknown:true,retryAuthorized:false});}
 });
 return router;
}

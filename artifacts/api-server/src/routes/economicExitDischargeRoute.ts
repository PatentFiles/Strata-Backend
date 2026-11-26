import {Router,type RequestHandler} from 'express';
import type {createEconomicDischargeService,EconomicDischargeTiming} from '../lib/strata/economicExitDischargeService';
type Service=ReturnType<typeof createEconomicDischargeService>;
const SAFE_REASON=/^economic_discharge_[a-z_]{1,80}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Mount ONLY inside the existing authenticated/AAL2 owner router. Neither a
 * query nor a request body can choose a different account or owner. */
export function economicDischargeRouter(service:Service){
 const router=Router();
 const owner:RequestHandler=(_req,res,next)=>{res.set('Cache-Control','private, no-store');
  if(!UUID.test(String(res.locals.strata?.subject??'')))return void res.status(401).json({reason:'unauthorized'});next();};
 router.use(owner);
 const timings=(req:Parameters<RequestHandler>[0],operation:'preview'|'apply')=>{
  const stages:Partial<Record<Parameters<EconomicDischargeTiming>[0],number>>={};
  const observe:EconomicDischargeTiming=(stage,ms)=>{stages[stage]=ms;};
  return {observe,finish:()=>{try{
   if(Object.keys(stages).length)req.log?.info({event:'economic_discharge_timing',operation,stages});
  }catch{/* Diagnostics are not part of the release decision. */}}};
 };
 router.post('/preview',async(req,res)=>{
  if(!service.enabled())return void res.status(404).end();
  if(req.get('X-Strata-Read-Intent')!=='inspect-economic-discharge'||Object.keys(req.query).length||
   req.body&&Object.keys(req.body).length)return void res.status(400).json({reason:'economic_discharge_empty_preview_required'});
  const trace=timings(req,'preview');
  try{const result=await service.preview(res.locals.strata.subject,trace.observe);res.status(result.ok?200:409).json(result);}
  catch{res.status(503).json({ok:false,reason:'economic_discharge_preview_unavailable',reserveReleased:false,leaseReleased:false,tradingAuthorized:false});}
  finally{trace.finish();}
 });
 router.post('/apply',async(req,res)=>{
  if(!service.enabled())return void res.status(404).end();
  if(Object.keys(req.query).length||req.get('X-Strata-Action-Intent')!=='discharge-economic-obligation')return void res.status(400).json({reason:'economic_discharge_action_intent_required'});
  const inputId=typeof req.body?.requestId==='string'&&UUID.test(req.body.requestId)?req.body.requestId:undefined;
  const correlate=<T extends {ok:boolean}>(result:T)=>{
   // Keep an existing returned ID intact so the browser detects mismatches.
   // A refusal or an unknown response can identify the attempt, never turn it into a receipt.
   return !result.ok&&inputId&&!('requestId' in result)?{...result,requestId:inputId}:result;
  };
  const logRefusal=(reason:unknown,status:unknown)=>{
   try{req.log?.warn({event:'economic_discharge_apply_not_recorded',
    status:status==='UNKNOWN'?'UNKNOWN':'REFUSED',
    reason:typeof reason==='string'&&SAFE_REASON.test(reason)?reason:'economic_discharge_verification_refused'});
   }catch{/* Observability must not affect release or receipt semantics. */}
  };
  const trace=timings(req,'apply');
  try{
   const result=await service.apply(res.locals.strata.subject,req.body,trace.observe);
   if(!result.ok)logRefusal(result.reason,result.status);
   res.status(result.ok?200:409).json(correlate(result));
  }
  // A transport failure after an attempted POST is not proof of no commit.
  catch{
   const reason='economic_discharge_apply_outcome_unavailable';
   logRefusal(reason,'UNKNOWN');
   res.status(503).json(correlate({ok:false,status:'UNKNOWN',reason,reserveReleased:null,leaseReleased:null,outcomeUnknown:true,tradingAuthorized:false}));
  }finally{trace.finish();}
 });
 router.post('/cancel',async(req,res)=>{
  if(Object.keys(req.query).length||!req.body||Object.keys(req.body).sort().join(',')!=='confirmation,requestId'||
   req.body.confirmation!=='CANCEL_ONLY_THIS_ECONOMIC_DISCHARGE_REQUEST'||!UUID.test(String(req.body.requestId)))return void res.status(400).end();
  try{const result=await service.cancel(res.locals.strata.subject,String(req.body.requestId));res.status(result.ok||result.status==='CANCELED'?200:409).json(result);}
  catch{res.status(503).json({ok:false,status:'UNKNOWN',reserveReleased:null,leaseReleased:null,outcomeUnknown:true,tradingAuthorized:false});}
 });
 router.get('/outcome',async(req,res)=>{
  if(Object.keys(req.query).sort().join(',')!=='requestId'||!UUID.test(String(req.query.requestId)))return void res.status(400).end();
  try{const result=await service.outcome(res.locals.strata.subject,String(req.query.requestId));res.status(result.ok?200:409).json(result);}
  catch{res.status(503).json({ok:false,status:'UNKNOWN',reserveReleased:null,leaseReleased:null,outcomeUnknown:true,tradingAuthorized:false});}
 });
 return router;
}
import {Router,type RequestHandler} from 'express';
import type {createEconomicDischargeService} from '../lib/strata/economicExitDischargeService';
type Service=ReturnType<typeof createEconomicDischargeService>;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Mount ONLY inside the existing authenticated/AAL2 owner router. Neither a
 * query nor a request body can choose a different account or owner. */
export function economicDischargeRouter(service:Service){
 const router=Router();
 const owner:RequestHandler=(_req,res,next)=>{res.set('Cache-Control','private, no-store');
  if(!UUID.test(String(res.locals.strata?.subject??'')))return void res.status(401).json({reason:'unauthorized'});next();};
 router.use(owner);
 router.post('/preview',async(req,res)=>{
  if(!service.enabled())return void res.status(404).end();
  if(req.get('X-Strata-Read-Intent')!=='inspect-economic-discharge'||Object.keys(req.query).length||
   req.body&&Object.keys(req.body).length)return void res.status(400).json({reason:'economic_discharge_empty_preview_required'});
  try{const result=await service.preview(res.locals.strata.subject);res.status(result.ok?200:409).json(result);}
  catch{res.status(503).json({ok:false,reason:'economic_discharge_preview_unavailable',reserveReleased:false,leaseReleased:false,tradingAuthorized:false});}
 });
 router.post('/apply',async(req,res)=>{
  if(!service.enabled())return void res.status(404).end();
  if(Object.keys(req.query).length||req.get('X-Strata-Action-Intent')!=='discharge-economic-obligation')return void res.status(400).json({reason:'economic_discharge_action_intent_required'});
  try{const result=await service.apply(res.locals.strata.subject,req.body);res.status(result.ok?200:409).json(result);}
  // A transport failure after an attempted POST is not proof of no commit.
  catch{res.status(503).json({ok:false,status:'UNKNOWN',reason:'economic_discharge_apply_outcome_unavailable',reserveReleased:null,leaseReleased:null,outcomeUnknown:true,tradingAuthorized:false});}
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
import {Router,type RequestHandler} from 'express';
import {createHeldReadDiagnostic} from '../lib/strata/heldReadDiagnostic';
/** Unmounted candidate router. Caller must supply existing trusted authentication
 * middleware. No owner/account is accepted from request input. No auth shortcut. */
export function createHeldReadDiagnosticRouter(requireUser:RequestHandler,deps:Parameters<typeof createHeldReadDiagnostic>[0]){
 const router=Router();router.use(requireUser);
 router.post('/held-read-diagnostic',heldReadDiagnosticHandler(deps));
 return router;
}
export function heldReadDiagnosticHandler(deps:Parameters<typeof createHeldReadDiagnostic>[0]):RequestHandler{
 return async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  const owner=res.locals.strata?.subject;
  if(typeof owner!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(owner)){
   res.status(401).json({error:'Unauthorized'});return;
  }
  if((req.body!=null&&(typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length>0))||Object.keys(req.query??{}).length>0){
   res.status(400).json({error:'diagnostic_input_not_allowed'});return;
  }
  const controller=new AbortController();
  const disconnected=()=>{if(!res.writableEnded)controller.abort();};
  req.once('aborted',disconnected);res.once('close',disconnected);
  if(req.aborted||res.destroyed)controller.abort();
  try{
   const result=await createHeldReadDiagnostic(deps)(owner,controller.signal);
   if(!res.destroyed)res.status(result.status==='read_complete'?200:409).json(result);
  }catch{if(!res.destroyed)res.status(503).json({error:'diagnostic_unavailable'});}
  finally{req.removeListener('aborted',disconnected);res.removeListener('close',disconnected);}
 };
}

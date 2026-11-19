/** Owner-scoped cash diagnostic; never a release or cash-clear authority. */
import {Router,type IRouter,type RequestHandler} from 'express';
import {pool} from '@workspace/db';
import {deployedGitSha} from '../lib/strata/deployedGitSha';
import {personalTradingSession} from '../lib/strata/sharedPersonalTradingControls';
import {createStoppedCashBracketAdapter} from '../lib/strata/stoppedCashDiagnosticAdapters';
import {createStoppedCashDiagnosticLoader} from '../lib/strata/stoppedCashDiagnosticLoader';
import {inspectStoppedCashDiagnosticPrototype} from '../lib/strata/stoppedCashDiagnosticPrototype';

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SHA=/^[0-9a-f]{40}$/;
const no=(reason:string)=>({ok:false as const,reason,accountWritesPerformed:false as const,
 observationPersisted:false as const,ordersSubmitted:false as const,tradingAuthorized:false as const});
type Result=Awaited<ReturnType<typeof inspectStoppedCashDiagnosticPrototype>>;
type Deps={env:()=>NodeJS.ProcessEnv; inspect:(subject:string)=>Promise<Result>};

export function stoppedCashDiagnosticOwner(env:NodeJS.ProcessEnv):string|null{
 const sha=env.STRATA_STOPPED_CASH_DIAGNOSTIC_SHA??'', owner=env.STRATA_STOPPED_CASH_DIAGNOSTIC_OWNER??'';
 return env.NODE_ENV==='production'&&env.STRATA_STOPPED_CASH_DIAGNOSTIC_ENABLED==='true'&&
   env.STRATA_STOPPED_CASH_DIAGNOSTIC_REVIEWED==='true'&&SHA.test(sha)&&
   deployedGitSha(env)===sha&&UUID.test(owner)?owner:null;
}
const loader=createStoppedCashDiagnosticLoader({connect:()=>pool.connect(),
 releaseSha:()=>deployedGitSha(process.env)??'',
 isScheduled:(owner,account)=>personalTradingSession.isScheduled(owner,account)});
const bracket=createStoppedCashBracketAdapter();
const defaults:Deps={env:()=>process.env,inspect:subject=>inspectStoppedCashDiagnosticPrototype(
 {subject,aal:'aal2'},{...loader,bracket,
 env:()=>stoppedCashDiagnosticOwner(process.env)===subject?process.env:{},wall:Date.now,mono:()=>performance.now()})};

/** requireUser must be Strata's verified AAL2 middleware. No unauthenticated
 * handler export; in-process guard is supplemental to the persistent quota. */
export function createStoppedCashDiagnosticRouter(requireUser:RequestHandler,deps:Deps=defaults):IRouter{
 const router:IRouter=Router();let inFlight=false;
 router.post('/my-stopped-cash-proof',(_req,res,next)=>{res.set('Cache-Control','private, no-store');next();},
  requireUser,async(req,res)=>{
   const subject:unknown=res.locals.strata?.subject;
   if(typeof subject!=='string'||!UUID.test(subject)){res.status(401).json(no('owner_aal2_required'));return;}
   const unparsedBody=req.body===undefined&&
    ((req.header('content-length')!==undefined&&req.header('content-length')!=='0')||
     req.header('transfer-encoding')!==undefined);
   if(unparsedBody||Object.keys(req.query).length||!(req.body===undefined||
       (req.body!==null&&typeof req.body==='object'&&!Array.isArray(req.body)&&Object.keys(req.body).length===0))){
    res.status(400).json(no('stopped_cash_diagnostic_accepts_no_input'));return;
   }
   if(stoppedCashDiagnosticOwner(deps.env())!==subject){
    res.status(404).json(no('stopped_cash_diagnostic_unavailable'));return;
   }
   if(inFlight){res.status(409).json(no('stopped_cash_diagnostic_in_progress'));return;}
   inFlight=true;
   try{
    const out=await deps.inspect(subject);
    if(stoppedCashDiagnosticOwner(deps.env())!==subject){
     res.status(404).json(no('stopped_cash_diagnostic_unavailable'));return;
    }
    if(!out.ok){res.status(409).json(no(out.reason));return;}
    const {observedAt,elapsedMs,terminalOrders,fills,settlements}=out;
    res.status(200).json({...no('stopped_cash_diagnostic_complete'),ok:true,observedAt,elapsedMs,
     cashMatchesLedger:true,openOrders:0,openPositions:0,terminalOrders,fills,settlements});
   }catch{res.status(503).json(no('stopped_cash_diagnostic_unavailable'));}
   finally{inFlight=false;}
  });
 return router;
}

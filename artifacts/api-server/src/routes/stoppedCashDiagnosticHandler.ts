/** Owner-scoped cash diagnostic; never a release or cash-clear authority. */
import {Router,type IRouter,type RequestHandler} from 'express';
import {pool} from '@workspace/db';
import {logger} from '../lib/logger';
import {observeStoppedBalanceOnly,STOPPED_BALANCE_FAILURE_STAGES} from '../lib/strata/stoppedBalanceObservation';
import {balanceEvidence} from '../lib/strata/settledCashBracket';
import {getOwnedProductionKalshiJson} from '../lib/strata/personalExchangeRead';
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
type BalanceResult=Awaited<ReturnType<typeof observeStoppedBalanceOnly>>;
type Deps={env:()=>NodeJS.ProcessEnv; inspect:(subject:string)=>Promise<Result>;
 observeBalance?:(subject:string,observeTransport:(read:1|2)=>void)=>Promise<BalanceResult>};
const balanceNo=()=>({status:'balance_observation_unverified' as const,historyUnverified:true as const,
 accountWritesPerformed:false as const,observationPersisted:false as const,ordersSubmitted:false as const,tradingAuthorized:false as const});
const safeBalanceStage=(stage:unknown)=>STOPPED_BALANCE_FAILURE_STAGES.find(x=>x===stage)??'observation_unavailable';
function logBalanceObservation(fields:Record<string,string|boolean>){
 try{logger.info({event:'stopped_balance_observation',...fields});}catch{/* diagnostics cannot affect responses */}
}
export function stoppedBalanceObservationOwner(env:NodeJS.ProcessEnv):string|null{
 const sha=env.STRATA_STOPPED_BALANCE_OBSERVATION_SHA??'',owner=env.STRATA_STOPPED_BALANCE_OBSERVATION_OWNER??'';
 return env.NODE_ENV==='production'&&env.STRATA_STOPPED_BALANCE_OBSERVATION_ENABLED==='true'&&
  env.STRATA_STOPPED_BALANCE_OBSERVATION_REVIEWED==='true'&&SHA.test(sha)&&
  deployedGitSha(env)===sha&&UUID.test(owner)?owner:null;
}

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
 env:()=>stoppedCashDiagnosticOwner(process.env)===subject?process.env:{},wall:Date.now,mono:()=>performance.now()}),
 observeBalance:(subject,observeTransport)=>observeStoppedBalanceOnly({subject,aal:'aal2'},{...loader,observeTransport,
 exactOwnerGate:owner=>stoppedBalanceObservationOwner(process.env)===owner,
 scopedGet:getOwnedProductionKalshiJson,parseBalance:balanceEvidence,wall:Date.now,mono:()=>performance.now()})};

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
 // Independent default-off capability; existing proof and cash-clear contracts unchanged.
 router.post('/my-stopped-balance-observation',(_req,res,next)=>{
  res.set('Cache-Control','private, no-store');logBalanceObservation({phase:'http_arrived'});next();},
  requireUser,async(req,res)=>{
   const subject:unknown=res.locals.strata?.subject;
   if(typeof subject!=='string'||!UUID.test(subject)){res.status(401).json(balanceNo());return;}
   const emptyBody=req.body===undefined||(req.body!==null&&typeof req.body==='object'&&
    !Array.isArray(req.body)&&Object.keys(req.body).length===0);
   // Express parsers may initialize req.body to {} even for a no-wire-body POST.
   if(Object.keys(req.query).length||!emptyBody||
      (req.header('content-length')!==undefined&&req.header('content-length')!=='0')||
      req.header('transfer-encoding')!==undefined){res.status(400).json(balanceNo());return;}
   if(stoppedBalanceObservationOwner(deps.env())!==subject||!deps.observeBalance){
    res.status(404).json(balanceNo());return;
   }
   if(inFlight){logBalanceObservation({phase:'in_progress'});res.status(409).json({...balanceNo(),failureStage:'observation_in_progress'});return;}
   inFlight=true;
   let openingFetchInvoked=false,closingFetchInvoked=false;
   let disposition='observation_unavailable';
   try{
    const b=await deps.observeBalance(subject,leg=>{
     if(leg===1)openingFetchInvoked=true;
     if(leg===2)closingFetchInvoked=true;
    });
    if(stoppedBalanceObservationOwner(deps.env())!==subject){disposition='gate_changed';res.status(404).json(balanceNo());return;}
    if(!('observedAt' in b)||typeof b.observedAt!=='string'||
       !['balance_matches_local_cash_history_unverified','balance_differs_from_local_cash_history_unverified'].includes(b.status)){
      const failureStage=safeBalanceStage('failureStage' in b?b.failureStage:undefined);
      disposition=failureStage;
      res.status(409).json({...balanceNo(),failureStage});return;
    }
    disposition='observation_complete'; // Do not log balance direction or amounts.
    res.status(200).json({...balanceNo(),status:b.status,observedAt:b.observedAt});
   }catch{
    if(stoppedBalanceObservationOwner(deps.env())!==subject){res.status(404).json(balanceNo());return;}
    res.status(503).json({...balanceNo(),failureStage:'observation_unavailable'});
   }
   finally{
    inFlight=false;
    logBalanceObservation({phase:'owner_observation_finished',disposition,openingFetchInvoked,closingFetchInvoked});
   }
  });
 return router;
}

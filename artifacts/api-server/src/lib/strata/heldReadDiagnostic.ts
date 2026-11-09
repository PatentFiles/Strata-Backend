import {performance} from 'node:perf_hooks';
import {readOwnedKalshiFeeds} from './personalExchangeRead';
import {getScopedKalshiJson} from '../kalshiAccountClient';
import {loadHeldReadDiagnosticScope,type DiagnosticDatabase} from './heldReadDiagnosticScope';
export {allowedDiagnosticUrl} from './heldReadDiagnosticPolicy';
type Dependencies={db:DiagnosticDatabase;transport?:typeof fetch;budgetMs?:number;drainMs?:number};
const activeOwners=new Set<string>();
/** Unregistered candidate. Trusted server auth supplies owner; no request account,
 * material or callback is accepted. Existing signer stays backend-only. No route,
 * ledger mutation, worker or execution callback. Original fetch identity retained.
 * Undrained work keeps both process exclusion and DB lease until settlement. */
export function createHeldReadDiagnostic(deps:Dependencies){
 if(process.env.NODE_ENV==='production'&&deps.transport&&deps.transport!==fetch)throw Error('diagnostic_original_transport_required');
 const budget=deps.budgetMs??15000,drain=deps.drainMs??1000;
 if(!Number.isInteger(budget)||budget<1||budget>15000||!Number.isInteger(drain)||drain<1||drain>1000)throw Error('diagnostic_budget_invalid');
 let used=false;
 return async(authenticatedOwner:string,externalSignal?:AbortSignal)=>{
  const base={tradingAuthorized:false as const,ordersSubmitted:false as const};
  if(used)return {...base,status:'already_consumed',drained:false,calls:0};
  used=true;
  if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(authenticatedOwner))return {...base,status:'invalid_owner',drained:true,calls:0};
  if(activeOwners.has(authenticatedOwner))return {...base,status:'busy',drained:false,calls:0};
  activeOwners.add(authenticatedOwner);
  const controller=new AbortController(),start=performance.now();let calls=0,settled=false,totalBytes=0;
  let databaseRole:string|undefined;
  const durationsMs:number[]=[];let reason='deadline';let expire:()=>void=()=>{};
  const interrupted=new Promise<'interrupted'>(resolve=>{expire=()=>{controller.abort();resolve('interrupted');};});
  const stop=()=>{reason='external_abort';expire();};
  externalSignal?.addEventListener('abort',stop,{once:true});
  const timer=setTimeout(expire,budget);
  if(externalSignal?.aborted)stop();
  const job=(async()=>{
   controller.signal.throwIfAborted();
   const scope=await loadHeldReadDiagnosticScope(deps.db,authenticatedOwner,controller.signal,()=>{reason='scope_lost';expire();});
   databaseRole=scope.databaseRole;
   try{
    controller.signal.throwIfAborted();
    const result=await readOwnedKalshiFeeds(scope.material,Date.now(),(material,path,query)=>
     getScopedKalshiJson(material,path,query,deps.transport??fetch,'https://external-api.kalshi.com',authenticatedOwner,controller.signal,{
      authorize:scope.authorize,
      consumeBytes:bytes=>{totalBytes+=bytes;if(totalBytes>8388608)throw Error('diagnostic_body_budget');},
      observe:event=>{if(event.phase==='start')calls++;else durationsMs.push(event.elapsedMs);},
     }));
    controller.signal.throwIfAborted();
   return result.ok&&result.historicalCoverageComplete===true?'read_complete':'read_refused';
   }finally{await scope.close();}
  })().catch(()=>controller.signal.aborted?'aborted':'read_refused').finally(()=>{settled=true;activeOwners.delete(authenticatedOwner);});
  let drainTimer:ReturnType<typeof setTimeout>|undefined;
  try{
   const status=await Promise.race([job,interrupted]);
   controller.abort();
   if(!settled)await Promise.race([job,new Promise<void>(resolve=>{drainTimer=setTimeout(resolve,drain);})]);
   return {...base,status:status==='interrupted'?reason:status,drained:settled,calls,durationsMs:[...durationsMs],...(databaseRole?{databaseRole,replicationRole:'origin'}:{}),elapsedMs:performance.now()-start};
  }finally{clearTimeout(timer);if(drainTimer)clearTimeout(drainTimer);externalSignal?.removeEventListener('abort',stop);controller.abort();}
 };
}

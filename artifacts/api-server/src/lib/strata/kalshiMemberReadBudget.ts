import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';

export const MEMBER_READ_PATHS = new Set([
 '/trade-api/v2/portfolio/balance','/trade-api/v2/portfolio/orders',
 '/trade-api/v2/portfolio/positions','/trade-api/v2/portfolio/fills',
 '/trade-api/v2/portfolio/settlements','/trade-api/v2/historical/orders',
 '/trade-api/v2/historical/fills',
]);
/** Public endpoint-cost snapshot HTTP200 2026-11-18T15:36:38.695Z.
 * This allowlist classifies GET only, never guesses mutation bucket type. */
export function memberReadCost(path:string):number {
 if(MEMBER_READ_PATHS.has(path))return 10;
 if(/^\/trade-api\/v2\/portfolio\/orders\/[A-Za-z0-9_-]{1,128}$/.test(path))return 2;
 if(['/trade-api/v2/api_keys','/trade-api/v2/account/limits','/trade-api/v2/markets','/trade-api/v2/series/KXBTC15M','/trade-api/v2/portfolio/subaccounts/balances','/trade-api/v2/portfolio/subaccounts/transfers','/trade-api/v2/portfolio/intra_exchange_instance_transfers'].includes(path))return 10;
 if(/^\/trade-api\/v2\/markets\/[A-Za-z0-9_-]+(?:\/orderbook)?$/.test(path)||/^\/trade-api\/v2\/portfolio\/intra_exchange_instance_transfers\/[A-Za-z0-9_-]{8,128}$/.test(path))return 10;
 throw Error('kalshi_member_budget_cost_unverified');
}
export function memberReadBudgetEnabled():boolean {
 const mode=process.env.STRATA_MEMBER_READ_BUDGET;
 if(mode===undefined||mode==='off')return false;
 if(mode!=='experimental_v1')throw Error('kalshi_member_budget_configuration_invalid');
 return true;
}
export function assertMemberBudgetUnsupported():void {
 if(memberReadBudgetEnabled())throw Error('kalshi_member_budget_transport_unsupported');
}
export type MemberBudgetQuery=(sql:string,args:unknown[])=>Promise<{rows:Record<string,unknown>[]} >;
export const MEMBER_READ_ADMISSION_SQL=`WITH binding AS MATERIALIZED (
 SELECT c.id,c.role FROM public.v13_production_account a
 JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id AND fa.provider='kalshi'
 JOIN private.provider_connections pc ON pc.financial_account_id=fa.id
 JOIN private.kalshi_connection_credentials c ON c.financial_account_id=fa.id AND c.owner_user_id=a.owner_user_id AND c.provider_connection_id=pc.id
 WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND pc.id=$3::uuid
 AND a.subaccount=1 AND a.exchange_index=2
 AND c.key_fingerprint=$4 AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL
 AND c.verification_reason='credential_verified'
 AND c.role IN ('restricted_execution','account_setup_execution','verification','provisioning')
 LIMIT 2
) SELECT CASE WHEN (SELECT count(*) FROM binding)=1
 THEN CASE WHEN $5::boolean THEN true ELSE private.strata_reserve_member_read_token($6::integer) END ELSE false END AS admitted,
 (SELECT count(*) FROM binding)=1 AS binding_verified,
 (SELECT id::text||':'||role FROM binding LIMIT 1) AS binding_token`;
export const MEMBER_READ_BINDING_SQL=MEMBER_READ_ADMISSION_SQL.slice(0,MEMBER_READ_ADMISSION_SQL.indexOf(') SELECT CASE'))+
 ") SELECT (SELECT count(*) FROM binding)=1 AS binding_verified, (SELECT id::text||':'||role FROM binding LIMIT 1) AS binding_token";
const configuredTuple=()=>JSON.stringify([process.env.STRATA_MEMBER_BUDGET_OWNER_ID,process.env.STRATA_MEMBER_BUDGET_ACCOUNT_ID,process.env.STRATA_MEMBER_BUDGET_CONNECTION_ID]);
async function verifyFreshMemberBinding(bindingArgs:readonly unknown[],expectedBinding:string,query:MemberBudgetQuery|undefined,signal?:AbortSignal):Promise<void>{
 signal?.throwIfAborted();
 const db=query??await (async()=>{const {pool}=await import('@workspace/db');return pool.query.bind(pool);})();
 const result=await db(MEMBER_READ_BINDING_SQL,[...bindingArgs]);
 signal?.throwIfAborted();
 if(result.rows.length!==1||result.rows[0]?.binding_verified!==true||result.rows[0]?.binding_token!==expectedBinding)throw Error('kalshi_member_budget_scope_unverified');
}
declare const ticketBrand:unique symbol;
export type MemberReadTicket={readonly [ticketBrand]:true};
type TicketState={mode:string|undefined;kind:"charged"|"balance";started:number;used:boolean;signal?:AbortSignal;active?:()=>boolean};
const tickets=new WeakMap<MemberReadTicket,TicketState>();
function mint(started:number,signal?:AbortSignal,active?:()=>boolean,kind:"charged"|"balance"="charged"):MemberReadTicket{const t=Object.freeze({}) as MemberReadTicket;tickets.set(t,{mode:process.env.STRATA_MEMBER_READ_BUDGET,kind,started,used:false,signal,active});return t;}
/** Consume after all awaits/signing, synchronously at the actual fetch boundary. */
export function dispatchMemberRead<T>(ticket:MemberReadTicket|null,send:()=>T):T{
 if(ticket===null){if(batches.getStore())throw Error('kalshi_member_budget_configuration_changed');if(memberReadBudgetEnabled())throw Error('kalshi_member_budget_ticket_missing');return send();}
 const state=tickets.get(ticket);if(!state||state.used)throw Error('kalshi_member_budget_ticket_invalid');
 state.used=true;state.signal?.throwIfAborted();
 if(state.mode!==process.env.STRATA_MEMBER_READ_BUDGET)throw Error('kalshi_member_budget_configuration_changed');
 const age=performance.now()-state.started;
 if(age<0||age>500||state.active&&!state.active())throw Error('kalshi_member_budget_ticket_expired');
 return send();
}
type Batch={signal:AbortSignal;mode:string|undefined;lanePermits:number;started:number;fingerprint:string;scope:string;binding:string;bindingArgs:readonly unknown[];active:boolean;entries:Map<string,{query:string;ticket:MemberReadTicket;claimed:boolean}>};
const batches=new AsyncLocalStorage<Batch>();
/** Scheduler-only capability. No caller-supplied cap; at most six groups per
 * verified prepaid invocation. Expired/closed contexts fail, never downgrade. */
export function captureMemberHistoryLaneEligibility():(()=>boolean)|null{
 const batch=batches.getStore();if(!batch)return null;
 const valid=()=>!batch.signal.aborted&&batch.active&&batch.scope===configuredTuple()&&batch.mode==='experimental_v1'&&batch.mode===process.env.STRATA_MEMBER_READ_BUDGET&&performance.now()-batch.started>=0&&performance.now()-batch.started<=500;
 if(!valid()||batch.lanePermits<=0)throw Error('kalshi_member_budget_lane_scope');
 batch.lanePermits--;return valid;
}
const historyPaths=['/portfolio/orders','/historical/orders','/portfolio/fills','/historical/fills','/portfolio/positions','/portfolio/settlements'].map(p=>'/trade-api/v2'+p);
function initialQuery(path:string){return '?limit=200&subaccount=1&exchange_index=2'+(path.endsWith('/positions')?'&settlement_status=all&count_filter=position%2Ctotal_traded':'');}
/** One invocation owns exactly six immutable first-page credits. No fallback. */
export async function withMemberHistoryCredits<T>(fingerprint:string|null,signal:AbortSignal,run:()=>Promise<T>,query?:MemberBudgetQuery):Promise<T>{
 if(!memberReadBudgetEnabled())return run();
 if(batches.getStore())throw Error('kalshi_member_budget_nested_scan');
 const mode=process.env.STRATA_MEMBER_READ_BUDGET,scope=configuredTuple();
 const bindingArgs=Object.freeze([process.env.STRATA_MEMBER_BUDGET_ACCOUNT_ID,process.env.STRATA_MEMBER_BUDGET_OWNER_ID,process.env.STRATA_MEMBER_BUDGET_CONNECTION_ID,fingerprint]);
 let binding='';
 const started=await reserveMemberCost(60,false,fingerprint,query,signal,(token)=>{if(typeof token!=='string'||token.length===0)throw Error('kalshi_member_budget_scope_unverified');binding=token;});
 if(configuredTuple()!==scope||process.env.STRATA_MEMBER_READ_BUDGET!==mode)throw Error('kalshi_member_budget_credit_scope');
 const batch:Batch={signal,mode,lanePermits:6,started,fingerprint:fingerprint!,scope,binding,bindingArgs,active:true,entries:new Map()};
 for(const path of historyPaths)batch.entries.set(path,{query:initialQuery(path),ticket:mint(started,signal,()=>batch.active&&batch.mode===process.env.STRATA_MEMBER_READ_BUDGET&&batch.scope===configuredTuple()),claimed:false});
 try{return await batches.run(batch,run);}finally{batch.active=false;}
}
export async function reserveMemberRead(path:string,fingerprint:string|null,
 query?:MemberBudgetQuery,signal?:AbortSignal,request?:{host:string;query:string}):Promise<MemberReadTicket|null>{
 const batch=batches.getStore();
 if(batch&&batch.mode!==process.env.STRATA_MEMBER_READ_BUDGET)throw Error('kalshi_member_budget_configuration_changed');
 if(!memberReadBudgetEnabled())return null;
 const cost=memberReadCost(path),entry=batch?.entries.get(path);
 if(entry){
  if(!batch!.active||batch!.scope!==configuredTuple()||batch!.fingerprint!==fingerprint||request?.host!=='https://external-api.kalshi.com')throw Error('kalshi_member_budget_credit_scope');
  signal?.throwIfAborted();
  if(request.query===entry.query){
   if(entry.claimed)throw Error('kalshi_member_budget_credit_reused');entry.claimed=true;
   await verifyFreshMemberBinding(batch!.bindingArgs,batch!.binding,query,signal);
   if(!batch!.active||batch!.scope!==configuredTuple()||batch!.mode!==process.env.STRATA_MEMBER_READ_BUDGET)throw Error('kalshi_member_budget_credit_scope');
   const state=tickets.get(entry.ticket)!;if(signal)state.signal=state.signal?AbortSignal.any([state.signal,signal]):signal;
   return entry.ticket;
  }
  if(!entry.claimed||!request.query.startsWith(entry.query+'&cursor=')||request.query.length===entry.query.length+8)throw Error('kalshi_member_budget_credit_scope');
 }
 return mint(await reserveMemberCost(cost,path==='/trade-api/v2/portfolio/balance',fingerprint,query,signal),signal,undefined,path==='/trade-api/v2/portfolio/balance'?'balance':'charged');
}
/** Only documented Read-charged mutations, never arbitrary HTTP POSTs. */
export async function reserveMemberReadMutation(method:'POST'|'DELETE',path:string,fingerprint:string|null,query?:MemberBudgetQuery,signal?:AbortSignal):Promise<MemberReadTicket|null>{
 if(!memberReadBudgetEnabled())return null;
 const known=method==='POST'&&['/trade-api/v2/api_keys/generate','/trade-api/v2/portfolio/subaccounts','/trade-api/v2/portfolio/subaccounts/transfer','/trade-api/v2/portfolio/intra_exchange_instance_transfer'].includes(path);
 if(!known)throw Error('kalshi_member_budget_operation_unverified');
 return mint(await reserveMemberCost(10,false,fingerprint,query,signal),signal);
}
async function reserveMemberCost(cost:number,balance:boolean,fingerprint:string|null,query:MemberBudgetQuery|undefined,signal?:AbortSignal,capture?:(token:unknown)=>void):Promise<number>{
 signal?.throwIfAborted();
 const owner=process.env.STRATA_MEMBER_BUDGET_OWNER_ID,account=process.env.STRATA_MEMBER_BUDGET_ACCOUNT_ID,connection=process.env.STRATA_MEMBER_BUDGET_CONNECTION_ID;
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
 if(!owner||!uuid.test(owner)||!connection||!uuid.test(connection)||!account||account.length>200||!fingerprint||! /^[a-f0-9]{64}$/.test(fingerprint))throw Error('kalshi_member_budget_scope_unverified');
 const db=query??await (async()=>{const {pool}=await import('@workspace/db');return pool.query.bind(pool);})();
 signal?.throwIfAborted();const args=[account,owner,connection,fingerprint,balance,cost];
 let started=performance.now(),result=await db(MEMBER_READ_ADMISSION_SQL,args);signal?.throwIfAborted();
 if(result.rows.length===1&&result.rows[0]?.binding_verified===true&&result.rows[0]?.admitted===false){
  // Upper bound for a full cost deficit at 300/s; no provider retry or initial credit.
  const wait=Math.min(250,Math.ceil(cost/300*1000)+10);
  await new Promise<void>((resolve,reject)=>{
   const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason??Error('kalshi_member_budget_aborted'));};
   const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},wait);
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
  signal?.throwIfAborted();started=performance.now();result=await db(MEMBER_READ_ADMISSION_SQL,args);
 }
 if(result.rows.length!==1||result.rows[0]?.admitted!==true)throw Error('kalshi_member_budget_unavailable');
 signal?.throwIfAborted();capture?.(result.rows[0]?.binding_token);return started;
}

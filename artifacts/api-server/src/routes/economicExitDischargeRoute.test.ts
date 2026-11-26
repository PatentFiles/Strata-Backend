import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import type {AddressInfo} from 'node:net';
import {economicDischargeRouter} from './economicExitDischargeRoute';
import {createEconomicDischargeService,economicDischargeEnabled,ECONOMIC_DISCHARGE_CONFIRM,readEconomicDischargeCut,readEconomicTransferPages} from '../lib/strata/economicExitDischargeService';
const owner='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222';

test('economic recovery is default-off and exact release bound',()=>{
 assert.equal(economicDischargeEnabled({}),false);
 assert.equal(economicDischargeEnabled({STRATA_ECONOMIC_EXIT_FINALITY_ENABLED:'true',RAILWAY_GIT_COMMIT_SHA:'a'.repeat(40),STRATA_ECONOMIC_EXIT_DISCHARGE_SHA:'b'.repeat(40)}),false);
 assert.equal(economicDischargeEnabled({STRATA_ECONOMIC_EXIT_FINALITY_ENABLED:'true',RAILWAY_GIT_COMMIT_SHA:'a'.repeat(40),STRATA_ECONOMIC_EXIT_DISCHARGE_SHA:'a'.repeat(40)}),true);
});
test('service refuses selector injection and implicit authorization before touching a database',async()=>{
 const db={connect:()=>{throw Error('unexpected_database');},query:()=>{throw Error('unexpected_database');}};
 const s=createEconomicDischargeService({db:db as never,enabled:()=>true,sha:()=> 'a'.repeat(40),isScheduled:()=>false});
 for(const v of [null,[],{}, {requestId,scopeDigest:'b'.repeat(64),releaseSha:'a'.repeat(40)},
  {requestId,scopeDigest:'b'.repeat(64),releaseSha:'a'.repeat(40),confirmation:ECONOMIC_DISCHARGE_CONFIRM,ownerId:'other'}]){
  const r=await s.apply(owner,v);assert.equal(r.ok,false);assert.equal(r.reason,'economic_discharge_explicit_owner_scope_required');
 }
});
test('mounted routes bind authenticated owner, require explicit intent and retain readback after disable',async()=>{
 const calls:string[]=[];const traces:unknown[]=[];let enabled=true;
 const result={ok:true,status:'RECORDED',reason:'economic_discharge_posted_transport_remains_unknown',accountingPosted:true};
 const service={enabled:()=>enabled,preview:async(who:string)=>{calls.push('preview:'+who);return {...result,accountingPosted:false};},
  apply:async(who:string,_input:unknown,observe:(stage:'signedHistory',ms:number)=>void)=>{calls.push('apply:'+who);observe('signedHistory',432);return result;},
  outcome:async(who:string,id:string)=>{calls.push('outcome:'+who+':'+id);return result;},
  cancel:async(who:string,id:string)=>{calls.push('cancel:'+who+':'+id);return {ok:false,status:'CANCELED',accountingPosted:false};}} as unknown as ReturnType<typeof createEconomicDischargeService>;
 const app=express();app.use(express.json());app.use((req,res,next)=>{res.locals.strata={subject:req.get('X-Test-Owner')??''};req.log={info:(v:unknown)=>traces.push(v)} as unknown as typeof req.log;next();});
 app.use('/economic',economicDischargeRouter(service));const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/economic`;
 const post=(path:string,body:unknown={},auth=true,header:Record<string,string>={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Test-Owner':owner}:{}),...header},body:JSON.stringify(body)});
 try{
  assert.equal((await post('/preview',{},false)).status,401);
  assert.equal((await post('/preview')).status,400);
  assert.equal((await post('/preview?owner=other',{},true,{'X-Strata-Read-Intent':'inspect-economic-discharge'})).status,400);
  assert.equal((await post('/preview',{accountId:'foreign'},true,{'X-Strata-Read-Intent':'inspect-economic-discharge'})).status,400);
  assert.equal(calls.length,0);
  const p=await post('/preview',{},true,{'X-Strata-Read-Intent':'inspect-economic-discharge'});assert.equal(p.status,200);assert.equal(p.headers.get('cache-control'),'private, no-store');
  assert.equal((await post('/apply')).status,400);
  assert.equal((await post('/apply',{},true,{'X-Strata-Action-Intent':'discharge-economic-obligation'})).status,200);
  enabled=false;assert.equal((await post('/preview',{},true,{'X-Strata-Read-Intent':'inspect-economic-discharge'})).status,404);
  assert.equal((await post('/apply',{},true,{'X-Strata-Action-Intent':'discharge-economic-obligation'})).status,404);
  const out=await fetch(`${base}/outcome?requestId=${requestId}`,{headers:{'X-Test-Owner':owner}});assert.equal(out.status,200);
  assert.equal((await post('/cancel',{requestId,confirmation:'CANCEL_ONLY_THIS_ECONOMIC_DISCHARGE_REQUEST'})).status,200);
  assert.deepEqual(traces,[{event:'economic_discharge_timing',operation:'apply',stages:{signedHistory:432}}]);
  assert.deepEqual(calls,[`preview:${owner}`,`apply:${owner}`,`outcome:${owner}:${requestId}`,`cancel:${owner}:${requestId}`]);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


test('transfer reads accept an omitted cursor only on a short terminal page',async()=>{
 const calls:(string|undefined)[]=[];
 const row={transfer_id:'fixture'};
 assert.deepEqual(await readEconomicTransferPages(async cursor=>{
  calls.push(cursor);
  return cursor===undefined?{transfers:[],cursor:'next'}:{transfers:[row]};
 }),[row]);
 assert.deepEqual(calls,[undefined,'next']);
 assert.deepEqual(await readEconomicTransferPages(async()=>({transfers:[]})),[]);
 assert.equal((await readEconomicTransferPages(async()=>({transfers:Array.from({length:200},()=>row),cursor:''}))).length,200);
 await assert.rejects(()=>readEconomicTransferPages(async()=>({transfers:Array.from({length:200},()=>row)})),/economic_discharge_transfer_cursor_unverified/);
});
test('transfer reads reject bad tokens, malformed pages, cursor cycles and a nonterminating list',async()=>{
 for(const cursor of [null,123,{},' ','line\nbreak','x'.repeat(1025)]){
  await assert.rejects(()=>readEconomicTransferPages(async()=>({transfers:[],cursor})),/economic_discharge_transfer_cursor_unverified/);
 }
 for(const transfers of [null, [null], Array.from({length:201},()=>({}))]){
  await assert.rejects(()=>readEconomicTransferPages(async()=>({transfers,cursor:''})),/economic_discharge_transfer_page_unverified/);
 }
 await assert.rejects(()=>readEconomicTransferPages(async()=>({transfers:[],cursor:'same'})),/economic_discharge_transfer_cursor_unverified/);
 let pages=0;
 await assert.rejects(()=>readEconomicTransferPages(async()=>({transfers:[],cursor:String(++pages)})),/economic_discharge_transfer_history_incomplete/);
 assert.equal(pages,20);
});


test('apply refusal preserves a valid attempt ID, pending semantics and bounded diagnostics',async()=>{
 const messages:unknown[]=[];
 let mode:'refused'|'mismatch'|'unknown'='refused';
 const service={enabled:()=>true,apply:async()=>{
  if(mode==='unknown')throw Error('a private provider payload must not be returned or logged');
  return {ok:false,status:'REFUSED',reason:'economic_discharge_evidence_expired',reserveReleased:false,leaseReleased:false,tradingAuthorized:false,
   ...(mode==='mismatch'?{requestId:owner}:{})};
 }} as unknown as ReturnType<typeof createEconomicDischargeService>;
 const app=express();app.use(express.json());
 app.use((req,res,next)=>{res.locals.strata={subject:owner};req.log={warn:(value:unknown)=>messages.push(value)} as unknown as typeof req.log;next();});
 app.use('/economic',economicDischargeRouter(service));const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/economic/apply`;
 const apply=(id:string)=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json','X-Strata-Action-Intent':'discharge-economic-obligation'},body:JSON.stringify({requestId:id,private:'never log the body'})});
 try{
  const refused=await apply(requestId);assert.equal(refused.status,409);
  assert.deepEqual(await refused.json(),{ok:false,status:'REFUSED',reason:'economic_discharge_evidence_expired',reserveReleased:false,leaseReleased:false,tradingAuthorized:false,requestId});
  assert.equal(((await (await apply('not-a-uuid')).json()) as {requestId?:string}).requestId,undefined);
  mode='mismatch';assert.equal(((await (await apply(requestId)).json()) as {requestId?:string}).requestId,owner);
  mode='unknown';const uncertain=await apply(requestId);assert.equal(uncertain.status,503);
  assert.deepEqual(await uncertain.json(),{ok:false,status:'UNKNOWN',reason:'economic_discharge_apply_outcome_unavailable',reserveReleased:null,leaseReleased:null,outcomeUnknown:true,tradingAuthorized:false,requestId});
  assert.deepEqual(messages.slice(-1),[{event:'economic_discharge_apply_not_recorded',status:'UNKNOWN',reason:'economic_discharge_apply_outcome_unavailable'}]);
  assert.ok(!JSON.stringify(messages).includes(requestId));assert.ok(!JSON.stringify(messages).includes('private'));
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


test('two independent cut reads overlap and both must finish before history',async()=>{
 const events:string[]=[];
 let finish!:()=>void;
 const gate=new Promise<void>(resolve=>{finish=resolve;});
 const cut=readEconomicDischargeCut(async()=>{events.push('transfer-start');await gate;events.push('transfer-complete');return 'transfers';},
  async()=>{events.push('market');finish();return 'market';});
 const pair=await cut;events.push('next-stage');
 assert.deepEqual(pair,['transfers','market']);
 assert.deepEqual(events,['transfer-start','market','transfer-complete','next-stage']);
});

test('failed cut does not finish with in-flight reads or admit partial evidence',async()=>{
 let done=false;
 await assert.rejects(readEconomicDischargeCut(async()=>{await new Promise<void>(resolve=>setImmediate(resolve));done=true;throw Error('transfer refused');},
  async()=>{throw Error('market refused');}),/transfer refused/);
 assert.equal(done,true);
});

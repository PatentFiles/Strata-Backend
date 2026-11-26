import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import type {AddressInfo} from 'node:net';
import {economicDischargeRouter} from './economicExitDischargeRoute';
import {createEconomicDischargeService,economicDischargeEnabled,ECONOMIC_DISCHARGE_CONFIRM} from '../lib/strata/economicExitDischargeService';
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
 const calls:string[]=[];let enabled=true;
 const result={ok:true,status:'RECORDED',reason:'economic_discharge_posted_transport_remains_unknown',accountingPosted:true};
 const service={enabled:()=>enabled,preview:async(who:string)=>{calls.push('preview:'+who);return {...result,accountingPosted:false};},
  apply:async(who:string)=>{calls.push('apply:'+who);return result;},
  outcome:async(who:string,id:string)=>{calls.push('outcome:'+who+':'+id);return result;},
  cancel:async(who:string,id:string)=>{calls.push('cancel:'+who+':'+id);return {ok:false,status:'CANCELED',accountingPosted:false};}} as unknown as ReturnType<typeof createEconomicDischargeService>;
 const app=express();app.use(express.json());app.use((req,res,next)=>{res.locals.strata={subject:req.get('X-Test-Owner')??''};next();});
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
  assert.deepEqual(calls,[`preview:${owner}`,`apply:${owner}`,`outcome:${owner}:${requestId}`,`cancel:${owner}:${requestId}`]);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

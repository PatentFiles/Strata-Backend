import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {SignJWT} from 'jose';
import {createStrataAccess,verifySupabaseAccessToken} from '../lib/strata/supabaseAuth';
import {createStoppedCashDiagnosticRouter,stoppedCashDiagnosticOwner} from './stoppedCashDiagnosticHandler';

const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const sha='a'.repeat(40),supabaseUrl='https://fixture.invalid',key=new Uint8Array(32).fill(7);
const config={NODE_ENV:'production',RAILWAY_GIT_COMMIT_SHA:sha,STRATA_STOPPED_CASH_DIAGNOSTIC_SHA:sha,
 STRATA_STOPPED_CASH_DIAGNOSTIC_ENABLED:'true',STRATA_STOPPED_CASH_DIAGNOSTIC_REVIEWED:'true',STRATA_STOPPED_CASH_DIAGNOSTIC_OWNER:owner};
const token=(who:string,aal:string)=>new SignJWT({aal}).setProtectedHeader({alg:'HS256'}).setSubject(who)
 .setIssuer(supabaseUrl+'/auth/v1').setAudience('authenticated').setExpirationTime('5m').sign(key);
const report={ok:true as const,reason:'stopped_cash_diagnostic_complete' as const,accountWritesPerformed:false as const,
 observationPersisted:false as const,ordersSubmitted:false as const,tradingAuthorized:false as const,
 observedAt:'2026-11-19T02:00:00.000Z',elapsedMs:1120,cashMatchesLedger:true as const,
 openOrders:0 as const,openPositions:0 as const,terminalOrders:1,fills:1,settlements:1};

test('default-off and all exact release-scope configurations are mandatory',()=>{
 assert.equal(stoppedCashDiagnosticOwner({}),null);
 assert.equal(stoppedCashDiagnosticOwner(config),owner);
 for(const k of Object.keys(config))assert.equal(stoppedCashDiagnosticOwner({...config,[k]:undefined}),null);
 assert.equal(stoppedCashDiagnosticOwner({...config,RAILWAY_GIT_COMMIT_SHA:'b'.repeat(40)}),null);
 assert.equal(stoppedCashDiagnosticOwner({...config,STRATA_STOPPED_CASH_DIAGNOSTIC_OWNER:'not-an-owner'}),null);
});

test('real AAL2 token verification, exact owner, no input, no store, bounded concurrency and revocation',async()=>{
 const app=express();app.use(express.json());
 const access=createStrataAccess({
  verifyToken:t=>verifySupabaseAccessToken(t,{supabaseUrl,keys:async()=>key}),
  roleOf:async()=> 'ADMIN',
 });
 let env:NodeJS.ProcessEnv={},calls=0,fail=false,enter!:()=>void,finish!:()=>void;
 let entered=new Promise<void>(r=>{enter=r;}),release=new Promise<void>(r=>{finish=r;});
 app.use('/fixture',createStoppedCashDiagnosticRouter(access.requireUser,{env:()=>env,inspect:async who=>{
  assert.equal(who,owner);calls++;enter();await release;if(fail)throw Error('secret_internal_error');return report;
 }}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 try{
  const addr=server.address();assert.ok(addr&&typeof addr==='object');
  const valid=await token(owner,'aal2'),foreign=await token(other,'aal2'),aal1=await token(owner,'aal1');
  const send=async(t?:string,body?:string,query='',type='application/json')=>{
   const res=await fetch('http://127.0.0.1:'+addr.port+'/fixture/my-stopped-cash-proof'+query,{method:'POST',
    headers:{...(t?{authorization:'Bearer '+t}:{}),...(body!==undefined?{'content-type':type}:{})},body});
   return {status:res.status,cache:res.headers.get('cache-control'),body:await res.json()};
  };
  for(const bad of [undefined,'invalid',aal1]){
   const result=await send(bad);assert.equal(result.status,401);assert.equal(result.cache,'private, no-store');
  }
  assert.equal((await send(valid)).status,404);env=config;
  assert.equal((await send(foreign)).status,404);
  assert.equal((await send(valid,'{"owner":"invalid"}')).status,400);
  assert.equal((await send(valid,'adversarial owner input','','text/plain')).status,400);
  assert.equal((await send(valid,undefined,'?owner='+other)).status,400);
  assert.equal(calls,0);
  const inflight=send(valid,'{}');await entered;
  assert.equal((await send(valid)).status,409);assert.equal(calls,1);finish();
  assert.deepEqual(await inflight,{status:200,cache:'private, no-store',body:report});
  entered=new Promise<void>(r=>{enter=r;});release=new Promise<void>(r=>{finish=r;});
  const revoked=send(valid);await entered;env={};finish();
  assert.equal((await revoked).status,404);
  env=config;fail=true;
  const unverified=await send(valid);
  assert.equal(unverified.status,503);assert.doesNotMatch(JSON.stringify(unverified.body),/secret_internal_error/);
  assert.equal(calls,3);
 }finally{finish();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('application path is mounted behind AAL2 and fail-closed when deployment is disabled',async()=>{
 const {createStrataRouter}=await import('./strataRouter');
 const app=express();app.use(express.json());
 const closed=async()=>{throw Error('unrelated_production_action_forbidden');};
 const fixtureRead=async()=>({});
 app.use('/api/strata',createStrataRouter({
  verifyToken:(t:string)=>verifySupabaseAccessToken(t,{supabaseUrl,keys:async()=>key}),roleOf:async()=>null,
  control:{start:closed,stop:closed,view:()=>({})},status:fixtureRead,positions:fixtureRead,orders:fixtureRead,
  fills:fixtureRead,trades:fixtureRead,latestTrade:fixtureRead,forwardTestStatus:fixtureRead,
  forwardTestHistory:fixtureRead,phase4State:fixtureRead,microLiveState:fixtureRead,emergencyStop:closed,
 } as never));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 try{
  const addr=server.address();assert.ok(addr&&typeof addr==='object');
  const url='http://127.0.0.1:'+addr.port+'/api/strata/me/release/my-stopped-cash-proof';
  const attempt=(jwt:string)=>fetch(url,{method:'POST',headers:{authorization:'Bearer '+jwt}});
  assert.equal((await attempt(await token(owner,'aal1'))).status,401);
  const off=await attempt(await token(owner,'aal2'));
  assert.equal(off.status,404);assert.equal(off.headers.get('cache-control'),'private, no-store');
  assert.equal((await off.json() as {reason?:string}).reason,'stopped_cash_diagnostic_unavailable');
  const forward=url.replace('my-stopped-cash-proof','my-forward-cash-observation');
  const forwardAttempt=(jwt:string)=>fetch(forward,{method:'POST',headers:{authorization:'Bearer '+jwt}});
  assert.equal((await forwardAttempt(await token(owner,'aal1'))).status,401);
  const forwardOff=await forwardAttempt(await token(owner,'aal2'));
  assert.equal(forwardOff.status,404);
  assert.equal(forwardOff.headers.get('cache-control'),'private, no-store');
  assert.equal((await forwardOff.json() as {reason?:string}).reason,'forward_cash_observation_unavailable');
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('forward route uses separate exact AAL2 gate and reports current balance without claiming clearance',async()=>{
 const app=express();app.use(express.json());
 const access=createStrataAccess({
  verifyToken:t=>verifySupabaseAccessToken(t,{supabaseUrl,keys:async()=>key}),roleOf:async()=> 'ADMIN',
 });
 let calls=0;
 let env:NodeJS.ProcessEnv={};
 const forwardConfig={NODE_ENV:'production',RAILWAY_GIT_COMMIT_SHA:sha,STRATA_FORWARD_CASH_OBSERVATION_SHA:sha,
  STRATA_FORWARD_CASH_OBSERVATION_ENABLED:'true',STRATA_FORWARD_CASH_OBSERVATION_REVIEWED:'true',STRATA_FORWARD_CASH_OBSERVATION_OWNER:owner};
 app.use('/fixture',createStoppedCashDiagnosticRouter(access.requireUser,{env:()=>env,
  inspect:async()=>{throw Error('historical lane must not run');},
  observeForward:async who=>{assert.equal(who,owner);calls++;return {
   status:'balance_matches_local_cash_history_unverified',observedAt:report.observedAt,historyUnverified:true,
   accountWritesPerformed:false,observationPersisted:false,ordersSubmitted:false,tradingAuthorized:false,
  };},
 }));
 const server=app.listen(0,'127.0.0.1');
 await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 try{
  const addr=server.address();assert.ok(addr&&typeof addr==='object');
  const valid=await token(owner,'aal2'),aal1=await token(owner,'aal1'),foreign=await token(other,'aal2');
  const send=(bearer:string,body?:string,query='')=>fetch('http://127.0.0.1:'+addr.port+'/fixture/my-forward-cash-observation'+query,
   {method:'POST',headers:{authorization:'Bearer '+bearer,...(body?{'content-type':'application/json'}:{})},body});
  assert.equal((await send(valid)).status,404);env=forwardConfig;
  assert.equal((await send(aal1)).status,401);
  assert.equal((await send(foreign)).status,404);
  assert.equal((await send(valid,'{}')).status,400);
  assert.equal((await send(valid,undefined,'?owner='+other)).status,400);
  assert.equal(calls,0);
  const response=await send(valid);assert.equal(response.status,409);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  const b=await response.json();
  assert.equal(b.balanceMatchesLocal,true);assert.equal(b.stoppedLocalScopeVerified,true);
  assert.equal(b.pendingCashCompletenessVerified,false);assert.equal(b.authenticatedExchangeFlat,false);
  assert.equal(b.historyReplayed,false);assert.equal(b.holdCleared,false);assert.equal(b.tradingAuthorized,false);assert.equal(calls,1);
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

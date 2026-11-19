import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {readFileSync} from 'node:fs';
import {pool} from '@workspace/db';
import {createStrataAccess} from '../lib/strata/supabaseAuth';
import {OWNER_SETTLED_CASH_RECOVERY_CONFIRM} from '../lib/strata/ownerSettledCashFreezeRecovery';
import {createOwnerSettledCashRecoveryHandler,ownerSettledCashRecoveryReleaseApproved,OWNER_SETTLED_CASH_RECOVERY_MIGRATION_READY_SQL} from './ownerSettledCashRecoveryHandler';
const owner='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const sha='a'.repeat(40);
const enable={NODE_ENV:'production',RAILWAY_GIT_COMMIT_SHA:sha,STRATA_OWNER_SETTLED_CASH_RECOVERY_SHA:sha,
 STRATA_OWNER_SETTLED_CASH_RECOVERY_ENABLED:'true',STRATA_OWNER_SETTLED_CASH_RECOVERY_DEPLOYMENT_REVIEWED:'true'};
const body={confirmation:OWNER_SETTLED_CASH_RECOVERY_CONFIRM,accountId:'strata-account-fixture',expectedRevision:'12',
 settlementEventId:'settlement:canonical-fixture',subaccount:1,exchangeIndex:2};
test('default and every missing production release gate disable recovery',()=>{
 assert.equal(ownerSettledCashRecoveryReleaseApproved({}),false);
 assert.equal(ownerSettledCashRecoveryReleaseApproved(enable),true);
 for(const k of Object.keys(enable))assert.equal(ownerSettledCashRecoveryReleaseApproved({...enable,[k]:undefined}),false);
 assert.equal(ownerSettledCashRecoveryReleaseApproved({...enable,RAILWAY_GIT_COMMIT_SHA:'b'.repeat(40)}),false);
});
test('auth, exact scope, schema readiness, wrong owner and scheduled refusal without fallback',async()=>{
 const app=express();app.use(express.json());
 let approved=false,readiness=false,throwReadiness=false,scheduled=false,checks=0;
 const called:{who:string;value:unknown}[]=[];
 const access=createStrataAccess({verifyToken:async token=>{
  if(token!=='own-aal2'&&token!=='other-aal2')throw Error('not_aal2');
  return {subject:token==='own-aal2'?owner:other,issuer:'fixture',audience:'authenticated',aal:'aal2'};
 },roleOf:async()=> 'ADMIN'});
 app.post('/recover',access.requireUser,createOwnerSettledCashRecoveryHandler({
  approved:()=>approved,
  migrationReady:async()=>{checks++;if(throwReadiness)throw Error('fixture_connection');return readiness;},
  recover:async(who,value)=>{
   called.push({who,value});
   const reason=who!==owner?'recovery_settled_cash_account_not_eligible':scheduled?'recovery_worker_must_be_stopped':'';
   return reason?{ok:false,reason,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false,riskFreezeCleared:false}:
    {ok:true,reason:'settled_cash_freeze_reconciled_account_remains_disarmed',ordersSubmitted:false,workerStarted:false,
     tradingAuthorized:false,riskFreezeCleared:true};
  },
 }));
 const server=app.listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>server.once('listening',resolve));
 try{
  const addr=server.address();assert.ok(addr&&typeof addr==='object');
  const send=async(v:unknown,token='own-aal2',q='')=>{
   const r=await fetch('http://127.0.0.1:'+addr.port+'/recover'+q,{method:'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(v)});
   return {status:r.status,cache:r.headers.get('cache-control'),out:await r.json() as Record<string,unknown>};
  };
  assert.equal((await send(body,'aal1')).status,401);
  assert.equal((await send(body)).out.reason,'owner_settled_cash_recovery_release_disabled');
  assert.equal(checks,0);
  approved=true;
  for(const x of [{...body,ownerUserId:other},{...body,exchangeIndex:1},{...body,confirmation:'another-affirmation'},
   {...body,accountId:''},{...body,expectedRevision:12},{...body,settlementEventId:'not-a-settlement'},{...body,read:'injected'}])
   assert.equal((await send(x)).status,400);
  assert.equal((await send(body,'own-aal2','?ownerUserId='+other)).status,400);
  assert.equal(checks,0);
  assert.equal((await send(body)).out.reason,'owner_settled_cash_recovery_migration_not_ready');
  throwReadiness=true;
  assert.equal((await send(body)).out.reason,'owner_settled_cash_recovery_migration_not_ready');
  assert.equal(called.length,0);
  throwReadiness=false;readiness=true;
  assert.equal((await send(body,'other-aal2')).out.reason,'recovery_settled_cash_account_not_eligible');
  assert.equal(called[0]?.who,other);
  scheduled=true;
  const denied=await send(body);
  assert.equal(denied.status,409);assert.equal(denied.out.reason,'recovery_worker_must_be_stopped');
  assert.equal(denied.out.tradingAuthorized,false);assert.equal(denied.cache,'private, no-store');
  scheduled=false;
  const allowed=await send(body);
  assert.equal(allowed.status,200);assert.equal(allowed.out.riskFreezeCleared,true);
  assert.equal(allowed.out.tradingAuthorized,false);assert.equal(allowed.out.workerStarted,false);
  assert.deepEqual(called[2],{who:owner,value:{
   accountId:body.accountId,expectedRevision:body.expectedRevision,settlementEventId:body.settlementEventId,confirmation:body.confirmation,
  }});
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('real catalog requires both locked-down deferred constraints in disposable PostgreSQL',async()=>{
 const url=process.env.V13_DISPOSABLE_DATABASE_URL;
 assert.ok(url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url??''));
 const ready=async()=> (await pool.query(OWNER_SETTLED_CASH_RECOVERY_MIGRATION_READY_SQL)).rows[0]?.ready;
 try{
  assert.equal(await ready(),false);
  await pool.query(`CREATE SCHEMA IF NOT EXISTS private;
   DO $$BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
   END$$;`);
  await pool.query(readFileSync('../../sql/strata_owner_settled_cash_recovery_commit_fence.sql','utf8'));
  assert.equal(await ready(),true);
  await pool.query('ALTER TABLE public.v13_production_account DISABLE TRIGGER owner_settled_cash_recovery_transition_fence');
  assert.equal(await ready(),false);
  await pool.query('ALTER TABLE public.v13_production_account ENABLE ALWAYS TRIGGER owner_settled_cash_recovery_transition_fence');
  assert.equal(await ready(),true);
  await pool.query('GRANT EXECUTE ON FUNCTION private.enforce_owner_settled_cash_recovery_commit_fence() TO PUBLIC');
  assert.equal(await ready(),false);
 }finally{await pool.end();}
});

import express from 'express';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStrataAccess } from '../lib/strata/supabaseAuth';
import { fixture } from '../lib/entryBudgetChoice.fixture';
import { createWalletEntryBudgetPreviewRouter, WALLET_ENTRY_BUDGET_LADDER, WALLET_ENTRY_BUDGET_PATH } from './walletEntryBudgetPreviewRouter';

const owner='owner', foreign='other-owner';
const auth=createStrataAccess({verifyToken:async token=>{
  if(token!=='own-aal2'&&token!=='other-aal2') throw Error('invalid or not aal2');
  return {subject:token==='own-aal2'?owner:foreign,issuer:'fixture',audience:'authenticated',aal:'aal2'};
},roleOf:async()=> 'STANDARD'});

async function withServer(deployment:'isolated-staging'|'disabled', run:(get:
  (query?:string,token?:string,method?:string,intent?:string)=>Promise<Response>, calls:unknown[])=>Promise<void>, limited=false){
  const app=express(), calls:unknown[]=[];
  app.use(createWalletEntryBudgetPreviewRouter({deployment,requireOwnerAal2:auth.requireUser,
    async readApprovedChoice(subject,gross){
      calls.push([subject,gross]);
      // Hostile/incorrect cross-tenant resolver output is denied by the route too.
      const f=fixture(gross,Math.ceil(gross*1.25),50000,62500);
      return limited?{...f,preflight:{...f.preflight,availableCashCents:350,
        capitalRemainingCents:1600,openPositions:1,realizedDailyLossCents:799000,
        realizedTotalLossCents:898500}}:f;
    }}));
  const server=app.listen(0,'127.0.0.1');
  await new Promise<void>(r=>server.once('listening',r));
  try {
    const a=server.address();assert.ok(a&&typeof a==='object');
    await run((query='grossCents=10000',token='own-aal2',method='GET',intent='preview-entry-budget')=>
      fetch('http://127.0.0.1:'+a.port+WALLET_ENTRY_BUDGET_PATH+'?'+query,
        {method,headers:{Authorization:'Bearer '+token,'X-Strata-Read-Intent':intent}}),calls);
  } finally {await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
}

test('isolated authenticated Wallets GET returns all nine ladder previews, never authority or scope',async()=>{
  await withServer('isolated-staging',async(get,calls)=>{
    assert.deepEqual(WALLET_ENTRY_BUDGET_LADDER,[500,1500,2500,5000,10000,15000,20000,25000,50000]);
    for(const cents of WALLET_ENTRY_BUDGET_LADDER) {
      const r=await get('grossCents='+cents);
      assert.equal(r.status,200);
      assert.equal(r.headers.get('Cache-Control'),'private, no-store');
      const v=await r.json();assert.ok(v&&typeof v==="object");const body=v as Record<string,unknown>;
      assert.deepEqual(Object.keys(body).sort(),Object.keys({ok:true,readOnly:true,tradingAuthorized:false,
        grossCents:0,allInCents:0,funding:0,plan:0}).sort());
      assert.equal(body.grossCents,cents);
      assert.equal(body.tradingAuthorized,false);
    }
    assert.equal(calls.length,9);
  });
});

test('AAL2 authentication, owner-derived scope, safe method and parameters fail closed',async()=>{
  await withServer('isolated-staging',async(get,calls)=>{
    assert.equal((await get(undefined,'aal1')).status,401);
    assert.equal((await get(undefined,'own-aal2','POST')).status,405);
    assert.equal((await get('grossCents=10000&accountId=else')).status,400);
    assert.equal((await get('grossCents=10000&grossCents=20000')).status,400);
    assert.equal((await get('grossCents=50001')).status,400);
    assert.equal((await get(undefined,'own-aal2','GET','')).status,400);
    assert.deepEqual(calls,[]);
    const denied=await get(undefined,'other-aal2');
    assert.equal(denied.status,409);
    assert.deepEqual(await denied.json(),{ok:false,reason:'entry_budget_choice_not_available',
      readOnly:true,tradingAuthorized:false});
    assert.deepEqual(calls,[[foreign,10000]]);
  });
});

test('disabled deployment and explicit production environment do not auth or load any approval',async()=>{
  await withServer('disabled',async(get,calls)=>{
    assert.equal((await get()).status,404);
    assert.equal((await get(undefined,'invalid')).status,404);
    assert.deepEqual(calls,[]);
  });
  const previous=process.env.RAILWAY_ENVIRONMENT_NAME;
  try {
    process.env.RAILWAY_ENVIRONMENT_NAME='production';
    await withServer('isolated-staging',async(get,calls)=>{
      assert.equal((await get()).status,404);
      assert.deepEqual(calls,[]);
    });
  } finally {
    if(previous===undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
    else process.env.RAILWAY_ENVIRONMENT_NAME=previous;
  }
});

test('approved $15 rung still shows funding gaps when no current plan is possible',async()=>{
  await withServer('isolated-staging',async get=>{
    const r=await get('grossCents=1500');
    assert.equal(r.status,200);
    assert.deepEqual(await r.json(),{ok:true,readOnly:true,tradingAuthorized:false,
      grossCents:1500,allInCents:1875,plan:null,funding:{
        fullReservationCents:1875,policyCapitalLimitCents:1000000,
        policyDailyLossLimitCents:800000,policyTotalLossLimitCents:900000,
        realizedDailyLossCents:799000,realizedTotalLossCents:898500,
        policyDailyLossForFullReservationCents:800875,policyTotalLossForFullReservationCents:900375,
        policyCapitalForFullReservationCents:1000275,positionSlotAvailable:false,
        headroom:{unreservedCashCents:350,remainingCapitalCents:1600,
          remainingDailyLossCents:1000,remainingTotalLossCents:1500},
        shortfalls:{cashCents:1525,capitalCents:275,dailyLossCents:875,totalLossCents:375}
      }});
  },true);
});

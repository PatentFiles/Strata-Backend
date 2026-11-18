import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {pool} from '@workspace/db';
import {getScopedKalshiJson} from '../kalshiAccountClient';
import {BALANCE_IDENTITY_RESERVATION_SQL} from './kalshiBalanceQuota';
const creds={keyId:'balance-boundary-fixture',privateKey:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'}).toString()};
test('actual balance transport retains post-wait authoritative binding and post-wait abort checks',async()=>{
 const env={NODE_ENV:'production',STRATA_MEMBER_READ_BUDGET:'experimental_v1',STRATA_MEMBER_BUDGET_OWNER_ID:'11111111-1111-4111-8111-111111111111',STRATA_MEMBER_BUDGET_ACCOUNT_ID:'account',STRATA_MEMBER_BUDGET_CONNECTION_ID:'22222222-2222-4222-8222-222222222222'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])),originalQuery=pool.query,originalFetch=globalThis.fetch;
 Object.assign(process.env,env);
 try{for(const mode of ['valid','revoked-after-bucket','abort-during-wait'] as const){
  const calls:string[]=[];let sends=0;const abort=new AbortController();
  pool.query=(async(sql:string)=>{
   if(sql===BALANCE_IDENTITY_RESERVATION_SQL){calls.push('bucket');if(mode==='abort-during-wait')setTimeout(()=>abort.abort(Error('fixture-abort')),1);return {rows:[{wait_ms:10}]};}
   assert.match(sql,/strata_reserve_member_read_token/);calls.push('binding');
   return {rows:[{binding_verified:mode==='valid',admitted:mode==='valid'}]};
  }) as typeof pool.query;
  globalThis.fetch=(async()=>{sends++;calls.push('fetch');return new Response('{}',{headers:{'content-type':'application/json'}});}) as typeof fetch;
  const read=()=>getScopedKalshiJson(creds,'/trade-api/v2/portfolio/balance','?subaccount=1&exchange_index=2',globalThis.fetch,'https://external-api.kalshi.com',undefined,abort.signal);
  if(mode==='valid'){await read();assert.deepEqual(calls,['bucket','binding','fetch']);assert.equal(sends,1);}
  else {await assert.rejects(read);assert.equal(sends,0);assert.deepEqual(calls,mode==='abort-during-wait'?['bucket']:['bucket','binding']);}
 }}finally{pool.query=originalQuery;globalThis.fetch=originalFetch;for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});

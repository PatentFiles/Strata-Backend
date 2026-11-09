import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {getOwnedProductionKalshiJson,readOwnedKalshiFeeds} from './personalExchangeRead';
import {getScopedKalshiJson} from '../kalshiAccountClient';
const material={keyId:'ephemeral-owned-host-test',privateKey:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString()};
const response=(url:string)=>new Response(JSON.stringify(url.includes('/balance')?
 {balance_dollars:'25.0000',subaccount:1,exchange_index:2}:{orders:[],fills:[],market_positions:[],settlements:[],cursor:''}),{status:200});
for(const environment of [undefined,'demo','production'])test(`all default owned feeds pin production with environment ${environment??'absent'}`,async()=>{
 const oldEnv=process.env.KALSHI_API_ENVIRONMENT,oldFetch=globalThis.fetch,urls:string[]=[];
 if(environment===undefined)delete process.env.KALSHI_API_ENVIRONMENT;else process.env.KALSHI_API_ENVIRONMENT=environment;
 globalThis.fetch=async(input)=>{const url=String(input);urls.push(url);return response(url);};
 try{
  const result=await readOwnedKalshiFeeds(material,Date.now());assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(urls.length,7);assert(urls.every(u=>new URL(u).origin==='https://external-api.kalshi.com'));
 }finally{globalThis.fetch=oldFetch;if(oldEnv===undefined)delete process.env.KALSHI_API_ENVIRONMENT;else process.env.KALSHI_API_ENVIRONMENT=oldEnv;}
});
test('generic client retains demo and explicit owned reader injection is preserved',async()=>{
 const old=process.env.KALSHI_API_ENVIRONMENT;process.env.KALSHI_API_ENVIRONMENT='demo';let url='';
 try{
  await getScopedKalshiJson(material,'/trade-api/v2/portfolio/orders','',async input=>{url=String(input);return response(url);});
  assert.equal(new URL(url).origin,'https://external-api.demo.kalshi.co');
  let reads=0;const result=await readOwnedKalshiFeeds(material,Date.now(),async(_c,path)=>{reads++;return JSON.parse(await response(path).text());});
  assert.equal(result.ok,true);assert.equal(reads,7);
 }finally{if(old===undefined)delete process.env.KALSHI_API_ENVIRONMENT;else process.env.KALSHI_API_ENVIRONMENT=old;}
});
test('owned wrapper preserves original transport and abort signal; ignores generic host override',async()=>{
 const c=new AbortController();let calls=0;
 const transport:typeof fetch=async(input,init)=>{calls++;assert.equal(new URL(String(input)).origin,'https://external-api.kalshi.com');assert.equal(init?.signal,c.signal);return response(String(input));};
 await getOwnedProductionKalshiJson(material,'/trade-api/v2/portfolio/orders','',transport,'https://external-api.demo.kalshi.co','owner-quota',c.signal);
 assert.equal(calls,1);c.abort();await assert.rejects(getOwnedProductionKalshiJson(material,'/trade-api/v2/portfolio/orders','',transport,undefined,'owner-quota',c.signal));assert.equal(calls,1);
 const source=readFileSync('src/lib/strata/personalExchangeRead.ts','utf8');
 assert.match(source,/getScopedKalshiJson\(creds,path,query,fetchImpl,PERSONAL_KALSHI_HOST,rateLimitOwnerId,externalSignal\)/);
});

test('owned production balance read preserves original quota-owner gate before transport',async()=>{
 const oldEnv=process.env.NODE_ENV,oldFetch=globalThis.fetch;let calls=0;
 process.env.NODE_ENV='production';globalThis.fetch=async input=>{calls++;return response(String(input));};
 try{
  await assert.rejects(getOwnedProductionKalshiJson(material,'/trade-api/v2/portfolio/balance','',globalThis.fetch,undefined,'invalid-owner'),/kalshi_balance_owner_invalid/);
  assert.equal(calls,0);
 }finally{globalThis.fetch=oldFetch;if(oldEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldEnv;}
});

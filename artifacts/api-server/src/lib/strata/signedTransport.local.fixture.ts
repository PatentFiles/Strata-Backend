import assert from 'node:assert/strict';
import {generateKeyPairSync,verify,constants} from 'node:crypto';
import {readOwnedKalshiFeeds} from './personalExchangeRead';
import {getScopedKalshiJson} from '../kalshiAccountClient';
export async function signedTransportFixture(pass:(s:string)=>void){
 const pair=generateKeyPairSync('rsa',{modulusLength:2048});
 const creds={keyId:'synthetic-local-rsa',privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
 type Reply=(u:URL,n:number)=>Response;
 const good=(u:URL)=>Response.json(u.pathname.endsWith('/balance')?{balance_dollars:'1.0000',subaccount:1,exchange_index:2}:{[u.pathname.endsWith('/positions')?'market_positions':u.pathname.split('/').at(-1)!]:[],cursor:''});
 async function scan(reply:Reply=good){
  const seen:URL[]=[];
  const fake:typeof fetch=async(input,init)=>{
   const u=new URL(String(input));assert.equal(u.origin,'https://external-api.kalshi.com');assert.equal(init?.method,'GET');assert.equal(init?.redirect,'manual');assert.equal(init?.cache,'no-store');assert.equal(init?.body,undefined);
   assert.equal(u.searchParams.get('subaccount'),'1');assert.equal(u.searchParams.get('exchange_index'),'2');
   const h=new Headers(init?.headers);assert.equal(h.get('KALSHI-ACCESS-KEY'),creds.keyId);
   assert.ok(verify('sha256',Buffer.from(h.get('KALSHI-ACCESS-TIMESTAMP')+'GET'+u.pathname),{key:pair.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(h.get('KALSHI-ACCESS-SIGNATURE')!,'base64')));
   if(!u.pathname.endsWith('/balance'))assert.equal(u.searchParams.get('limit'),'200');
   if(u.pathname.endsWith('/positions')){assert.equal(u.searchParams.get('settlement_status'),'all');assert.equal(u.searchParams.get('count_filter'),'position,total_traded');}
   seen.push(u);return reply(u,seen.length);
  };
  const result=await readOwnedKalshiFeeds(creds,Date.now(),(c,p,q)=>getScopedKalshiJson(c,p,q,fake,'https://external-api.kalshi.com'));
  return {result,seen};
 }
 let r=await scan();assert.ok(r.result.ok);assert.equal(r.seen.length,7);pass('actual RSA-PSS signer and seven scoped GET feeds verified by synthetic transport; no order methods');
 r=await scan(u=>u.pathname==='/trade-api/v2/portfolio/orders'&&!u.searchParams.has('cursor')?Response.json({orders:[],cursor:'next / +'}):good(u));assert.ok(r.result.ok);assert.equal(r.seen[2].searchParams.get('cursor'),'next / +');pass('original pagination follows encoded cursor with signed path excluding query');
 for(const cursor of ['repeat',123]){r=await scan(u=>u.pathname.endsWith('/orders')?Response.json({orders:[],cursor}):good(u));assert.equal(r.result.ok,false);assert.ok(r.seen.length<=3);}pass('repeated and non-string cursors fail closed before remaining feeds');
 let pages=0;r=await scan(u=>u.pathname.endsWith('/orders')?Response.json({orders:[],cursor:'page'+(++pages)}):good(u));assert.equal(r.result.ok,false);assert.equal(pages,20);assert.equal(r.seen.length,21);pass('twenty-page exhaustion fails closed with bounded GET count');
 for(const status of [401,403,429,500,302]){r=await scan(()=>new Response('',{status}));assert.equal(r.result.ok,false);assert.equal(r.seen.length,1);}pass('authentication permission rate-limit server and redirect responses stop scan without retry');
 r=await scan(()=>{throw Error('synthetic-sensitive-message');});assert.equal(r.result.ok,false);assert.equal(r.seen.length,1);assert.ok(!JSON.stringify(r.result).includes('synthetic-sensitive'));pass('transport exception sanitized and stops without retry');
 r=await scan(u=>u.pathname.includes('/historical/')?new Response('',{status:404}):good(u));assert.ok(r.result.ok);if(r.result.ok)assert.equal(r.result.historicalCoverageComplete,false);pass('archival first-page 404 remains explicit incomplete coverage, not full flatness proof');
 r=await scan(u=>u.pathname.endsWith('/balance')?Response.json({balance_dollars:'1.0000',subaccount:2,exchange_index:2}):good(u));assert.equal(r.result.ok,false);assert.equal(r.seen.length,1);pass('balance scope mismatch blocks further reads');
 r=await scan(u=>u.pathname.endsWith('/positions')?Response.json({market_positions:[{subaccount:1,exchange_index:3}],cursor:''}):good(u));assert.equal(r.result.ok,false);pass('row scope mismatch fails original complete-feed validation');
 const row={order_id:'synthetic-order',status:'canceled',subaccount:1,exchange_index:2};
 r=await scan(u=>u.pathname.endsWith('/orders')?Response.json({orders:[{...row,...(u.pathname.includes('/historical/')?{status:'executed'}:{})}],cursor:''}):good(u));assert.equal(r.result.ok,false);pass('contradictory current and archival order identity fails reconciliation input');
 let calls=0;const noFetch:typeof fetch=async()=>{calls++;throw Error('unexpected');};
 await assert.rejects(getScopedKalshiJson(creds,'/trade-api/v2/portfolio/events/orders','',noFetch));
 await assert.rejects(getScopedKalshiJson(creds,'/trade-api/v2/portfolio/orders','',noFetch,'http://127.0.0.1'));
 const abort=new AbortController();abort.abort();await assert.rejects(getScopedKalshiJson(creds,'/trade-api/v2/portfolio/orders','',noFetch,'https://external-api.kalshi.com',undefined,abort.signal));
 assert.equal(calls,0);pass('disallowed path host and pre-aborted request never reach transport');
}

// One generated signer is provisioned into the synthetic Vault and then loaded
// unchanged by the original collector; this factory never substitutes material.
export function createJoinedSigner(cashDollars='1.0000'){
 const pair=generateKeyPairSync('rsa',{modulusLength:2048});
 const material={keyId:'synthetic-joined-rsa',privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
 let mode='ok',calls=0;
 return {material,setCashDollars:(v:string)=>{cashDollars=v;},setMode:(m:string)=>{mode=m;},get calls(){return calls;},
  transferGet:(rows:unknown[],cursor='',omitTerminalCursor=false)=>async(loaded:typeof material,path:string,query='')=>{
   assert.deepEqual(loaded,material);assert.equal(path,'/trade-api/v2/portfolio/subaccounts/transfers');
   return getScopedKalshiJson(loaded,path,query,async(input,init)=>{
    calls++;const u=new URL(String(input)),h=new Headers(init?.headers);
    assert.equal(u.origin,'https://external-api.kalshi.com');assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);
    assert.ok(verify('sha256',Buffer.from(h.get('KALSHI-ACCESS-TIMESTAMP')+'GET'+u.pathname),{key:pair.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(h.get('KALSHI-ACCESS-SIGNATURE')!,'base64')));
    return Response.json({transfers:rows,...(omitTerminalCursor?{}:{cursor})});
   },'https://external-api.kalshi.com');
  },
  cashGet:async(loaded:typeof material,path:string,query='')=>{
   assert.deepEqual(loaded,material);assert.equal(path,'/trade-api/v2/portfolio/balance');
   assert.ok(query===''||query==='?subaccount=1&exchange_index=2');
   return getScopedKalshiJson(loaded,path,query,async(input,init)=>{
    calls++;const u=new URL(String(input)),h=new Headers(init?.headers);
    assert.equal(u.origin,'https://external-api.kalshi.com');assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);
    assert.ok(verify('sha256',Buffer.from(h.get('KALSHI-ACCESS-TIMESTAMP')+'GET'+u.pathname),{key:pair.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(h.get('KALSHI-ACCESS-SIGNATURE')!,'base64')));
    return Response.json(query?{balance_dollars:cashDollars,subaccount:1,exchange_index:2}:{balance_dollars:'999.0000'});
   },'https://external-api.kalshi.com');
  },
  read:async(loaded:typeof material,now:number,orders:unknown[],complete:boolean,entered?:()=>void,gate?:Promise<void>,externalSignal?:AbortSignal,fills:unknown[]=[],settlements:unknown[]=[])=>{
   assert.ok(loaded.keyId===material.keyId&&loaded.privateKey===material.privateKey,'loaded synthetic signer must remain exact');
   let paused=false;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   const fake:typeof fetch=async(input,init)=>{
    calls++;const u=new URL(String(input)),h=new Headers(init?.headers);
    assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);assert.equal(init?.redirect,'manual');assert.equal(u.origin,'https://external-api.kalshi.com');
    assert.equal(u.searchParams.get('subaccount'),'1');assert.equal(u.searchParams.get('exchange_index'),'2');
    assert.ok(verify('sha256',Buffer.from(h.get('KALSHI-ACCESS-TIMESTAMP')+'GET'+u.pathname),{key:pair.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(h.get('KALSHI-ACCESS-SIGNATURE')!,'base64')));
    if(gate&&!paused&&u.pathname==='/trade-api/v2/portfolio/orders'){paused=true;entered?.();await gate;}
    if((mode==='cancel'||mode==='deadline')&&u.pathname==='/trade-api/v2/portfolio/orders')return new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});if(mode==='cancel')timer=setTimeout(()=>abort.abort(),30);});
    if(mode==='timeout')throw new DOMException('synthetic timeout','TimeoutError');
    if(u.pathname.endsWith('/balance'))return Response.json({balance_dollars:cashDollars,subaccount:1,exchange_index:2});
    if(!complete&&u.pathname.includes('/historical/'))return new Response('',{status:404});
    const key=u.pathname.endsWith('/positions')?'market_positions':u.pathname.split('/').at(-1)!;
    if(mode==='partial'&&key==='positions')return Response.json({wrong:[]});
    if(mode==='partial'&&key==='market_positions')return Response.json({wrong:[]});
    if(mode==='cursor'&&key==='orders')return Response.json({orders:[],cursor:'loop'});
    if(u.pathname==='/trade-api/v2/portfolio/orders')return Response.json({orders:u.searchParams.has('cursor')?orders:[],cursor:u.searchParams.has('cursor')?'':'second-page'});
    return Response.json({[key]:key==='fills'&&!u.pathname.includes('/historical/')?fills:key==='settlements'?settlements:[],cursor:''});
   };
   try{return await readOwnedKalshiFeeds(loaded,now,(c,p,q)=>getScopedKalshiJson(c,p,q,fake,'https://external-api.kalshi.com',undefined,externalSignal??abort.signal));}finally{if(timer)clearTimeout(timer);}
  }};
}

export async function cancellationQuotaFixture(db:any,owner:string,pass:(s:string)=>void){
 const {reserveKalshiBalanceReadSlot}=await import('./kalshiBalanceQuota');
 const key=generateKeyPairSync('rsa',{modulusLength:2048});const material={keyId:'synthetic-cancellation',privateKey:key.privateKey.export({format:'pem',type:'pkcs8'}).toString()};
 let started=false,aborted=false;const controller=new AbortController();
 const waiting:typeof fetch=async(_input,init)=>{started=true;return new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>{aborted=true;reject(new DOMException('cancelled','AbortError'));},{once:true});});};
 const pending=getScopedKalshiJson(material,'/trade-api/v2/portfolio/orders','',waiting,'https://external-api.kalshi.com',undefined,controller.signal);
 const timer=setTimeout(()=>controller.abort(),30);try{await assert.rejects(pending);}finally{clearTimeout(timer);}
 assert.ok(started&&aborted);pass('real pending synthetic transport receives abort event and signed GET fails without retry');
 const start=Date.now();await Promise.all([reserveKalshiBalanceReadSlot(material.keyId,owner,db.query.bind(db)),reserveKalshiBalanceReadSlot(material.keyId,owner,db.query.bind(db))]);
 assert.ok(Date.now()-start>=1100);pass('actual PostgreSQL quota reservations serialize concurrent balance slots with 1.2 second spacing');
 const oldFetch=globalThis.fetch,oldEnv=process.env.NODE_ENV;let sent=0;const fake:typeof fetch=async()=>{sent++;return Response.json({balance_dollars:'1'});};
 const stop=new AbortController();globalThis.fetch=fake;process.env.NODE_ENV='production';
 const waitStart=Date.now();const t=setTimeout(()=>stop.abort(),30);try{
  await assert.rejects(getScopedKalshiJson(material,'/trade-api/v2/portfolio/balance','',fake,'https://external-api.kalshi.com',owner,stop.signal));
  assert.equal(sent,0);assert.ok(Date.now()-waitStart<600,'quota cancellation must not wait for reserved slot');
 }finally{clearTimeout(t);globalThis.fetch=oldFetch;if(oldEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldEnv;}
 pass('actual quota-wait branch rechecks cancellation before signing or fetching; reserved slot retained');
}

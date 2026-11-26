import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {generateKeyPairSync,constants,verify} from 'node:crypto';import {getScopedKalshiJson} from '../kalshiAccountClient';import {dedicatedSignerFingerprint} from './commissioning';
import {readOwnedKalshiFeeds} from './personalExchangeRead';
import {pool} from '@workspace/db';import {reserveMemberRead,withMemberHistoryCredits,dispatchMemberRead,MEMBER_READ_BINDING_SQL} from './kalshiMemberReadBudget';
const owner='11111111-1111-1111-1111-111111111111',connection='22222222-2222-2222-2222-222222222222',fin='33333333-3333-3333-3333-333333333333';
test('shared member admission: cold start, roles, replicas, scope, no refunds and lock serialization',async()=>{
 assert.match(process.env.DATABASE_URL??'',/@(?:127\.0\.0\.1|localhost):/);
 await pool.query(`CREATE SCHEMA IF NOT EXISTS private;
 DROP TABLE IF EXISTS public.v13_production_account, public.financial_accounts, private.provider_connections, private.kalshi_connection_credentials CASCADE;
 CREATE TABLE public.v13_production_account(id text,owner_user_id uuid,kalshi_connection_id uuid,subaccount integer,exchange_index integer,key_fingerprint text);
 CREATE TABLE public.financial_accounts(id uuid,user_id uuid,provider text);
 CREATE TABLE private.provider_connections(id uuid,financial_account_id uuid);
 CREATE TABLE private.kalshi_connection_credentials(id text,financial_account_id uuid,owner_user_id uuid,provider_connection_id uuid,key_fingerprint text,revoked_at timestamptz,verified_at timestamptz,verification_reason text,role text);
 INSERT INTO public.v13_production_account VALUES('test-account','${owner}','${fin}',1,2);
 INSERT INTO public.financial_accounts VALUES('${fin}','${owner}','kalshi');
 INSERT INTO private.provider_connections VALUES('${connection}','${fin}');
 INSERT INTO private.kalshi_connection_credentials VALUES('one','${fin}','${owner}','${connection}','${'a'.repeat(64)}',NULL,now(),'credential_verified','restricted_execution'),('two','${fin}','${owner}','${connection}','${'b'.repeat(64)}',NULL,now(),'credential_verified','account_setup_execution');`);
 await pool.query(readFileSync('../../docs/member-read-budget/schema.sql','utf8'));
 process.env.STRATA_MEMBER_READ_BUDGET='experimental_v1';process.env.STRATA_MEMBER_BUDGET_OWNER_ID=owner;process.env.STRATA_MEMBER_BUDGET_ACCOUNT_ID='test-account';process.env.STRATA_MEMBER_BUDGET_CONNECTION_ID=connection;
 const path='/trade-api/v2/portfolio/fills';
 await reserveMemberRead(path,'a'.repeat(64)); // Cold local wait/recheck, one successful debit.
 await pool.query("UPDATE private.strata_member_read_budget SET tokens=20,measured_at=clock_timestamp()+interval '1 hour'");
 const outcomes=await Promise.allSettled(Array.from({length:12},(_,i)=>reserveMemberRead(path,(i%2?'a':'b').repeat(64))));
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,2);assert.equal(Number((await pool.query('SELECT tokens FROM private.strata_member_read_budget')).rows[0].tokens),0);
 await pool.query("UPDATE private.strata_member_read_budget SET tokens=20,measured_at=clock_timestamp()+interval '1 hour'");
 await assert.rejects(reserveMemberRead(path,'c'.repeat(64)),/unavailable/);
 await pool.query("UPDATE private.kalshi_connection_credentials SET revoked_at=now() WHERE id='one'");
 await assert.rejects(reserveMemberRead(path,'a'.repeat(64)),/unavailable/);
 await reserveMemberRead(path,'b'.repeat(64));
 const controller=new AbortController();await assert.rejects(reserveMemberRead(path,'b'.repeat(64),async(sql,args)=>{const r=await pool.query(sql,args);controller.abort();return r;},controller.signal));
 assert.equal(Number((await pool.query('SELECT tokens FROM private.strata_member_read_budget')).rows[0].tokens),0);
 await pool.query("UPDATE private.strata_member_read_budget SET tokens=0,measured_at=clock_timestamp()-interval '10 seconds'");
 await reserveMemberRead(path,'b'.repeat(64));assert.equal(Number((await pool.query('SELECT tokens FROM private.strata_member_read_budget')).rows[0].tokens),740);
 const rollback=await pool.connect();await rollback.query('BEGIN');
 await reserveMemberRead(path,'b'.repeat(64));await rollback.query('ROLLBACK');rollback.release();
 assert.ok(Number((await pool.query('SELECT tokens FROM private.strata_member_read_budget')).rows[0].tokens)<740,'autocommit debit survives caller rollback');
 const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT * FROM private.strata_member_read_budget FOR UPDATE');
 const lockStart=Date.now();
 try{await assert.rejects(reserveMemberRead(path,'b'.repeat(64)),(e:any)=>e.code==='55P03');assert.ok(Date.now()-lockStart<1000,'production default pool bounded by function lock_timeout');}finally{await blocker.query('ROLLBACK');blocker.release();}
 for(const role of ['verification','provisioning']){
 await pool.query("UPDATE private.kalshi_connection_credentials SET role=$1 WHERE id='two'",[role]);await reserveMemberRead(path,'b'.repeat(64));}
 await pool.query("UPDATE private.kalshi_connection_credentials SET role='account_setup_execution' WHERE id='two'");
 await pool.query("INSERT INTO private.kalshi_connection_credentials SELECT 'duplicate',financial_account_id,owner_user_id,provider_connection_id,key_fingerprint,revoked_at,verified_at,verification_reason,role FROM private.kalshi_connection_credentials WHERE id='two'");
 await assert.rejects(reserveMemberRead(path,'b'.repeat(64)),/unavailable/);await pool.query("DELETE FROM private.kalshi_connection_credentials WHERE id='duplicate'");
 const pair=generateKeyPairSync('rsa',{modulusLength:2048});const creds={keyId:'synthetic-member-budget',privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
 await pool.query("UPDATE private.kalshi_connection_credentials SET key_fingerprint=$1 WHERE id='two'",[dedicatedSignerFingerprint(creds.keyId,creds.privateKey)]);
 await pool.query('TRUNCATE private.strata_member_read_budget');
 let providerCalls=0;const fake:typeof fetch=async()=>{providerCalls++;return new Response(JSON.stringify({fills:[],cursor:''}),{status:200});};
 await getScopedKalshiJson(creds,path,'',fake,'https://external-api.kalshi.com');assert.equal(providerCalls,1,'cold admission performs exactly one provider request');
 await assert.rejects(getScopedKalshiJson(creds,path,'',fake,'https://external-api.demo.kalshi.co'),/host_unverified/);assert.equal(providerCalls,1);
 await pool.query("UPDATE private.strata_member_read_budget SET tokens=0,measured_at=clock_timestamp()+interval '1 hour'");
 await assert.rejects(getScopedKalshiJson(creds,path,'',fake,'https://external-api.kalshi.com'),/unavailable/);assert.equal(providerCalls,1);
 await pool.query("UPDATE private.strata_member_read_budget SET tokens=100,measured_at=clock_timestamp()+interval '1 hour'");
 let limitedCalls=0;const limited:typeof fetch=async()=>{limitedCalls++;return new Response('{}',{status:429});};
 await assert.rejects(getScopedKalshiJson(creds,path,'',limited,'https://external-api.kalshi.com'),(e:any)=>e.status===429);assert.equal(limitedCalls,1);assert.equal(Number((await pool.query('SELECT tokens FROM private.strata_member_read_budget')).rows[0].tokens),90,'429 committed debit is never refunded');
 const originalObservation=1795000000000;
 for(let repeat=0;repeat<20;repeat++){
  await pool.query('TRUNCATE private.strata_member_read_budget');
  const scanPaths:string[]=[];const admissionFailures:string[]=[];
  const feedFetch:typeof fetch=async(url)=>{const p=new URL(String(url)).pathname;scanPaths.push(p);const payload=p.endsWith('/balance')?{subaccount:1,exchange_index:2,balance_dollars:'25.0000'}:{[p.endsWith('/positions')?'market_positions':p.split('/').at(-1)!]:[]};return new Response(JSON.stringify(payload),{status:200});};
  const scan=await readOwnedKalshiFeeds(creds,originalObservation,async(c,p,q,_f,_h,o,signal)=>{try{return await getScopedKalshiJson(c,p,q,feedFetch,'https://external-api.kalshi.com',o,signal);}catch(e){admissionFailures.push(p+':'+(e as Error).message);throw e;}},{mode:'bounded_history_reads_v1'});
  assert.equal(scan.ok,true,JSON.stringify({repeat,scan,scanPaths,admissionFailures}));if(scan.ok){assert.equal(scan.observedAtMs,originalObservation);assert.equal(scan.historicalCoverageComplete,true);}
  assert.equal(scanPaths.length,7);assert.equal(new Set(scanPaths).size,7);assert.ok(scanPaths[0].endsWith('/balance'));
 }
 // Later pagination is independently debited, never spends a second first-page credit.
 await pool.query("UPDATE private.strata_member_read_budget SET tokens=750,measured_at=clock_timestamp()+interval '1 hour'");
 let pagedCalls=0;const pagedFetch:typeof fetch=async(url)=>{pagedCalls++;const u=new URL(String(url)),p=u.pathname;
 const payload=p.endsWith('/balance')?{subaccount:1,exchange_index:2,balance_dollars:'25.0000'}:{[p.endsWith('/positions')?'market_positions':p.split('/').at(-1)!]:[],...(p==='/trade-api/v2/portfolio/orders'&&!u.searchParams.has('cursor')?{cursor:'next'}:{})};
 return new Response(JSON.stringify(payload),{status:200});};
 const paged=await readOwnedKalshiFeeds(creds,originalObservation,(c,p,q,_f,_h,o,signal)=>getScopedKalshiJson(c,p,q,pagedFetch,'https://external-api.kalshi.com',o,signal),{mode:'bounded_history_reads_v1'});
 assert.equal(paged.ok,true);assert.equal(pagedCalls,8);assert.equal(Number((await pool.query('SELECT tokens FROM private.strata_member_read_budget')).rows[0].tokens),680);
 // Successful debit with lost acknowledgement never grants tickets or refunds.
 let escapedBatch=0;await assert.rejects(withMemberHistoryCredits(dedicatedSignerFingerprint(creds.keyId,creds.privateKey),new AbortController().signal,async()=>{escapedBatch++;},async(sql,args)=>{await pool.query(sql,args);throw Error('lost_successful_ack');}),/lost_successful_ack/);
 assert.equal(escapedBatch,0);assert.equal(Number((await pool.query('SELECT tokens FROM private.strata_member_read_budget')).rows[0].tokens),620);
 // Two already-sent slow pages drain; remaining credits expire without fallback GETs.
 await pool.query("UPDATE private.strata_member_read_budget SET tokens=750,measured_at=clock_timestamp()+interval '1 hour'");
 let slowCalls=0,active=0;const slowFetch:typeof fetch=async(url)=>{slowCalls++;const p=new URL(String(url)).pathname;
 if(!p.endsWith('/balance')){active++;await new Promise(r=>setTimeout(r,530));active--;}
 return new Response(JSON.stringify(p.endsWith('/balance')?{subaccount:1,exchange_index:2,balance_dollars:'25.0000'}:{[p.split('/').at(-1)!]:[]}),{status:200});};
 const slow=await readOwnedKalshiFeeds(creds,originalObservation,async(c,p,q,_f,_h,o,signal)=>{if(p.endsWith('/settlements'))await new Promise(r=>setTimeout(r,530));return getScopedKalshiJson(c,p,q,slowFetch,'https://external-api.kalshi.com',o,signal);},{mode:'bounded_history_reads_v1'});
 assert.equal(slow.ok,false);assert.equal(slowCalls,6);assert.equal(active,0);
 for(const canceled of [false,true]){
  await pool.query("UPDATE private.strata_member_read_budget SET tokens=0,measured_at=clock_timestamp()+interval '1 hour'");
  const controller=new AbortController();let reads=0;
  const feedFetch:typeof fetch=async()=>{reads++;if(canceled)setTimeout(()=>controller.abort(Error('original_source_deadline')),5);return new Response(JSON.stringify({subaccount:1,exchange_index:2,balance_dollars:'25.0000'}),{status:200});};
  const scan=await readOwnedKalshiFeeds(creds,originalObservation,(c,p,q,_f,_h,o,signal)=>getScopedKalshiJson(c,p,q,feedFetch,'https://external-api.kalshi.com',o,signal),{mode:'bounded_history_reads_v1',signal:controller.signal});
  assert.equal(scan.ok,false);assert.equal(reads,1,'only balance sent; no history send after exhausted/canceled admission');
 }
 const pair2=generateKeyPairSync('rsa',{modulusLength:2048});const creds2={keyId:'synthetic-second-member-role',privateKey:pair2.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
 await pool.query("UPDATE private.kalshi_connection_credentials SET revoked_at=NULL,key_fingerprint=$1 WHERE id='one'",[dedicatedSignerFingerprint(creds2.keyId,creds2.privateKey)]);
 for(const same of [true,false]){
  await pool.query("UPDATE private.strata_member_read_budget SET tokens=750,measured_at=clock_timestamp()+interval '1 hour'");
  const seen=[0,0];let concurrent=0,peak=0;
  const scans=[creds,same?creds:creds2].map((material,index)=>{
   const fetcher:typeof fetch=async(url)=>{seen[index]++;peak=Math.max(peak,++concurrent);await new Promise(r=>setImmediate(r));concurrent--;const p=new URL(String(url)).pathname;
    return new Response(JSON.stringify(p.endsWith('/balance')?{subaccount:1,exchange_index:2,balance_dollars:'25.0000'}:{[p.endsWith('/positions')?'market_positions':p.split('/').at(-1)!]:[]}),{status:200});};
   return readOwnedKalshiFeeds(material,originalObservation,(c,p,q,_f,_h,o,signal)=>getScopedKalshiJson(c,p,q,fetcher,'https://external-api.kalshi.com',o,signal),{mode:'bounded_history_reads_v1'});
  });
  assert.ok((await Promise.all(scans)).every(scan=>scan.ok),'overlapping snapshot credits retain their own invocation');assert.deepEqual(seen,[7,7]);assert.ok(peak<=6);assert.equal(concurrent,0);
  assert.equal(Number((await pool.query('SELECT tokens FROM private.strata_member_read_budget')).rows[0].tokens),630);
 }
 const realFingerprint=dedicatedSignerFingerprint(creds.keyId,creds.privateKey)!;
 const request={host:'https://external-api.kalshi.com',query:'?limit=200&subaccount=1&exchange_index=2'};
 const warm=()=>pool.query("UPDATE private.strata_member_read_budget SET tokens=750,measured_at=clock_timestamp()+interval '1 hour'");
 let hybridSends=0;
 await warm();await withMemberHistoryCredits(realFingerprint,new AbortController().signal,async()=>{
  await pool.query("UPDATE private.kalshi_connection_credentials SET revoked_at=now() WHERE id='two'");
  await assert.rejects(reserveMemberRead(path,realFingerprint,undefined,undefined,request),/scope_unverified/);
 });
 assert.equal(hybridSends,0);assert.equal(Number((await pool.query('SELECT tokens FROM private.strata_member_read_budget')).rows[0].tokens),690);
 await pool.query("UPDATE private.kalshi_connection_credentials SET revoked_at=NULL WHERE id='two'");
 await warm();await withMemberHistoryCredits(realFingerprint,new AbortController().signal,async()=>{
  const first=await reserveMemberRead(path,realFingerprint,undefined,undefined,request);dispatchMemberRead(first,()=>hybridSends++);
  await pool.query("UPDATE private.kalshi_connection_credentials SET revoked_at=now() WHERE id='two'");
  await assert.rejects(reserveMemberRead('/trade-api/v2/historical/fills',realFingerprint,undefined,undefined,request),/scope_unverified/);
 });assert.equal(hybridSends,1);
 await pool.query("UPDATE private.kalshi_connection_credentials SET revoked_at=NULL WHERE id='two'");
 await warm();await withMemberHistoryCredits(realFingerprint,new AbortController().signal,async()=>{
  await pool.query("UPDATE private.kalshi_connection_credentials SET role='verification' WHERE id='two'");
  await assert.rejects(reserveMemberRead(path,realFingerprint,undefined,undefined,request),/scope_unverified/);
 });await pool.query("UPDATE private.kalshi_connection_credentials SET role='account_setup_execution' WHERE id='two'");
 await warm();await withMemberHistoryCredits(realFingerprint,new AbortController().signal,async()=>{
  let release!:()=>void;const waiting=new Promise<void>(r=>release=r);let started!:()=>void;const hasStarted=new Promise<void>(r=>started=r);
  const attempt=reserveMemberRead(path,realFingerprint,async(sql,args)=>{started();await waiting;return pool.query(sql,args);},undefined,request);
  await hasStarted;await pool.query("UPDATE private.kalshi_connection_credentials SET revoked_at=now() WHERE id='two'");release();
  await assert.rejects(attempt,/scope_unverified/);
 });await pool.query("UPDATE private.kalshi_connection_credentials SET revoked_at=NULL WHERE id='two'");
 await warm();await withMemberHistoryCredits(realFingerprint,new AbortController().signal,async()=>{
  process.env.STRATA_MEMBER_BUDGET_ACCOUNT_ID='different-account';
  try{await assert.rejects(reserveMemberRead(path,realFingerprint,undefined,undefined,request),/credit_scope/);}finally{process.env.STRATA_MEMBER_BUDGET_ACCOUNT_ID='test-account';}
 });
 await warm();await withMemberHistoryCredits(realFingerprint,new AbortController().signal,async()=>{
  const late=await reserveMemberRead(path,realFingerprint,async(sql,args)=>{const r=await pool.query(sql,args);await new Promise(r=>setTimeout(r,530));return r;},undefined,request);
  assert.throws(()=>dispatchMemberRead(late,()=>hybridSends++),/ticket_expired/);
 });assert.equal(hybridSends,1,'fresh validation never resets original quota-ticket clock');
 await warm();await withMemberHistoryCredits(realFingerprint,new AbortController().signal,async()=>{
  await assert.rejects(reserveMemberRead(path,realFingerprint,async(sql,args)=>{await pool.query(sql,args);throw Error('lost_binding_ack');},undefined,request),/lost_binding_ack/);
  await assert.rejects(reserveMemberRead(path,realFingerprint,undefined,undefined,request),/credit_reused/);
 });assert.equal(hybridSends,1);
 for(const duringBinding of [false,true]){
  await warm();await withMemberHistoryCredits(realFingerprint,new AbortController().signal,async()=>{
   const originalQuery=pool.query.bind(pool);let sends=0;
   if(duringBinding)(pool as any).query=async(sql:any,args:any)=>{const result=await originalQuery(sql,args);if(sql===MEMBER_READ_BINDING_SQL)process.env.STRATA_MEMBER_READ_BUDGET='off';return result;};
   else process.env.STRATA_MEMBER_READ_BUDGET='off';
   try{await assert.rejects(getScopedKalshiJson(creds,path,request.query,async()=>{sends++;return new Response('{}');},'https://external-api.kalshi.com'));assert.equal(sends,0,'mode drift cannot turn prepaid client call into unmetered send');}
   finally{(pool as any).query=originalQuery;process.env.STRATA_MEMBER_READ_BUDGET='experimental_v1';}
  });
 }
 delete process.env.STRATA_MEMBER_READ_BUDGET;
});
test('public owners spend the same budget with their own current verified credentials, not the pilot tuple',async()=>{
 const old=Object.fromEntries(['STRATA_MEMBER_READ_BUDGET','STRATA_PUBLIC_SELF_SERVICE_ENABLED','STRATA_MEMBER_BUDGET_OWNER_ID','STRATA_MEMBER_BUDGET_ACCOUNT_ID','STRATA_MEMBER_BUDGET_CONNECTION_ID'].map(k=>[k,process.env[k]]));
 const users=[1,2].map(n=>{
  const id=String(n+3).repeat(8)+'-1111-4111-8111-'+String(n).repeat(12);
  const finId=String(n+5).repeat(8)+'-1111-4111-8111-'+String(n).repeat(12);
  const connectionId=String(n+7).repeat(8)+'-1111-4111-8111-'+String(n).repeat(12);
  const keys=generateKeyPairSync('rsa',{modulusLength:2048});
  const material={keyId:'independent-owner-'+n,privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
  return {owner:id,financial:finId,connection:connectionId,account:'independent-account-'+n,material,publicKey:keys.publicKey,fp:dedicatedSignerFingerprint(material.keyId,material.privateKey)!};
 });
 try{
  await pool.query('TRUNCATE public.v13_production_account,public.financial_accounts,private.provider_connections,private.kalshi_connection_credentials');
  await pool.query('ALTER TABLE public.v13_production_account ADD COLUMN IF NOT EXISTS key_fingerprint text');
  for(const u of users){
   await pool.query('INSERT INTO public.v13_production_account(id,owner_user_id,kalshi_connection_id,subaccount,exchange_index,key_fingerprint) VALUES($1,$2,$3,1,2,$4)',[u.account,u.owner,u.financial,u.fp]);
   await pool.query("INSERT INTO public.financial_accounts VALUES($1,$2,'kalshi')",[u.financial,u.owner]);
   await pool.query('INSERT INTO private.provider_connections VALUES($1,$2)',[u.connection,u.financial]);
   await pool.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,$4,$5,NULL,now(),'credential_verified','restricted_execution')",[u.account,u.financial,u.owner,u.connection,u.fp]);
  }
  Object.assign(process.env,{STRATA_MEMBER_READ_BUDGET:'experimental_v1',STRATA_PUBLIC_SELF_SERVICE_ENABLED:'true',STRATA_MEMBER_BUDGET_OWNER_ID:users[0].owner,STRATA_MEMBER_BUDGET_ACCOUNT_ID:users[0].account,STRATA_MEMBER_BUDGET_CONNECTION_ID:users[0].connection});
  await pool.query("UPDATE private.strata_member_read_budget SET tokens=750,measured_at=clock_timestamp()+interval '1 hour'");
  const calls=[0,0];
  const transport=(u:typeof users[number],index:number):typeof fetch=>async(input,init)=>{
   calls[index]++;const url=new URL(String(input)),headers=new Headers(init?.headers);
   assert.equal(init?.method,'GET');assert.equal(headers.get('KALSHI-ACCESS-KEY'),u.material.keyId);
   assert.equal(verify('sha256',Buffer.from(headers.get('KALSHI-ACCESS-TIMESTAMP')+'GET'+url.pathname),{key:u.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:constants.RSA_PSS_SALTLEN_DIGEST},Buffer.from(headers.get('KALSHI-ACCESS-SIGNATURE')!,'base64')),true);
   const key=url.pathname.endsWith('/positions')?'market_positions':url.pathname.split('/').at(-1)!;
   return new Response(JSON.stringify(key==='balance'?{subaccount:1,exchange_index:2,balance_dollars:'25.0000'}:{[key]:[]}),{status:200});
  };
  await Promise.all(users.map(async(u,index)=>{
   const send=transport(u,index);
   await getScopedKalshiJson(u.material,'/trade-api/v2/portfolio/subaccounts/transfers','?limit=100',send,'https://external-api.kalshi.com',u.owner);
   const feeds=await readOwnedKalshiFeeds(u.material,Date.now(),(c,p,q,_f,_h,o,s)=>getScopedKalshiJson(c,p,q,send,'https://external-api.kalshi.com',o,s),{mode:'bounded_history_reads_v1'});
   assert.equal(feeds.ok,true,JSON.stringify(feeds));
  }));
  assert.deepEqual(calls,[8,8]);
  assert.equal(Number((await pool.query('SELECT tokens FROM private.strata_member_read_budget')).rows[0].tokens),610,'both owners debit one shared bucket');
  const u=users[1],send=transport(u,1),path='/trade-api/v2/portfolio/subaccounts/transfers';
  await assert.rejects(getScopedKalshiJson(u.material,path,'?limit=100',send,'https://external-api.kalshi.com',users[0].owner));
  assert.deepEqual(calls,[8,8],'a supplied owner must match the signing credential');
  await pool.query('UPDATE private.kalshi_connection_credentials SET revoked_at=now() WHERE id=$1',[u.account]);
  await assert.rejects(getScopedKalshiJson(u.material,path,'',send,'https://external-api.kalshi.com',u.owner));
  await pool.query('UPDATE private.kalshi_connection_credentials SET revoked_at=NULL WHERE id=$1',[u.account]);
  await pool.query('UPDATE public.v13_production_account SET key_fingerprint=$2 WHERE id=$1',[u.account,'0'.repeat(64)]);
  await assert.rejects(getScopedKalshiJson(u.material,path,'',send,'https://external-api.kalshi.com',u.owner));
  await pool.query('UPDATE public.v13_production_account SET key_fingerprint=$2 WHERE id=$1',[u.account,u.fp]);
  await withMemberHistoryCredits(u.fp,new AbortController().signal,async()=>{
   await pool.query('UPDATE public.v13_production_account SET id=$2 WHERE id=$1',[u.account,u.account+'-rebound']);
   try{await assert.rejects(reserveMemberRead('/trade-api/v2/portfolio/orders',u.fp,undefined,undefined,
    {host:'https://external-api.kalshi.com',query:'?limit=200&subaccount=1&exchange_index=2',ownerId:u.owner}),/scope_unverified/);}
   finally{await pool.query('UPDATE public.v13_production_account SET id=$2 WHERE id=$1',[u.account+'-rebound',u.account]);}
  });
  await pool.query('INSERT INTO public.v13_production_account SELECT id || $2,owner_user_id,kalshi_connection_id,subaccount,exchange_index,key_fingerprint FROM public.v13_production_account WHERE id=$1',[u.account,'-ambiguous']);
  await assert.rejects(getScopedKalshiJson(u.material,path,'',send,'https://external-api.kalshi.com',u.owner),/budget_unavailable/);
  await pool.query('DELETE FROM public.v13_production_account WHERE id=$1',[u.account+'-ambiguous']);
  await pool.query("UPDATE private.strata_member_read_budget SET tokens=0,measured_at=clock_timestamp()+interval '1 hour'");
  await assert.rejects(getScopedKalshiJson(u.material,path,'',send,'https://external-api.kalshi.com',u.owner),/budget_unavailable/);
  assert.deepEqual(calls,[8,8],'revocation, stale execution key and exhausted quota send nothing');
 }finally{for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});

test.after(async()=>{await pool.end();});

import test from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {generateKeyPairSync} from 'node:crypto';
import {createStoppedCashDiagnosticLoader} from './stoppedCashDiagnosticLoader';
import {createStoppedCashBracketAdapter} from './stoppedCashDiagnosticAdapters';
import {inspectStoppedCashDiagnosticPrototype} from './stoppedCashDiagnosticPrototype';
import {dedicatedSignerFingerprint} from './commissioning';

const owner='11111111-1111-4111-8111-111111111111',other='55555555-5555-4555-8555-555555555555',
 account='main',fa='22222222-2222-4222-8222-222222222222',pc='33333333-3333-4333-8333-333333333333',
 vault='44444444-4444-4444-8444-444444444444',sha='a'.repeat(40);
const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
const fingerprint=dedicatedSignerFingerprint('fixture-key',pem)!;
const url=process.env.V13_DISPOSABLE_DATABASE_URL;
if(!url||url!==process.env.DATABASE_URL||new URL(url).hostname!=='127.0.0.1'||
 !/^\/v13_disposable_\d+$/.test(new URL(url).pathname))throw Error('explicit_disposable_only');

test('native held owner/Vault/history loader uses read-only RR and mapped local intent discipline',async()=>{
 let keys=0,count=0,scheduled=false;
 const loader=createStoppedCashDiagnosticLoader({releaseSha:()=>sha,isScheduled:()=>scheduled,connect:async()=>{
  const c=await pool.connect();return {query:async(s:string,p?:unknown[])=>{
   assert.match(s.trim(),/^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL|WITH\s+scoped\s+AS|SELECT|COMMIT|ROLLBACK)\b/i);
   assert.doesNotMatch(s,/\b(?:UPDATE|INSERT|DELETE|FOR\s+SHARE)\b/i);
   if(s.includes('vault.decrypted_secrets'))keys++;
   const out=await c.query(s,p);
   if(s.startsWith('BEGIN')){
    const a=(await c.query("SELECT current_setting('transaction_isolation') AS mode,current_setting('transaction_read_only') AS ro")).rows[0];
    assert.deepEqual(a,{mode:'repeatable read',ro:'on'});count++;
   }
   return out;
  },release:(discard?:boolean)=>c.release(discard)};
 }});
 try{
  // Synthetic database only; writer setup is not part of the diagnostic port.
  await pool.query(`CREATE SCHEMA private;CREATE SCHEMA vault;
  CREATE TABLE public.v13_production_account(id text,owner_user_id uuid,kalshi_connection_id uuid,key_fingerprint text,commissioned boolean,kill_switch boolean,blocked_reason text,cash_precision_verified boolean,cash_micros bigint,initial_cash_micros bigint,reserved_micros bigint,policy_id text,subaccount int,exchange_index int,execution_enabled boolean);
  CREATE TABLE public.v13_live_money_policy(id text,execution_account_id text,created_by text,state text,fee_policy_version text);
  CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,fencing_token bigint,holder_id text,state text,arm_requested boolean,account_kill boolean,credential_fingerprint text);
  CREATE TABLE public.financial_accounts(id uuid,user_id uuid,provider text);
  CREATE TABLE private.provider_connections(id uuid,financial_account_id uuid);
  CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id uuid,provider_connection_id uuid,role text,revoked_at timestamptz,verified_at timestamptz,verification_reason text,key_fingerprint text,vault_secret_id uuid);
  CREATE TABLE vault.decrypted_secrets(id uuid,decrypted_secret text);
  CREATE TABLE public.v13_production_position(account_id text,quantity_hundredths bigint,basis_micros bigint,realized_pnl_micros bigint);
  CREATE TABLE public.v13_production_intent(account_id text,terminal boolean,state text,reserved_micros bigint,request jsonb,created_at timestamptz,id text,kind text,client_order_id text,exchange_order_id text,filled_hundredths bigint);
  CREATE TABLE public.v13_production_event(account_id text,event_id text,digest text,cash_delta_micros bigint,pnl_micros bigint);
  CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text,state text);`);
  await pool.query("INSERT INTO public.v13_production_account VALUES($1,$2,$3,$4,true,false,'production_external_cash_mismatch',true,25000000,25000000,0,'policy',1,2,true)",[account,owner,fa,fingerprint]);
  await pool.query("INSERT INTO public.v13_live_money_policy VALUES('policy',$1,$2,'APPROVED','fee')",[account,owner]);
  await pool.query("INSERT INTO public.financial_accounts VALUES($1,$2,'kalshi')",[fa,owner]);
  await pool.query('INSERT INTO private.provider_connections VALUES($1,$2)',[pc,fa]);
  await pool.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,'restricted_execution',NULL,now(),'credential_verified',$4,$5)",[owner,fa,pc,fingerprint,vault]);
  await pool.query("INSERT INTO vault.decrypted_secrets VALUES($1,$2)",[vault,JSON.stringify({api_key_id:'fixture-key',private_key:pem})]);
  await pool.query("INSERT INTO private.kalshi_account_worker_lease VALUES($1,$2,24,'held','released',false,false,$3)",[account,owner,fingerprint]);
  const first=await loader.loadHeld(owner);
  assert.ok(first&&first.executionEnabled&&first.killSwitch===false&&first.outstandingCount===0);
  assert.equal(await loader.loadHeld(other),null);assert.equal(keys,0);
  assert.equal(await loader.verifiedMaterial(owner,'elsewhere',fingerprint),null);assert.equal(keys,0);
  const material=await loader.verifiedMaterial(owner,account,fingerprint);assert.equal(material?.keyId,'fixture-key');assert.equal(keys,1);
  const at=Date.now(),clock=()=>at;
  let requests=0;
  const bracket=createStoppedCashBracketAdapter({now:clock,get:async(_material,path,_q,_f,_h,bound)=>{
   assert.equal(bound,owner);requests++;
   if(path.endsWith('/balance'))return {balance:2500,balance_dollars:'25.0000',updated_ts:7};
   return {[path.split('/').at(-1)!]:[],cursor:''};
  }});
  const proof=await inspectStoppedCashDiagnosticPrototype({subject:owner,aal:'aal2'},{
   ...loader,bracket,wall:clock,mono:()=>performance.now(),
   env:()=>({NODE_ENV:'production',RAILWAY_GIT_COMMIT_SHA:sha,STRATA_STOPPED_CASH_DIAGNOSTIC_SHA:sha,
    STRATA_STOPPED_CASH_DIAGNOSTIC_ENABLED:'true',STRATA_STOPPED_CASH_DIAGNOSTIC_REVIEWED:'true'}),
  });
  assert.equal(proof.ok,true,JSON.stringify(proof));assert.equal(proof.ordersSubmitted,false);assert.equal(requests,8);
  assert.equal((await loader.loadHeld(owner))?.holdFence,first.holdFence);
  assert.equal(keys,2);

  await pool.query("UPDATE private.kalshi_account_worker_lease SET credential_fingerprint=$1",['f'.repeat(64)]);
  assert.equal(await loader.loadHeld(owner),null,'valid-shaped mismatched lease fingerprint must refuse');
  assert.equal(await loader.verifiedMaterial(owner,account,fingerprint),null);
  assert.equal(keys,2,'fingerprint mismatch must refuse before Vault');
  await pool.query("UPDATE private.kalshi_account_worker_lease SET credential_fingerprint=$1",[fingerprint]);
  assert.notEqual((await loader.loadHeld(owner))?.holdFence,first.holdFence,'lease credential ABA moves row revision');

  await pool.query("UPDATE private.kalshi_account_worker_lease SET arm_requested=true");
  assert.equal(await loader.verifiedMaterial(owner,account,fingerprint),null);assert.equal(keys,2);
  await pool.query("UPDATE private.kalshi_account_worker_lease SET arm_requested=false");
  assert.notEqual((await loader.loadHeld(owner))?.holdFence,first.holdFence,'ARM/STOP ABA moves row revision');
  const request={market:'FIX',side:'YES',action:'BUY',limitMicros:500000,timeInForce:'IOC',reduceOnly:false,contracts:1,clientOrderId:'local-1'};
  await pool.query("INSERT INTO public.v13_production_intent VALUES($1,true,'TERMINAL',0,$2,clock_timestamp(),'i','ENTRY','local-1',NULL,0)",[account,request]);
  assert.equal(await loader.loadHeld(owner),null,'terminal without remote ID or no-send proof');
  await pool.query("UPDATE public.v13_production_intent SET exchange_order_id='provider-1'");
  assert.equal((await loader.loadHeld(owner))?.expectedOrders[0]?.orderId,'provider-1');
  await pool.query("INSERT INTO public.v13_production_event VALUES($1,'settlement:leg-1',$2,0,0)",[account,'b'.repeat(64)]);
  const withEvent=await loader.loadHeld(owner);
  assert.equal(withEvent?.events.length,1);
  assert.notEqual(withEvent?.historyDigest,first.historyDigest);
  await pool.query("UPDATE private.kalshi_connection_credentials SET revoked_at=clock_timestamp()");
  assert.equal(await loader.verifiedMaterial(owner,account,fingerprint),null);assert.equal(keys,2);
  await pool.query("UPDATE private.kalshi_connection_credentials SET revoked_at=NULL");
  scheduled=true;assert.equal(await loader.loadHeld(owner),null);
  assert.ok(count>9);
 }finally{await pool.end();}
});

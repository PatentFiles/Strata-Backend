import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createHeldUnknownAccountingRecovery} from './ownerUnknownRecoveryHeld';
import {OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION,ownerUnknownEvidenceDigest as hash} from './ownerUnknownRecoveryPlan';
import {dedicatedSignerFingerprint} from './commissioning';
import {readOwnedKalshiFeeds} from './personalExchangeRead';
const owner='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';
const receiptId='33333333-3333-4333-8333-333333333333',now=Date.parse('2026-11-08T23:30:00Z');
const material={keyId:'synthetic-key',privateKey:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString()};
const fingerprint=dedicatedSignerFingerprint(material.keyId,material.privateKey)!;
const input={ownerId:owner,targetIntentId:target,fenceReceiptId:receiptId,confirmation:OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION};
function fixture(change=''){
 const account={id:'synthetic-account',owner_user_id:owner,kalshi_connection_id:'connection',subaccount:1,exchange_index:2,
  key_fingerprint:fingerprint,revision:'8',cash_micros:'25000000',reserved_micros:'6000000',
  blocked_reason:'personal_exchange_history_unreconciled',kill_switch:true,execution_enabled:false,
  commissioned:true,cash_precision_verified:true,state:'killed',arm_requested:false,account_kill:true,
  fencing_token:'8',lease_owner:owner,credential_fingerprint:fingerprint,
  revisions:{account:'28',lease:'29',credential:'10',policy:'11',financial:'12',provider:'13'}};
 const request={market:'KXBTC15M-SYNTHETIC',side:'NO',action:'BUY',contracts:3,limitMicros:430000,
  timeInForce:'IOC',reduceOnly:false,clientOrderId:'synthetic-client'};
 const intent={id:target,account_id:account.id,kind:'ENTRY',state:'UNKNOWN',terminal:false,
  created_at:new Date(now-100000),request,reserved_micros:'6000000',filled_hundredths:'0',
  exchange_order_id:'synthetic-order',client_order_id:request.clientOrderId,
  decision:{},policy_hash:'policy',fee_fingerprint:'fee',capability_digest:'capability',row_revision:'30'};
 const payload={ownerId:owner,accountId:account.id,targetIntentId:target,priorToken:'7',nextToken:'8',
  priorRevision:'7',nextRevision:'8',financialStateChanged:false,tradingAuthorized:false};
 let accountReads=0,signers=0,reads=0,connects=0,clock=now;
 const calls:string[]=[];
 const db={query:async(sql:string)=>{
  calls.push(sql);
  if(sql.startsWith('SELECT a.id')){
   accountReads++;const a=structuredClone(account);
   if(change==='notKilled')a.kill_switch=false;
   if(change==='notFenced')a.state='owned';
   if(change==='metadataAba'&&accountReads>1)a.revisions.lease='99';
   if(change==='wrongOwner')a.owner_user_id='other';
   return {rows:[a]};
  }
  if(sql.startsWith('SELECT payload,digest'))return {rows:change==='missingReceipt'?[]:[{payload,
   digest:change==='badReceipt'?'0'.repeat(64):hash(payload),observed_at:new Date(now-2000)}]};
  if(sql.startsWith('SELECT\n (SELECT count'))return {rows:[{exits:change==='protective'?'1':'0',transfers:change==='transfer'?'1':'0'}]};
  if(sql.startsWith('SELECT id,account_id,kind'))return {rows:[{...intent,
   ...(change==='terminal'?{state:'TERMINAL',terminal:true}:{}),
   ...(change==='historyRace'&&accountReads>1?{row_revision:'99'}:{})}]};
  throw Error('unexpected_query');
 },connect:async()=>{connects++;throw Error('offline_positive_collection_reached_ledger_boundary');}};
 const run=createHeldUnknownAccountingRecovery({db:db as never,now:()=>clock,
  isScheduled:()=>change==='running',material:async()=>{signers++;return change==='wrongSigner'?{...material,keyId:'other'}:material;},
  readFeeds:async(creds,at)=>{
   const read=await readOwnedKalshiFeeds(creds,at,async(_c,path)=>{
    reads++;
    if(path.endsWith('/balance'))return {balance_dollars:'23.7200',subaccount:1,exchange_index:2};
    if(path.includes('/historical/'))return {orders:[],fills:[],cursor:''};
    if(path.endsWith('/orders'))return {orders:change==='noOrder'?[]:[{order_id:'synthetic-order',client_order_id:request.clientOrderId,
     ticker:request.market,status:'executed',book_side:'ask',side:'no',action:'buy',yes_price_dollars:'0.5700',
     initial_count_fp:'3.00',fill_count_fp:'3.00'}],cursor:''};
    if(path.endsWith('/fills'))return {fills:change==='noOrder'?[]:[{trade_id:'synthetic-fill',order_id:'synthetic-order',
     ticker:request.market,count_fp:'3.00',yes_price_dollars:'0.5900',no_price_dollars:'0.4100',fee_cost:'0.0500',
     ts:Math.floor((now-99000)/1000)}],cursor:''};
    if(path.endsWith('/positions'))return {market_positions:[],cursor:''};
    if(path.endsWith('/settlements'))return {settlements:change==='noOrder'?[]:[{ticker:request.market,yes_count_fp:'0.00',
     no_count_fp:'3.00',market_result:'yes',revenue:0,settled_time:new Date(now-50000).toISOString()}],cursor:''};
    throw Error('unexpected_feed');
   });
   if(change==='expired')clock+=16000;
   if(read.ok&&change==='archive')read.historicalCoverageComplete=false;
   return read;
  }});
 return {run:()=>run(input),db,calls,signers:()=>signers,reads:()=>reads,connects:()=>connects};
}
test('actual seven-feed mapper accepts ts-only synthetic losing settlement and reaches only locked ledger boundary',async()=>{
 const f=fixture(),r=await f.run();assert.equal(f.reads(),7);assert.equal(f.signers(),1);assert.equal(f.connects(),1);
 assert.equal(r.ok,false);assert.equal(r.reason,'recovery_accounting_failed');
 assert.equal(f.calls.some(x=>/^(UPDATE|INSERT|DELETE)/.test(x)),false);
});
for(const change of ['notKilled','notFenced','wrongOwner','missingReceipt','badReceipt','protective','transfer','terminal','running'])
 test(`held collector refuses ${change} before signer and provider access`,async()=>{
  const f=fixture(change),r=await f.run();assert.equal(r.ok,false);assert.equal(f.signers(),0);
  assert.equal(f.reads(),0);assert.equal(f.connects(),0);
 });
test('signer fingerprint mismatch refuses before provider access',async()=>{
 const f=fixture('wrongSigner'),r=await f.run();assert.equal(r.ok,false);assert.equal(f.signers(),1);
 assert.equal(f.reads(),0);assert.equal(f.connects(),0);
});
for(const change of ['metadataAba','historyRace','noOrder','expired','archive'])
 test(`post-read ${change} refuses before financial transaction`,async()=>{
  const f=fixture(change),r=await f.run();assert.equal(r.ok,false,JSON.stringify(r));assert.equal(f.reads(),7);
  assert.equal(f.connects(),0);assert.equal(f.calls.some(x=>/^(UPDATE|INSERT|DELETE)/.test(x)),false);
 });

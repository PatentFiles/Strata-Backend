import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {recoverOwnerTransientFreeze,OWNER_TRANSIENT_RECOVERY_CONFIRM,TRANSIENT_DATABASE_FREEZE} from './ownerTransientFreezeRecovery';
import {dedicatedSignerFingerprint} from './commissioning';
import {computeV13LiveMoneyPolicyHash} from '../v13LiveMoneyRisk';
const owner='11111111-1111-4111-8111-111111111111';
const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
const fp=dedicatedSignerFingerprint('test',pem)!;
const now=Date.now();
function fixture(overrides:Record<string,unknown>={},fault=''){
 const calls:string[]=[];let reads=0;
 const account={id:'a',owner_user_id:owner,subaccount:1,exchange_index:2,policy_id:'p',
  kalshi_connection_id:'connection',key_fingerprint:fp,blocked_reason:TRANSIENT_DATABASE_FREEZE,
  commissioned:true,cash_precision_verified:true,reserved_micros:'0',cash_micros:'25000000',
  initial_cash_micros:'25000000',revision:'1',execution_enabled:true,kill_switch:false,...overrides};
 const policy={id:'p',state:'APPROVED',created_by:owner};
 const policy_hash=computeV13LiveMoneyPolicyHash({id:'p',state:'APPROVED',createdBy:owner} as never);
 const query=async(sql:string)=>{
  calls.push(sql);
  if(sql==='COMMIT'&&fault==='commit_ack_lost')throw Error('commit acknowledgement lost');
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.startsWith('SET LOCAL')||sql.includes("set_config('lock_timeout'"))return {rows:[]};
  if(sql.includes('SELECT a.*'))return {rows:[account]};
  if(sql.includes('SELECT * FROM v13_production_account'))return {rows:[{...account,...(fault==='account_changed'?{revision:'2'}:{})}]};
  if(sql.includes('SELECT * FROM private.kalshi_account_worker_lease'))return {rows:[{state:fault==='lease_owned'?'owned':'released',arm_requested:fault==='armed',credential_fingerprint:fp,fencing_token:'22'}]};
  if(sql.includes('SELECT p.*'))return {rows:fault==='policy_revoked'?[]:[{...policy,policy_hash}]};
  if(sql.includes('SELECT key_fingerprint'))return {rows:fault==='credential_revoked'?[]:[{key_fingerprint:fp}]};
  if(sql.includes('SELECT s.decrypted_secret'))return {rows:[{decrypted_secret:JSON.stringify({api_key_id:'test',private_key:pem})}]};
  if(sql.includes(') intents,'))return {rows:[{intents:fault==='unknown'?'1':'0',positions:fault==='position'?'1':'0',exits:fault==='unknown_exit'?'1':'0'}]};
  if(sql.includes('SELECT request')||sql.includes('SELECT * FROM v13_production_intent')||sql.includes('SELECT market,side'))return {rows:[]};
  if(sql.includes('sum(cash_delta_micros)'))return {rows:[{cash:'0',pnl:'0'}]};
  if(sql.includes('sum(basis_micros)'))return {rows:[{basis:'0',pnl:'0'}]};
  if(sql.includes('sum(reserved_micros)'))return {rows:[{amount:'0'}]};
  if(sql.includes('INSERT INTO v13_production_observation')){if(fault==='audit_failure')throw Error('audit unavailable');return {rows:[]};}
  if(sql.includes('UPDATE public.v13_production_account')){
   assert.match(sql,/execution_enabled=false,kill_switch=true/);
   assert.match(sql,/clock_timestamp\(\).*BETWEEN/);
   return {rows:fault==='cas_failure'?[]:[{id:'a'}]};
  }
  throw Error('Unexpected SQL '+sql);
 };
 const db={query,connect:async()=>({query,release(){}})};
 const run=()=>recoverOwnerTransientFreeze(owner,OWNER_TRANSIENT_RECOVERY_CONFIRM,{
  db:db as never,now:()=>now+(fault==='expired'&&reads?5001:0),
  isScheduled:()=>fault==='running'||(fault==='concurrent_start'&&reads>0),
  read:async(_material,at)=>{reads++;return {ok:true,observedAtMs:at,
   historicalCoverageComplete:fault!=='archive_missing',cashMicros:fault==='cash_mismatch'?'24000000':'25000000',
   orders:[],fills:[],positions:fault==='exchange_position'?[{ticker:'X',position:1}]:[],settlements:[]};},
 });
 return {run,calls,get reads(){return reads;}};
}
test('signed flat complete recovery only clears transient hold with gates closed',async()=>{
 const f=fixture();assert.equal((await f.run()).ok,true);assert.equal(f.reads,1);
 assert.ok(f.calls.includes('COMMIT'));assert.ok(!f.calls.includes('ROLLBACK'));
 assert.equal(f.calls.filter(s=>s.startsWith('UPDATE')).length,1);
});
for(const fault of ['account_changed','lease_owned','armed','policy_revoked','credential_revoked','unknown','position','unknown_exit','audit_failure','cas_failure','expired','running','concurrent_start','archive_missing','cash_mismatch','exchange_position']){
 test(`refuses ${fault}, never commits recovery`,async()=>{
  const f=fixture({},fault);const r=await f.run();assert.equal(r.ok,false,JSON.stringify(r));
  assert.equal(r.tradingAuthorized,false);assert.equal(f.calls.includes('COMMIT'),false);
  if(f.calls.includes('BEGIN'))assert.ok(f.calls.includes('ROLLBACK'));
 });
}
for(const overrides of [{owner_user_id:'foreign'},{blocked_reason:'late_fill_after_terminal'},
 {blocked_reason:null},{reserved_micros:'1'},{commissioned:false},{cash_precision_verified:false},
 {subaccount:0},{exchange_index:1}]){
 test(`rejects account mismatch ${JSON.stringify(overrides)} before signed reads`,async()=>{
  const f=fixture(overrides);assert.equal((await f.run()).ok,false);assert.equal(f.reads,0);
 });
}
test('missing explicit owner confirmation does no work',async()=>{
 let calls=0;const r=await recoverOwnerTransientFreeze(owner,'wrong',{
 db:{query:async()=>{calls++;throw Error();}} as never,isScheduled:()=>false});
 assert.equal(r.ok,false);assert.equal(calls,0);
});

test('lost COMMIT acknowledgement reports unknown rather than claiming clearance absent',async()=>{
 const f=fixture({},'commit_ack_lost');const r=await f.run();
 assert.equal(r.ok,false);assert.equal(r.riskFreezeCleared,null);
 assert.equal(r.reason,'recovery_commit_outcome_unverified');
});

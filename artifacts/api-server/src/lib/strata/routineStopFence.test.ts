import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoutineStopFence} from './routineStopFence';
const owner='11111111-1111-4111-8111-111111111111',key='a'.repeat(64);
const clean={owner_id:owner,id:'fixture',blocked_reason:null,diagnostic_held:true,lease_state:'released',
 arm_requested:false,lease_account_kill:false,position_exists:false,reserved_micros_text:'0',
 key_fingerprint:key,lease_credential_fingerprint:key,execution_enabled:true,kill_switch:false,
 hold_revision:{account:'7',policy:'8',lease:'9',fence:'10',credential:'11',financial:'12',provider:'13',key,vault:'fixture',holder:'worker'}};
function fixture(rows:Record<string,unknown>[],isScheduled=()=>false){
 const sql:string[]=[];
 const read=createRoutineStopFence({releaseSha:()=>'b'.repeat(40),isScheduled,connect:async()=>({
  query:async(s,p)=>{sql.push(s);if(s.includes('WITH scoped')){assert.deepEqual(p,[owner]);return {rows};}
   assert.match(s,/^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL |COMMIT|ROLLBACK)/);return {rows:[]};},
  release:()=>{},
 })});
 return {read,sql};
}
test('clean and held stopped scope admitted only as distinct local fences without provider authority',async()=>{
 const c=fixture([clean]),h=fixture([{...clean,blocked_reason:'production_external_cash_mismatch'}]);
 const a=await c.read(owner),b=await h.read(owner);
 assert.equal(a?.status,'LOCAL_STOP_SCOPE_ONLY');assert.equal(b?.status,'LOCAL_STOP_SCOPE_ONLY');
 assert.equal(a?.cashMismatchHold,false);assert.equal(b?.cashMismatchHold,true);assert.notEqual(a?.fence,b?.fence);
 for(const out of [a,b]){assert.equal(out?.authenticatedExchangeFlat,false);assert.equal(out?.pendingCashCompletenessVerified,false);assert.equal(out?.holdCleared,false);assert.equal(out?.tradingAuthorized,false);}
 assert.match(c.sql[3]!,/NOT EXISTS[\s\S]*UNKNOWN/);assert.equal(c.sql[4],'COMMIT');
});
test('protective manager, unknown/exposure projection, reservations, other holds and malformed fences refuse',async()=>{
 for(const patch of [{lease_state:'owned'},{diagnostic_held:false},{position_exists:true},{reserved_micros_text:'1'},
  {arm_requested:true},{blocked_reason:'other_hold'},{hold_revision:{...clean.hold_revision,fence:'garbage'}},
  {lease_credential_fingerprint:'b'.repeat(64)}])assert.equal(await fixture([{...clean,...patch}]).read(owner),null);
 assert.equal(await fixture([clean],()=>true).read(owner),null);
 let n=0;assert.equal(await fixture([clean],()=>++n===2).read(owner),null);
 assert.equal(await fixture([clean,clean]).read(owner),null);
});
test('revision changes produce a different fence; there is no prior owner proof fallback',async()=>{
 const a=await fixture([clean]).read(owner);
 const b=await fixture([{...clean,hold_revision:{...clean.hold_revision,lease:'10'}}]).read(owner);
 assert.notEqual(a?.fence,b?.fence);
 const invalid=fixture([clean]);assert.equal(await invalid.read('not-a-user'),null);assert.equal(invalid.sql.length,0);
});

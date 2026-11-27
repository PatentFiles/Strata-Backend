import test from 'node:test';
import assert from 'node:assert/strict';
import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET} from '@workspace/v13-strategy';
import {readOwnerBotCatalog} from './ownerBotCatalog';
const owner='10000000-0000-4000-8000-000000000001';
const row={id:'synthetic-owned-account',policy_state:'APPROVED',strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,
 strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,worker_state:'owned',arm_requested:true};
const db=(rows:Record<string,unknown>[])=>( {query:async(sql:string,args?:unknown[])=>{
 assert.match(sql,/WHERE a.owner_user_id=\$1::uuid/);assert.deepEqual(args,[owner]);
 assert.doesNotMatch(sql,/\b(UPDATE|INSERT|DELETE)\b/);return {rows};
}} );
test('catalog shows the actual approved owner strategy without granting order or switch authority',async()=>{
 const r=await readOwnerBotCatalog(owner,db([row]));assert.equal(r.ok,true);if(!r.ok)return;
 assert.equal(r.currentBotId,V13_CHAMPION_PARAMETER_SET.id);assert.equal(r.selectionEnabled,false);
 assert.equal(r.executionAuthority,'NONE');assert.equal(r.workerMayBeActive,true);
 assert.equal(r.bots[1]?.name,'Warren Buffett');assert.equal(r.bots[1]?.status,'RESEARCH_ONLY');
});
test('unapproved, wrong-hash, or missing policy is never represented as a saved C52/C53 choice',async()=>{
 for(const patch of [{policy_state:'DRAFT'},{strategy_parameter_hash:'f'.repeat(64)},{strategy_parameter_set_id:null}]){
  const r=await readOwnerBotCatalog(owner,db([{...row,...patch}]));assert.ok(r.ok);
  if(r.ok){assert.equal(r.currentBotId,null);assert.equal(r.currentPolicyVerified,false);}
 }
});
test('invalid owner is rejected before any data read',async()=>{
 const r=await readOwnerBotCatalog('foreign-selector',{query:async()=>{throw Error('must_not_query');}});
 assert.equal(r.ok,false);
});
test('missing or ambiguous account does not fall back to another owner or a mock default',async()=>{
 for(const rows of [[],[row,row]])assert.equal((await readOwnerBotCatalog(owner,db(rows))).ok,false);
});

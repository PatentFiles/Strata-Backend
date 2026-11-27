import test from 'node:test';import assert from 'node:assert/strict';
import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET} from '@workspace/v13-strategy';
import {readOwnerBotCatalog,selectOwnedBot,qualifiedWarrenRelease,readRuntimeBotChoice,CHAMPION_BOT,WARREN_BOT,WARREN_BOT_HASH} from './ownerBotCatalog';
const owner='10000000-0000-4000-8000-000000000001';
const policyHash='a'.repeat(64),sha='b'.repeat(40);
const row={id:'synthetic-owned-account',policy_state:'APPROVED',policy_hash:policyHash,
 strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,
 worker_state:'released',arm_requested:false,kill_switch:true,execution_enabled:false,
 blocked_reason:null,reserved_micros:'0',reconciled_at:new Date(),selected_bot:null,selection_revision:null};
const db=(rows:Record<string,unknown>[])=>( {query:async(sql:string,args?:unknown[])=>{
 assert.match(sql,/owner_user_id/);assert.deepEqual(args,[owner]);
 assert.doesNotMatch(sql,/\b(UPDATE|INSERT|DELETE)\b/);return {rows};
}} );
test('original champion identity stays owner scoped and selectable only when stopped',async()=>{
 const r=await readOwnerBotCatalog(owner,db([row]));assert.equal(r.ok,true);
 if(r.ok){assert.equal(r.currentBotId,CHAMPION_BOT);assert.equal(r.currentPolicyVerified,true);
  assert.equal(r.selectionEnabled,true);assert.equal(r.executionAuthority,'ACCOUNT_OWNER_ONLY');
  assert.equal(r.bots[1].name,'Warren Buffett');assert.equal(r.bots[1].status,'RESEARCH_ONLY');}
});
test('a running worker, old cash or missing approval cannot save strategy',async()=>{
 for(const patch of [{worker_state:'owned',arm_requested:true},{blocked_reason:'hold'},
  {reconciled_at:new Date(0)},{policy_state:'DRAFT'},{strategy_parameter_hash:'f'.repeat(64)}]){
  const r=await readOwnerBotCatalog(owner,db([{...row,...patch}]));
  assert.equal(r.ok,true);if(r.ok)assert.equal(r.selectionEnabled,false);
 }
});
test('no owner spoofing or guessed default for missing/ambiguous account',async()=>{
 assert.equal((await readOwnerBotCatalog('wrong',db([row]))).ok,false);
 for(const rows of [[],[row,row]])assert.equal((await readOwnerBotCatalog(owner,db(rows))).ok,false);
});
test('unqualified Warren cannot be enabled or silently substituted',async()=>{
 assert.equal(qualifiedWarrenRelease(sha,{} as NodeJS.ProcessEnv),false);
 const failed=await selectOwnedBot(owner,{botId:WARREN_BOT,confirmation:'wrong'},{} as never);
 assert.equal(failed.ok,false);
 assert.match(WARREN_BOT_HASH,/^[a-f0-9]{64}$/);
 const current=await readRuntimeBotChoice({query:async()=>({rows:[]})},owner,'account',policyHash,sha);
 assert.equal(current,CHAMPION_BOT);
 await assert.rejects(readRuntimeBotChoice({query:async()=>({rows:[{
  bot_id:WARREN_BOT,bot_fingerprint:WARREN_BOT_HASH,policy_hash:policyHash,release_sha:sha}]})},
  owner,'account',policyHash,sha),/bot_warren_release_not_qualified/);
});

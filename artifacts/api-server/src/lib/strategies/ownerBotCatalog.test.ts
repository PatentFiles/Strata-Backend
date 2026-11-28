import test from 'node:test';import assert from 'node:assert/strict';
import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET} from '@workspace/v13-strategy';
import {readOwnerBotCatalog,selectOwnedBot,prepareOwnerBotChange,qualifiedWarrenRelease,readRuntimeBotChoice,CHAMPION_BOT,WARREN_BOT,WARREN_BOT_HASH} from './ownerBotCatalog';
const owner='10000000-0000-4000-8000-000000000001';
const policyHash='a'.repeat(64),sha='b'.repeat(40);
const row={id:'synthetic-owned-account',policy_state:'APPROVED',policy_hash:policyHash,
 strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,
 worker_state:'released',arm_requested:false,account_kill:false,kill_switch:false,execution_enabled:true,
 blocked_reason:null,reserved_micros:'0',open_positions:0,unresolved_intents:0,pending_exits:0,reconciled_at:new Date(),selected_bot:null,selection_revision:null};
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
  {reconciled_at:new Date(0)},{open_positions:1},{unresolved_intents:1},{pending_exits:1},{policy_state:'DRAFT'},{strategy_parameter_hash:'f'.repeat(64)},
   {worker_state:'released',arm_requested:false,account_kill:true},
   {worker_state:'killed',account_kill:true,kill_switch:false,execution_enabled:true}]){
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

test('cash expiry alone explains why a safely stopped account cannot switch; explicit maintenance renews it',async()=>{
 const current={...row,reconciled_at:new Date(0)};
 let cashCalls=0;
 const result=await prepareOwnerBotChange(owner,{confirmation:'PREPARE_STOPPED_OWNER_BOT_CHANGE_V1'},db([current]),
  async()=>{cashCalls++;current.reconciled_at=new Date();return {ok:true,reason:'cash_reconciled'};});
 assert.equal(result.ok,true);assert.equal(cashCalls,1);
 if(result.ok){assert.equal(result.catalog.selectionEnabled,true);assert.equal(result.ordersSubmitted,false);assert.equal(result.transferAttempted,false);}
});
test('preparation cannot reconcile running worker, uncertain order, reserved cash or financial hold',async()=>{
 for(const patch of [{worker_state:'owned',arm_requested:true},{unresolved_intents:1},
  {reserved_micros:'50000'},{blocked_reason:'fee_hold'},{open_positions:1},{pending_exits:1}]){
  let attempts=0;
  const r=await prepareOwnerBotChange(owner,{confirmation:'PREPARE_STOPPED_OWNER_BOT_CHANGE_V1'},
   db([{...row,reconciled_at:new Date(0),...patch}]),async()=>{attempts++;return {ok:true,reason:'cash_reconciled'};});
  assert.equal(r.ok,false);assert.equal(attempts,0);
 }
});
test('preparation rejects unapproved spoofed requests and refuses changed account readback',async()=>{
 let calls=0;
 const no=await prepareOwnerBotChange(owner,{confirmation:'wrong'},db([row]),async()=>{calls++;return {ok:true,reason:'cash_reconciled'};});
 assert.equal(no.ok,false);assert.equal(calls,0);
 const mutable={...row,reconciled_at:new Date(0),selection_revision:0};
 const changed=await prepareOwnerBotChange(owner,{confirmation:'PREPARE_STOPPED_OWNER_BOT_CHANGE_V1'},db([mutable]),async()=>{
  mutable.reconciled_at=new Date();mutable.selection_revision=1;return {ok:true,reason:'cash_reconciled'};
 });
 assert.equal(changed.ok,false);
});

test('only unchanged approved policy can be marked as exact-release-only reauthorization',async()=>{
 const before=process.env.RAILWAY_GIT_COMMIT_SHA;
 try{
  process.env.RAILWAY_GIT_COMMIT_SHA=sha;
  const common={...row,selected_bot:WARREN_BOT,selected_fingerprint:WARREN_BOT_HASH,
   selected_policy_hash:policyHash,selection_sha:'c'.repeat(40),selection_revision:7};
  const rotated=await readOwnerBotCatalog(owner,db([common]));
  assert.equal(rotated.ok,true);
  if(rotated.ok){assert.equal(rotated.requiresReauthorization,true);
   assert.equal(rotated.releaseOnlyReauthorization,true);
   assert.equal(rotated.reason,'owner_bot_requires_exact_release_reauthorization');}
  const changed=await readOwnerBotCatalog(owner,db([{...common,selected_policy_hash:'d'.repeat(64)}]));
  assert.equal(changed.ok,true);
  if(changed.ok){assert.equal(changed.requiresReauthorization,true);
   assert.equal(changed.releaseOnlyReauthorization,false);
   assert.equal(changed.reason,'owner_bot_changed_financial_policy_requires_review');}
  const stale=await readOwnerBotCatalog(owner,db([{...common,reconciled_at:new Date(0)}]));
  assert.equal(stale.ok,true);
  if(stale.ok){assert.equal(stale.selectionEnabled,false);
   assert.equal(stale.reason,'owner_bot_cash_reconciliation_stale');}
  const unknown=await readOwnerBotCatalog(owner,db([{...common,selected_fingerprint:'f'.repeat(64)}]));
  assert.equal(unknown.ok,true);
  if(unknown.ok){assert.equal(unknown.selectionEnabled,false);
   assert.equal(unknown.reason,'owner_bot_selection_invalid');}
 }finally{
  if(before===undefined)delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA=before;
 }
});

test('owner bot catalog keeps the economic discharge projection gated and fail closed',async()=>{
 const previous=process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED;
 try{
  for(const enabled of [false,true]){
   process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED=enabled?'true':'false';
   let captured='';
   const db={query:async(sql:string,args?:unknown[])=>{
    captured=sql;
    assert.deepEqual(args,[owner]);
    return {rows:[row]};
   }};
   const result=await readOwnerBotCatalog(owner,db);
   assert.equal(result.ok,true);
   if(enabled){
    assert.match(captured,/i\.kind IS DISTINCT FROM 'EXIT'/);
    assert.match(captured,/x\.execution_account_id,x\.client_order_id/);
    assert.match(captured,/CASE WHEN EXISTS/);
   }else{
    assert.doesNotMatch(captured,/strata_has_economic_exit_discharge/);
   }
  }
 }finally{
  if(previous===undefined)delete process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED;
  else process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED=previous;
 }
});

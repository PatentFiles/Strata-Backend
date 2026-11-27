import test from 'node:test';import assert from 'node:assert/strict';
import {directTargetReadiness,TARGET_INITIALIZATION_MS} from './directTargetReadiness';
import {liveAnalyticsFailure,normalizeLiveDecision} from './liveDecisionAnalytics';
const base={target:null,status:'pending',openMs:100000,nowMs:100001,previouslyReady:false};
test('only genuine initial absence receives a bounded wait, never trading readiness',()=>{
 assert.equal(directTargetReadiness(base),'waiting');
 assert.equal(directTargetReadiness({...base,nowMs:base.openMs+TARGET_INITIALIZATION_MS}),'waiting');
 assert.equal(directTargetReadiness({...base,nowMs:base.openMs+TARGET_INITIALIZATION_MS+1}),'unavailable');
 for(const target of [undefined,0,-1,'100',NaN,Infinity])assert.equal(directTargetReadiness({...base,target}),'invalid');
 assert.equal(directTargetReadiness({...base,status:'invalid'}),'invalid');
 assert.equal(directTargetReadiness({...base,status:undefined}),'invalid');
 assert.equal(directTargetReadiness({...base,previouslyReady:true}),'invalid');
 assert.equal(directTargetReadiness({...base,nowMs:99999}),'invalid');
 assert.equal(directTargetReadiness({...base,target:60542.28,status:'ready'}),'ready');
});
test('specific price protection is retained without accepting arbitrary diagnostic text',()=>{
 const reason='live_money_best_ask_above_signal_ceiling';assert.equal(liveAnalyticsFailure(Error(reason)),reason);
 for(const s of ['live_money_secret_material',reason+' SECRET',reason+'\nsecret'])assert.equal(liveAnalyticsFailure(Error(s)),'live_evaluation_or_execution_failed');
});

test('only fixed target readiness enums survive analytics normalization',()=>{
 const input={accountId:'test',ownerId:'11111111-1111-4111-8111-111111111111',releaseSha:'a'.repeat(40),observedAtMs:Date.now(),stage:'OBSERVATION' as const,outcome:'PASS' as const,reasonCode:'market_target_initializing'};
 assert.equal(normalizeLiveDecision({...input,facts:{targetReadiness:'waiting'}})?.facts.targetReadiness,'waiting');
 assert.equal(normalizeLiveDecision({...input,facts:{targetReadiness:'arbitrary secret'}})?.facts.targetReadiness,undefined);
});

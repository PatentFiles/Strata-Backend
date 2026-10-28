import test from 'node:test';
import assert from 'node:assert/strict';
import {recordLiveSignalDecision,sanitizedDecisionReason} from './signalDecisionTrace';
const input={accountId:'acct',evaluationId:'11111111-1111-4111-8111-111111111111',phase:'QUALIFYING_SEEN' as const};
const sha='a'.repeat(40);
test('an already committed signal phase is a successful idempotent retry',async()=>{
 assert.equal(await recordLiveSignalDecision(input,{query:async()=>({rows:[]})},sha),true);
});
test('database failure and invalid source ages cannot be mistaken for persisted tracing',async()=>{
 assert.equal(await recordLiveSignalDecision(input,{query:async()=>{throw Error('offline');}},sha),false);
 let calls=0;
 const db={query:async()=>{calls++;return {rows:[{}]};}};
 for(const age of [-1,NaN,Infinity,1.5])assert.equal(await recordLiveSignalDecision({...input,sourceAgeMs:age},db,sha),false);
 assert.equal(calls,0);
});
test('arbitrary error payloads cannot leak into decision reasons',()=>{
 assert.equal(sanitizedDecisionReason(new Error('production_evaluation_stale')),'production_evaluation_stale');
 assert.equal(sanitizedDecisionReason(new Error('request failed: secret=not-for-logs')),'live_execution_rejection_details_redacted');
});

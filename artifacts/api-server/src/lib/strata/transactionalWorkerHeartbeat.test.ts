import test from 'node:test';
import assert from 'node:assert/strict';
import {heartbeatLeaseInTransaction,TRANSACTIONAL_HEARTBEAT_SQL} from './transactionalWorkerHeartbeat';
import {HEARTBEAT_LEASE_SQL} from './accountScopedExecution';
const input={executionAccountId:'account',ownerUserId:'owner',holderId:'worker',fencingToken:2,fingerprint:'fingerprint',now:'2026-11-18T00:00:00Z'};
test('transaction heartbeat changes only RETURNING and makes exactly one scoped request',async()=>{
 assert.equal(TRANSACTIONAL_HEARTBEAT_SQL.replace(', arm_requested, account_kill, state',''),HEARTBEAT_LEASE_SQL);
 let count=0;
 const result=await heartbeatLeaseInTransaction({async query(sql,args){count++;assert.equal(sql,TRANSACTIONAL_HEARTBEAT_SQL);assert.deepEqual(args,['account','owner',input.now,'worker',2,'fingerprint']);return {rows:[{state:'owned',account_kill:false,arm_requested:true}]};}},input);
 assert.deepEqual(result,{ok:true,armRequested:true});assert.equal(count,1);
});
test('missing ambiguous killed and nonowned rows refuse; thrown query has no retry',async()=>{
 for(const rows of [[],[{state:'owned'},{state:'owned'}],[{state:'killed'}],[{state:'owned',account_kill:true}]])assert.deepEqual(await heartbeatLeaseInTransaction({async query(){return {rows};}},input),{ok:false,reason:'stale_worker_fence'});
 let count=0;assert.deepEqual(await heartbeatLeaseInTransaction({async query(){count++;throw Error('lost ack');}},input),{ok:false,reason:'stale_worker_fence'});assert.equal(count,1);
});
test('disarmed row does not reopen entry authority',async()=>{
 assert.deepEqual(await heartbeatLeaseInTransaction({async query(){return {rows:[{state:'owned',account_kill:false,arm_requested:false}]};}},input),{ok:true,armRequested:false});
});

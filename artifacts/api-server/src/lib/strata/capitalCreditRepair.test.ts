import test from 'node:test';import assert from 'node:assert/strict';
import {readCapitalTransfers,uniqueCapitalTransfer,CREDIT_CONFIRM} from './capitalCreditTransfers';
import {validCreditScope,scopeDigest} from './capitalCreditProof';
import {capitalNoAuthority,capitalCreditOutcome} from './capitalCreditRepair';
import {sanitizePublic} from '../v13-production/sanitize';
const now=1795000000000,transfer={transfer_id:'synthetic-receipt',from_subaccount:0,to_subaccount:1,amount_cents:272,exchange_index:2,created_ts:now/1000-5};
test('signed transfer history requires complete finite pagination, unique identities and exact applied receipt fields',async()=>{
 const seen:string[]=[];const rows=await readCapitalTransfers(async(_p,q)=>{seen.push(q);return q.includes('cursor')?{transfers:[transfer],cursor:''}:{transfers:[{...transfer,transfer_id:'older-receipt',created_ts:transfer.created_ts-100}],cursor:'next +/'};},now);
 assert.equal(rows.length,2);assert.ok(seen[1].includes('next%20%2B%2F'));assert.equal(uniqueCapitalTransfer(rows,now-10000).amountCents,272);
 for(const raw of [{transfers:[transfer,transfer],cursor:''},{transfers:[{...transfer,amount_cents:2.72}],cursor:''},{transfers:[{...transfer,created_ts:now+1}],cursor:''},{transfers:[{...transfer,exchange_index:null}],cursor:''},{transfers:[],cursor:undefined},{transfers:[],cursor:'repeat'}])await assert.rejects(readCapitalTransfers(async()=>raw,now));
 await assert.rejects(readCapitalTransfers(async()=>{throw Error('403');},now));
 assert.throws(()=>uniqueCapitalTransfer([...rows,{...rows[1],transferId:'third'}],now-10000));
 assert.throws(()=>uniqueCapitalTransfer([{...rows[1],fromSubaccount:1,toSubaccount:0}],now-10000));
 assert.throws(()=>uniqueCapitalTransfer(rows,rows[1].createdAtMs+100));
});
const core={ownerId:'11111111-1111-4111-8111-111111111111',accountId:'owned-account',sha:'a'.repeat(40),policyHash:'b'.repeat(64),checkpointId:'checkpoint',checkpointDigest:'c'.repeat(64),receiptId:'synthetic-receipt',receiptDigest:'d'.repeat(64),receiptCreatedAt:new Date(now-5000).toISOString(),amountCents:272,oldInitialCashMicros:'25000000',newInitialCashMicros:'27720000',cashMicros:'25007000',accountRevision:'123'};
const scope={...core,scopeDigest:scopeDigest(core)};
test('scope is exact, digest bound, bounded int64, and explicit capital delta',()=>{
 assert.equal(validCreditScope(scope),true);for(const s of [{...scope,amountCents:273},{...scope,extra:true},{...scope,newInitialCashMicros:'99999999999999999999999999'},{...scope,receiptCreatedAt:'yesterday'}])assert.equal(validCreditScope(s),false);
});
test('actual production sanitizer preserves complete capital preview and terminal receipt DTOs',()=>{
 for(const dto of [{ok:true,...scope,confirmation:CREDIT_CONFIRM,...capitalNoAuthority},{outcome:'RECORDED',repairId:'22222222-2222-4222-8222-222222222222',...scope,confirmation:CREDIT_CONFIRM,...capitalNoAuthority},{outcome:'REJECTED',repairId:'22222222-2222-4222-8222-222222222222',...scope,confirmation:CREDIT_CONFIRM,noCommit:true,reason:'capital_pending_repair_canceled_or_refused',...capitalNoAuthority}])assert.deepEqual(sanitizePublic(dto),dto);
});
test('outcome malformed owner/id never queries DB or implies retry',async()=>{let calls=0;const r=await capitalCreditOutcome(core.ownerId,'bad',core.sha,{query:async()=>{calls++;return {rows:[]};}});assert.equal(calls,0);assert.deepEqual(r,{outcome:'UNKNOWN',...capitalNoAuthority});});

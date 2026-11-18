import test from 'node:test';import assert from 'node:assert/strict';
import {parseDurableFeeSource,verifyDurableFeeStage,verifyDurableProtectiveAuthority} from './durableFeeConsumers';
import {readOwnerV3ProtectiveSource} from './ownerStandingFeeAuthorization';
import {DURABLE_FEE_VERSION} from './durableOwnerFeePolicy';
const id='11111111-1111-4111-8111-111111111111',source=`strata-durable-owner-fee://${id}`;
test('durable source requires exact versioned identity, not issuer URL or legacy scheme',()=>{
 assert.equal(parseDurableFeeSource(source),id);
 for(const value of [source+'/extra',source+'?owner=x','https://kalshi.com/docs/kalshi-fee-schedule.pdf','strata-owner-fee://'+id,'strata-durable-owner-fee://bad'])assert.equal(parseDurableFeeSource(value),null);
});
test('feature off never contacts DB or provider at startup, market or protective stages',async()=>{
 const prior=process.env.STRATA_DURABLE_OWNER_FEE_ENABLED;delete process.env.STRATA_DURABLE_OWNER_FEE_ENABLED;
 try{assert.equal((await verifyDurableFeeStage(id,'account',source,'ENTRY')).ok,false);
 assert.equal((await verifyDurableFeeStage(id,'account',source,'PROTECTIVE_EXIT','KXBTC15M-X')).ok,false);
 assert.equal((await verifyDurableProtectiveAuthority(id,'account','a'.repeat(40),{query:async()=>{throw Error('must not query')}})).ok,false);
 }finally{if(prior===undefined)delete process.env.STRATA_DURABLE_OWNER_FEE_ENABLED;else process.env.STRATA_DURABLE_OWNER_FEE_ENABLED=prior;}
});
test('durable protective mode selected only from exact approved policy identity',async()=>{
 const row={fee_policy_version:DURABLE_FEE_VERSION,fee_formula_version:'standard-quadratic-0.07-v1',fee_source_url:source,policy_hash:'b'.repeat(64)};
 const db={query:async(sql:string,args?:unknown[])=>{assert.ok(sql.includes("p.state='APPROVED'"));assert.deepEqual(args,[id,'account']);return {rows:[row]}}};
 assert.equal((await readOwnerV3ProtectiveSource(id,'account',db)).mode,'OWNER_DURABLE');
 for(const change of [{fee_formula_version:'unrecognized'},{fee_policy_version:'other'},{policy_hash:'bad'}]){
 const r=await readOwnerV3ProtectiveSource(id,'account',{query:async()=>({rows:[{...row,...change}]})});assert.notEqual(r.mode,'OWNER_DURABLE');}
});
test('supplied PREPARE metadata cannot initiate ticker discovery or protective authority reads',async()=>{
 const previous=process.env.STRATA_DURABLE_OWNER_FEE_ENABLED;process.env.STRATA_DURABLE_OWNER_FEE_ENABLED='true';
 const metadata={read:async()=>{throw Error('must_not_read');},capture:()=>{throw Error('must_not_capture');}};
 try{for(const [intent,ticker] of [['ENTRY',undefined],['PROTECTIVE_EXIT','KXBTC15M-X']] as const){
 const result=await verifyDurableFeeStage(id,'account',source,intent,ticker,metadata);
 assert.equal(result.ok,false);if(!result.ok)assert.equal(result.reason,'durable_fee_prefetch_scope_invalid');
 }}finally{if(previous===undefined)delete process.env.STRATA_DURABLE_OWNER_FEE_ENABLED;else process.env.STRATA_DURABLE_OWNER_FEE_ENABLED=previous;}
});
test('borrowed durable stage failure has no pool retry or transaction ownership',async()=>{
 const old=process.env.STRATA_DURABLE_OWNER_FEE_ENABLED;process.env.STRATA_DURABLE_OWNER_FEE_ENABLED='true';
 let queries=0,lifecycle=0;const borrowed={query:async()=>{queries++;throw Object.assign(Error('synthetic connection lost'),{code:'08006'});},release:()=>{lifecycle++;}};
 try{const result=await verifyDurableFeeStage(id,'account',source,'ENTRY','KXBTC15M-X',undefined,borrowed);
 assert.equal(result.ok,false);if(!result.ok)assert.equal(result.reason,'durable_source_or_market_unavailable');
 assert.equal(queries,1);assert.equal(lifecycle,0);
 }finally{if(old===undefined)delete process.env.STRATA_DURABLE_OWNER_FEE_ENABLED;else process.env.STRATA_DURABLE_OWNER_FEE_ENABLED=old;}
});

test('FINAL handle rejects discovery, protective or mixed metadata before any read',async()=>{
 const old=process.env.STRATA_DURABLE_OWNER_FEE_ENABLED;process.env.STRATA_DURABLE_OWNER_FEE_ENABLED='true';let queries=0;
 const db={query:async()=>{queries++;throw Error('unexpected query');}};
 const handle={kind:'DURABLE_PHASE_PUBLIC_BYTES' as const,read:async()=>{throw Error('read');},capture:()=>{throw Error('capture');}};
 try{for(const [intent,ticker,prepare] of [['ENTRY',undefined,undefined],['PROTECTIVE_EXIT','KXBTC15M-X',undefined],['ENTRY','KXBTC15M-X',handle]] as const){
 const result=await verifyDurableFeeStage(id,'account',source,intent,ticker,prepare,db,handle);assert.equal(result.ok,false);if(!result.ok)assert.equal(result.reason,'durable_fee_prefetch_scope_invalid');
 }assert.equal(queries,0);}finally{if(old===undefined)delete process.env.STRATA_DURABLE_OWNER_FEE_ENABLED;else process.env.STRATA_DURABLE_OWNER_FEE_ENABLED=old;}
});

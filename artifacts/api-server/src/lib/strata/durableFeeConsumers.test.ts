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

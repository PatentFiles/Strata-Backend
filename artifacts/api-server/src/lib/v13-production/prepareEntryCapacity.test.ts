import assert from 'node:assert/strict';
import test from 'node:test';
import {readPrepareEntryCapacity,PREPARE_ENTRY_CAPACITY_SQL} from './prepareEntryCapacity';
const valid={has_prepared:false,open:'0',basis:'0',total_loss:'0',daily_loss:'0'};
const at=new Date('2026-11-18T00:00:00Z');
test('capacity batch performs one account-scoped read and retains exact money strings',async()=>{
 let calls=0;const out=await readPrepareEntryCapacity(async(sql,args)=>{calls++;assert.equal(sql,PREPARE_ENTRY_CAPACITY_SQL);assert.deepEqual(args,['owned',at]);return {rows:[{...valid,basis:'9223372036854775808'}]};},'owned',at);
 assert.equal(calls,1);assert.deepEqual(out,{open:'0',basis:'9223372036854775808',total_loss:'0',daily_loss:'0'});
});
test('pending refusal precedes null capacity validation',async()=>{
 await assert.rejects(readPrepareEntryCapacity(async()=>({rows:[{has_prepared:true,open:null,basis:null,total_loss:null,daily_loss:null}]}),'owned',at),/production_prepared_order_blocks_entry/);
});
for(const rows of [[],[valid,valid],[null],[{...valid,has_prepared:'false'}],[{...valid,basis:null}],[{...valid,open:'-1'}],[{...valid,open:'9007199254740992'}],[{...valid,total_loss:'1.2'}],[{...valid,daily_loss:'00'}]])test(`capacity batch refuses malformed evidence ${JSON.stringify(rows)}`,async()=>{
 await assert.rejects(readPrepareEntryCapacity(async()=>({rows:rows as never}),'owned',at),/production_prepare_capacity_unverified/);
});
test('capacity query failure propagates without fallback or retry',async()=>{
 let calls=0;await assert.rejects(readPrepareEntryCapacity(async()=>{calls++;throw Error('db_unavailable');},'owned',at),/db_unavailable/);assert.equal(calls,1);
});

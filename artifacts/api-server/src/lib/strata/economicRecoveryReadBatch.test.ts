import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeEconomicBatchCell,readEconomicHistoryBatch,readEconomicPendingMoneyBatch} from './economicRecoveryReadBatch';

test('batch transport preserves exact bigint, numeric, date, boolean, null and JSON shapes',()=>{
 for(const n of ['9007199254740993','-9007199254740993','0'])assert.equal(decodeEconomicBatchCell(20,n),n);
 assert.equal(decodeEconomicBatchCell(1700,'123.450000'),'123.450000');
 assert.equal(decodeEconomicBatchCell(23,'25'),25);
 assert.equal(decodeEconomicBatchCell(21,'2'),2);
 assert.equal(decodeEconomicBatchCell(16,'false'),false);
 assert.equal(decodeEconomicBatchCell(16,'true'),true);
 assert.equal(decodeEconomicBatchCell(25,null),null);
 assert.equal(decodeEconomicBatchCell(1184,'2026-11-26T00:00:00.123456+00:00') instanceof Date,true);
 assert.deepEqual(decodeEconomicBatchCell(3802,'{"amount":"9007199254740993","nested":[true,null]}'),{amount:'9007199254740993',nested:[true,null]});
 for(const [oid,value] of [[20,9007199254740992],[23,'9007199254740993'],[16,'1'],[1184,'invalid'],[999999,'value'],[20,'NaN']])assert.throws(()=>decodeEconomicBatchCell(oid,value));
});
test('batch only parameterizes owner-derived account and retains bounds and ordered row locks',async()=>{
 const calls:{sql:string;args:unknown[]|undefined}[]=[];
 const db={query:async(sql:string,args?:unknown[])=>{
  calls.push({sql,args});const names=sql.includes("'events'::text")?['events','positions','markers','receipts']:['topups','allocations','transfers','withdrawals','maintenance'];
  return {rows:names.map(section=>({section,types:{row_revision:25},records:[]}))};
 }};
 const account="untrusted' ; DELETE FROM public.v13_production_event; --";
 await readEconomicHistoryBatch(db,account,true);await readEconomicPendingMoneyBatch(db,account,true);
 assert.equal(calls.length,2);
 for(const c of calls){assert.deepEqual(c.args,[account]);assert.ok(!c.sql.includes(account));assert.match(c.sql,/FOR SHARE OF t/);assert.match(c.sql,/AS MATERIALIZED/);assert.match(c.sql,/count\(\*\) FROM r0/);assert.match(c.sql,/LIMIT 1001/);}
 assert.match(calls[0]!.sql,/LIMIT 3001/);assert.match(calls[0]!.sql,/ORDER BY r.event_id/);
});
test('missing, duplicate or malformed batch sections are not empty financial histories',async()=>{
 const valid=['events','positions','markers','receipts'].map(section=>({section,types:{row_revision:25},records:[]}));
 for(const rows of [[],valid.slice(1),[valid[0],valid[0],valid[2],valid[3]],[{...valid[0],records:[{row_revision:'1',unexpected:'0'}]},...valid.slice(1)]]){
  await assert.rejects(readEconomicHistoryBatch({query:async()=>({rows})} as never,'account',false));
 }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {ReconciliationEventDigests} from './reconciliationEventDigests';
test('reconciliation digest batch is lazy, account-scoped, and one read across existing/new occurrences',async()=>{
 let calls=0;const ids=['fill:one','settlement:new','settlement:new'];
 const index=new ReconciliationEventDigests(async(sql,args)=>{calls++;assert.match(sql,/WHERE account_id=\$1 AND event_id=ANY\(\$2::text\[\]\)/);assert.deepEqual(args,['owned',ids]);return{rows:[{event_id:'fill:one',digest:'known'}]};},'owned',()=>ids);
 assert.equal(calls,0);assert.deepEqual(await index.read('fill:one'),{present:true,digest:'known'});
 assert.deepEqual(await index.read('settlement:new'),{present:false});index.inserted('settlement:new','new-digest');
 assert.deepEqual(await index.read('settlement:new'),{present:true,digest:'new-digest'});assert.equal(calls,1);
});
test('failed INSERT not acknowledged to map remains missing',async()=>{
 const index=new ReconciliationEventDigests(async()=>({rows:[]}),'owned',()=>['fill:new']);
 assert.deepEqual(await index.read('fill:new'),{present:false});
 // The ledger does not call inserted() if its awaited SQL INSERT rejects.
 assert.deepEqual(await index.read('fill:new'),{present:false});
});
for(const rows of [[{event_id:'fill:x',digest:'a'},{event_id:'fill:x',digest:'b'}],[{event_id:'fill:x',digest:null}],[null]])test(`batch refuses malformed or ambiguous database evidence ${JSON.stringify(rows)}`,async()=>{
 const index=new ReconciliationEventDigests(async()=>({rows:rows as never}),'owned',()=>['fill:x']);await assert.rejects(index.read('fill:x'),/production_event_digest_batch_unverified/);
});
test('batch query failure propagates; no cached history or provider fallback',async()=>{
 let calls=0;const index=new ReconciliationEventDigests(async()=>{calls++;throw Error('database_failure');},'owned',()=>['fill:x']);await assert.rejects(index.read('fill:x'),/database_failure/);assert.equal(calls,1);
});
test('uninitialized and duplicate INSERT acknowledgment fail closed',async()=>{
 const index=new ReconciliationEventDigests(async()=>({rows:[]}),'owned',()=>['fill:x']);assert.throws(()=>index.inserted('fill:x','x'),/production_event_digest_batch_unverified/);
 await index.read('fill:x');index.inserted('fill:x','x');assert.throws(()=>index.inserted('fill:x','x'),/production_event_digest_batch_unverified/);
});

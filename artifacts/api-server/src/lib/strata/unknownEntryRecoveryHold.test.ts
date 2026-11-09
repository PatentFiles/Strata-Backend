import {test} from 'node:test';
import assert from 'node:assert/strict';
import {holdUnknownEntryRecovery} from './unknownEntryRecoveryHold';
const scope={ownerId:'11111111-1111-1111-1111-111111111111',accountId:'a',intentId:'i',holderId:'h',fencingToken:'4',keyFingerprint:'a'.repeat(64),policyHash:'b'.repeat(64),financialAccountId:'11111111-1111-1111-1111-111111111112',providerConnectionId:'11111111-1111-1111-1111-111111111113',vaultSecretId:'11111111-1111-1111-1111-111111111114'};
function fixture(fail=''){
 const statements:string[]=[];let discarded=false;
 const db={connect:async()=>({query:async(sql:string)=>{
  statements.push(sql);if(fail&&(fail==='COMMIT'?sql===fail:sql.includes(fail)))throw Error('synthetic_failure');
  if(sql.includes('SELECT p.policy_hash'))return {rows:[{policy_hash:'b'.repeat(64)}]};
  if(sql.includes('fencing_token'))return {rows:[{fencing_token:'4'}]};
  if(sql.includes('SELECT id'))return {rows:[{id:'a'}]};return {rows:[]};
 },release:(error?:Error)=>{discarded=!!error;}})};
 return {db,statements,discarded:()=>discarded};
}
test('hold uses account then exact lease then intent; sole update disarms',async()=>{
 const f=fixture();const r=await holdUnknownEntryRecovery(f.db,scope);
 assert.equal(r.held,true);assert.equal(r.tradingAuthorized,false);
 const q=f.statements;assert.ok(q.findIndex(s=>s.includes('production_account'))<q.findIndex(s=>s.includes('SELECT fencing_token')));
 const writes=q.filter(s=>/^UPDATE/.test(s));assert.equal(writes.length,1);assert.match(writes[0],/SET arm_requested=false/);
 assert.equal(q.at(-1),'COMMIT');assert.equal(f.discarded(),false);
});
for(const failure of ['SELECT id FROM public.v13_production_account','SELECT fencing_token','SELECT id FROM public.v13_production_intent','SELECT p.policy_hash','UPDATE private'])test(`rollback on ${failure}`,async()=>{
 const f=fixture(failure);const r=await holdUnknownEntryRecovery(f.db,scope);
 assert.equal(r.held,false);assert.equal(r.uncertain,false);assert.equal(f.statements.at(-1),'ROLLBACK');assert.equal(f.discarded(),true);
});
test('lost commit acknowledgment cannot retry or claim hold',async()=>{
 const f=fixture('COMMIT');const r=await holdUnknownEntryRecovery(f.db,scope);
 assert.equal(r.held,false);assert.equal(r.uncertain,true);assert.equal(r.mayRetry,false);
 assert.equal(f.statements.at(-1),'COMMIT');assert.equal(f.discarded(),true);
});
test('missing/changed lease refuses before writing',async()=>{
 const f=fixture();const db={connect:async()=>{const c=await f.db.connect();return {...c,query:async(s:string)=>s.includes('SELECT fencing_token')?{rows:[{fencing_token:'5'}]}:c.query(s)};}};
 const r=await holdUnknownEntryRecovery(db,scope);assert.equal(r.reason,'recovery_hold_fence_changed');
 assert.equal(f.statements.some(s=>s.startsWith('UPDATE')),false);
});
test('invalid scope does not connect',async()=>{
 let calls=0;const db={connect:async()=>{calls++;throw Error();}};
 assert.equal((await holdUnknownEntryRecovery(db,{...scope,fencingToken:'0'})).held,false);assert.equal(calls,0);
});

test('caller mutation during connect cannot mix account scope',async()=>{
 const original={...scope};const params:unknown[][]=[];const f=fixture();
 const db={connect:async()=>{original.accountId='foreign';const c=await f.db.connect();return {...c,query:async(sql:string,p:unknown[]=[])=>{params.push(p);return c.query(sql);}};}};
 assert.equal((await holdUnknownEntryRecovery(db,original)).held,true);
 assert.equal(params.some(p=>p.includes('foreign')),false);
});
test('release failure does not erase committed outcome',async()=>{
 const f=fixture();const db={connect:async()=>({...await f.db.connect(),release:()=>{throw Error('cleanup');}})};
 assert.equal((await holdUnknownEntryRecovery(db,scope)).held,true);
});

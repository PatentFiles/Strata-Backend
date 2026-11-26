import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoppedCashBracketAdapter,readStoppedCashDatabaseLeg} from './stoppedCashDiagnosticAdapters';

const owner='11111111-1111-4111-8111-111111111111',at=1_786_000_000_000;
const fp='b'.repeat(64),material={keyId:'fixture',privateKey:'never-export-this'};
const bal='/trade-api/v2/portfolio/balance';
test('real bracket parser rebinds verified owner for opening, history and closing GETs',async()=>{
 const calls:string[]=[];let balances=0;
 const adapter=createStoppedCashBracketAdapter({now:()=>at,get:async(c,path,query,fetcher,host,bound,signal)=>{
  assert.equal(c,material);assert.equal(fetcher,undefined);assert.equal(host,undefined);assert.equal(bound,owner);
  assert.ok(signal);calls.push(path);
  if(path===bal){balances++;assert.equal(query,'?subaccount=1&exchange_index=2');return {balance:2500,balance_dollars:'25.0000',updated_ts:13};}
  assert.match(query??'',/subaccount=1&exchange_index=2/);
  const key=path.endsWith('/positions')?'positions':path.split('/').at(-1)!;
  return {[key]:[],cursor:''};
 }});
 const mapped=await adapter(owner,material,at,[],fp);
 assert.ok(mapped&&mapped.cashMicros==='25000000'&&mapped.authenticated===true&&mapped.complete===true);
 assert.equal(balances,2);
 assert.equal(calls.length,8);assert.equal(calls[0],bal);assert.equal(calls.at(-1),bal);
});
test('database leg uses REPEATABLE READ READ ONLY and releases safely on errors',async()=>{
 const calls:string[]=[];let failed=0;
 const connection=async()=>({query:async(sql:string)=>{calls.push(sql);if(sql==='SELECT broken')throw Error('db');return {rows:[{}]};},
  release:(discard?:boolean)=>{if(discard)failed++;}});
 assert.equal(await readStoppedCashDatabaseLeg(connection,async(q)=>(await q.query('SELECT 1')).rows.length),1);
 await assert.rejects(readStoppedCashDatabaseLeg(connection,q=>q.query('SELECT broken')),/stopped_cash_readonly/);
 assert.equal(failed,1);
 assert.equal(calls.filter(s=>s==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length,2);
 assert.equal(calls.at(-1),'ROLLBACK');
});

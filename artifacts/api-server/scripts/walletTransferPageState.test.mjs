import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {stripTypeScriptTypes} from 'node:module';
const source=readFileSync(new URL('../src/lib/strata/userScopeDatabase.ts', import.meta.url),'utf8');
const start=source.indexOf('function walletTransferPageState'),stop=source.indexOf('function rowsOf',start);
const parser=new Function(stripTypeScriptTypes(source.slice(start,stop),{mode:'transform'})+'\nreturn walletTransferPageState;')();
const row={transfer_id:'synthetic-fixture',amount_cents:42};
test('allowlisted state only with explicit provider cursor and actual page shape',()=>{
 assert.equal(parser({transfers:[row],cursor:'private-cursor-shall-not-leak'}),'more');
 assert.equal(parser({transfers:[],cursor:'will-continue'}),'more');
 assert.equal(parser({transfers:[row],cursor:''}),'last');
 assert.equal(parser({transfers:[],cursor:''}),'last');
});
test('missing/malformed page and ambiguous terminal are not last',()=>{
 for(const payload of [null,[],{}, {transfers:[]}, {transfers:{},cursor:''},{transfers:[],cursor:null},{transfers:[],cursor:0},
  {transfers:[null],cursor:''},{transfers:[[]],cursor:''},{transfers:[],cursor:'  '},{transfers:[],cursor:'good\u0000bad'},
  {transfers:[],cursor:'x'.repeat(1025)},{transfers:new Array(201).fill(row),cursor:''}]){
  assert.equal(parser(payload),'unknown',JSON.stringify(payload));
 }
});
test('existing successful transfer read is required; failure always yields unknown; no extra call',()=>{
 const match=source.match(/subaccountTransferPageState:displayReadDiagnostics\.reads\.transfers\.status==="response_received"\s+\?walletTransferPageState\(transfers\):"unknown" as const/);
 assert.ok(match);
 const project=new Function('transfers','displayReadDiagnostics','walletTransferPageState','return {'+
   stripTypeScriptTypes(match[0],{mode:'transform'}).replace(/;\s*$/,'')+'}');
 assert.deepEqual(project({transfers:[row],cursor:'must-not-return'},{reads:{transfers:{status:'response_received'}}},parser),{subaccountTransferPageState:'more'});
 assert.deepEqual(project({transfers:[],cursor:''},{reads:{transfers:{status:'unavailable'}}},parser),{subaccountTransferPageState:'unknown'});
 assert.equal((source.match(/settled\("transfers", "\/trade-api\/v2\/portfolio\/subaccounts\/transfers", activityQuery\)/g)||[]).length,1);
});

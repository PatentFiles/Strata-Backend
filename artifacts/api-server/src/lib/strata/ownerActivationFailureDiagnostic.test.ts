import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerActivationFailureDiagnostic as diagnostic,OWNER_ACTIVATION_STAGES} from './ownerActivationFailureDiagnostic';

test('signed evidence freshness and stage are identifiable without changing refusal',()=>{
 assert.deepEqual(diagnostic(Error('release_signed_evidence_stale'),'signed_evidence'),{stage:'signed_evidence',failureCode:'release_signed_evidence_stale'});
});
test('unknown provider errors never expose raw text, stacks, SQL or credentials',()=>{
 const secret='PRIVATE KEY and provider response with SQL and credentials';
 const result=diagnostic(Object.assign(Error(secret),{detail:secret,stack:secret,code:secret}),'signed_evidence');
 assert.deepEqual(result,{stage:'signed_evidence',failureCode:'activation_internal_failure'});
 assert.equal(JSON.stringify(result).includes(secret),false);
});
test('only known SQLSTATE values are retained without query or parameters',()=>{
 assert.deepEqual(diagnostic({message:'SQL with private data',code:'55P03',query:'secret'},'locked_scope'),{stage:'locked_scope',failureCode:'activation_internal_failure',sqlState:'55P03'});
 assert.deepEqual(diagnostic({message:'unknown',code:'ZZZZZ'},'locked_scope'),{stage:'locked_scope',failureCode:'activation_internal_failure'});
});
test('null, primitive and unrecognized failures remain sanitized at every stage',()=>{
 for(const stage of OWNER_ACTIVATION_STAGES)for(const error of [null,undefined,'secret',123,{}])assert.deepEqual(diagnostic(error,stage),{stage,failureCode:'activation_internal_failure'});
});

test('throwing exception property getters cannot interrupt refusal',()=>{
 const error=Object.defineProperty({},'message',{get(){throw Error('private getter data');}});
 assert.deepEqual(diagnostic(error,'signed_evidence'),{stage:'signed_evidence',failureCode:'activation_internal_failure'});
});

test('mutable exception getters emit only the exact values checked by the allowlists',()=>{
 let messages=0,codes=0;
 const error={get message(){return ++messages===1?'release_signed_evidence_stale':'private message';},get code(){return ++codes===1?'55P03':'private code';}};
 assert.deepEqual(diagnostic(error,'signed_evidence'),{stage:'signed_evidence',failureCode:'release_signed_evidence_stale',sqlState:'55P03'});
 assert.equal(messages,1);
 assert.equal(codes,1);
});

test('money conservation diagnostic exposes only safe fixed reason, no balances',()=>{assert.deepEqual(diagnostic(Error('production_money_conservation_failed'),'ledger_proof'),{stage:'ledger_proof',failureCode:'production_money_conservation_failed'});});

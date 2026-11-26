import {sanitizePublic} from '../v13-production/sanitize';
import test from 'node:test';import assert from 'node:assert/strict';
import {KalshiApiError} from '../kalshiAccountClient';
import {capitalFailureDiagnostic,capitalStage,logCapitalFailure,capitalPublicReason} from './capitalCreditDiagnostic';
test('typed provider 403 retains fixed stage and status, never response text',async()=>{
 const error=new KalshiApiError('HTTP_ERROR',403);error.message='private account provider body';
 try{await capitalStage('transfer_history',async()=>{throw error;});assert.fail('expected refusal');}catch(e){assert.deepEqual(capitalFailureDiagnostic(e,'preview'),{stage:'transfer_history',failureCode:'capital_provider_read_failed',providerType:'HTTP_ERROR',providerStatus:403});assert.equal(capitalPublicReason(e),'capital_credit_refused');}
});
test('plain forged provider object and unknown SQLSTATE expose no arbitrary fields',()=>{
 assert.deepEqual(capitalFailureDiagnostic({type:'HTTP_ERROR',status:403,message:'secret',code:'XXXXX',query:'secret'},'local_ledger'),{stage:'local_ledger',failureCode:'capital_internal_failure'});
 assert.deepEqual(capitalFailureDiagnostic({message:'relation private details',code:'42703'},'receipt_registry'),{stage:'receipt_registry',failureCode:'capital_internal_failure',sqlState:'42703'});
});
test('known history reason is fixed and nested stage is retained; capital reasons unchanged',async()=>{
 for(const reason of ['release_never_posted_evidence_invalid_or_contradictory','capital_checkpoint_unverified']){
  try{await capitalStage('local_ledger',()=>capitalStage('retained_history',async()=>{throw Error(reason);}));assert.fail('expected');}catch(e){assert.equal(capitalFailureDiagnostic(e,'preview').stage,'retained_history');assert.equal(capitalFailureDiagnostic(e,'preview').failureCode,reason);assert.equal(capitalPublicReason(e),reason.startsWith('capital_')?reason:'capital_credit_refused');}
 }
});
test('throwing and mutable getters cannot leak unchecked error values',()=>{
 const bad={get message(){throw Error('private getter');}};assert.deepEqual(capitalFailureDiagnostic(bad,'preview'),{stage:'preview',failureCode:'capital_internal_failure'});
 let n=0,c=0;const e={get message(){return n++?'private':'production_money_conservation_failed';},get code(){return c++?'private':'55P03';}};
 assert.deepEqual(capitalFailureDiagnostic(e,'final_ledger'),{stage:'final_ledger',failureCode:'production_money_conservation_failed',sqlState:'55P03'});assert.equal(n,1);assert.equal(c,1);
});
test('diagnostic logger failures do not replace refusal or return secrets',()=>{const original=console.warn;console.warn=()=>{throw Error('private logger');};try{assert.deepEqual(logCapitalFailure(new KalshiApiError('NETWORK_ERROR'),'transfer_history'),{stage:'transfer_history',failureCode:'capital_provider_read_failed',providerType:'NETWORK_ERROR'});}finally{console.warn=original;}});

test('safe diagnostic fields survive public sanitizer',()=>{const d={stage:'transfer_history',failureCode:'capital_provider_read_failed',providerType:'HTTP_ERROR',providerStatus:403};assert.deepEqual(sanitizePublic({diagnostic:d}),{diagnostic:d});});

test('registered opening and member budget failures retain only fixed identifiers',async()=>{
 for(const code of ['registered_opening_signed_receipt_mismatch','kalshi_member_budget_unavailable']){
  await assert.rejects(capitalStage('transfer_history',async()=>{throw Error(code);}),e=>{
   const d=capitalFailureDiagnostic(e,'preview');
   assert.deepEqual(d,{stage:'transfer_history',failureCode:code});
   assert.deepEqual(sanitizePublic({diagnostic:d}),{diagnostic:d});
   assert.equal(capitalPublicReason(e),'capital_credit_refused');return true;
  });
 }
 for(const code of ['registered_opening_private_account_details','kalshi_member_budget_private_signature'])
  assert.equal(capitalFailureDiagnostic(Error(code),'preview').failureCode,'capital_internal_failure');
});

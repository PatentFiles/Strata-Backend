import test from 'node:test';
import assert from 'node:assert/strict';
import {conservativeExitFeeMicros} from './fractionalExitFee';
import {maximumExitFeePerContractMicros} from '../microLiveEntryFees';
const ceil=(n:bigint,d:bigint)=>(n+d-1n)/d;
test('exact hundredths scale the existing basis with an upward whole-cent ceiling',()=>{
 const fee={contracts:3,reservedExitFeeCents:6};
 for(const [q,want] of [['1',10000n],['50',10000n],['100',20000n],['125',30000n],['299',60000n],['300',60000n],['301',70000n]] as const)
  assert.equal(conservativeExitFeeMicros(fee,q),want);
 assert.equal(conservativeExitFeeMicros({contracts:9,reservedExitFeeCents:0},'1'),0n);
 assert.equal(conservativeExitFeeMicros(fee,'100000'),20000000n);
});
test('whole-count compatibility reproduces the original exact fee basis and never mutates it',()=>{
 const fee=Object.freeze({contracts:999999999,reservedExitFeeCents:123456789});
 assert.equal(conservativeExitFeeMicros(fee,'99999999900'),1234567890000n);
 assert.equal(conservativeExitFeeMicros({contracts:1,reservedExitFeeCents:Number.MAX_SAFE_INTEGER},'99999999900'),
  BigInt(Number.MAX_SAFE_INTEGER)*999999999n*10000n);
});
test('malformed quantity or fee basis is rejected; no decimal count or float rounding',()=>{
 const fee={contracts:3,reservedExitFeeCents:6};
 for(const q of ['', '0','00','01','-1','+1',' 1','1 ','1.00','1e2','NaN','99999999901','999999999999999999999'])
  assert.throws(()=>conservativeExitFeeMicros(fee,q),/production_exit_fee_quantity_invalid/);
 for(const count of [0,-1,.01,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
  assert.throws(()=>conservativeExitFeeMicros({...fee,contracts:count},'1'));
 for(const cents of [-1,.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
  assert.throws(()=>conservativeExitFeeMicros({...fee,reservedExitFeeCents:cents},'1'));
});
test('all new permitted quantities dominate the actual existing .01-fill bound on both sides',()=>{
 for(const side of ['yes','no'] as const){
  const perContract=maximumExitFeePerContractMicros(1,[1,1000,5000,7500,9999],side)!;
  assert.ok(Number.isSafeInteger(perContract)&&perContract>0);assert.equal(perContract%100,0);
  for(const count of [1,3,17]){
   const basisCents=Number(ceil(BigInt(perContract)*BigInt(count),10000n));
   for(let q=1;q<=100000;q++){
    const actualModelCeil=ceil(BigInt(perContract)*BigInt(q),100n*10000n)*10000n;
    assert.ok(conservativeExitFeeMicros({contracts:count,reservedExitFeeCents:basisCents},String(q))>=actualModelCeil);
   }
  }
 }
});

test('existing ENTRY admission includes the large future exit allowance of cheap high-count $5 orders',async()=>{
 const {preflightV13LiveMoneyEntry}=await import('../v13LiveMoneyEntryPreflight');
 const {computeV13LiveMoneyPolicyHash}=await import('../v13LiveMoneyRisk');
 const {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET}=await import('@workspace/v13-strategy');
 const {maximumEntryFeePerContractMicros}=await import('../microLiveEntryFees');
 const p={id:'offline-fee-audit',version:1,supersedesPolicyId:null,state:'APPROVED' as const,strategyVersion:'V1.3' as const,
  strategyParameterSetId:V13_CHAMPION_PARAMETER_SET.id,strategyParameterHash:V13_CHAMPION_PARAMETER_HASH,
  championSelectionReviewId:'offline-review',championSelectionEvidenceHash:'a'.repeat(64),championSelectedBy:'owner',
  championSelectedAt:new Date(1000),capitalLimitCents:2500,maxEntryStakeCents:500,maxEntryAllInCents:2500,
  maxOpenPositions:1,maxDailyLossCents:2500,maxTotalLossCents:2500,maxQuoteAgeMs:5000,maxFeeEvidenceAgeMs:15000,
  feePolicyVersion:'existing-reviewed-fee',feeSourceUrl:'https://fee-source.invalid',feeFormulaVersion:'existing-formula',
  requireFullDepth:true,entryTimeInForce:'IOC' as const,entryLimitSource:'SIGNAL_REFERENCE_OFFER' as const,
  policyHash:null as string|null,createdBy:'owner',approvedBy:'owner',approvedAt:new Date(2000)};
 p.policyHash=computeV13LiveMoneyPolicyHash(p);
 for(const price of [.0001,.007,.069]){
  const count=Math.floor(5/price+1e-9);
  const entry=maximumEntryFeePerContractMicros(1,price.toFixed(4))!,exit=maximumExitFeePerContractMicros(1)!;
  const fee={policyVersion:p.feePolicyVersion,sourceUrl:p.feeSourceUrl,formulaVersion:p.feeFormulaVersion,
   fingerprint:'offline-existing-fee-basis',verifiedAtMs:10000,contracts:count,limitPrice:price,
   reservedEntryFeeCents:Number(ceil(BigInt(entry)*BigInt(count),10000n)),
   reservedExitFeeCents:Number(ceil(BigInt(exit)*BigInt(count),10000n))};
  assert.ok(fee.reservedExitFeeCents>p.capitalLimitCents,'cheap notional must not imply small future-exit reserve');
  const result=preflightV13LiveMoneyEntry({policy:p,strategyParameterSetId:p.strategyParameterSetId,
   strategyParameterHash:p.strategyParameterHash,signal:'SCOUT',direction:'UP',referenceOffer:price,
   bestAskDollars:price.toFixed(4),askLevels:[{priceDollars:price.toFixed(4),availableContracts:'100000'}],
   quoteAgeMs:0,nowMs:10000,feeEvidence:fee,availableCashCents:2500,capitalRemainingCents:2500,
   openPositions:0,realizedDailyLossCents:0,realizedTotalLossCents:0,configuredStakeCents:500});
  assert.deepEqual(result,{ok:false,reason:'live_money_entry_exceeds_capital_or_stake_limit'});
  console.info('low_price_exit_reserve',JSON.stringify({price,count,entryFeeCents:fee.reservedEntryFeeCents,exitFeeCents:fee.reservedExitFeeCents}));
 }
});

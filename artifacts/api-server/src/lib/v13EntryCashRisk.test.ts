import test from 'node:test';import assert from 'node:assert/strict';
import {ENTRY_CASH_RISK_VERSION,cashRiskModelFingerprint,cashRiskFeeFingerprint,entryCashProof,planCashBoundEntry,
 validEntryCashRisk,pinnedEntryDepthAvailable,samePinnedCashModel,entryFillFeeUpperMicros} from './v13EntryCashRisk';
import type {V13VerifiedFeeEvidence} from './v13LiveMoneyEntryPreflight';
function basis(price=.52,count=9):V13VerifiedFeeEvidence{
 const model={version:ENTRY_CASH_RISK_VERSION,marketTicker:'KXBTC15M-TEST-000',side:'YES' as const,
  policyHash:'a'.repeat(64),artifactDigest:'b'.repeat(64),feeMetadataDigest:'c'.repeat(64),seriesDigest:'d'.repeat(64),gridDigest:'e'.repeat(64)};
 const cashRisk={...model,modelFingerprint:cashRiskModelFingerprint(model),entryCashDebitPerContractMicros:1000000,
  entryTradeFeePerContractMicros:price>=.5?17500:Math.ceil(.07*.01*price*(1-price)*1e6)*100,exitLossPerContractMicros:999000};
 const fee={policyVersion:'test',sourceUrl:'test',formulaVersion:'test',verifiedAtMs:10000,fingerprint:'',contracts:count,limitPrice:price,cashRisk,
  reservedEntryFeeCents:Math.ceil(cashRisk.entryTradeFeePerContractMicros*count/10000),reservedExitFeeCents:Math.ceil(cashRisk.exitLossPerContractMicros*count/10000)};
 fee.fingerprint=cashRiskFeeFingerprint(fee);return fee;
}
const plan=(fee:V13VerifiedFeeEvidence,budgetCents:number,depth='100')=>planCashBoundEntry({signal:'SCOUT',direction:'UP',referenceOffer:.52,
 maxStakeCents:500,bestAskDollars:fee.limitPrice.toFixed(4),askLevels:[{priceDollars:fee.limitPrice.toFixed(4),availableContracts:depth}],fee,budgetCents});
test('625-cent maximum selects three whole contracts without double counting gross, price changes or invented depth',()=>{
 const fee=basis(),r=plan(fee,625);assert.equal(r.ok,true);if(!r.ok)return;
 assert.equal(r.plan.contracts,3);assert.equal(r.plan.limitPrice,.52);assert.equal(r.plan.worstCaseGrossCents,156);
 assert.equal(r.cashRisk.reservedEntryCashCents,300);assert.equal(r.cashRisk.reservedExitFeeCents,300);assert.equal(r.cashRisk.plannedAllInCents,600);
 assert.equal(r.plan.visibleContractsAtLimit,100);assert.equal(fee.contracts,9);
 assert.equal(plan(fee,199).ok,false);const one=plan(fee,200);assert.ok(one.ok&&one.plan.contracts===1);
 const shallow=plan(fee,625,'2.99');assert.ok(shallow.ok&&shallow.plan.contracts===2);
 assert.equal(plan(fee,625,'0.99').ok,false);
});
test('all-in boundary and whole-count behavior are exact at every allowed cash budget',()=>{
 const fee=basis();for(let cents=1;cents<=1000;cents++){
  const r=plan(fee,cents);if(r.ok){assert.ok(r.cashRisk.plannedAllInCents<=cents);assert.ok(Number.isInteger(r.plan.contracts));
   const next=entryCashProof(fee,r.plan.contracts+1,cents);if(next)assert.ok(next.plannedAllInCents>cents||r.plan.contracts===9);
  }else assert.ok(cents<200);
 }
});
test('model/basis/receipt forgery and unsupported versions cannot authorize a plan',()=>{
 for(const patch of [{entryCashDebitPerContractMicros:500000},{gridDigest:'f'.repeat(64)},{entryTradeFeePerContractMicros:0},{version:'DIRECT_CENTICENT'}]){
  const fee=basis();Object.assign(fee.cashRisk!,patch);assert.equal(validEntryCashRisk(fee),false);assert.equal(plan(fee,625).ok,false);
 }
 for(const patch of [{contracts:9.1},{reservedExitFeeCents:1},{fingerprint:'f'.repeat(64)}]){const fee={...basis(),...patch};assert.equal(validEntryCashRisk(fee),false);}
});
test('pinned-order admissibility accepts better or more depth but never raises quantity or limit',()=>{
 assert.equal(pinnedEntryDepthAvailable('0.4900',[{priceDollars:'0.4900',availableContracts:'2.50'},{priceDollars:'0.5100',availableContracts:'0.50'}],3,520000),true);
 for(const [ask,qty] of [['0.5300','100'],['0.4900','2.99']] as const)
  assert.equal(pinnedEntryDepthAvailable(ask,[{priceDollars:ask,availableContracts:qty}],3,520000),false);
 assert.equal(pinnedEntryDepthAvailable('0.4900',[{priceDollars:'0.4900',availableContracts:'3.001'}],3,520000),false);
});
test('fresh quote basis may change only under the same verified semantic model; original reserve never shrinks',()=>{
 const original=basis(),fresh=basis(.49,10);assert.notEqual(original.fingerprint,fresh.fingerprint);assert.equal(samePinnedCashModel(original,fresh),true);
 assert.equal(entryCashProof(original,3,625)!.plannedAllInCents,600);
 for(const field of ['policyHash','artifactDigest','feeMetadataDigest','seriesDigest','gridDigest'] as const){const changed=basis(.49,10);changed.cashRisk![field]='f'.repeat(64);
  changed.cashRisk!.modelFingerprint=cashRiskModelFingerprint(changed.cashRisk!);changed.fingerprint=cashRiskFeeFingerprint(changed);
  assert.equal(samePinnedCashModel(original,changed),false);
 }
 const forged=basis();forged.cashRisk!.entryTradeFeePerContractMicros=100;forged.reservedEntryFeeCents=1;forged.fingerprint=cashRiskFeeFingerprint(forged);
 assert.equal(samePinnedCashModel(original,forged),false);
});
test('actual per-fill fee bound uses aligned joint gross+fee, not arbitrary leftover cash or extra cent',()=>{
 const fee=basis();assert.equal(entryFillFeeUpperMicros(fee,100n,500000),20000n);
 assert.equal(entryFillFeeUpperMicros(fee,100n,490000),20000n);
 assert.equal(entryFillFeeUpperMicros(fee,1n,520000),4800n);
 assert.equal(entryFillFeeUpperMicros(fee,300n,520000),60000n);
 assert.equal(entryFillFeeUpperMicros(fee,1n,530000),null);
 for(let q=1n;q<=900n;q++)for(const p of [100,10000,490000,500000,520000]){
  const cap=entryFillFeeUpperMicros(fee,q,p)!;const gross=q*BigInt(p)/100n;
  assert.ok(cap>=0n);assert.equal((gross+cap)%10000n,0n);assert.ok(gross+cap<=q*10000n);
 }
});

test('versioned EXIT scaling uses exact per-unit allowance without second basis-cent rounding',async()=>{
 const {conservativeExitFeeMicros}=await import('./v13-production/fractionalExitFee');
 for(const count of [1,3,9]){
  const fee=basis(.52,count);
  for(const q of ['1','50','99','100','125','299','300','100000']){
   const exact=(999000n*BigInt(q)+999999n)/1000000n*10000n;
   assert.equal(conservativeExitFeeMicros(fee,q),exact);
  }
 }
 const fee=basis();fee.cashRisk!.exitLossPerContractMicros=100;
 assert.throws(()=>conservativeExitFeeMicros(fee,'100'),/production_exit_fee_quantity_invalid/);
});

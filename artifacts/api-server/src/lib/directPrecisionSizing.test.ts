import test from 'node:test';import assert from 'node:assert/strict';
import {DIRECT_ENTRY_CASH_RISK_VERSION,cashRiskModelFingerprint,cashRiskFeeFingerprint,planCashBoundEntry,validEntryCashRisk,samePinnedCashModel,entryFillFeeUpperMicros} from './v13EntryCashRisk';
import {prepareDirectPrecisionBounds} from './directPrecisionCashBounds';
import {DIRECT_ROUNDING_EVIDENCE_VERSION,type DirectAccountRoundingEvidence} from './strata/directAccountRoundingEvidence';
import {repriceVerifiedEntryFee} from './entryCashFeeRepricing';
import {digest} from './v13-production/types';
import type {V13VerifiedFeeEvidence} from './v13LiveMoneyEntryPreflight';
const evidence=():DirectAccountRoundingEvidence=>({version:DIRECT_ROUNDING_EVIDENCE_VERSION,accountId:'12345678-1234-1234-1234-123456789abc',subaccount:1,exchangeIndex:2,executionCredentialFingerprint:'a'.repeat(64),verificationCredentialFingerprint:'b'.repeat(64),documentationPolicyDigest:'c'.repeat(64),scopeGeneration:1,authorityIssuedAtMs:1000,authorityExpiresAtMs:100000,observedAtMs:2000,expiresAtMs:17000,balanceResponseDigest:'d'.repeat(64),keyMetadataDigest:'e'.repeat(64)});
const grid={structure:'deci_cent' as const,ranges:[{start:'0.0000',end:'1.0000',step:'0.0001'}]};
function fixture(price=.52,side:'YES'|'NO'='YES',contracts=9):V13VerifiedFeeEvidence{
 const model={version:DIRECT_ENTRY_CASH_RISK_VERSION,roundingEvidence:evidence(),marketTicker:'KXBTC15M-TEST-000',side,
 policyHash:'a'.repeat(64),artifactDigest:'b'.repeat(64),feeMetadataDigest:'c'.repeat(64),seriesDigest:'d'.repeat(64),gridDigest:digest(grid)};
 const b=prepareDirectPrecisionBounds(Array.from({length:9999},(_,i)=>i+1),side)!(price)!;
 const cashRisk={...model,gridEvidence:structuredClone(grid),modelFingerprint:cashRiskModelFingerprint(model),entryCashDebitPerContractMicros:b.cash,entryTradeFeePerContractMicros:b.trade,exitLossPerContractMicros:b.exit};
 const fee={policyVersion:'test',sourceUrl:'test',formulaVersion:'test',verifiedAtMs:2000,fingerprint:'',contracts,limitPrice:price,cashRisk,reservedEntryFeeCents:Math.ceil(b.trade*contracts/10000),reservedExitFeeCents:Math.ceil(b.exit*contracts/10000)};
 fee.fingerprint=cashRiskFeeFingerprint(fee);return fee;
}
function plan(fee:V13VerifiedFeeEvidence,budgetCents=625,levels=[{priceDollars:fee.limitPrice.toFixed(4),availableContracts:'100'}],stake=500){return planCashBoundEntry({signal:'SCOUT',direction:fee.cashRisk!.side==='YES'?'UP':'DOWN',referenceOffer:.60,maxStakeCents:stake,bestAskDollars:levels[0]!.priceDollars,askLevels:levels,fee,budgetCents});}
test('conditional direct model requests9/11 without changing gross or risk limits',()=>{
 for(const side of ['YES','NO'] as const)for(const [price,count,allin] of [[.52,9,511],[.43,11,526]]){const fee=fixture(price,side,count),original=structuredClone(fee);assert.ok(validEntryCashRisk(fee));const r=plan(fee);assert.ok(r.ok);if(!r.ok)continue;assert.equal(r.plan.contracts,count);assert.equal(r.cashRisk.version,DIRECT_ENTRY_CASH_RISK_VERSION);assert.equal(r.cashRisk.plannedAllInCents,allin);assert.ok(r.plan.worstCaseGrossCents<=500);assert.deepEqual(fee,original);}
});
test('cash bound varies by selected limit and maximizes count over real depth',()=>{
 const fee=fixture(.43);const r=plan(fee,625,[{priceDollars:'0.4300',availableContracts:'1'},{priceDollars:'0.5200',availableContracts:'100'}]);assert.ok(r.ok);if(!r.ok)return;assert.equal(r.plan.contracts,9);assert.equal(r.plan.limitPrice,.52);assert.equal(r.feeEvidence.cashRisk!.entryCashDebitPerContractMicros,540000);
});
test('a high-price original basis does not reject an affordable lower-price candidate',()=>{
 const r=plan(fixture(.52),50,[{priceDollars:'0.4300',availableContracts:'100'}]);assert.ok(r.ok);if(r.ok){assert.equal(r.plan.contracts,1);assert.equal(r.cashRisk.plannedAllInCents,48);}
});
test('risk and shallow depth can still reduce size; no target top-up',()=>{
 const r=plan(fixture(),200);assert.ok(r.ok&&r.plan.contracts===3);
 const s=plan(fixture(),625,[{priceDollars:'0.5200',availableContracts:'2.99'}]);assert.ok(s.ok&&s.plan.contracts===2);
 const h=plan(fixture(),625,[{priceDollars:'0.5200',availableContracts:'100'}],100);assert.ok(h.ok&&h.plan.contracts===1);
});
test('missing/wrong evidence, modified grid, under-reserved basis rejected',()=>{
 for(const mutate of [(f:any)=>delete f.cashRisk.roundingEvidence,(f:any)=>f.cashRisk.roundingEvidence.subaccount=0,(f:any)=>f.cashRisk.gridEvidence.ranges[0].step='0.0100',(f:any)=>f.cashRisk.entryCashDebitPerContractMicros=10000]){
 const fee=fixture();mutate(fee);fee.cashRisk!.modelFingerprint=cashRiskModelFingerprint(fee.cashRisk!);fee.fingerprint=cashRiskFeeFingerprint(fee);assert.equal(plan(fee).ok,false);}
});
test('new observation preserves pin but account/key/authority change does not',()=>{
 const a=fixture(),b=fixture(.49);b.cashRisk!.roundingEvidence!.observedAtMs=3000;b.cashRisk!.roundingEvidence!.expiresAtMs=18000;b.cashRisk!.roundingEvidence!.balanceResponseDigest='f'.repeat(64);b.cashRisk!.modelFingerprint=cashRiskModelFingerprint(b.cashRisk!);b.fingerprint=cashRiskFeeFingerprint(b);assert.equal(samePinnedCashModel(a,b),true);
 const c=fixture(.49);c.cashRisk!.roundingEvidence!.scopeGeneration=2;c.cashRisk!.modelFingerprint=cashRiskModelFingerprint(c.cashRisk!);c.fingerprint=cashRiskFeeFingerprint(c);assert.equal(samePinnedCashModel(a,c),false);
 assert.equal(samePinnedCashModel(fixture(.43),fixture(.52)),false);
});
test('repricing preserves independent authority times and computes exact changed price bounds',()=>{
 const old=fixture(.43);const fresh=repriceVerifiedEntryFee(old,grid,9,.52)!;assert.ok(fresh);assert.equal(fresh.cashRisk!.entryCashDebitPerContractMicros,540000);assert.deepEqual(fresh.cashRisk!.roundingEvidence,old.cashRisk!.roundingEvidence);assert.equal(fresh.verifiedAtMs,old.verifiedAtMs);
});
test('actual fill checker follows pinned quantum, not a new default',()=>{
 const fee=fixture();assert.equal(entryFillFeeUpperMicros(fee,1n,520000),200n);assert.equal(entryFillFeeUpperMicros(fee,900n,520000),157300n);assert.equal(entryFillFeeUpperMicros(fee,901n,520000),null);
});

test('same-price fresh cash under-reservation cannot pass pinned comparison',()=>{
 const pinned=fixture(),fresh=fixture();fresh.cashRisk!.entryCashDebitPerContractMicros=530000;fresh.fingerprint=cashRiskFeeFingerprint(fresh);assert.ok(validEntryCashRisk(fresh));assert.equal(samePinnedCashModel(pinned,fresh),false);
});

test('lower-price fresh or pinned direct under-reservation fails exact grid recomputation',()=>{
 const pinned=fixture(),fresh=fixture(.49);fresh.cashRisk!.entryCashDebitPerContractMicros=10000;fresh.fingerprint=cashRiskFeeFingerprint(fresh);assert.ok(validEntryCashRisk(fresh));assert.equal(samePinnedCashModel(pinned,fresh),false);
 const bad=fixture();bad.cashRisk!.entryCashDebitPerContractMicros=530000;bad.fingerprint=cashRiskFeeFingerprint(bad);assert.equal(samePinnedCashModel(bad,fixture(.49)),false);
});
test('direct planner matches independent maximal-count search across prices, depth and budgets',()=>{
 const fee=fixture(.1),limits=[.1,.43,.52];
 const b=prepareDirectPrecisionBounds(Array.from({length:9999},(_,i)=>i+1),'YES')!;
 for(const firstDepth of [0.5,2,20])for(const budget of [50,200,625]){
 const levels=limits.map((p,i)=>({priceDollars:p.toFixed(4),availableContracts:String(i===0?firstDepth:5)}));
 let expected=0,depth=0;
 for(let i=0;i<limits.length;i++){depth+=Number(levels[i]!.availableContracts);const p=limits[i]!,v=b(p)!;
 for(let n=1;n<=Math.floor(depth);n++)if(n*p<=5+1e-12&&Math.ceil(v.cash*n/10000)+Math.ceil(v.exit*n/10000)<=budget)expected=Math.max(expected,n);
 }
 const actual=plan(fee,budget,levels);assert.equal(actual.ok?actual.plan.contracts:0,expected);
 }
});

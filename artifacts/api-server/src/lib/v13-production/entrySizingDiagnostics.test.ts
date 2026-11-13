import test from 'node:test';
import assert from 'node:assert/strict';
import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET,V13_LEGACY_ENTRY_POLICY} from '@workspace/v13-strategy';
import {computeV13LiveMoneyPolicyHash,type V13ApprovedLiveMoneyPolicy} from '../v13LiveMoneyRisk';
import {preflightV13LiveMoneyEntry,type V13LiveMoneyEntryPreflightInput} from '../v13LiveMoneyEntryPreflight';
import {planV13IocEntry} from '../v13ExecutionPlanner';
import {cashRiskFeeFingerprint} from '../v13EntryCashRisk';
import {entryCashRiskFeeFixture} from './entryCashRisk.fixture';
import {captureEntrySizingDiagnostics,isEntrySizingDiagnostics} from './entrySizingDiagnostics';
import {beginExecutionStage,type StageTiming} from './stageTiming';
import {ProductionExecutor} from './executor';

// Offline fixtures, not live approval or evidence of a cheaper fee model.
const now=Date.parse('2026-11-10T00:00:00Z');
function input(price=.52,depth=100,stake=500):V13LiveMoneyEntryPreflightInput{
 const p:V13ApprovedLiveMoneyPolicy={id:'offline-sizing-test',version:1,supersedesPolicyId:null,state:'APPROVED',
  strategyVersion:'V1.3',strategyParameterSetId:V13_CHAMPION_PARAMETER_SET.id,strategyParameterHash:V13_CHAMPION_PARAMETER_HASH,
  championSelectionReviewId:'offline-test',championSelectionEvidenceHash:'a'.repeat(64),championSelectedBy:'offline-test',championSelectedAt:new Date(now-1),
  capitalLimitCents:2500,maxEntryStakeCents:stake,maxEntryAllInCents:Math.max(625,Math.ceil(stake*1.25)),maxOpenPositions:1,maxDailyLossCents:1000,maxTotalLossCents:1500,
  maxQuoteAgeMs:5000,maxFeeEvidenceAgeMs:5000,feePolicyVersion:'offline-test',feeSourceUrl:'https://invalid.test/fees',feeFormulaVersion:'offline-test',
  requireFullDepth:true,entryTimeInForce:'IOC',entryLimitSource:'SIGNAL_REFERENCE_OFFER',policyHash:null,
  createdBy:'offline-test',approvedBy:'offline-test',approvedAt:new Date(now-1)};
 p.policyHash=computeV13LiveMoneyPolicyHash(p);
 const fee=entryCashRiskFeeFixture({now,market:'KXBTC15M-SIZING-TEST',side:'NO',price,contracts:100,
  policyHash:p.policyHash,policyVersion:p.feePolicyVersion!,sourceUrl:p.feeSourceUrl!,formulaVersion:p.feeFormulaVersion!});
 return {policy:p,strategyParameterSetId:V13_CHAMPION_PARAMETER_SET.id,strategyParameterHash:V13_CHAMPION_PARAMETER_HASH,
  signal:'SCOUT',direction:'DOWN',referenceOffer:price,bestAskDollars:price.toFixed(4),
  askLevels:[{priceDollars:price.toFixed(4),availableContracts:String(depth)}],quoteAgeMs:1000,nowMs:now,
  feeEvidence:fee,availableCashCents:2500,capitalRemainingCents:2500,openPositions:0,realizedDailyLossCents:0,realizedTotalLossCents:0,
  configuredStakeCents:stake,requireCashRisk:true};
}
function capture(i:V13LiveMoneyEntryPreflightInput){
 const result=preflightV13LiveMoneyEntry(i);assert.ok(result.ok);
 const before=JSON.stringify(result),d=captureEntrySizingDiagnostics(i,result);assert.ok(d);
 assert.equal(JSON.stringify(result),before,'explanation must not mutate the authoritative plan');
 return {result,d};
}

test('52c and 43c orders are gross/depth candidates of 9 and 11, but risk permits only 3',()=>{
 for(const [price,count,gross] of [[.52,9,156],[.43,11,129]]){
  const {result,d}=capture(input(price));
  assert.equal(result.plan.contracts,3);assert.equal(d.requestedContracts,3);
  assert.equal(d.grossAndDepthOnlyContracts,count);assert.equal(d.grossOnlyWholeContractsAtSelectedLimit,count);
  assert.equal(d.configuredGrossCeilingCents,500);assert.equal(d.worstCaseGrossCents,gross);
  assert.equal(d.maximumContractsUnderCashRisk,3);assert.equal(d.riskReserveBudgetCents,625);
  assert.deepEqual(d.bindingRiskBudgets,['approvedAllIn']);assert.equal(d.reducedByAdditionalConstraints,true);
  assert.equal(d.entryCashReserveCents,300);assert.equal(d.exitLossReserveCents,300);assert.equal(d.plannedAllInReserveCents,600);
  assert.equal(d.actualFilledContracts,null);assert.equal(d.actualGrossCents,null);assert.equal(d.actualFeesCents,null);
  assert.equal(d.execution,'SINGLE_IOC_NO_FILL_GUARANTEE_NO_TOP_UP');
 }
});

test('larger configured stake is not hard-coded back to five dollars, and no risk cap is increased',()=>{
 const i=input(.46,100,1000);
 // Synthetic larger APPROVED ceiling, with available cash still independently binding.
 i.availableCashCents=625;
 const {d}=capture(i);
 assert.equal(d.configuredGrossCeilingCents,1000);assert.equal(d.grossAndDepthOnlyContracts,21);
 assert.equal(d.requestedContracts,3);assert.equal(d.maximumContractsUnderCashRisk,3);
 assert.deepEqual(d.bindingRiskBudgets,['availableCash']);assert.equal(i.policy.maxEntryAllInCents,1250);assert.equal(i.policy.maxDailyLossCents,1000);assert.equal(i.policy.maxTotalLossCents,1500);
 assert.equal(i.policy.maxQuoteAgeMs,5000);assert.equal(i.policy.maxFeeEvidenceAgeMs,5000);
});

test('configured stake above the approved ceiling is still refused and never described as executable',()=>{
 const i=input();i.configuredStakeCents=1000;
 const r=preflightV13LiveMoneyEntry(i);assert.deepEqual(r,{ok:false,reason:'live_money_configured_stake_invalid'});
 assert.equal(captureEntrySizingDiagnostics(i,r),undefined);
});

test('genuinely shallow depth permits smaller IOC without a new target-shortfall rejection',()=>{
 const {result,d}=capture(input(.41,2));
 assert.equal(result.plan.contracts,2);assert.equal(d.grossAndDepthOnlyContracts,2);
 assert.equal(d.grossOnlyWholeContractsAtSelectedLimit,12);assert.equal(d.visibleWholeContractsAtSelectedLimit,2);
 assert.equal(d.reducedByAdditionalConstraints,false);assert.equal(d.worstCaseGrossCents,82);
});

test('remaining cash, capital, daily and total loss budgets independently reduce the allowed quantity',()=>{
 const cases: Array<[string,(i:V13LiveMoneyEntryPreflightInput)=>void]>= [
  ['availableCash',i=>{i.availableCashCents=400;}],['remainingCapital',i=>{i.capitalRemainingCents=400;}],
  ['remainingDailyLoss',i=>{i.realizedDailyLossCents=600;}],['remainingTotalLoss',i=>{i.realizedTotalLossCents=1100;}],
 ];
 for(const [key,change] of cases){const i=input();change(i);const {d}=capture(i);
  assert.equal(d.requestedContracts,2);assert.equal(d.riskReserveBudgetCents,400);assert.deepEqual(d.bindingRiskBudgets,[key]);}
});

test('equal binding budgets are all reported, without adding them or confusing fees with gross',()=>{
 const i=input();i.availableCashCents=625;i.capitalRemainingCents=625;i.realizedDailyLossCents=375;i.realizedTotalLossCents=875;
 const {d}=capture(i);assert.deepEqual(d.bindingRiskBudgets,['approvedAllIn','availableCash','remainingCapital','remainingDailyLoss','remainingTotalLoss']);
 assert.equal(d.riskReserveBudgetCents,625);assert.equal(d.plannedAllInReserveCents,600);
 assert.equal(d.worstCaseGrossCents,156);assert.equal(d.entryCashReserveCents,300);
});

test('a restricted legacy fee quantity is distinguishable from the cash-risk ceiling',()=>{
 const i=input();delete i.feeEvidence.cashRisk!.gridEvidence;
 // Fingerprints deliberately bind grid digest, not the optional carried grid.
 i.feeEvidence.contracts=2;i.feeEvidence.reservedEntryFeeCents=Math.ceil(i.feeEvidence.cashRisk!.entryTradeFeePerContractMicros*2/10000);
 i.feeEvidence.reservedExitFeeCents=Math.ceil(i.feeEvidence.cashRisk!.exitLossPerContractMicros*2/10000);
 // Recompute the exact quantity fingerprint, not a cheaper risk envelope.
 i.feeEvidence.fingerprint=cashRiskFeeFingerprint(i.feeEvidence);
 const {d}=capture(i);assert.equal(d.requestedContracts,2);assert.equal(d.maximumContractsUnderCashRisk,3);
 assert.equal(d.verifiedFeeQuantityCeiling,2);assert.equal(d.reducedByAdditionalConstraints,true);
});

test('legacy exact-fee test terms report gross and fee reserves separately, not as actual fees',()=>{
 const i=input(.46);i.requireCashRisk=false;delete i.feeEvidence.cashRisk;
 i.feeEvidence.contracts=10;i.feeEvidence.reservedEntryFeeCents=20;i.feeEvidence.reservedExitFeeCents=20;
 const {d}=capture(i);assert.equal(d.requestedContracts,10);assert.equal(d.worstCaseGrossCents,460);
 assert.equal(d.entryCashReserveCents,480);assert.equal(d.exitLossReserveCents,20);assert.equal(d.plannedAllInReserveCents,500);
 assert.equal(d.actualFeesCents,null);assert.equal(d.maximumContractsUnderCashRisk,null);
});

test('five-second freshness and price limits are unchanged, including the 5001ms rejection',()=>{
 const quote=input();quote.quoteAgeMs=5001;
 const qr=preflightV13LiveMoneyEntry(quote);assert.equal(qr.ok,false);assert.equal(captureEntrySizingDiagnostics(quote,qr),undefined);
 const fee=input();fee.feeEvidence.verifiedAtMs=now-5001;
 assert.deepEqual(preflightV13LiveMoneyEntry(fee),{ok:false,reason:'live_money_fee_evidence_invalid_or_stale'});
 const price=input();price.referenceOffer=.51;
 assert.deepEqual(preflightV13LiveMoneyEntry(price),{ok:false,reason:'live_money_best_ask_above_signal_ceiling'});
 const edge=input();edge.quoteAgeMs=5000;assert.ok(preflightV13LiveMoneyEntry(edge).ok);
});

test('capture is frozen, whitelisted and best-effort even for hostile getters',()=>{
 const i=input(),{result,d}=capture(i);
 assert.ok(isEntrySizingDiagnostics(d));assert.ok(Object.isFrozen(d));assert.ok(Object.isFrozen(d.bindingRiskBudgets));
 assert.equal(isEntrySizingDiagnostics({...d}),false);
 assert.equal(captureEntrySizingDiagnostics(new Proxy(i,{get(){throw Error('secret');}}),result),undefined);
 for(const field of ['contracts','expectedGrossCents','worstCaseGrossCents','visibleContractsAtLimit']){
  const altered={...result,plan:{...result.plan,[field]:{rawBody:'SECRET'}}};
  assert.equal(captureEntrySizingDiagnostics(i,altered as never),undefined);
 }
 assert.equal(captureEntrySizingDiagnostics(i,{...result,cashRisk:{...result.cashRisk,version:{rawBody:'SECRET'}}} as never),undefined);
 const text=JSON.stringify(d);assert.ok(!text.includes('policyHash'));assert.ok(!text.includes('fingerprint'));assert.ok(!text.includes('sourceUrl'));
 assert.equal(captureEntrySizingDiagnostics({...i,askLevels:Array(1001).fill(i.askLevels[0])},result),undefined);
});

test('only genuine sizing diagnostics appear on prepare stages; observer failures cannot become authority',async()=>{
 const {d}=capture(input()),events:StageTiming[]=[];
 const context={accountId:'offline-account',mode:'SIMULATION' as const};
 const observer=(event:Readonly<StageTiming>)=>{events.push(event);throw Error('observer_failure');};
 beginExecutionStage(observer,'prepare_entry',context)('completed',{entrySizing:d});
 beginExecutionStage(observer,'dispatch',context)('completed',{entrySizing:d});
 beginExecutionStage(observer,'prepare_entry',context)('completed',{entrySizing:{...d}});
 await Promise.resolve();assert.equal(events.length,3);assert.equal(events[0]!.entrySizing,d);
 assert.equal(events[1]!.entrySizing,undefined);assert.equal(events[2]!.entrySizing,undefined);
});

test('real prepare wiring records sizing without changing request/reservation or waiting for observers',async()=>{
 const runs=[];
 for(const observe of [false,true]){
  const i=input(.52),source={evaluation_source:'paper',strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,
   strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,qualifying_trigger:true,fresh_cross:true,position_was_open:false,
   crossing_key:'offline-cross',feed_freshness:'current',signal:'SCOUT',direction:'DOWN',evaluated_at:new Date(now-1000),
   entry_policy_version:V13_LEGACY_ENTRY_POLICY,market_ticker:'KXBTC15M-SIZING-TEST',target:77035,btc_price:77025,
   previous_side:'UP',velocity:-38,signed_buffer:-10,up_offer:.49,down_offer:.52,entry_offer:.52,
   btc_provider_age_ms:0,btc_receive_age_ms:0,market_age_ms:0};
  const account={id:'offline-account',cash_micros:'25000000',reserved_micros:'0',subaccount:1,exchange_index:2,key_fingerprint:'offline'};
  let requested:Record<string,unknown>|undefined,decision:Record<string,any>|undefined,bookReads=0,posts=0;
  const tx={query:async(sql:string,args?:unknown[])=>{
   if(sql.includes('FROM forward_test_evaluations'))return {rows:[source]};
   if(sql.includes('AS total_loss'))return {rows:[{basis:'0',total_loss:'0',daily_loss:'0',open:0}]};
   if(sql.includes('FROM strata_configured_stake'))return {rows:[{configured_stake_cents:500,revision:1}]};
   if(sql.startsWith('INSERT INTO v13_production_intent')){requested=JSON.parse(String(args![6]));decision=JSON.parse(String(args![7]));}
   return {rows:[]};
  }};
  const ledger={accountId:account.id,pool:{query:async()=>({rows:[source]})},
   transaction:async(fn:(tx:unknown,a:unknown)=>unknown)=>fn(tx,account),policy:async()=>i.policy,
   persist:async()=>{},assertConservation:async()=>{}};
  const executor=new ProductionExecutor(ledger as never,{mode:'SIMULATION',
   market:async()=>{bookReads++;return {bestAskDollars:i.bestAskDollars,bestBidDollars:'0.5100',asks:i.askLevels,bids:[],observedAtMs:now,fee:i.feeEvidence};},
   submit:async()=>{posts++;throw Error('unexpected_post');}} as never,()=>now);
  // Unit-test ledger/gate doubles only; not native Postgres or live qualification.
  executor.gate=async()=>{};
  const events:StageTiming[]=[];
  if(observe)executor.timingObserver=e=>{events.push(e);return new Promise<void>(()=>{});};
  await executor.prepareEntry('offline-evaluation');
  assert.ok(requested);assert.ok(decision);assert.equal(bookReads,1);assert.equal(posts,0);
  assert.equal(requested.contracts,3);assert.equal(requested.limitMicros,520000);assert.equal(requested.timeInForce,'IOC');
  assert.equal(account.reserved_micros,'6000000');assert.equal(decision.configuredStakeCents,500);
  assert.equal(decision.preflight.plannedAllInCents,600);assert.equal(decision.entrySizing,undefined);
  if(observe){const event=events.find(e=>e.stage==='prepare_entry');assert.equal(event?.outcome,'completed');assert.equal(event?.entrySizing?.requestedContracts,3);}
  const {clientOrderId,...sameRequest}=requested;runs.push(sameRequest);
 }
 assert.deepEqual(runs[0],runs[1]);
});

test('whole-contract planner globally maximizes valid quantity, never raises price to exhaust a stake',()=>{
 // Exhaustive small-depth reference comparison; includes fractional visible
 // depth, differing stake settings and price ceilings. No live network.
 for(const stake of [500,750,1000])for(const ceiling of [.43,.52,.60])for(const a of [0.5,2,20])for(const b of [0.5,5,30]){
  const prices=[.41,.43,.52,.61],quantities=[a,b,40,100];
  const levels=prices.map((p,k)=>({priceDollars:p.toFixed(4),availableContracts:String(quantities[k])}));
  const r=planV13IocEntry({signal:'SCOUT',direction:'DOWN',referenceOffer:ceiling,maxStakeCents:stake,bestAskDollars:'0.4100',askLevels:levels});
  let best=0,limit=0,visible=0;
  for(let k=0;k<prices.length;k++){if(prices[k]!>ceiling)break;visible+=quantities[k]!;
   const count=Math.min(Math.floor(visible),Math.floor(stake*10000/Math.round(prices[k]!*1000000)));
   if(count>best){best=count;limit=prices[k]!;}}
  assert.ok(r.ok);assert.equal(r.plan.contracts,best);assert.equal(r.plan.limitPrice,limit);
  assert.ok(r.plan.worstCaseGrossCents<=stake);assert.ok(r.plan.limitPrice<=ceiling);
 }
});

import {planV13IocEntry} from '../v13ExecutionPlanner';
import {DIRECT_ENTRY_CASH_RISK_VERSION,ENTRY_CASH_RISK_VERSION} from '../v13EntryCashRisk';
import type {V13LiveMoneyEntryPreflightInput,V13LiveMoneyEntryPreflightResult} from '../v13LiveMoneyEntryPreflight';

const captured=new WeakSet<object>();
export const isEntrySizingDiagnostics=(value:unknown):value is EntrySizingDiagnostics=>
 typeof value==='object'&&value!==null&&captured.has(value);
const ceil=(n:bigint,d:bigint)=>(n+d-1n)/d;
const integer=(value:unknown,min=0):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;

/** Best-effort explanation only. Uses the admitted plan and the same real
 * depth; never changes quantity, price, reservation, freshness or authority.
 * Requested quantity is NOT an actual fill. No provider reads or extra orders.
 */
export function captureEntrySizingDiagnostics(input:V13LiveMoneyEntryPreflightInput,result:V13LiveMoneyEntryPreflightResult){
 try {
  if(!result.ok||!Array.isArray(input.askLevels)||input.askLevels.length>1000)return undefined;
  const approvedGrossCeilingCents=input.policy.maxEntryStakeCents;
  const configuredGrossCeilingCents=input.configuredStakeCents??approvedGrossCeilingCents;
  const budgets={approvedAllIn:input.policy.maxEntryAllInCents,availableCash:input.availableCashCents,
   remainingCapital:input.capitalRemainingCents,remainingDailyLoss:input.policy.maxDailyLossCents-input.realizedDailyLossCents,
   remainingTotalLoss:input.policy.maxTotalLossCents-input.realizedTotalLossCents};
  if(!integer(configuredGrossCeilingCents,1)||!integer(approvedGrossCeilingCents,configuredGrossCeilingCents)||
   Object.values(budgets).some(v=>!Number.isSafeInteger(v)||v<1))return undefined;
  const riskReserveBudgetCents=Math.min(...Object.values(budgets));
  const grossDepth=planV13IocEntry({signal:input.signal,direction:input.direction,referenceOffer:input.referenceOffer,
   maxStakeCents:configuredGrossCeilingCents,bestAskDollars:input.bestAskDollars,askLevels:input.askLevels});
  if(!grossDepth.ok)return undefined;
  const plan=result.plan,selectedLimitMicros=Math.round(plan.limitPrice*1_000_000);
  const requestedContracts=plan.contracts,expectedGrossCents=plan.expectedGrossCents,
   worstCaseGrossCents=plan.worstCaseGrossCents,visibleWholeContractsAtSelectedLimit=plan.visibleContractsAtLimit,
   plannedAllInReserveCents=result.plannedAllInCents,cashRiskModelVersion=result.cashRisk?.version??null;
  if(!integer(selectedLimitMicros,1)||selectedLimitMicros>=1_000_000||!integer(requestedContracts,1)||
   !integer(expectedGrossCents)||!integer(worstCaseGrossCents,expectedGrossCents)||worstCaseGrossCents>configuredGrossCeilingCents||
   !integer(visibleWholeContractsAtSelectedLimit,requestedContracts)||!integer(plannedAllInReserveCents,worstCaseGrossCents)||
   (cashRiskModelVersion!==null&&cashRiskModelVersion!==ENTRY_CASH_RISK_VERSION&&cashRiskModelVersion!==DIRECT_ENTRY_CASH_RISK_VERSION))return undefined;
  const fee=result.selectedFeeEvidence??input.feeEvidence;
  let maximumContractsUnderCashRisk:number|null=null,verifiedFeeQuantityCeiling:number|null=null;
  if(result.cashRisk&&fee.cashRisk){
   const cashMicros=fee.cashRisk.entryCashDebitPerContractMicros,exitMicros=fee.cashRisk.exitLossPerContractMicros;
   if(!integer(cashMicros,1)||!integer(exitMicros))return undefined;
   const cash=BigInt(cashMicros),exit=BigInt(exitMicros);
   let count=BigInt(riskReserveBudgetCents)*10000n/(cash+exit);
   while(count>0n&&ceil(cash*count,10000n)+ceil(exit*count,10000n)>BigInt(riskReserveBudgetCents))count--;
   if(count>BigInt(Number.MAX_SAFE_INTEGER))return undefined;
   maximumContractsUnderCashRisk=Number(count);
   // Without a verified grid, the existing exact fee envelope cannot be resized.
   if(input.feeEvidence.cashRisk?.gridEvidence===undefined){
    const quantity=input.feeEvidence.contracts;if(!integer(quantity,1))return undefined;verifiedFeeQuantityCeiling=quantity;
   }
  }
  const entryCashReserveCents=result.cashRisk?.reservedEntryCashCents??worstCaseGrossCents+fee.reservedEntryFeeCents;
  const exitLossReserveCents=result.cashRisk?.reservedExitFeeCents??fee.reservedExitFeeCents;
  if(!integer(entryCashReserveCents,worstCaseGrossCents)||!integer(exitLossReserveCents)||
   entryCashReserveCents+exitLossReserveCents!==plannedAllInReserveCents)return undefined;
  const diagnostic=Object.freeze({version:1 as const,semantics:'MAX_WHOLE_CONTRACTS_WITHIN_GROSS_CEILING' as const,
   configuredGrossCeilingCents,approvedGrossCeilingCents,
   selectedLimitMicros,requestedContracts,expectedGrossCents,
   worstCaseGrossCents,uncommittedGrossCents:configuredGrossCeilingCents-worstCaseGrossCents,
   grossOnlyWholeContractsAtSelectedLimit:Number(BigInt(configuredGrossCeilingCents)*10000n/BigInt(selectedLimitMicros)),
   visibleWholeContractsAtSelectedLimit,
   grossAndDepthOnlyContracts:grossDepth.plan.contracts,grossAndDepthOnlyLimitMicros:Math.round(grossDepth.plan.limitPrice*1_000_000),
   reducedByAdditionalConstraints:requestedContracts<grossDepth.plan.contracts,
   cashRiskModelVersion,maximumContractsUnderCashRisk,verifiedFeeQuantityCeiling,
   riskReserveBudgetCents,bindingRiskBudgets:Object.freeze(Object.keys(budgets).filter(k=>budgets[k as keyof typeof budgets]===riskReserveBudgetCents)),
   entryCashReserveCents,exitLossReserveCents,plannedAllInReserveCents,
   actualFilledContracts:null,actualGrossCents:null,actualFeesCents:null,
   execution:'SINGLE_IOC_NO_FILL_GUARANTEE_NO_TOP_UP' as const});
  captured.add(diagnostic);return diagnostic;
 }catch{return undefined; /* Observability must never affect execution. */}
}
export type EntrySizingDiagnostics=NonNullable<ReturnType<typeof captureEntrySizingDiagnostics>>;

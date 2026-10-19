/**
 * Offline verification report for the four protective IOC outcome classes.
 *
 * This module accepts test/review observations and produces an AUDIT DIAGNOSTIC.
 * It does not authenticate exchange receipts or verify signatures (callers
 * cannot self-attest those properties), dispatch a POST, approve a release,
 * change kill switches or grant the user permission to trade.
 *
 * Actual acceptance requires separate signed exchange traces from the
 * account's trusted restricted signer, a distinct authenticated Kalshi read
 * of orders/fills/positions, and an independently reviewed durable ledger.
 */
import {reconcileIocEmergencyExit,type IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";

export type ExpectedExitOutcome="ZERO_FILL"|"PARTIAL_FILL"|"FULL_FILL"|"UNKNOWN_TIMEOUT";
export interface ExitEvidenceScenario{
 kind:ExpectedExitOutcome;
 /** One immutable durable UNKNOWN record must predate the sole attempted POST. */
 unknownPersistedBeforeTransport:boolean;
 submitCount:number;
 observation:IocRecoveryObservation;
}
export type ExitAuditReport={
 conformsToRecoveryModel:boolean;
 problems:string[];
 observedScenarios:ExpectedExitOutcome[];
 /** Never authorize execution using user-supplied records or mocks. */
 authenticatedExchangeEvidenceVerified:false;
 independentProductionSignoff:false;
 liveOrderAuthorized:false;
};

function parseFixed(x:unknown):bigint|null{
 if(typeof x!=="string"||!/^\d{1,9}\.\d{2}$/.test(x))return null;
 const [a,b]=x.split(".");
 return BigInt(a!)*100n+BigInt(b!);
}
const expected:ExpectedExitOutcome[]=[
 "ZERO_FILL","PARTIAL_FILL","FULL_FILL","UNKNOWN_TIMEOUT",
];
export function auditExitOutcomeMatrix(cases:readonly ExitEvidenceScenario[]):ExitAuditReport{
 const problems:string[]=[];
 const seen=new Set<ExpectedExitOutcome>(),ids=new Set<string>();
 if(cases.length!==expected.length)problems.push("expected_four_independent_scenarios");
 for(const c of cases){
  if(!expected.includes(c.kind)||seen.has(c.kind)){
    problems.push("missing_or_duplicate_exit_case");continue;
  }
  seen.add(c.kind);
  const obs=c.observation;
  if(!obs||typeof obs.clientOrderId!=="string"||ids.has(obs.clientOrderId))
    problems.push("reused_or_invalid_client_order_id");
  else ids.add(obs.clientOrderId);
  if(c.unknownPersistedBeforeTransport!==true)
    problems.push(c.kind+":unknown_not_durable_before_post");
  if(c.submitCount!==1)problems.push(c.kind+":not_exactly_one_signed_attempt");
  const recon=obs?reconcileIocEmergencyExit(obs):null;
  if(c.kind==="UNKNOWN_TIMEOUT"){
    // Timeout must remain UNKNOWN, un-retryable, never a zero-fill inference.
    if(obs?.response!==null||recon?.state!=="UNKNOWN"||recon?.mayRetry!==false)
      problems.push("timeout_wrongly_accepted_or_retryable");
    continue;
  }
  if(recon?.state!=="RECONCILED"||recon?.mayRetry!==false){
    problems.push(c.kind+":not_exchange_reconciled");continue;
  }
  // reconcileIocEmergencyExit emits integer hundredths, NOT "1.00" strings.
  // Keep the exchange wire quantity format distinct from recovery output units.
  const recovered=(x:unknown):bigint|null=>
    typeof x==="string"&&/^\\d+$/.test(x)?BigInt(x):null;
  const filled=recovered(recon.filledHundredths);
  const remaining=recovered(recon.remainingHundredths);
  const requested=parseFixed(obs.requestedCountFp);
  if(filled===null||remaining===null||requested===null||requested<=0n||
    filled+remaining!==requested){
    problems.push(c.kind+":amount_invalid");continue;
  }
  const validFill=c.kind==="ZERO_FILL"?filled===0n&&remaining===requested:
    c.kind==="FULL_FILL"?filled===requested&&remaining===0n:
    filled>0n&&filled<requested&&remaining>0n;
  if(!validFill)problems.push(c.kind+":unexpected_fill_class");
 }
 for(const k of expected)if(!seen.has(k))problems.push(k+":scenario_missing");
 return {
  conformsToRecoveryModel:problems.length===0,problems,
  observedScenarios:[...seen],
  authenticatedExchangeEvidenceVerified:false,
  independentProductionSignoff:false,liveOrderAuthorized:false,
 };
}

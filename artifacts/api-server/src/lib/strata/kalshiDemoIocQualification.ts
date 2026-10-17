/**
 * Operator-only DEMO qualification orchestration.
 * No Express routes, no production signer, no live trading configuration.
 * Creates a private durable PREPARED row then consumes UNKNOWN atomically
 * before one signed DEMO IOC and independently verified final reconciliation.
 */
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
import type {IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";
import {
 demoSignerFingerprint,executeOneSignedDemoProtectiveIoc,
 type DemoExitApproval,type DemoIocResult,
} from "./kalshiDemoSignedIoc";
import {
 prepareDemoIocOnce,consumeDemoIocUnknown,finalizeVerifiedDemoIoc,
 type DemoLedgerIdentity,
} from "./kalshiDemoIocLedger";

export type DemoQualificationResult=DemoIocResult;
const blocked=(reason:string):DemoQualificationResult=>({
 environment:"KALSHI_DEMO",state:"BLOCKED",reason,httpStatus:null,
 submitted:false,mayRetry:false,productionOrderSubmitted:false,
 tradingAuthorized:false,
});
export async function runPreparedDemoIocQualification(input:{
  identity:DemoLedgerIdentity;
  order:Readonly<EmergencyExitOrder>;
  approval:Readonly<DemoExitApproval>;
  demoKeyId:string;
  demoPrivateKeyPem:string;
  readVerifiedExchangeHistory:(
    clientOrderId:string,
    receipt:IocRecoveryObservation["response"],
  )=>Promise<IocRecoveryObservation>;
  fetchImpl?:typeof fetch;
  nowMs?:()=>number;
  ledger?:{
    prepare:typeof prepareDemoIocOnce;
    consume:typeof consumeDemoIocUnknown;
    finalize:typeof finalizeVerifiedDemoIoc;
  };
}):Promise<DemoQualificationResult>{
 const {identity,approval,order}=input;
 const signerFp=demoSignerFingerprint(input.demoKeyId,input.demoPrivateKeyPem);
 const now=(input.nowMs??Date.now)();
 if(!signerFp || !approval || !identity ||
    !Number.isSafeInteger(now) || now<=0 ||
    approval.environment!=="KALSHI_DEMO" ||
    approval.signerFingerprint!==signerFp ||
    approval.authenticatedOwnerId!==identity.ownerId ||
    approval.accountOwnerId!==identity.ownerId ||
    approval.operatorApprovalId!==identity.operatorApprovalId ||
    approval.workerFencingToken!==identity.workerFencingToken ||
    approval.demoAccountVerified!==true ||
    approval.authorizedByIndependentOperator!==true ||
    approval.feesCurrentAndApplicable!==true ||
    approval.marketTicker!==order.ticker ||
    approval.positionMarketTicker!==order.ticker ||
    approval.positionsComplete!==true ||
    approval.restingOrderCount!==0 ||
    approval.unresolvedOrderCount!==0 ||
    approval.approvalExpiresAtMs<=now ||
    approval.approvalExpiresAtMs>now+60_000)
    return blocked("demo_qualification_owner_or_approval_invalid");
 const ledger=input.ledger??{
   prepare:prepareDemoIocOnce,
   consume:consumeDemoIocUnknown,
   finalize:finalizeVerifiedDemoIoc,
 };
 const prepared=await ledger.prepare({
   identity,order,signerFingerprint:signerFp,
   feeFingerprint:approval.feeFingerprint,
   approvalExpiresAtMs:approval.approvalExpiresAtMs,
   nowMs:now,
 });
 if(!prepared)return blocked("demo_qualification_reservation_duplicate_or_unavailable");
 return executeOneSignedDemoProtectiveIoc({
   keyId:input.demoKeyId,
   privateKeyPem:input.demoPrivateKeyPem,
   order,approval,
   deps:{
     nowMs:input.nowMs,
     fetchImpl:input.fetchImpl,
     readVerifiedExchangeHistory:input.readVerifiedExchangeHistory,
     commitUnknownBeforePost:async(currentOrder,fp)=>
       (await ledger.consume({
         identity,order:currentOrder,
         signerFingerprint:fp,
         feeFingerprint:approval.feeFingerprint,
       })) ?? Promise.reject(Error("unknown_not_durable")),
     commitVerifiedReconciliation:async(clientOrderId,verified)=>{
       if(verified!==true)return false;
       return ledger.finalize({
         identity,clientOrderId,
         independentlyVerified:true,
         exactAccountMarketOrderFillPositionMatched:true,
       });
     },
   },
 });
}

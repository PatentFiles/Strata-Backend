import {randomUUID} from "node:crypto";
import {planV13IocExit} from "../v13ExecutionPlanner";
import type {MarketEvidence} from "../v13-production/types";
import {reserveOwnedEmergencyExitProof,type ExitWorkerLease} from "./ownerFeeEmergencyExitReserve";
import {dispatchReviewedProtectiveExitOnce} from "./ownerFeeEmergencyExitSignedDispatch";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";

/**
 * Canonical server-only protective EXIT path for the account-scoped V13 worker.
 * This is not a public controller, an entry route or a way to enable trading.
 * Before preparing an IOC, independently re-read a fresh fee/position snapshot
 * and let the immutable reservation and signed dispatcher verify the account,
 * signer, active worker lease, current risk/kill gates and release SHA again.
 *
 * A fail/unknown outcome must halt the worker's further entry authority. In
 * particular, this never falls back to the legacy V13 EXIT transport after
 * a partial or uncertain signed-order attempt.
 */
export type WorkerOwnedExit={
 ownerId:string;accountId:string;
 material:{keyId:string;privateKey:string};
 lease:ExitWorkerLease;
 market:string;positionSide:"YES"|"NO";
 ownedQuantityHundredths:string;
 minimumExitMicros:number;
 readMarket:(market:string,side:"YES"|"NO")=>Promise<MarketEvidence>;
};
type ExitOutcome={state:"BLOCKED"|"UNKNOWN"|"RECONCILED";reason:string;postAttempted:boolean;};
const denied=(reason:string):ExitOutcome=>({state:"BLOCKED",reason,postAttempted:false});
type Ports={
 reserve?:typeof reserveOwnedEmergencyExitProof;
 dispatch?:typeof dispatchReviewedProtectiveExitOnce;
};
export async function dispatchOwnedWorkerProtectiveExit(input:WorkerOwnedExit,ports:Ports={}):Promise<ExitOutcome>{
 const hosted=Boolean(process.env.RAILWAY_PROJECT_ID||
   process.env.RAILWAY_SERVICE_ID||process.env.RAILWAY_ENVIRONMENT_ID);
 if((ports.reserve||ports.dispatch)&&(process.env.NODE_ENV!=="test"||hosted))
  return denied("protective_exit_test_ports_prohibited");
 // Two distinct release gates: this feature flag AND the reviewed,
 // commit-bound SQL release in the signed dispatcher. Never simulate approval.
 if(!ports.dispatch&&process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE!=="true")
  return denied("protective_exit_release_disabled");
 if(!/^[0-9a-f-]{36}$/i.test(input.ownerId)||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.accountId)||
    !/^KXBTC15M-[A-Za-z0-9-]+$/.test(input.market)||
    (input.positionSide!=="YES"&&input.positionSide!=="NO")||
    !/^\d+$/.test(input.ownedQuantityHundredths)||
    !Number.isSafeInteger(input.minimumExitMicros)||
    input.minimumExitMicros<1||input.minimumExitMicros>=1_000_000||
    !input.lease||!Number.isSafeInteger(input.lease.fencingToken)||
    input.lease.fencingToken<1)
  return denied("protective_exit_worker_input_invalid");
 try{
  const quantity=BigInt(input.ownedQuantityHundredths);
  // Match the established V13 whole-contract exit policy. No rounding up.
  const owned=quantity/100n;
  if(owned===0n||owned>1000n)return denied("protective_exit_worker_quantity_invalid");
  const book=await input.readMarket(input.market,input.positionSide);
  const floor=input.minimumExitMicros/1_000_000;
  const plan=planV13IocExit({
   ownedContracts:Number(owned),bestBidDollars:book.bestBidDollars,
   bidLevels:book.bids,minimumExitPrice:floor,
  });
  if(!plan.ok)return denied("protective_exit_depth_or_floor_unverified");
  const contracts=plan.plan.plannedContracts;
  if(!Number.isSafeInteger(contracts)||contracts<1||contracts>Number(owned))
   return denied("protective_exit_quantity_plan_invalid");
  const ticks=Math.round(plan.plan.limitPrice*10_000);
  if(!Number.isSafeInteger(ticks)||ticks<1||ticks>9999||
     Math.abs(plan.plan.limitPrice-ticks/10_000)>0.00000001)
   return denied("protective_exit_price_tick_invalid");
  const yesTicks=input.positionSide==="YES"?ticks:10_000-ticks;
  if(yesTicks<1||yesTicks>9999)return denied("protective_exit_yes_price_invalid");
  const order:EmergencyExitOrder={
   ticker:input.market,side:input.positionSide==="YES"?"ask":"bid",
   count:contracts.toFixed(2),price:(yesTicks/10_000).toFixed(4),
   client_order_id:"v13p-"+randomUUID(),
   time_in_force:"immediate_or_cancel",
   self_trade_prevention_type:"taker_at_cross",
   reduce_only:true,post_only:false,subaccount:1,exchange_index:2,
  };
  const result=await (ports.reserve??reserveOwnedEmergencyExitProof)(
   input.ownerId,input.accountId,input.material,order,input.lease,
  );
  if(result.reservationPrepared!==true||typeof result.reservationId!=="string")
   return denied(result.reason);
  const sent=await (ports.dispatch??dispatchReviewedProtectiveExitOnce)({
   ownerId:input.ownerId,accountId:input.accountId,
   reservationId:result.reservationId,lease:input.lease,material:input.material,order,
  });
  return {state:sent.state,reason:sent.reason,postAttempted:sent.postAttempted};
 }catch{return denied("protective_exit_worker_transport_or_read_failed");}
}

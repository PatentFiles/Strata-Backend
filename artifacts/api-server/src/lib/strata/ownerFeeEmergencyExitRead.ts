import {pool} from "@workspace/db";
import {dedicatedSignerFingerprint} from "./commissioning";
import {readOwnedKalshiFeeds} from "./personalExchangeRead";
import {probeCurrentKalshiFeeApi} from "./twoSourceFeeEvidence";
import {inspectEmergencyExitCandidate,type EmergencyExitOrder,
  type EmergencyExitDecision,type EmergencyExitEvidence} from "./ownerFeeEmergencyExit";

/**
 * Backend-only READ adapter. Owner must come from authenticated session,
 * key material from credential vault, never the request body. No POST, signing,
 * audit writes, worker start, or trading authorization can happen here.
 */
type DB={query(sql:string,params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const yes=(x:unknown)=>x===true||x==="t"||x==="true";
const no=(x:unknown)=>x===false||x==="f"||x==="false";
const obj=(x:unknown):Record<string,unknown>|null=>
  x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:null;
const deny=(reason:string):EmergencyExitDecision=>({
  ok:false,reason,diagnosticEligible:false,
  tradingAuthorized:false,needsIndependentApproval:true,
});
export async function inspectOwnedEmergencyExitRead(
  ownerId:string,accountId:string,material:{keyId:string;privateKey:string},
  order:EmergencyExitOrder,
  deps:{db?:DB;readFeeds?:typeof readOwnedKalshiFeeds;
    readFees?:typeof probeCurrentKalshiFeeApi;
    signerFingerprint?:typeof dedicatedSignerFingerprint;now?:()=>number}={},
):Promise<EmergencyExitDecision>{
  if(!UUID.test(ownerId)||!UUID.test(accountId))return deny("emergency_exit_owner_invalid");
  const db=deps.db??pool;
  const now=deps.now??Date.now,started=now();
  if(!Number.isSafeInteger(started)||started<=0)return deny("emergency_exit_clock_invalid");
  try{
    const account=await db.query(
      "SELECT owner_user_id,subaccount,exchange_index,execution_enabled,kill_switch,key_fingerprint FROM public.v13_production_account WHERE id=$1::uuid AND owner_user_id=$2::uuid LIMIT 2",
      [accountId,ownerId]);
    const global=await db.query(
      "SELECT live_execution_enabled,manual_kill_switch FROM public.live_execution_config WHERE id='singleton'");
    if(account.rows.length!==1||global.rows.length!==1)
      return deny("emergency_exit_authenticated_pair_unverified");
    const a=account.rows[0]!,g=global.rows[0]!;
    const signer=(deps.signerFingerprint??dedicatedSignerFingerprint)(material.keyId,material.privateKey);
    if(String(a.owner_user_id)!==ownerId||Number(a.subaccount)!==1||
       Number(a.exchange_index)!==2||!signer||signer!==a.key_fingerprint)
      return deny("emergency_exit_authenticated_pair_unverified");
    if(!no(a.kill_switch)||!no(g.manual_kill_switch)||
       !yes(a.execution_enabled)||!yes(g.live_execution_enabled))
      return deny("emergency_exit_execution_gate_closed");
    const feeds=await (deps.readFeeds??readOwnedKalshiFeeds)(material,started);
    if(!feeds.ok)return deny(feeds.reason);
    const positions=feeds.positions.map(obj);
    if(positions.some(p=>!p))return deny("emergency_exit_live_position_unverified");
    const matching=positions.filter(p=>p?.ticker===order.ticker);
    if(matching.length!==1)return deny("emergency_exit_live_position_unverified");
    const positionFp=matching[0]?.position_fp??matching[0]?.position;
    if(typeof positionFp!=="string")return deny("emergency_exit_live_position_unverified");
    let resting=0;
    for(const raw of feeds.orders){
      const row=obj(raw),status=row?.status;
      if(typeof status!=="string"||
         !["executed","canceled","cancelled","resting","pending"].includes(status))
        return deny("emergency_exit_orders_unreconciled");
      if(status==="resting"||status==="pending")resting++;
    }
    const unknown=await db.query(
      "SELECT count(*)::integer AS n FROM public.v13_production_intent WHERE account_id=$1::uuid AND state IN ('DISPATCHED','UNKNOWN')",
      [accountId]);
    const pending=Number(unknown.rows[0]?.n);
    if(unknown.rows.length!==1||!Number.isSafeInteger(pending)||pending<0)
      return deny("emergency_exit_orders_unreconciled");
    const fee=await (deps.readFees??probeCurrentKalshiFeeApi)();
    const fingerprint=fee.metadataDigest;
    const readAt=Date.parse(String(fee.liveVerifiedAt??""));
    const evidence:EmergencyExitEvidence={
      authenticatedOwnerId:ownerId,accountOwnerId:ownerId,
      accountSubaccount:1,accountExchangeIndex:2,signerVerified:true,
      globalKillActive:false,accountKillActive:false,executionEnabled:true,
      positionsComplete:true,positionMarket:String(matching[0]!.ticker),
      positionFp,positionsObservedAtMs:feeds.observedAtMs,
      restingOrderCount:resting,uncertainOrderCount:pending,
      kalshiFee:fee.ok&&fee.marketTicker===order.ticker&&
        fee.series==="KXBTC15M"&&fee.exchangeIndex===2&&
        fee.feeType==="quadratic"&&fee.feeMultiplier==="1"&&
        typeof fingerprint==="string"?
        {source:"kalshi_live_api",market:fee.marketTicker,
         fingerprint,observedAtMs:readAt,feeType:"quadratic",
         feeMultiplier:1,noUnverifiedOverridesOrChanges:true,marketOpen:true}:null,
    };
    return inspectEmergencyExitCandidate(ownerId,order,evidence,now());
  }catch{return deny("emergency_exit_independent_reads_unavailable");}
}

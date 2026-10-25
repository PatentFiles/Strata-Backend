/**
 * Background issuer-document OBSERVER for exactly one explicitly configured
 * account. Makes no signed exchange requests, grants, orders, policy or cash
 * writes; the original project-wide SQL capture lease serializes all egress.
 * It can never claim a PDF existed unless Railway really fetched its bytes.
 */
import {pool} from "@workspace/db";
import {captureIndependentOfficialFeeV5} from "./independentOfficialFeeV5";
const ACCOUNT=/^strata-account-[0-9a-f]{24}$/;
let started=false;
export function startOwnerIndependentFeeV5Collector():void{
 if(started||process.env.STRATA_V5_RAILWAY_CAPTURE_ENABLED!=="true")return;
 const id=process.env.STRATA_V5_RAILWAY_ACCOUNT_ID??"";
 if(!ACCOUNT.test(id))return;
 started=true;
 let busy=false;
 async function tick():Promise<void>{
  if(busy)return;
  busy=true;
  try{
   const {rows}=await pool.query<{owner_user_id:string}>(
     "SELECT owner_user_id::text FROM public.v13_production_account WHERE id=$1 AND subaccount=1 AND exchange_index=2 AND commissioned=true LIMIT 2",[id]);
   if(rows.length!==1||typeof rows[0]?.owner_user_id!=="string")return;
   const result=await captureIndependentOfficialFeeV5(rows[0].owner_user_id);
   // Never log source bytes, credentials, personal identifiers or orders.
   if(result.ok && result.reason==="v5_genuine_railway_issuer_capture_recorded")
     console.info(JSON.stringify({event:"v5_issuer_capture_verified",source:"railway_direct",
       originalCapturedAt:result.originalCapturedAt,digest:result.digest}));
   else if(!result.ok && result.reason!=="v5_issuer_shared_cooldown")
     console.warn(JSON.stringify({event:"v5_issuer_capture_pending",reason:result.reason,
       retryAt:result.retryAt}));
  }catch{console.warn(JSON.stringify({event:"v5_issuer_collector_unavailable"}));}
  finally{busy=false;}
 }
 // Single Node process with a PostgreSQL atomic cross-instance lease.
 // 120s status interval; a genuine issuer GET remains at most one per 30m
 // (or longer if the provider announces a Retry-After).
 const t=setInterval(()=>{void tick();},120_000);
 t.unref();
 void tick();
}
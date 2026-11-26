/**
 * Transitional release containment, not an independent live signal adapter.
 * Until a reviewed account-bound live source is available, no production ENTRY
 * may reach the actual HTTP transport. Existing reduce-only/cancel/reconciliation
 * authority is NOT granted or changed by this guard. Do not deploy this candidate
 * as an independently functioning live engine.
 */
export const LIVE_ENTRY_SOURCE_UNAVAILABLE="production_independent_entry_source_unavailable";
export function assertIndependentEntryAvailable():never {
  throw new Error(LIVE_ENTRY_SOURCE_UNAVAILABLE);
}

/** The production transport constructs a fixed string URL, explicit method and
 * serialized order object. Reject other input shapes rather than guess whether
 * a request is reducing. This is a narrowing fence, not an exit authorization. */
import type {ProductionLedger} from "./ledger";
import {readOwnedSelfServiceScope,publicSelfServiceRequested,publicSelfServiceReleaseQualified,type EligibilityQuery} from "../strata/ownerSelfServiceEligibility";

/** A rollout is configuration, never owner consent or a trading permit.
 * Exact owner, execution account and running Railway build are all required.
 * A bare process-wide switch cannot opt any account into independent entry. */
export type IndependentLiveRolloutScope = Readonly<{
  ownerId:string;
  accountId:string;
  releaseSha:string;
}>;
function validRolloutScope(value:unknown):value is IndependentLiveRolloutScope{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const s=value as Record<string,unknown>;
  return Object.keys(s).sort().join(",")==="accountId,ownerId,releaseSha" &&
    typeof s.ownerId==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.ownerId) &&
    typeof s.accountId==="string" && /^[A-Za-z0-9._:-]{1,128}$/.test(s.accountId) &&
    typeof s.releaseSha==="string" && /^[a-f0-9]{40}$/.test(s.releaseSha);
}
/** A server-minted capability authenticates a newly discovered account's
 * scope. It is not an order permit: START, current continuous grant, worker
 * lease, per-order risk/fee checks and the one-shot ledger wire pin still
 * have to pass. It cannot be serialized or reconstructed from client JSON. */
export type PublicLiveAdmission=Readonly<IndependentLiveRolloutScope&{keyFingerprint:string;policyHash:string}>;
const publicAdmissions=new WeakSet<object>();
export async function qualifyPublicIndependentLiveScope(db:EligibilityQuery,scope:IndependentLiveRolloutScope,
 env:NodeJS.ProcessEnv=process.env):Promise<PublicLiveAdmission|null>{
 if(!validRolloutScope(scope)||!publicSelfServiceReleaseQualified(scope.releaseSha,env)||
  env.STRATA_INDEPENDENT_LIVE_SOURCE_V1!=="true")return null;
 const a=await readOwnedSelfServiceScope(db,scope.ownerId,scope.releaseSha,"authority",env);
 if(!a||a.accountId!==scope.accountId||!a.commissioned||!a.executionEnabled||a.killSwitchOn||
  a.blocked||!a.cashConserved||!a.cashReconciled||a.reservedMicros!=="0"||
  BigInt(a.cashMicros)<BigInt(a.stakeCents)*10000n)return null;
 const admission=Object.freeze({...scope,keyFingerprint:a.keyFingerprint,policyHash:a.policyHash});
 publicAdmissions.add(admission);return admission;
}
export function independentLiveRolloutAllowed(scope:IndependentLiveRolloutScope,env:NodeJS.ProcessEnv=process.env,admission?:PublicLiveAdmission|null):boolean{
  if(env.NODE_ENV!=="production"||env.STRATA_INDEPENDENT_LIVE_SOURCE_V1!=="true"||
     !validRolloutScope(scope)||env.RAILWAY_GIT_COMMIT_SHA!==scope.releaseSha)return false;
  // In public mode the old manually enrolled scopes are never consulted.
  // Only a qualified platform release and a real server-owned admission
  // can select the live source. Final order authorization remains locked.
  if(publicSelfServiceRequested(env)){
   return publicSelfServiceReleaseQualified(scope.releaseSha,env)&&!!admission&&publicAdmissions.has(admission)&&
    admission.ownerId===scope.ownerId&&admission.accountId===scope.accountId&&admission.releaseSha===scope.releaseSha;
  }
  // Historical pilot mode only. Explicit list takes precedence. Empty, malformed, duplicate or ambiguous
  // configuration never falls back to the old single-account authorization.
  const configured=env.STRATA_INDEPENDENT_LIVE_SOURCE_V1_SCOPES;
  if(configured!==undefined){
    if(configured.length>65536)return false;
    let entries:unknown;
    try{entries=JSON.parse(configured);}catch{return false;}
    if(!Array.isArray(entries)||entries.length>256||!entries.every(validRolloutScope))return false;
    const accounts=new Set<string>();
    for(const e of entries){
      if(accounts.has(e.accountId)||e.releaseSha!==env.RAILWAY_GIT_COMMIT_SHA)return false;
      accounts.add(e.accountId);
    }
    return entries.some(e=>e.ownerId===scope.ownerId&&e.accountId===scope.accountId&&e.releaseSha===scope.releaseSha);
  }
  return env.STRATA_INDEPENDENT_LIVE_SOURCE_V1_OWNER===scope.ownerId &&
    env.STRATA_INDEPENDENT_LIVE_SOURCE_V1_ACCOUNT===scope.accountId &&
    env.STRATA_INDEPENDENT_LIVE_SOURCE_V1_SHA===scope.releaseSha;
}
function assertProductionRequest(input:Parameters<typeof fetch>[0],init?:RequestInit,entry?: (body:unknown)=>void):void {
  if(typeof input!=="string"||!init||typeof init.method!=="string")assertIndependentEntryAvailable();
  const method=init.method.toUpperCase();
  let url:URL;
  try{url=new URL(input);}catch{assertIndependentEntryAvailable();}
  if(url.origin!=="https://external-api.kalshi.com"||url.username||url.password||url.hash)
    assertIndependentEntryAvailable();
  if(method==="GET"||method==="HEAD")return;
  const orderPath="/trade-api/v2/portfolio/events/orders";
  if(method==="DELETE"&&url.pathname.startsWith(orderPath+"/"))return;
  if(method!=="POST"||url.pathname!==orderPath||url.search||typeof init.body!=="string")
    assertIndependentEntryAvailable();
  let value:unknown;
  try{value=JSON.parse(init.body);}catch{assertIndependentEntryAvailable();}
  if(!value||typeof value!=="object"||Array.isArray(value))assertIndependentEntryAvailable();
  const order=value as Record<string,unknown>;
  if(order.subaccount!==1||order.exchange_index!==2||order.time_in_force!=="immediate_or_cancel"||order.post_only!==false)
    assertIndependentEntryAvailable();
  if(order.reduce_only===true)return;
  if(order.reduce_only!==false||!entry)assertIndependentEntryAvailable();
  entry(order);
}
export function assertContainedProductionRequest(input:Parameters<typeof fetch>[0],init?:RequestInit):void{
  assertProductionRequest(input,init);
}
/** The ordinary transport stays contained. Only the currently locked,
 * exact-source, one-shot permit can admit a BUY. A synthetic source can
 * NEVER use the default external HTTP transport. */
export function createIndependentProductionFetch(ledger:()=>ProductionLedger|null,isolatedRaw?:typeof fetch,liveScope?:IndependentLiveRolloutScope,publicAdmission?:PublicLiveAdmission|null):typeof fetch{
 const isolated=isolatedRaw!==undefined;
 const boundScope=liveScope?Object.freeze({...liveScope}):undefined;
 if(isolated&&!(process.env.NODE_ENV==="test"&&!process.env.RAILWAY_ENVIRONMENT_ID&&
  !process.env.RAILWAY_SERVICE_ID&&!process.env.RAILWAY_PROJECT_ID&&
  /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(process.env.V13_DISPOSABLE_DATABASE_URL??"")))
  throw Error("independent_wire_test_transport_forbidden");
 return async(input,init)=>{
  assertProductionRequest(input,init,body=>{
   const current=ledger();if(!current)assertIndependentEntryAvailable();
   if(!isolated&&(!boundScope||!independentLiveRolloutAllowed(boundScope,process.env,publicAdmission)))assertIndependentEntryAvailable();
   current.consumeIndependentEntryWire(body,isolated?"SIMULATION":"LIVE_OBSERVATION",
    isolated?undefined:{...boundScope!,keyFingerprint:publicAdmission?.keyFingerprint,policyHash:publicAdmission?.policyHash});
  });
  return (isolatedRaw??fetch)(input,{...init,redirect:"error"});
 };
}
export const containedProductionFetch:typeof fetch=async(input,init)=>{
  assertContainedProductionRequest(input,init);
  // Do not follow redirects with signed order material.
  return fetch(input,{...init,redirect:"error"});
};

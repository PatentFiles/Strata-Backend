import test from "node:test";
import assert from "node:assert/strict";
import { digest as v13Digest } from "../v13-production/types";
import { API_SOURCE_POLICY_VERSION, API_SOURCE_FORMULA_VERSION } from "./apiFeeSourceStage";
import { DYNAMIC_FEE_POLICY_VERSION_V4 } from "./dynamicFeeOrderRiskV4";
import { computeDynamicFeeModelDigest, type DynamicFeeModel } from "./dynamicOfficialFeeSchedule";
import { CANONICAL_FEE_SCHEDULE_URL } from "../microLiveFeeArtifact";
import {
  qualifyProtectiveRelease,attestProtectiveReleaseReview,
  authorizeProtectiveRelease,readReleaseOwner,protectiveReleaseStatus,
  REVIEW_CONFIRM,OWNER_CONFIRM,OWNER_STANDING_CONFIRM,PROVISIONAL_REPAIR_CONFIRM,
} from "./inAppProtectiveRelease";
const OWNER="11111111-1111-4111-8111-111111111111";
const REVIEWER="22222222-2222-4222-8222-222222222222";
const SHA="a".repeat(40);
const DIGEST="b".repeat(64);
const QID="33333333-3333-4333-8333-333333333333";
const RID="44444444-4444-4444-8444-444444444444";
const V4_TICKER="KXBTC15M-26OCT200530";
const V4_CLOCK=Date.parse("2026-10-20T05:30:00Z");
const V4_BASE:Omit<DynamicFeeModel,"modelDigest">={
 issuer:CANONICAL_FEE_SCHEDULE_URL,
 publicationDigest:"c".repeat(64),effectiveDate:"2026-07-07",
 takerRatePpm:70000,makerRatePpm:17500,
 defaultTakerMultiplierPpm:1000000,defaultMakerMultiplierPpm:1000000,
 feeType:"quadratic",feeMultiplier:"1",
 marketTicker:V4_TICKER,eventTicker:V4_TICKER,metadataDigest:"d".repeat(64),
 observedAt:new Date(V4_CLOCK).toISOString(),
 tradingAuthorized:false,requiresVersionedReview:true,
};
const V4_MODEL:DynamicFeeModel={...V4_BASE,modelDigest:computeDynamicFeeModelDigest(V4_BASE)};
const v4Observed=(model:DynamicFeeModel=V4_MODEL)=>({
 ok:true as const,reason:"dynamic_fee_observation_for_review_only" as const,
 model,providerContentChanged:false,tradingAuthorized:false as const,
});
const emptySignedFeed=(override:Record<string,unknown>={})=>({
 ok:true as const,observedAtMs:Date.now(),cashMicros:"25000000",
 orders:[],fills:[],positions:[],settlements:[],...override,
});
const repairRequest={reviewId:RID,confirmation:OWNER_CONFIRM,
 provisionalRepairConfirmation:PROVISIONAL_REPAIR_CONFIRM};
const account={id:"owner-execution-2",owner_id:OWNER,commissioned:true,policy_state:"APPROVED",
  policy_hash:"e".repeat(64),
 cash_precision_verified:true,minimum_exit_micros:10000,fee_artifact_digest:DIGEST,
 fee_source_url:"https://kalshi.com/docs/kalshi-fee-schedule.pdf",
 cash_micros:"25000000",key_fingerprint:"c".repeat(64),
 policy_id:"policy-v13",commissioning_digest:"c".repeat(64),kalshi_connection_id:QID,configured_stake_cents:100,
 max_entry_stake_cents:2500,max_entry_all_in_cents:3000};
type Row=Record<string,unknown>;
function fakeDb(input:{review?:boolean;duplicate?:boolean;permit?:boolean;badCash?:boolean;freeze?:string;unresolved?:boolean;fresh?:boolean;apiSource?:boolean;v4Source?:boolean;v4Grant?:"valid"|"missing"|"duplicate"|"malformed";globalLive?:boolean;accountLive?:boolean;globalInconsistent?:boolean;eligibleKilled?:boolean;leaseState?:"killed"|"owned"|"released";leaseKill?:boolean;leaseArmed?:boolean;leaseExposure?:boolean}={}){
 const executed:string[]=[];
 const query=async(sql:string,_args?:unknown[]):Promise<{rows:Row[]}>=>{
  executed.push(sql);
  if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.startsWith("SET LOCAL"))return {rows:[]};
  if(sql.includes("FROM public.v13_production_account a")&&sql.includes("stake.configured_stake_cents"))return {rows:[{...account,blocked_reason:input.freeze??null,...(input.apiSource?{
    fee_source_url:"strata-api-reviewed://kxbtc15m/55555555-5555-4555-8555-555555555555",
    fee_policy_version:API_SOURCE_POLICY_VERSION,fee_formula_version:API_SOURCE_FORMULA_VERSION,
  }:{}),...(input.v4Source?{
    fee_policy_version:DYNAMIC_FEE_POLICY_VERSION_V4,
    fee_formula_version:DYNAMIC_FEE_POLICY_VERSION_V4,
    policy_hash:"f".repeat(64),
  }:{})}]};
  if(sql.includes("FROM public.v13_production_observation o"))return {rows:[{
    digest:v13Digest({accountId:String(account.id),policyId:String(account.policy_id),
      feeDigest:String(account.fee_artifact_digest),stakeCents:Number(account.configured_stake_cents),
      commissioningDigest:String(account.commissioning_digest??""),
      minimumExitMicros:Number(account.minimum_exit_micros)})
  }]};
  if(sql.includes("WITH unresolved_intents"))return {rows:[{n:"0"}]};
  if(sql.includes("FROM private.strata_wallet_v4_fee_authority g")){
    const row={authority_id:QID,market_ticker:V4_TICKER,
      model_digest:V4_MODEL.modelDigest,official_source_digest:V4_MODEL.publicationDigest};
    if(input.v4Grant==="missing")return {rows:[]};
    if(input.v4Grant==="duplicate")return {rows:[row,row]};
    if(input.v4Grant==="malformed")return {rows:[{...row,official_source_digest:"invalid"}]};
    return {rows:[row]};
  }
  if(sql.includes("FROM private.kalshi_connection_credentials c"))return {rows:[{
    decrypted_secret:JSON.stringify({api_key_id:"not-real",private_key:"offline-only"}),
  }]};
  if(sql.includes("AS positions,")&&sql.includes("AS exits"))
    return {rows:[{positions:input.leaseExposure?1:0,intents:0,exits:0}]};
  if(sql.includes("AS intents,")||sql.includes(") intents,"))
   return {rows:[{intents:input.unresolved?"1":"0",events:"0",positions:"0",exit_reservations:"0"}]};
  // The guarded UPDATE embeds NOT EXISTS history subqueries; match writes
  // before generic SELECT history mocks or this test would falsely refuse.
  if(sql.includes("FROM private.kalshi_account_worker_lease")&&sql.includes("FOR UPDATE"))
    return {rows:input.leaseState?[{
      state:input.leaseState,account_kill:input.leaseKill??(input.leaseState==="killed"),
      arm_requested:input.leaseArmed??false,fencing_token:"3"
    }]:[]};
  if(sql.includes("UPDATE private.kalshi_account_worker_lease"))
    return {rows:[{fencing_token:"4"}]};
  if(sql.includes("UPDATE public.v13_production_account"))return {rows:[{id:account.id}]};
  if(sql.includes("INSERT INTO public.v13_production_observation"))return {rows:[]};
  if(sql.includes("FROM public.v13_production_intent WHERE account_id"))return {rows:[]};
  if(sql.includes("INSERT INTO private.strata_protective_release_qualification"))
   return {rows:[{id:QID,expires_at:"2026-10-20T06:00:00Z"}]};
  if(sql.includes("FROM private.strata_protective_release_qualification"))
   return {rows:[{qualification_id:QID,evidence_digest:DIGEST}]};
  if(sql.includes("FROM private.strata_protective_release_reviews")&&
     sql.includes("reviewer_user_id=$2"))return {rows:input.duplicate?[{review_id:RID}]:[]};
  if(sql.includes("INSERT INTO private.strata_protective_release_reviews"))
   return {rows:[{id:RID,expires_at:"2026-10-20T06:00:00Z"}]};
  if(sql.includes("FROM public.v13_production_account")&&sql.includes("FOR UPDATE"))
   return {rows:[{id:account.id,execution_enabled:input.accountLive??false,kill_switch:input.eligibleKilled===true?true:!(input.accountLive??false),cash_micros:"25000000",
    blocked_reason:input.freeze??null,commissioned:true,cash_precision_verified:true,reserved_micros:"0",
    reconciled_at:new Date(Date.now()-(input.fresh===false?60_000:1000)).toISOString()}]};
  if(sql.includes("FROM public.live_execution_config"))return {rows:[{
    mode:"V13_PRODUCTION",live_execution_enabled:input.globalLive??false,
    manual_kill_switch:input.globalInconsistent===true?true:!(input.globalLive??false),
  }]};
  if(sql.includes("FROM private.strata_protective_release_reviews r")&&
     sql.includes("JOIN private.strata_protective_release_qualification"))
   return {rows:input.review===false?[]:[{review_id:RID,reviewer_user_id:REVIEWER,
     review_url:"https://github.com/PatentFiles/Strata-Backend/pull/107",
     evidence_digest:DIGEST,qualification_digest:DIGEST}]};
  if(sql.includes("FROM auth.users u JOIN public.profiles p"))return {rows:input.permit===false?[]:[{"?column?":1}]};
  if(sql.includes("FROM private.strata_protective_exit_release"))return {rows:[]};
  if(sql.includes("INSERT INTO private.strata_protective_exit_release"))
   return {rows:[{id:"55555555-5555-4555-8555-555555555555",expires_at:"2026-10-20T06:00:00Z"}]};
  if(sql.includes("UPDATE public.live_execution_config"))return {rows:[{id:"singleton"}]};
  throw Error("unexpected_query");
 };
 const db={query,connect:async()=>({query,release(){executed.push("RELEASE")}})};
 return {db:db as never,executed};
}
test("PRODUCTION qualifier performs only owned GET and stores a digest, not a trading permission",async()=>{
 const h=fakeDb();
 let reads=0;
 const result=await qualifyProtectiveRelease(OWNER,{
  db:h.db,sha:()=>SHA,now:()=>Date.parse("2026-10-20T05:30:00Z"),
  readFeeds:(async()=>{reads++;return {ok:true,observedAtMs:Date.parse("2026-10-20T05:30:00Z"),
    cashMicros:"25000000",orders:[],fills:[],positions:[],settlements:[]}}) as never,
  verifyFee:(async()=>({ok:true,monetaryFeeAuthorized:true,sourceDigest:DIGEST})) as never,
 });
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(reads,1);
 assert.equal(result.ordersSubmitted,false);
 assert.equal(h.executed.filter(s=>s.includes("INSERT INTO")).length,1);
 assert.equal(h.executed.some(s=>/INSERT INTO (?:public\.v13_production_intent|private\.strata_protective_exit_release)/.test(s)),false);
});
test("Step 12 reports sanitized provider source reasons and still refuses missing or changed PDF digest",async()=>{
 const cases=[
  {fee:{ok:false,reason:"independent_official_fee_snapshot_expired"},
   expected:"release_fee_independent_official_fee_snapshot_expired"},
  {fee:{ok:false,reason:"official_fee_schedule_http_429"},
   expected:"release_fee_official_fee_schedule_http_429"},
  {fee:{ok:false,reason:"market_or_event_fee_override_unreviewed"},
   expected:"release_fee_market_or_event_fee_override_unreviewed"},
  {fee:{ok:true,sourceDigest:"c".repeat(64)},
   expected:"approved_fee_artifact_digest_changed"},
  {fee:{ok:true,sourceDigest:undefined},
   expected:"current_official_fee_digest_missing"},
  {fee:{ok:false,reason:"unsafe stack with=credentials&secret=must-not-echo"},
   expected:"release_fee_fee_preflight_unavailable"},
 ];
 for(const row of cases){
  const h=fakeDb();
  const result=await qualifyProtectiveRelease(OWNER,{
   db:h.db,sha:()=>SHA,now:()=>Date.parse("2026-10-20T05:30:00Z"),
   readFeeds:(async()=>({ok:true,observedAtMs:Date.parse("2026-10-20T05:30:00Z"),
    cashMicros:"25000000",orders:[],fills:[],positions:[],settlements:[]})) as never,
   verifyFee:(async()=>row.fee) as never,
  });
  assert.equal(result.ok,false,row.expected);
  assert.equal(result.reason,row.expected);
  assert.equal(result.ordersSubmitted,false);
  assert.equal(h.executed.some(s=>s.includes("INSERT INTO private.strata_protective_release_qualification")),false);
 }
});
test("Step 12 accepts a genuine reviewed API-source eligibility without a PDF capture",async()=>{
 const observed=Date.parse("2026-10-20T05:30:00Z"),h=fakeDb({apiSource:true});
 let pdfReads=0,apiReads=0;
 const r=await qualifyProtectiveRelease(OWNER,{
  db:h.db,sha:()=>SHA,now:()=>observed,
  readFeeds:(async()=>({ok:true,observedAtMs:observed,cashMicros:"25000000",
    orders:[],fills:[],positions:[],settlements:[]})) as never,
  verifyFee:(async()=>{pdfReads++;throw Error("PDF must not be used for API-reviewed source")}) as never,
  verifyApiFee:(async(owner:string,stage:string,url:string)=>{
   apiReads++;
   assert.equal(owner,OWNER);assert.equal(stage,"STEP_11");
   assert.equal(url,"strata-api-reviewed://kxbtc15m/55555555-5555-4555-8555-555555555555");
   return {ok:true,reason:"reviewed_api_fee_source_stage_current",identity:{
    grantId:"55555555-5555-4555-8555-555555555555",sourceUrl:url,
    digest:"f".repeat(64),feePolicyVersion:API_SOURCE_POLICY_VERSION,
    formulaVersion:API_SOURCE_FORMULA_VERSION,
    marketTicker:"KXBTC15M-26OCT200530",verifiedAtMs:observed,
   }};
  }) as never,
 });
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.ordersSubmitted,false);
 assert.equal(pdfReads,0);assert.equal(apiReads,1);
 assert.equal(h.executed.filter(x=>x.includes("INSERT INTO private.strata_protective_release_qualification")).length,1);
});

test("V4 protective qualification uses exact owner-approved dynamic issuer model, never legacy PDF preflight",async()=>{
 const h=fakeDb({v4Source:true});
 let readModel=0,legacyReads=0;
 const r=await qualifyProtectiveRelease(OWNER,{
  db:h.db,sha:()=>SHA,now:()=>V4_CLOCK,
  readFeeds:(async()=>({ok:true,observedAtMs:V4_CLOCK,cashMicros:"25000000",
   orders:[],fills:[],positions:[],settlements:[]})) as never,
  verifyFee:(async()=>{legacyReads++;throw Error("wrong policy branch");}) as never,
  observeV4Fee:async(ticker)=>{
    assert.equal(ticker,V4_TICKER);readModel++;return v4Observed();
  },
 });
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.ordersSubmitted,false);
 assert.equal(legacyReads,0);
 assert.equal(readModel,1);
 assert.ok(h.executed.some(sql=>sql.includes("g.policy_hash=$4")&&
   sql.includes("e.execution_account_id=g.execution_account_id")&&
   sql.includes("g.deployed_sha=$3")&&sql.includes("g.expires_at>now()+interval '60 seconds'")));
 assert.equal(h.executed.filter(sql=>sql.includes("INSERT INTO private.strata_protective_release_qualification")).length,1);
 assert.equal(h.executed.some(sql=>sql.includes("UPDATE public.v13_production_account")||
   sql.includes("INSERT INTO private.strata_protective_exit_release")),false);
});

test("V4 qualification fails closed on absent, duplicate, malformed, changed, future or stale owner fee evidence",async()=>{
 const cases=[
  {name:"missing",grant:"missing" as const,expected:"release_v4_owner_fee_grant_missing_or_ambiguous"},
  {name:"duplicate",grant:"duplicate" as const,expected:"release_v4_owner_fee_grant_missing_or_ambiguous"},
  {name:"malformed",grant:"malformed" as const,expected:"release_v4_fee_grant_identity_invalid"},
  {name:"changed",model:{...V4_MODEL,publicationDigest:"e".repeat(64)},expected:"release_v4_official_fee_model_changed_or_stale"},
  {name:"clock_future",model:{...V4_MODEL,observedAt:new Date(V4_CLOCK+1000).toISOString()},expected:"release_v4_official_fee_model_changed_or_stale"},
  {name:"clock_stale",model:{...V4_MODEL,observedAt:new Date(V4_CLOCK-10001).toISOString()},expected:"release_v4_official_fee_model_changed_or_stale"},
  {name:"wrong_market",model:{...V4_MODEL,marketTicker:"KXBTC15M-FOREIGN"},expected:"release_v4_official_fee_model_changed_or_stale"},
 ];
 for(const c of cases){
   const h=fakeDb({v4Source:true,v4Grant:"grant" in c?c.grant:"valid"});
   const r=await qualifyProtectiveRelease(OWNER,{
    db:h.db,sha:()=>SHA,now:()=>V4_CLOCK,
    readFeeds:(async()=>({ok:true,observedAtMs:V4_CLOCK,cashMicros:"25000000",
     orders:[],fills:[],positions:[],settlements:[]})) as never,
    verifyFee:(async()=>{throw Error("Legacy proof used for V4");}) as never,
    observeV4Fee:async()=>v4Observed("model" in c?c.model:V4_MODEL),
   });
   assert.equal(r.ok,false,c.name);
   assert.equal(r.reason,c.expected,c.name);
   assert.equal(r.ordersSubmitted,false,c.name);
   assert.equal(h.executed.some(sql=>sql.includes("INSERT INTO private.strata_protective_release_qualification")),false,c.name);
 }
 const unavailable=fakeDb({v4Source:true});
 const failed=await qualifyProtectiveRelease(OWNER,{
   db:unavailable.db,sha:()=>SHA,now:()=>V4_CLOCK,
   readFeeds:(async()=>({ok:true,observedAtMs:V4_CLOCK,cashMicros:"25000000",
    orders:[],fills:[],positions:[],settlements:[]})) as never,
   observeV4Fee:async()=>({ok:false,reason:"dynamic_fee_publication_http_429",tradingAuthorized:false}),
 });
 assert.equal(failed.ok,false);
 assert.equal(failed.reason,"release_v4_official_fee_dynamic_fee_publication_http_429");
 assert.equal(unavailable.executed.some(sql=>sql.includes("INSERT INTO private.strata_protective_release_qualification")),false);
});

test("Step 12 denies a revoked, wrong or stale API fee-source review",async()=>{
 const observed=Date.parse("2026-10-20T05:30:00Z");
 for(const caseName of ["revoked","wrong_grant","stale"]){
  const h=fakeDb({apiSource:true});
  const r=await qualifyProtectiveRelease(OWNER,{
   db:h.db,sha:()=>SHA,now:()=>observed,
   readFeeds:(async()=>({ok:true,observedAtMs:observed,cashMicros:"25000000",
     orders:[],fills:[],positions:[],settlements:[]})) as never,
   verifyFee:(async()=>{throw Error("unexpected PDF request")}) as never,
   verifyApiFee:(async()=>{
    if(caseName==="revoked")return {ok:false,reason:"api_fee_grant_missing_invalid_or_expired"};
    return {ok:true,identity:{
     grantId:caseName==="wrong_grant"?"66666666-6666-4666-8666-666666666666":
      "55555555-5555-4555-8555-555555555555",
     sourceUrl:"strata-api-reviewed://kxbtc15m/55555555-5555-4555-8555-555555555555",
     digest:"f".repeat(64),feePolicyVersion:API_SOURCE_POLICY_VERSION,
     formulaVersion:API_SOURCE_FORMULA_VERSION,marketTicker:"KXBTC15M-26OCT200530",
     verifiedAtMs:caseName==="stale"?observed-60_000:observed,
    }};
   }) as never,
  });
  assert.equal(r.ok,false,caseName);
  assert.equal(r.ordersSubmitted,false);
  assert.equal(h.executed.some(s=>s.includes("INSERT INTO private.strata_protective_release_qualification")),false);
 }
});
test("owner-only qualification rejects stale exchange readings and expired provider journeys",async()=>{
 const observed=Date.parse("2026-10-20T05:30:00Z");
 const expired=fakeDb();
 const staleFeed=await qualifyProtectiveRelease(OWNER,{
  db:expired.db,sha:()=>SHA,now:()=>observed,
  readFeeds:(async()=>({
   ok:true,observedAtMs:observed-45_001,cashMicros:"25000000",
   orders:[],fills:[],positions:[],settlements:[],
  })) as never,
  verifyFee:(async()=>({ok:true,sourceDigest:DIGEST})) as never,
 });
 assert.equal(staleFeed.reason,"authenticated_production_read_stale");
 assert.equal(expired.executed.some(sql=>sql.includes("INSERT INTO private.strata_protective_release_qualification")),false);
 const slow=fakeDb();
 let observedClockCalls=0;
 const expiredFee=await qualifyProtectiveRelease(OWNER,{
  db:slow.db,sha:()=>SHA,
  now:()=>++observedClockCalls===1?observed:
    observedClockCalls===2?observed:observed+45_001,
  readFeeds:(async()=>({
   ok:true,observedAtMs:observed,cashMicros:"25000000",
   orders:[],fills:[],positions:[],settlements:[],
  })) as never,
  verifyFee:(async()=>({ok:true,sourceDigest:DIGEST})) as never,
 });
 assert.equal(expiredFee.reason,"authenticated_production_qualification_stale");
 assert.equal(slow.executed.some(sql=>sql.includes("INSERT INTO private.strata_protective_release_qualification")),false);
});
test("reviewer cannot impersonate account owner or use ordinary user role",async()=>{
 const h=fakeDb(),data={ownerUserId:OWNER,qualificationId:QID,
  reviewUrl:"https://github.com/PatentFiles/Strata-Backend/pull/107",
  note:"Reviewed the exact SHA, price floors, unknown orders, crash recovery, fees, owner isolation and signed production GET evidence.",
  confirmation:REVIEW_CONFIRM};
 assert.equal((await attestProtectiveReleaseReview(OWNER,"ADMIN",data,{db:h.db,sha:()=>SHA})).ok,false);
 assert.equal((await attestProtectiveReleaseReview(REVIEWER,"STANDARD",data,{db:h.db,sha:()=>SHA})).ok,false);
 assert.equal(h.executed.length,0);
});
test("authenticated distinct reviewer persists immutable evidence in transaction",async()=>{
 const h=fakeDb(),data={ownerUserId:OWNER,qualificationId:QID,
  reviewUrl:"https://github.com/PatentFiles/Strata-Backend/pull/107",
  note:"Reviewed the exact release SHA, official fee inputs, full provider history, cash and position reconciliation, signed exits, and no-retry crashes.",
  confirmation:REVIEW_CONFIRM};
 const r=await attestProtectiveReleaseReview(REVIEWER,"DEVELOPER",data,{db:h.db,sha:()=>SHA});
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.ok(h.executed.indexOf("BEGIN")<h.executed.indexOf("COMMIT"));
 assert.equal(h.executed.some(s=>s.includes("UPDATE public.live_execution_config")),false);
});
test("owner acceptance is rejected if missing distinct reviewer or authenticated confirmation",async()=>{
 const h=fakeDb({review:false});
 const body={reviewId:RID,confirmation:OWNER_CONFIRM};
 assert.equal((await authorizeProtectiveRelease(OWNER,{...body,confirmation:"wrong"},{db:h.db,sha:()=>SHA})).ok,false);
 assert.equal((await authorizeProtectiveRelease(OWNER,body,{db:h.db,sha:()=>SHA})).ok,false);
 assert.equal(h.executed.some(s=>s.includes("UPDATE public.live_execution_config")),false);
 assert.ok(h.executed.includes("ROLLBACK"));
});
test("independently approved owner release fences killed terminal lease without ARM or START",async()=>{
 const h=fakeDb({globalLive:true,accountLive:true,eligibleKilled:true,leaseState:"killed"});
 const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_CONFIRM},{db:h.db,sha:()=>SHA});
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.ok(h.executed.some(x=>x.includes("UPDATE private.kalshi_account_worker_lease") &&
   x.includes("fencing_token=fencing_token+1") &&
   x.includes("state='released'") &&
   x.includes("account_kill=false") &&
   x.includes("arm_requested=false")));
 assert.ok(h.executed.some(x=>x.includes("'OWNER_RELEASE_FENCED_TERMINAL_LEASE'")));
 assert.equal(h.executed.some(x=>/productionStart|productionArm|kalshiPost|submitOrder/.test(x)),false);
 assert.ok(h.executed.includes("COMMIT"));
});
test("terminal lease transition refuses missing review, armed lease, exposure and owned worker",async()=>{
 for(const input of [
   {leaseState:"killed" as const,review:false},
   {leaseState:"killed" as const,leaseArmed:true},
   {leaseState:"killed" as const,leaseExposure:true},
   {leaseState:"owned" as const},
 ]){
   const h=fakeDb({globalLive:true,accountLive:true,eligibleKilled:true,...input});
   const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_CONFIRM},{db:h.db,sha:()=>SHA});
   assert.equal(r.ok,false,JSON.stringify(input));
   assert.equal(h.executed.includes("COMMIT"),false,JSON.stringify(input));
   assert.equal(h.executed.some(x=>x.includes("UPDATE private.kalshi_account_worker_lease")),false,JSON.stringify(input));
 }
});
test("standing release requires a distinct owner confirmation and retains immutable policy scope",async()=>{
 const h=fakeDb();
 const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_STANDING_CONFIRM},
  {db:h.db,sha:()=>SHA});
 assert.equal(r.ok,true,JSON.stringify(r));
 const q=h.executed.find(sql=>sql.includes("INSERT INTO private.strata_protective_exit_release"));
 assert.ok(q?.includes("'infinity'::timestamptz"));
 assert.ok(q?.includes("standing_policy_hash"));
 assert.ok(q?.includes("standing_execution_account_id"));
 assert.equal(h.executed.filter(sql=>sql.includes("INSERT INTO private.strata_protective_exit_release")).length,1);
});
test("owner consent inserts exact signed release then atomically enables account and global live flag",async()=>{
 const h=fakeDb();
 const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_CONFIRM},{db:h.db,sha:()=>SHA});
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.ordersSubmitted,false);
 assert.equal("workerStarted" in r && r.workerStarted,false);
 const insert=h.executed.findIndex(s=>s.includes("INSERT INTO private.strata_protective_exit_release"));
 const accountUpdate=h.executed.findIndex(s=>s.includes("UPDATE public.v13_production_account"));
 const globalUpdate=h.executed.findIndex(s=>s.includes("UPDATE public.live_execution_config"));
 assert.ok(insert>0&&accountUpdate>insert&&globalUpdate>accountUpdate);
 assert.ok(h.executed.indexOf("COMMIT")>globalUpdate);
});


test("eligible but killed owner remains stopped until genuine reviewed release",async()=>{
 const h=fakeDb({globalLive:true,accountLive:true,eligibleKilled:true});
 const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_CONFIRM},{db:h.db,sha:()=>SHA});
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.ordersSubmitted,false);
 assert.ok(h.executed.some(q=>q.includes("UPDATE public.v13_production_account SET execution_enabled=true,kill_switch=false")));
 assert.equal(h.executed.some(q=>q.includes("UPDATE public.live_execution_config")),false);
});
test("eligible but killed owner cannot bypass independent technical review",async()=>{
 const h=fakeDb({globalLive:true,accountLive:true,eligibleKilled:true,review:false});
 const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_CONFIRM},{db:h.db,sha:()=>SHA});
 assert.equal(r.ok,false);
 assert.equal(h.executed.some(q=>q.includes("UPDATE public.v13_production_account")),false);
});
test("owner's independently qualified stopped account can release when shared master is already enabled",async()=>{
 const h=fakeDb({globalLive:true});
 const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_CONFIRM},{
  db:h.db,sha:()=>SHA,
 });
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.ordersSubmitted,false);
 const technical=h.executed.findIndex(q=>q.includes("FROM private.strata_protective_release_reviews r"));
 const owned=h.executed.findIndex(q=>q.includes("UPDATE public.v13_production_account"));
 const release=h.executed.findIndex(q=>q.includes("INSERT INTO private.strata_protective_exit_release"));
 assert.ok(technical>0&&release>technical&&owned>release);
 assert.equal(h.executed.some(q=>q.includes("UPDATE public.live_execution_config")),false,
  "an already live global gate must NEVER be rewritten to qualify another account");
 assert.ok(h.executed.includes("COMMIT"));
});

test("already enabled account cannot outrun a globally stopped or inconsistent master",async()=>{
 for(const [name,input,reason] of [
  ["account active/global stopped",{accountLive:true,globalLive:false},
   "account_global_release_state_mismatch"],
  ["inconsistent global kill",{globalLive:true,globalInconsistent:true},
   "global_execution_kill_state_inconsistent"],
 ] as const){
  const h=fakeDb(input);
  const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_CONFIRM},{
   db:h.db,sha:()=>SHA,
  });
  assert.equal(r.ok,false,name);
  assert.equal(r.reason,reason,name);
  assert.equal(h.executed.some(q=>q.includes("INSERT INTO private.strata_protective_exit_release")),false,name);
  assert.equal(h.executed.some(q=>q.includes("UPDATE public.v13_production_account")),false,name);
  assert.equal(h.executed.some(q=>q.includes("UPDATE public.live_execution_config")),false,name);
  assert.ok(h.executed.includes("ROLLBACK"),name);
 }
});

test("globally enabled master still cannot bypass absent independent reviewer",async()=>{
 const h=fakeDb({globalLive:true,review:false});
 const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_CONFIRM},{
  db:h.db,sha:()=>SHA,
 });
 assert.equal(r.ok,false);
 assert.equal(h.executed.some(q=>q.includes("INSERT INTO private.strata_protective_exit_release")),false);
 assert.equal(h.executed.some(q=>q.includes("UPDATE public.v13_production_account")),false);
 assert.ok(h.executed.includes("ROLLBACK"));
});

test("provisional freeze cannot be cleared without distinct explicit owner consent",async()=>{
 const h=fakeDb({freeze:"awaiting_account_commissioning"});
 const r=await authorizeProtectiveRelease(OWNER,{reviewId:RID,confirmation:OWNER_CONFIRM},{db:h.db,sha:()=>SHA});
 assert.equal(r.ok,false);
 assert.equal(r.reason,"explicit_commissioning_repair_confirmation_required");
 assert.equal(h.executed.some(s=>s.includes("SET blocked_reason=NULL")),false);
 assert.equal(h.executed.includes("COMMIT"),false);
});
test("any genuine freeze is immutable through commissioning recovery",async()=>{
 const h=fakeDb({freeze:"unknown_exchange_order"});
 const r=await authorizeProtectiveRelease(OWNER,{
  reviewId:RID,confirmation:OWNER_CONFIRM,provisionalRepairConfirmation:PROVISIONAL_REPAIR_CONFIRM,
 },{db:h.db,sha:()=>SHA});
 assert.equal(r.reason,"account_risk_freeze_requires_independent_remediation");
 assert.equal(h.executed.some(s=>s.includes("SET blocked_reason=NULL")),false);
});
test("owner-authorized recovery denies stale signed source, mismatched cash and any exchange exposure",async()=>{
 const cases=[
  {name:"stale exchange feed",feed:emptySignedFeed({observedAtMs:Date.now()-60_000}),
   reason:"commissioning_repair_live_cash_or_freshness_unverified"},
  {name:"cash mismatch",feed:emptySignedFeed({cashMicros:"24000000"}),
   reason:"commissioning_repair_live_cash_or_freshness_unverified"},
  {name:"exchange orders",feed:emptySignedFeed({orders:[{order_id:"unknown"}]}),
   reason:"commissioning_repair_live_exposure_unverified"},
  {name:"exchange open positions",feed:emptySignedFeed({positions:[{ticker:"KXBTC15M-TEST",position_fp:"1.00"}]}),
   reason:"commissioning_repair_live_exposure_unverified"},
  {name:"provider failure",feed:{ok:false as const,reason:"kalshi_read_failed"},
   reason:"commissioning_repair_live_exchange_read_unavailable"},
 ];
 for(const row of cases){
  const h=fakeDb({freeze:"awaiting_account_commissioning"});
  const r=await authorizeProtectiveRelease(OWNER,repairRequest,{
   db:h.db,sha:()=>SHA,
   // Avoid preconstructing stale transport timestamps for otherwise valid evidence.
   readFeeds:(async (_material:unknown,observedAtMs:number)=>{
    const feed=row.feed;
    return feed.ok
      ? {...feed,observedAtMs:row.name==="stale exchange feed"?feed.observedAtMs:observedAtMs}
      : feed;
   }) as never,
  });
  assert.equal(r.ok,false,row.name);
  assert.equal(r.reason,row.reason,row.name);
  assert.equal(h.executed.some(s=>s.includes("SET blocked_reason=NULL")),false,row.name);
  assert.ok(h.executed.includes("ROLLBACK"),row.name);
 }
 const h=fakeDb({freeze:"awaiting_account_commissioning",unresolved:true});
 const r=await authorizeProtectiveRelease(OWNER,repairRequest,{
  db:h.db,sha:()=>SHA,readFeeds:(async()=>emptySignedFeed()) as never,
 });
 assert.equal(r.reason,"commissioning_repair_fresh_zero_exposure_unverified");
 assert.equal(h.executed.some(s=>s.includes("SET blocked_reason=NULL")),false);
});
test("explicit owner reviewed repair refreshes real Kalshi evidence inside transaction even with old worker reconciliation",async()=>{
 const h=fakeDb({freeze:"awaiting_account_commissioning",fresh:false});
 // The signed provider read and the expected qualification clock refer to
 // ONE observation. Sampling Date.now() twice made this positive-path test
 // nondeterministic across millisecond boundaries.
 const observedAtMs=Date.now();
 let signedReads=0;
 const r=await authorizeProtectiveRelease(OWNER,repairRequest,{
  db:h.db,sha:()=>SHA,now:()=>observedAtMs,
  readFeeds:(async()=>{
   signedReads++;
   return emptySignedFeed({observedAtMs});
  }) as never,
 });
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(signedReads,1);
 assert.equal("provisionalFreezeRepaired" in r && r.provisionalFreezeRepaired,true);
 const providerMaterial=h.executed.findIndex(s=>s.includes("FROM private.kalshi_connection_credentials c"));
 const release=h.executed.findIndex(s=>s.includes("INSERT INTO private.strata_protective_exit_release"));
 const repair=h.executed.findIndex(s=>s.includes("SET blocked_reason=NULL"));
 const audit=h.executed.findIndex(s=>s.includes("OWNER_COMMISSIONING_FREEZE_REPAIR"));
 assert.ok(providerMaterial>=0&&release>providerMaterial&&repair>release&&audit>repair);
 assert.ok(h.executed.indexOf("COMMIT")>audit);
 assert.equal(h.executed.some(s=>s.includes("INSERT INTO public.v13_production_intent")),false);
 assert.ok(h.executed.some(s=>s.includes("statement_timestamp()-interval '15 seconds'")));
 assert.equal(h.executed.some(s=>s.includes("AND reconciled_at>now()-interval '15 seconds'")),false);
});

test("release account lookup binds the policy to both execution account and owner",async()=>{
  let sqlText="";
  const db={query:async(sql:string)=>{
    sqlText=sql;
    return {rows:[]};
  }};
  const result=await readReleaseOwner(db as never,OWNER);
  assert.deepEqual(result,{ok:false,reason:"owned_account_missing_or_ambiguous"});
  assert.match(sqlText,/p\.execution_account_id\s*=\s*a\.id/);
  assert.match(sqlText,/p\.created_by\s*=\s*a\.owner_user_id::text/);
});

test("owner SHA consent alone never reports a live technical protective-exit release",async()=>{
  const h=fakeDb();
  const query=(h.db as unknown as {query:(sql:string,params?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>}).query;
  let technicalSql="";
  const db={
    query:async(sql:string,params?:unknown[])=>{
      if(sql.includes("FROM private.strata_owner_sha_approvals")){
        return {rows:[{approval_id:RID}]};
      }
      // No reviewed technical release accompanies this valid owner consent.
      if(sql.includes("FROM private.strata_protective_release_reviews v")){
        return {rows:[]};
      }
      if(sql.includes("SELECT release_id::text,expires_at FROM private.strata_protective_exit_release")){
        technicalSql=sql;
        return {rows:[]};
      }
      return query(sql,params);
    },
  };
  const status=await protectiveReleaseStatus(OWNER,OWNER,{db:db as never,sha:()=>SHA});
  assert.equal(status.ok,true,JSON.stringify(status));
  if(!("codeApprovalActive" in status && "releaseActive" in status)){
    throw new Error("release_status_shape_unavailable");
  }
  assert.equal(status.codeApprovalActive,true);
  assert.equal(status.releaseActive,false);
  assert.match(technicalSql,/expires_at>now\(\)\+interval '20 minutes'/);
  assert.match(technicalSql,/independent_reviewer_id<>\$2::uuid/);
  assert.match(technicalSql,/operator_approver_id<>independent_reviewer_id/);
});

test("OWNER_SHA_V1 releaseActive is true only with BOTH exact-SHA owner consent and technical exit approval",async()=>{
  for(const scenario of [
    {name:"technical-only",owner:false,technical:1,expected:false},
    {name:"both",owner:true,technical:1,expected:true},
    {name:"duplicate-technical",owner:true,technical:2,expected:false},
  ]){
    const h=fakeDb();
    const query=(h.db as unknown as {
      query:(sql:string,params?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>
    }).query;
    const db={query:async(sql:string,params?:unknown[])=>{
      if(sql.includes("FROM private.strata_owner_sha_approvals")){
        return {rows:scenario.owner?[{approval_id:RID}]:[]};
      }
      if(sql.includes("FROM private.strata_protective_release_reviews v")){
        return {rows:[]};
      }
      if(sql.includes("SELECT release_id::text,expires_at FROM private.strata_protective_exit_release")){
        return {rows:Array.from({length:scenario.technical},()=>({
          release_id:RID,expires_at:new Date(Date.now()+60*60_000).toISOString(),
        }))};
      }
      return query(sql,params);
    }};
    const status=await protectiveReleaseStatus(OWNER,OWNER,{db:db as never,sha:()=>SHA});
    assert.equal(status.ok,true,scenario.name+": "+JSON.stringify(status));
    if(!("releaseActive" in status && "codeApprovalActive" in status)){
      throw new Error("owner_release_status_shape_unavailable");
    }
    assert.equal(status.releaseMode,"OWNER_SHA_V1",scenario.name);
    assert.equal(status.releaseActive,scenario.expected,scenario.name);
    assert.equal(status.codeApprovalActive,scenario.owner,scenario.name);
  }
});

test("Step12 status returns legacy fee evidence diagnostics without claiming qualification",async()=>{
 const h=fakeDb();
 const t=Date.parse("2026-10-23T19:00:00Z");
 const base=(h.db as unknown as {query:(sql:string,p?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>}).query;
 const statusDb={query:async(sql:string,p?:unknown[])=>{
  if(sql.includes("FROM private.strata_owner_sha_approvals")||
     sql.includes("FROM private.strata_protective_release_reviews v"))
   return {rows:[]};
  return base(sql,p);
 }};
 const s=await protectiveReleaseStatus(OWNER,OWNER,{db:statusDb as never,sha:()=>SHA,now:()=>t});
 assert.equal(s.ok,true);
 assert.ok("feeSourceMode" in s);
 assert.ok("legacyPdfSnapshotExpired" in s);
 assert.equal(s.ordersSubmitted,false);
});


test("Step12 status identifies approved V4 policy by version, never falsely as legacy PDF",async()=>{
 for(const scenario of [
  {name:"approved_v4",opts:{v4Source:true},expected:"DYNAMIC_PROVIDER_V4",legacyExpired:false},
  {name:"legacy_pdf",opts:{},expected:"LEGACY_PDF_V1",legacyExpired:true},
  {name:"reviewed_api",opts:{apiSource:true},expected:"REVIEWED_API_V2",legacyExpired:false},
 ]){
  const h=fakeDb(scenario.opts),base=(h.db as unknown as {
    query:(sql:string,params?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>
  }).query;
  const db={query:async(sql:string,params?:unknown[])=>{
    if(sql.includes("FROM private.strata_owner_sha_approvals")||
       sql.includes("FROM private.strata_protective_release_reviews v"))
      return {rows:[]};
    return base(sql,params);
  }};
  const res=await protectiveReleaseStatus(OWNER,OWNER,{
    db:db as never,sha:()=>SHA,now:()=>Date.parse("2026-10-24T18:00:00Z"),
  });
  assert.equal(res.ok,true,scenario.name+": "+JSON.stringify(res));
  if(!("feeSourceMode" in res && "legacyPdfSnapshotExpired" in res))
    throw Error("source status shape unverified");
  assert.equal(res.feeSourceMode,scenario.expected,scenario.name);
  assert.equal(res.legacyPdfSnapshotExpired,scenario.legacyExpired,scenario.name);
  assert.equal(res.releaseActive,false);
  assert.equal(res.ordersSubmitted,false);
 }
});

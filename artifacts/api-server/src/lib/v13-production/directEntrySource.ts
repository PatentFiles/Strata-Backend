import type {CommittedForwardSourceHint} from '../forwardTestSignalWake';
import {directTargetReadiness} from "./directTargetReadiness";
import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from "node:crypto";
import type {Pool,PoolClient} from "@workspace/db";
import {evaluateV13Strategy,needsV13EntryPrice,V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET,V13_ENTRY_POLICY_VERSION} from "@workspace/v13-strategy";
import {createPublicForwardTestFeeds,type ForwardTestFeeds} from "../forwardTestFeeds";
import {createPublicBookReader,type ReadonlyResearchBook} from "../forwardTestOrderbookDepth";
import {emitDirectEntryRolloverGap,publishHeldRolloverDiagnostics} from "../rolloverStrikeDiagnostics";
import {readForwardCycleFeeds} from "../forwardFeedReadScope";
import {assertAuthorizedEntrySourceReference} from "./sourceReference";
import {WarrenBuffettResearch,type WarrenCandidate} from '../strategies/warrenBuffett';
import {WARREN_BOT,WARREN_BOT_HASH} from '../strategies/warrenBotIdentity';
import {canonical,requireProof} from "./types";
import {enqueueLiveDecision,liveAnalyticsFailure,type LiveDecisionPolicy,type LiveDecisionInput} from "./liveDecisionAnalytics";

const AGE=5000;
const TICKER=/^KXBTC15M-[A-Z0-9-]{5,90}$/;
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
const time=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
const sha=(s:string)=>createHash("sha256").update(s,"utf8").digest("hex");
const simulationEnvironment=()=>process.env.NODE_ENV==="test"&&!process.env.RAILWAY_ENVIRONMENT_ID&&
 !process.env.RAILWAY_SERVICE_ID&&!process.env.RAILWAY_PROJECT_ID&&
 /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(process.env.V13_DISPOSABLE_DATABASE_URL??"");
export type DirectWorkerPin=Readonly<{holderId:string;fencingToken:string;credentialFingerprint:string;releaseSha:string}>;
export type DirectScope=Readonly<{accountId:string;ownerId:string|null;worker?:DirectWorkerPin}>;
type Environment="LIVE_OBSERVATION"|"SIMULATION";
export type DirectEvaluation={
 id:string;evaluation_source:"direct_live_v1"|"direct_simulation_v1";execution_environment:Environment;
 market_ticker:string;crossing_key:string;entry_policy_version:string;strategy_parameter_set_id:string;strategy_parameter_hash:string;
 evaluated_at:string;original_oldest_ms:number;market_open_ms:number;market_close_ms:number;
 btc_price:number;target:number;signed_buffer:number;velocity:number;previous_side:"UP"|"DOWN"|"AT";
 up_offer:number;down_offer:number;entry_offer:number;signal:"SCOUT"|"CONFIRM";direction:"UP"|"DOWN";
 qualifying_trigger:true;fresh_cross:boolean;crossing_consumed:true;position_was_open:false;feed_freshness:"current";
 bot_strategy_id?:typeof WARREN_BOT;bot_spec_hash?:string;warren_crossing?:WarrenCandidate['crossing'];
 btc_provider_age_ms:number;btc_receive_age_ms:number;market_age_ms:number;
 account_id:string;owner_user_id:string|null;worker_pin:DirectWorkerPin|null;
 direct_quote_evidence:Quote;
 /** A fresh observation after one committed pre-order price refusal, never a wire replay. */
 price_retry_of?:string;
};
type Point={price:number;provider:number;received:number};
type Prior={ticker:string;target:number;open:number;close:number;point:Point};
// Match champion research's 30-second receipt-time velocity, using only
// this producer's own validated, consecutive observations.
function observedVelocity(points:Point[]):number|null{
 const first=points[0],last=points.at(-1);
 if(!first||!last||last.received<=first.received)return null;
 const velocity=(last.price-first.price)/((last.received-first.received)/60000);
 return finite(velocity)?velocity:null;
}
type Quote={timestampAuthority:"LOCAL_RECEIPT_ONLY";started:number;headers:number;completed:number;
 digest:string;normalizedBookDigest:string;yesBid:number;noBid:number};
type Unsigned={version:1;account:string;owner:string|null;ticker:string;evaluation:string;oldest:number;observed:number;closesAt:number;
 environment:Environment;source:DirectEvaluation;quote:Quote;priceRetryProtocol?:"PRICE_REFUSAL_V1";};
type Receipt=Unsigned&{producerSeal:string};
type Query=Pick<Pool|PoolClient,"query">;
/** A held position has its own market and quantity; current-window discovery
 * cannot substitute for that contract, including during rollover. */
export type DirectHeldEvaluation={
 id:string;evaluation_source:"direct_held_simulation_v1"|"direct_held_live_v1";execution_environment:Environment;
 position_id:string;account_id:string;owner_user_id:string|null;worker_pin:DirectWorkerPin|null;
 market_ticker:string;side:"YES"|"NO";quantity_hundredths:string;
 strategy_parameter_set_id:string;strategy_parameter_hash:string;
 evaluated_at:string;original_oldest_ms:number;market_close_ms:number;
 btc_price:number;target:number;signed_buffer:number;velocity:number|null;up_offer:number;down_offer:number;
 feed_freshness:"current";btc_provider_age_ms:number;btc_receive_age_ms:number;market_age_ms:number;
};
type HeldReceipt={version:1;account:string;owner:string|null;source:DirectHeldEvaluation;quote:Quote;producerSeal:string};

function top(book:ReadonlyResearchBook,market:string,cycle:number,now:number):Quote {
 requireProof(book.ticker===market&&book.source==="KALSHI_PUBLIC_REST"&&book.timestampAuthority==="LOCAL_RECEIPT_ONLY"&&
  time(book.requestStartedAtMs)&&time(book.receivedAtMs)&&time(book.bodyCompletedAtMs)&&
  cycle<=book.requestStartedAtMs&&book.requestStartedAtMs<=book.receivedAtMs&&book.receivedAtMs<=book.bodyCompletedAtMs&&
  book.bodyCompletedAtMs<=now&&now-book.requestStartedAtMs<=AGE&&typeof book.rawResponseDigest==="string"&&HASH.test(book.rawResponseDigest),
  "direct_entry_book_provenance_invalid");
 const bid=(levels:ReadonlyResearchBook["yesBids"])=>{
  requireProof(Array.isArray(levels)&&levels.length>0&&levels.length<=1000,"direct_entry_book_depth_invalid");
  const seen=new Set<number>();let best=0;
  for(const l of levels){
   requireProof(Number.isSafeInteger(l.priceTicks)&&l.priceTicks>0&&l.priceTicks<10000&&
    Number.isSafeInteger(l.contractsHundredths)&&l.contractsHundredths>0&&l.contractsHundredths<=1000000000&&
    !seen.has(l.priceTicks),"direct_entry_book_depth_invalid");
   seen.add(l.priceTicks);best=Math.max(best,l.priceTicks);
  }
  return best;
 };
 const yesBid=bid(book.yesBids),noBid=bid(book.noBids);
 requireProof(yesBid+noBid<=10000,"direct_entry_book_crossed");
 return {timestampAuthority:"LOCAL_RECEIPT_ONLY",started:book.requestStartedAtMs,headers:book.receivedAtMs,
  completed:book.bodyCompletedAtMs,digest:book.rawResponseDigest,
  normalizedBookDigest:sha(canonical({ticker:book.ticker,yes:[...book.yesBids].sort((a,b)=>b.priceTicks-a.priceTicks),
    no:[...book.noBids].sort((a,b)=>b.priceTicks-a.priceTicks)})),yesBid,noBid};
}
/** Independent public depth and top-of-book identity. Actual signed depth,
 * stake and cash-risk checks remain mandatory. No modeled paper quantity or
 * fill is execution evidence. HMAC custody is checked separately by readExact.
 */
export function assertDirectEntryQuoteEvidence(value:unknown,now:number):void{
 const fail="direct_entry_quote_evidence_invalid";
 requireProof(value!==null&&typeof value==="object"&&!Array.isArray(value),fail);
 const v=value as DirectEvaluation,q=v.direct_quote_evidence;
 requireProof(q&&typeof q==="object"&&q.timestampAuthority==="LOCAL_RECEIPT_ONLY"&&
  (v.evaluation_source==="direct_live_v1"&&v.execution_environment==="LIVE_OBSERVATION"||
   v.evaluation_source==="direct_simulation_v1"&&v.execution_environment==="SIMULATION")&&
  TICKER.test(v.market_ticker)&&typeof q.digest==="string"&&HASH.test(q.digest)&&
  typeof q.normalizedBookDigest==="string"&&HASH.test(q.normalizedBookDigest)&&
  time(q.started)&&time(q.headers)&&time(q.completed)&&
  Number.isSafeInteger(q.yesBid)&&q.yesBid>0&&q.yesBid<10000&&
  Number.isSafeInteger(q.noBid)&&q.noBid>0&&q.noBid<10000&&q.yesBid+q.noBid<=10000&&
  v.up_offer===(10000-q.noBid)/10000&&v.down_offer===(10000-q.yesBid)/10000&&
  (v.direction==="UP"||v.direction==="DOWN")&&v.entry_offer===(v.direction==="UP"?v.up_offer:v.down_offer),fail);
 const evaluated=Date.parse(v.evaluated_at);
 requireProof(time(now)&&time(evaluated)&&time(v.original_oldest_ms)&&time(v.market_open_ms)&&time(v.market_close_ms)&&
  v.market_close_ms-v.market_open_ms===900000&&v.market_open_ms<=v.original_oldest_ms&&
  v.original_oldest_ms<=q.started&&q.started<=q.headers&&q.headers<=q.completed&&q.completed<=evaluated&&evaluated<=now&&
  now-v.original_oldest_ms<=AGE&&now<v.market_close_ms&&
  [v.btc_provider_age_ms,v.btc_receive_age_ms,v.market_age_ms].every(a=>time(a)&&a+now-evaluated<=AGE),
  "direct_entry_original_source_expired");
 assertAuthorizedEntrySourceReference(v);
}

export type DirectCommittedMetadataSource=CommittedForwardSourceHint & Readonly<{
 directSourceSha256:string;directOldestMs:number;
}>;

/**
 * Independent producer and exact committed-source reader for the existing
 * executor. Public provider observations only; no paper ledger, positions,
 * fills, notifications or simulation stake.
 *
 * The seal is process-local custody, NOT an exchange signature. Restart or
 * another producer instance cannot adopt a receipt. Financial entry remains
 * durably unique per market. One separately sealed fresh observation is possible
 * only after a committed pre-intent price refusal; uncertain orders never retry.
 * The live factory pins the actual owner-worker lease. It never restores custody after restart.
 */
export class DirectEntrySource{
 readonly #committedMetadata=new WeakSet<DirectCommittedMetadataSource>();
 ownsCommittedMetadata(hint:DirectCommittedMetadataSource):boolean{return this.#committedMetadata.has(hint);}
 static readonly #validatedDigests=new WeakMap<object,string>();
 static validatedSourceDigest(source:unknown):string|undefined{
  return source!==null&&typeof source==="object"?this.#validatedDigests.get(source):undefined;
 }
 readonly #secret=randomBytes(32);
 readonly #scope:DirectScope;
 readonly #environment:Environment;
 #prior:Prior|null=null;#points:Point[]=[];#running=false;#lastClock=-1;
 #retryRehearsal=false;
 #selectedBot:string=V13_CHAMPION_PARAMETER_SET.id;#warren:WarrenBuffettResearch|null=null;
 get strategyId():string{return this.#selectedBot;}
 #priceRetryStorage=false;
 #lastReadyMarket:string|null=null;
 #heldPrior:(Prior&{positionId:string})|null=null;#heldPoints:Point[]=[];
 #clearHeld(){this.#heldPrior=null;this.#heldPoints=[];}
 private constructor(scope:DirectScope,environment:Environment,private readonly feeds:ForwardTestFeeds,private readonly clock:()=>number,private readonly auditPolicy:LiveDecisionPolicy={}){
  requireProof(typeof scope.accountId==="string"&&scope.accountId.length>0&&scope.accountId.length<=128&&
   (scope.ownerId===null||UUID.test(scope.ownerId)),"direct_entry_scope_invalid");
  this.#scope=Object.freeze({...scope,...(scope.worker?{worker:Object.freeze({...scope.worker})}:{})});this.#environment=environment;
 }
 get environment(){return this.#environment;}
 matches(scope:DirectScope){return this.#scope.accountId===scope.accountId&&this.#scope.ownerId===scope.ownerId;}
 static marketObservation(scope:DirectScope,auditPolicy:LiveDecisionPolicy={},botId:string=V13_CHAMPION_PARAMETER_SET.id){
  requireProof(botId===V13_CHAMPION_PARAMETER_SET.id||botId===WARREN_BOT,'direct_bot_identity_not_qualified');
  requireProof(scope.ownerId&&scope.worker&&/^[A-Za-z0-9._:-]{1,128}$/.test(scope.worker.holderId)&&
   /^[1-9]\d*$/.test(scope.worker.fencingToken)&&HASH.test(scope.worker.credentialFingerprint)&&
   /^[a-f0-9]{40}$/.test(scope.worker.releaseSha)&&scope.worker.releaseSha===process.env.RAILWAY_GIT_COMMIT_SHA,
   "direct_live_worker_scope_invalid");
  // The direct-entry lane owns its own public-feed diagnostics when paper is separate.
  const feeds=createPublicForwardTestFeeds(fetch,()=>new Date(),()=>performance.now(),event=>{
   emitDirectEntryRolloverGap(event);
   queueMicrotask(()=>publishHeldRolloverDiagnostics(event));
  });
  const source=new DirectEntrySource(scope,"LIVE_OBSERVATION",{...feeds,book:createPublicBookReader()},Date.now,auditPolicy);
  source.#selectedBot=botId;source.#warren=botId===WARREN_BOT?new WarrenBuffettResearch():null;
  source.#priceRetryStorage=process.env.STRATA_DIRECT_PRICE_RETRY_V1_SHA===scope.worker.releaseSha;
  return source;
 }
 static isolatedSimulation(scope:DirectScope,feeds:ForwardTestFeeds,clock:()=>number){
  requireProof(simulationEnvironment(),"direct_entry_simulation_requires_disposable");
  return new DirectEntrySource(scope,"SIMULATION",feeds,clock);
 }
 /** Independent native tests still require the canonical disposable boundary. */
 static isolatedPriceRetrySimulation(scope:DirectScope,feeds:ForwardTestFeeds,clock:()=>number){
  const source=this.isolatedSimulation(scope,feeds,clock);
  requireProof(scope.ownerId&&scope.worker,'direct_price_retry_owned_scope_required');
  source.#priceRetryStorage=true;return source;
 }
 /** Isolated strategy qualification has no order/transport capabilities. */
 static isolatedWarrenSimulation(scope:DirectScope,feeds:ForwardTestFeeds,clock:()=>number){
  const source=this.isolatedSimulation(scope,feeds,clock);source.#selectedBot=WARREN_BOT;
  source.#warren=new WarrenBuffettResearch();return source;
 }
 priceRetryPermitted():boolean{
  if(!this.#priceRetryStorage)return false;
  if(this.#environment==='SIMULATION')return simulationEnvironment();
  return process.env.NODE_ENV==='production'&&process.env.STRATA_DIRECT_PRICE_RETRY_V1_SHA===this.#scope.worker?.releaseSha&&
   process.env.RAILWAY_GIT_COMMIT_SHA===this.#scope.worker?.releaseSha;
 }
 /** Record only a code-owned failed preflight inside its existing account transaction.
  * No intent or reservation has been created at this boundary. Database guards
  * independently refuse a changed owner, lease, policy, source or financial state. */
 async recordPriceRefusal(tx:Query,source:DirectEvaluation,policyHash:string,bestAsk:string):Promise<boolean>{
  if(!this.priceRetryPermitted()||source.price_retry_of||!this.#scope.ownerId||!this.#scope.worker)return false;
  this.assertExecutorBinding(this.#environment==='SIMULATION'?'SIMULATION':'LIVE',this.#scope);
  const sourceSha256=DirectEntrySource.validatedSourceDigest(source);
  requireProof(sourceSha256&&source.account_id===this.#scope.accountId&&source.owner_user_id===this.#scope.ownerId,'direct_price_refusal_source_unverified');
  const reference=Math.round(source.entry_offer*1000000),ask=Math.round(Number(bestAsk)*1000000);
  requireProof(Number.isSafeInteger(reference)&&Number.isSafeInteger(ask)&&ask>reference&&ask<1000000,'direct_price_refusal_not_price_change');
  const result=await tx.query('INSERT INTO private.strata_direct_price_refusal(source_id,account_id,crossing_key,owner_user_id,source_sha256,release_sha,policy_hash,reference_micros,best_ask_micros,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING source_id',
   [source.id,this.#scope.accountId,source.crossing_key,this.#scope.ownerId,sourceSha256,this.#scope.worker.releaseSha,policyHash,reference,ask,'live_money_best_ask_above_signal_ceiling']);
  return result.rows.length===1;
 }
 /** This exercise cannot be reached from Railway startup or a LIVE worker. */
 static isolatedRetryRehearsal(scope:DirectScope,feeds:ForwardTestFeeds,clock:()=>number){
  const source=this.isolatedSimulation(scope,feeds,clock);
  source.#retryRehearsal=true;
  return source;
 }
 assertFirstReadReceiptWorkerPin(pin:Readonly<{
  ownerId:string;releaseSha:string;holderId:string;fencingToken:string;credentialFingerprint:string;
 }>):void{
  requireProof(this.#environment==="LIVE_OBSERVATION"&&this.#scope.worker,
   "direct_fee_refusal_requires_live_observation");
  this.assertExecutorBinding("LIVE",this.#scope);
  const own=this.#scope.worker;
  requireProof(this.#scope.ownerId===pin.ownerId&&own.releaseSha===pin.releaseSha&&
   own.holderId===pin.holderId&&own.fencingToken===pin.fencingToken&&
   own.credentialFingerprint===pin.credentialFingerprint,"direct_fee_refusal_worker_pin_mismatch");
 }
 assertSimulationBinding(scope:DirectScope){
  requireProof(this.#environment==="SIMULATION"&&simulationEnvironment()&&this.matches(scope),
   "direct_entry_simulation_binding_invalid");
 }
 /** Real LIVE adapters may be exercised with synthetic sources only in the
  * existing disposable environment. The real HTTP wrapper rejects them. */
 assertExecutorBinding(mode:"LIVE"|"SIMULATION",scope:DirectScope):void{
  requireProof(this.matches(scope),"direct_source_account_mismatch");
  if(this.#retryRehearsal)requireProof(mode==="SIMULATION","direct_retry_rehearsal_requires_simulation");
  if(this.#environment==="SIMULATION"){this.assertSimulationBinding(scope);return;}
  requireProof(mode==="LIVE"&&this.#scope.ownerId!==null&&this.#scope.worker&&
    this.#scope.worker.releaseSha===process.env.RAILWAY_GIT_COMMIT_SHA,
    "direct_live_worker_scope_invalid");
 }
 async #assertDatabase(db:Query){
  if(this.#environment==="SIMULATION"){
   requireProof(simulationEnvironment(),"direct_entry_simulation_requires_disposable");
   const r=await db.query("SELECT current_database() AS db,host(inet_server_addr()) AS host");
   requireProof(r.rows.length===1&&r.rows[0].db===new URL(process.env.V13_DISPOSABLE_DATABASE_URL!).pathname.slice(1)&&
    r.rows[0].host==="127.0.0.1","direct_entry_simulation_requires_disposable");
  }else{
   this.assertExecutorBinding("LIVE",this.#scope);
   const pin=this.#scope.worker!;
   // Same account, credential, holder and fence on every custody read.
   // STOP only closes entries; a still-owned non-killed lease can reduce.
   const r=await db.query("SELECT l.execution_account_id FROM private.kalshi_account_worker_lease l "+
    "JOIN public.v13_production_account a ON a.id=l.execution_account_id AND a.owner_user_id=l.owner_user_id "+
    "JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id AND c.financial_account_id=a.kalshi_connection_id "+
    "AND c.provider_connection_id=l.provider_connection_id AND c.vault_secret_id=l.vault_secret_id AND c.key_fingerprint=l.credential_fingerprint "+
    "WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND l.holder_id=$3 AND l.fencing_token=$4::bigint "+
    "AND l.credential_fingerprint=$5 AND a.key_fingerprint=$5 AND l.state='owned' AND l.account_kill=false "+
    "AND a.kill_switch=false AND a.execution_enabled=true AND l.heartbeat_at BETWEEN clock_timestamp()-interval '5 seconds' AND clock_timestamp() "+
    "AND c.role='restricted_execution' AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified' FOR SHARE OF l,c",
    [this.#scope.accountId,this.#scope.ownerId,pin.holderId,pin.fencingToken,pin.credentialFingerprint]);
   requireProof(r.rows.length===1&&r.rows[0].execution_account_id===this.#scope.accountId,"direct_live_worker_lease_changed");
  }
 }
 #now(){const n=this.clock();requireProof(time(n)&&n>=this.#lastClock,"direct_entry_clock_regressed");this.#lastClock=n;return n;}
 #seal(bytes:string){return createHmac("sha256",this.#secret).update(bytes,"utf8").digest("hex");}
 async capture(db:Query,signal?:AbortSignal,afterCommit?:(hint:DirectCommittedMetadataSource)=>void):Promise<string|null>{
  if(this.#running)return null;this.#running=true;
  const audit:Pick<LiveDecisionInput,"outcome"|"reasonCode"|"reasonDetail"|"market"|"direction"|"signal"|"sourceId"|"facts">={
   outcome:"ERROR",reasonCode:"live_evaluation_incomplete",facts:{}
  };
  const facts=audit.facts!;
  let auditAt=Date.now();
  try{
   await this.#assertDatabase(db);
   const cycle=this.#now(),deadline=AbortSignal.timeout(AGE);
   const {btc,market}=await readForwardCycleFeeds(this.feeds,undefined,signal,deadline);
   const now=this.#now(),provider=btc.providerAt.getTime(),received=btc.receivedAt.getTime(),
    fetched=market.fetchedAt.getTime(),open=market.startsAt?.getTime(),close=market.endsAt?.getTime();
   auditAt=now;
   audit.market=typeof market.ticker==="string"&&TICKER.test(market.ticker)?market.ticker:null;
   Object.assign(facts,{btcPrice:btc.price,target:market.target,
    distance:typeof btc.price==="number"&&typeof market.target==="number"?btc.price-market.target:null,
    marketOpenMs:open??null,marketCloseMs:close??null,btcProviderAgeMs:now-provider,
    btcReceiveAgeMs:now-received,marketAgeMs:now-fetched});
   requireProof(time(open)&&time(close)&&close-open===900000&&open<=cycle&&now<close&&
    TICKER.test(market.ticker)&&["open","active"].includes(market.status)&&market.result===null&&
    finite(btc.price)&&btc.price>0&&time(provider)&&time(received)&&
    provider<=received&&cycle<=received&&cycle<=fetched&&[cycle,provider,received,fetched].every(x=>time(x)&&x<=now&&now-x<=AGE),
    "direct_entry_market_or_feed_invalid");
   const targetReadiness=directTargetReadiness({target:market.target,status:market.targetStatus,openMs:open,nowMs:now,previouslyReady:this.#lastReadyMarket===market.ticker});
   facts.targetReadiness=targetReadiness;
   if(targetReadiness==='waiting'){
    // Never derive a crossing through a missing target. No quote, source claim,
    // fee request, order or clock extension occurs while initialization waits.
    this.#prior=null;this.#points=[];this.#warren?.invalidate();
    audit.outcome='PASS';audit.reasonCode='market_target_initializing';
    audit.reasonDetail='Exact market target not published yet; waiting without an order.';
    return null;
   }
   requireProof(targetReadiness==='ready',targetReadiness==='unavailable'?'direct_entry_target_unavailable':'direct_entry_target_invalid');
   requireProof(finite(market.target)&&market.target>0,'direct_entry_target_invalid');
   this.#lastReadyMarket=market.ticker;
   const point={price:btc.price,provider,received},prior=this.#prior,target=market.target;
   if(prior&&prior.ticker===market.ticker&&(prior.target!==target||prior.open!==open||prior.close!==close))
    throw Error("direct_entry_market_identity_changed");
   // No crossing across restart, rollover, repeated provider time or data gap.
   const continuous=!!prior&&prior.ticker===market.ticker&&provider>prior.point.provider&&
    received>prior.point.received&&provider-prior.point.provider<=AGE&&received-prior.point.received<=AGE;
   if(!continuous)this.#points=[];
   this.#points=[...this.#points.filter(p=>received-p.received<=30000),point].slice(-180);
   this.#prior={ticker:market.ticker,target,open,close,point};
   const warren=this.#warren?.observe({market:market.ticker,target,btc:btc.price,openMs:open,closeMs:close,
    nowMs:now,providerAtMs:provider,receivedAtMs:received,marketObservedAtMs:fetched});
   facts.continuous=continuous;
   if(!continuous||!prior){
    audit.outcome="PASS";audit.reasonCode="continuous_crossing_history_required";
    audit.reasonDetail="No consecutive validated observations for this market; no fresh crossing can be established.";
    return null;
   }
   const velocity=observedVelocity(this.#points),previousBuffer=prior.point.price-target;
   Object.assign(facts,{velocity,previousBuffer});
   const input={marketTicker:market.ticker,btcPrice:btc.price,target,previousBuffer,velocity,
    freshness:"current" as const,position:null};
   const needsPrice=this.#warren?warren?.outcome==='QUOTE_REQUIRED':needsV13EntryPrice(input);
   facts.needsEntryPrice=needsPrice;
   if(this.#warren&&!needsPrice){
    audit.outcome=warren?.outcome==='ERROR'?'ERROR':'PASS';audit.reasonCode='warren_'+(warren?.reason??'no_candidate');
    audit.reasonDetail='Warren pending-cross rules did not authorize a fresh quote.';return null;
   }
   if(!needsPrice||velocity===null||!this.feeds.book){
    // Preserve the existing no-book-read prefilter. A missing quote is not
    // evidence of repricing or insufficient liquidity.
    const diagnostic=evaluateV13Strategy({...input,upOffer:null,downOffer:null});
    audit.direction=diagnostic.direction;audit.signal=diagnostic.signal;
    Object.assign(facts,{freshCross:diagnostic.freshCross,separation:diagnostic.separation,qualifyingTrigger:false});
    audit.outcome=!this.feeds.book&&needsPrice?"ERROR":"PASS";
    audit.reasonCode=velocity===null?"velocity_unavailable":!diagnostic.freshCross?"no_fresh_cross":
      !this.feeds.book&&needsPrice?"entry_book_reader_unavailable":"price_independent_entry_filter_not_met";
    audit.reasonDetail=audit.reasonCode==="price_independent_entry_filter_not_met"?
      "Observed crossing, separation or directional velocity did not meet the champion prefilter; no entry quote requested.":
      audit.reasonCode==="no_fresh_cross"?"No new directional crossing in consecutive observations.":
      audit.reasonCode==="velocity_unavailable"?"Directional velocity unavailable.":"Entry order-book reader unavailable.";
    return null;
   }
   const book=await this.feeds.book(market.ticker,signal?AbortSignal.any([signal,deadline]):deadline);
   const observed=this.#now();deadline.throwIfAborted();signal?.throwIfAborted();
   const quote=top(book,market.ticker,cycle,observed);
   const oldest=Math.min(cycle,provider,received,fetched,quote.started);
   requireProof(observed-oldest<=AGE&&oldest>=open&&observed<close,"direct_entry_original_source_expired");
   const up=(10000-quote.noBid)/10000,down=(10000-quote.yesBid)/10000;
   const baseDecision=evaluateV13Strategy({...input,upOffer:up,downOffer:down});
   const warrenPriced=this.#warren&&warren?.candidate?this.#warren.price(warren.candidate,
    {market:market.ticker,requestStartedAtMs:quote.started,receivedAtMs:quote.completed,upOffer:up,downOffer:down},observed):null;
   const warrenOk=warrenPriced?.outcome==='QUALIFIED'&&warren?.candidate;
   const decision=this.#warren&&warren?.candidate?{...baseDecision,
    signal:warrenOk?warren.candidate.signal:'PASS' as const,
    direction:warren.candidate.direction,qualifyingTrigger:Boolean(warrenOk),
    freshCross:warren.candidate.freshCrossAtObservation,
    entrySideOffer:warrenOk?warrenPriced!.referenceOffer??null:null,
    reason:warrenPriced?.reason??'warren_qualification_refused'}:baseDecision;
   auditAt=observed;audit.signal=decision.signal;audit.direction=decision.direction;
   audit.reasonDetail=decision.reason;
   Object.assign(facts,{upOffer:up,downOffer:down,entryOffer:decision.entrySideOffer,candidateOffer:decision.candidateOffer,
    freshCross:decision.freshCross,separation:decision.separation,qualifyingTrigger:decision.qualifyingTrigger});
   audit.outcome="PASS";audit.reasonCode=decision.signal==="PASS"?"strategy_pass":"strategy_trigger_not_qualified";
   if(!decision.qualifyingTrigger||(!this.#warren&&!decision.freshCross)||decision.entrySideOffer===null||
    (decision.signal!=="SCOUT"&&decision.signal!=="CONFIRM")||(decision.direction!=="UP"&&decision.direction!=="DOWN"))return null;
   const id=randomUUID(),account=this.#scope.accountId,ticker=market.ticker,crossing=ticker+":first";
   let priceRetryOf:string|undefined;
   if(this.priceRetryPermitted()){
    const previous=await db.query('SELECT s.id FROM public.strata_direct_entry_source s JOIN private.strata_direct_price_refusal r ON r.source_id=s.id AND r.account_id=s.account_id AND r.source_sha256=s.evidence_sha256 WHERE s.account_id=$1 AND s.crossing_key=$2 AND r.owner_user_id=$3::uuid AND r.release_sha=$4 LIMIT 2',
     [account,crossing,this.#scope.ownerId,this.#scope.worker!.releaseSha]);
    if(previous.rows.length===1)priceRetryOf=previous.rows[0].id;
   }
   const source:DirectEvaluation={id,...(priceRetryOf?{price_retry_of:priceRetryOf}:{}),evaluation_source:this.#environment==="SIMULATION"?"direct_simulation_v1":"direct_live_v1",
    execution_environment:this.#environment,market_ticker:ticker,crossing_key:crossing,
    entry_policy_version:V13_ENTRY_POLICY_VERSION,strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,
    strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,
    ...(warrenOk?{bot_strategy_id:WARREN_BOT,bot_spec_hash:WARREN_BOT_HASH,warren_crossing:warren.candidate.crossing}:{}),
    evaluated_at:new Date(observed).toISOString(),original_oldest_ms:oldest,market_open_ms:open,market_close_ms:close,
    btc_price:btc.price,target,signed_buffer:btc.price-target,velocity,previous_side:previousBuffer>0?"UP":previousBuffer<0?"DOWN":"AT",
    up_offer:up,down_offer:down,entry_offer:decision.entrySideOffer,signal:decision.signal,direction:decision.direction,
    qualifying_trigger:true,fresh_cross:decision.freshCross,crossing_consumed:true,position_was_open:false,feed_freshness:"current",
    btc_provider_age_ms:observed-provider,btc_receive_age_ms:observed-received,market_age_ms:observed-fetched,
    account_id:account,owner_user_id:this.#scope.ownerId,worker_pin:this.#scope.worker??null,direct_quote_evidence:quote};
   assertDirectEntryQuoteEvidence(source,observed);
   const unsigned:Unsigned={version:1,account,owner:this.#scope.ownerId,ticker,evaluation:id,oldest,observed,closesAt:close,
    environment:this.#environment,source,quote,...(this.priceRetryPermitted()?{priceRetryProtocol:"PRICE_REFUSAL_V1" as const}:{})};
   const receipt:Receipt={...unsigned,producerSeal:this.#seal(JSON.stringify(unsigned))};
   const bytes=JSON.stringify(receipt),sourceHash=sha(bytes);
   const r=await db.query(
    "INSERT INTO public.strata_direct_entry_source (id,account_id,market_ticker,crossing_key,observed_at,oldest_source_at,closes_at,evidence_bytes,evidence_sha256) "+
    "SELECT $1,a.id,$3,$4,$5,$6,$7,$8,$9 FROM public.v13_production_account a "+
    "WHERE a.id=$2 AND a.owner_user_id IS NOT DISTINCT FROM $10::uuid "+
    "ON CONFLICT DO NOTHING RETURNING id",
    [id,account,ticker,crossing,new Date(observed),new Date(oldest),new Date(close),bytes,sourceHash,this.#scope.ownerId]);
   if(r.rows.length!==1||r.rows[0].id!==id){
    audit.outcome="BLOCKED";audit.reasonCode="crossing_already_consumed";
    audit.reasonDetail="Existing immutable entry-source claim prevented a duplicate crossing.";
    return null;
   }
   audit.sourceId=id;
   const committedAt=this.#now();
   if(afterCommit&&this.#environment==='LIVE_OBSERVATION'){
    const hint:DirectCommittedMetadataSource=Object.freeze({evaluationId:id,marketTicker:ticker,evaluatedAtMs:observed,
     btcProviderAgeMs:source.btc_provider_age_ms,btcReceiveAgeMs:source.btc_receive_age_ms,marketAgeMs:source.market_age_ms,
     qualifyingTrigger:true,committedAtMs:committedAt,directSourceSha256:sourceHash,directOldestMs:oldest});
    // Only this source object can issue scheduling coordinates after its successful INSERT.
    // Public metadata cannot replace either subsequent exact custody/source read.
    this.#committedMetadata.add(hint);
    try{afterCommit(hint);}catch{/* optional scheduling cannot change the observation */}
   }
   const exact=await this.readExact(db,id,committedAt);
   audit.outcome=exact?"QUALIFIED":"BLOCKED";
   audit.reasonCode=exact?"qualifying_live_trigger":"direct_source_readback_unverified";
   if(!exact)audit.reasonDetail="The source did not pass exact readback.";
   return exact?id:null;
  }catch(e){
   audit.outcome="ERROR";audit.reasonCode=liveAnalyticsFailure(e);audit.reasonDetail=null;
   this.#prior=null;this.#points=[];this.#warren?.invalidate();throw e;
  }finally{
   this.#running=false;
   if(this.#environment==="LIVE_OBSERVATION"&&this.#scope.ownerId&&this.#scope.worker)
    enqueueLiveDecision({...audit,...this.auditPolicy,accountId:this.#scope.accountId,ownerId:this.#scope.ownerId,
     releaseSha:this.#scope.worker.releaseSha,observedAtMs:auditAt,stage:"OBSERVATION"});
  }
 }
 async readExact(db:Query,id:string,now:number):Promise<DirectEvaluation|null>{
  if(!UUID.test(id)||!time(now))return null;
  await this.#assertDatabase(db);
  const r=await db.query(
   "SELECT s.*,a.owner_user_id::text AS owner_id FROM public.strata_direct_entry_source s "+
   "JOIN public.v13_production_account a ON a.id=s.account_id "+
   "WHERE s.id=$1 AND s.account_id=$2 AND a.owner_user_id IS NOT DISTINCT FROM $3::uuid "+
   (this.#priceRetryStorage?"AND NOT EXISTS(SELECT 1 FROM private.strata_direct_price_refusal price_refusal WHERE price_refusal.source_id=s.id) ":"")+
   (this.#retryRehearsal?"AND EXISTS(SELECT 1 FROM public.strata_direct_entry_current c WHERE c.source_id=s.id AND c.account_id=s.account_id AND c.crossing_key=s.crossing_key) AND NOT EXISTS(SELECT 1 FROM public.strata_direct_entry_refusal f WHERE f.source_id=s.id) ":"")+
   "FOR SHARE OF s",
   [id,this.#scope.accountId,this.#scope.ownerId]);
  if(r.rows.length!==1)return null;
  const row=r.rows[0],bytes=row.evidence_bytes;
  if(typeof bytes!=="string"||Buffer.byteLength(bytes)>65536||row.evidence_sha256!==sha(bytes))return null;
  try{
   const receipt=JSON.parse(bytes) as Receipt,{producerSeal,...unsigned}=receipt;
   if(typeof producerSeal!=="string"||!HASH.test(producerSeal)||!timingSafeEqual(Buffer.from(producerSeal,"hex"),Buffer.from(this.#seal(JSON.stringify(unsigned)),"hex")))return null;
   const s=receipt.source;
   if(s.price_retry_of&&(!UUID.test(s.price_retry_of)||!this.priceRetryPermitted()||receipt.priceRetryProtocol!=="PRICE_REFUSAL_V1"))return null;
   if(JSON.stringify(receipt)!==bytes||receipt.version!==1||receipt.environment!==this.#environment||
    receipt.account!==this.#scope.accountId||receipt.owner!==this.#scope.ownerId||row.owner_id!==this.#scope.ownerId||
    receipt.evaluation!==id||s.id!==id||s.execution_environment!==this.#environment||
    s.account_id!==this.#scope.accountId||s.owner_user_id!==this.#scope.ownerId||
    canonical(s.worker_pin)!==canonical(this.#scope.worker??null)||canonical(s.direct_quote_evidence)!==canonical(receipt.quote)||
    s.evaluation_source!==(this.#environment==="SIMULATION"?"direct_simulation_v1":"direct_live_v1")||
    receipt.ticker!==row.market_ticker||receipt.ticker!==s.market_ticker||s.crossing_key!==row.crossing_key||
    s.crossing_key!==s.market_ticker+":first"||!time(receipt.oldest)||!time(receipt.observed)||!time(receipt.closesAt)||
    receipt.oldest>receipt.observed||receipt.observed>now||now-receipt.oldest>AGE||now>=receipt.closesAt||
    new Date(row.oldest_source_at).getTime()!==receipt.oldest||new Date(row.observed_at).getTime()!==receipt.observed||
    new Date(row.closes_at).getTime()!==receipt.closesAt||Date.parse(s.evaluated_at)!==receipt.observed||
    s.original_oldest_ms!==receipt.oldest||s.market_close_ms!==receipt.closesAt||s.market_open_ms>receipt.oldest||s.entry_policy_version!==V13_ENTRY_POLICY_VERSION||
    s.strategy_parameter_hash!==V13_CHAMPION_PARAMETER_HASH||s.strategy_parameter_set_id!==V13_CHAMPION_PARAMETER_SET.id||
    (this.#selectedBot===WARREN_BOT?(s.bot_strategy_id!==WARREN_BOT||s.bot_spec_hash!==WARREN_BOT_HASH):s.bot_strategy_id!==undefined)||
    !s.qualifying_trigger||(!s.fresh_cross&&this.#selectedBot!==WARREN_BOT)||!s.crossing_consumed||s.position_was_open||s.feed_freshness!=="current")return null;
   assertDirectEntryQuoteEvidence(s,now);
   DirectEntrySource.#validatedDigests.set(s,row.evidence_sha256);
   return Object.freeze(s);
  }catch{return null;}
 }
 async #heldPosition(db:Query,id:string){
  const r=await db.query(
   "SELECT p.id,p.account_id,p.market,p.side,p.quantity_hundredths::text AS quantity_hundredths "+
   "FROM public.v13_production_position p JOIN public.v13_production_account a ON a.id=p.account_id "+
   "JOIN public.v13_production_intent i ON i.id=p.id AND i.account_id=p.account_id "+
   "WHERE p.id=$1 AND p.account_id=$2 AND a.owner_user_id IS NOT DISTINCT FROM $3::uuid "+
   "AND p.quantity_hundredths>0 AND i.kind='ENTRY' AND i.terminal IS TRUE",
   [id,this.#scope.accountId,this.#scope.ownerId]);
  return r.rows.length===1?r.rows[0]:null;
 }
 async captureHeld(db:Query,parentId:string,signal?:AbortSignal):Promise<string|null>{
  this.assertExecutorBinding(this.#environment==="SIMULATION"?"SIMULATION":"LIVE",this.#scope);
  if(this.#running)return null;this.#running=true;
  try{
   await this.#assertDatabase(db);
   const pos=await this.#heldPosition(db,parentId);
   if(!pos||!TICKER.test(pos.market)||!["YES","NO"].includes(pos.side)){this.#clearHeld();return null;}
   const cycle=this.#now(),deadline=AbortSignal.timeout(AGE);
   const {btc,market}=await readForwardCycleFeeds(this.feeds,pos.market,signal,deadline);
   const now=this.#now(),provider=btc.providerAt.getTime(),received=btc.receivedAt.getTime(),fetched=market.fetchedAt.getTime(),
    open=market.startsAt?.getTime(),close=market.endsAt?.getTime();
   requireProof(market.ticker===pos.market&&time(open)&&time(close)&&close-open===900000&&open<=cycle&&
    time(fetched)&&cycle<=fetched&&fetched<=now&&now-fetched<=AGE,"direct_held_market_or_feed_invalid");
   // Closure is not a strategy exit. Leave the held quantity intact for
   // authenticated settlement reconciliation; never switch to a new ticker.
   if(now>=close||market.result!==null){this.#clearHeld();return null;}
   requireProof(["open","active"].includes(market.status)&&finite(market.target)&&market.target>0&&
    finite(btc.price)&&btc.price>0&&time(provider)&&time(received)&&provider<=received&&cycle<=received&&
    [cycle,provider,received,fetched].every(x=>time(x)&&x<=now&&now-x<=AGE),"direct_held_market_or_feed_invalid");
   const point={price:btc.price,provider,received},prior=this.#heldPrior,target=market.target;
   if(prior&&prior.positionId===parentId&&prior.ticker===pos.market&&
     (prior.target!==target||prior.open!==open||prior.close!==close))throw Error("direct_held_market_identity_changed");
   const continuous=!!prior&&prior.positionId===parentId&&prior.ticker===pos.market&&
    provider>prior.point.provider&&received>prior.point.received&&
    provider-prior.point.provider<=AGE&&received-prior.point.received<=AGE;
   if(!continuous)this.#heldPoints=[];
   this.#heldPoints=[...this.#heldPoints.filter(p=>received-p.received<=30000),point].slice(-180);
   this.#heldPrior={positionId:parentId,ticker:pos.market,target,open,close,point};
   const velocity=observedVelocity(this.#heldPoints);
   requireProof(this.feeds.book,"direct_held_book_missing");
   const book=await this.feeds.book(pos.market,signal?AbortSignal.any([signal,deadline]):deadline);
   const observed=this.#now();deadline.throwIfAborted();signal?.throwIfAborted();
   const quote=top(book,pos.market,cycle,observed),oldest=Math.min(cycle,provider,received,fetched,quote.started);
   requireProof(observed-oldest<=AGE&&oldest>=open&&observed<close,"direct_held_original_source_expired");
   const up=(10000-quote.noBid)/10000,down=(10000-quote.yesBid)/10000;
   // A first held observation cannot infer historical velocity. The approved
   // wrong-side recross rule remains eligible from current evidence alone.
   const input={marketTicker:pos.market,btcPrice:btc.price,target:market.target,previousBuffer:null,velocity,
    upOffer:up,downOffer:down,freshness:"current" as const,position:{status:"open" as const,direction:pos.side==="YES"?"up" as const:"down" as const}};
   const decision=evaluateV13Strategy(input);
   if(decision.signal!=="EXIT"||!decision.positionExitReason)return null;
   const id=randomUUID(),source:DirectHeldEvaluation={id,evaluation_source:this.#environment==="SIMULATION"?"direct_held_simulation_v1":"direct_held_live_v1",execution_environment:this.#environment,
    position_id:parentId,account_id:this.#scope.accountId,owner_user_id:this.#scope.ownerId,worker_pin:this.#scope.worker??null,
    market_ticker:pos.market,side:pos.side,quantity_hundredths:pos.quantity_hundredths,
    strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,
    evaluated_at:new Date(observed).toISOString(),original_oldest_ms:oldest,market_close_ms:close,
    btc_price:btc.price,target:market.target,signed_buffer:btc.price-market.target,velocity,up_offer:up,down_offer:down,feed_freshness:"current",
    btc_provider_age_ms:observed-provider,btc_receive_age_ms:observed-received,market_age_ms:observed-fetched};
   const unsigned={version:1 as const,account:this.#scope.accountId,owner:this.#scope.ownerId,source,quote};
   const receipt:HeldReceipt={...unsigned,producerSeal:this.#seal(JSON.stringify(unsigned))};
   const bytes=JSON.stringify(receipt);
   // The existing financial audit journal holds the exact sealed bytes. JSONB
   // key reordering cannot change the receipt digest because bytes are a string.
   await db.query("INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) "+
    "VALUES($1,$2,$3,$4,$5)",
    [id,this.#scope.accountId,this.#environment==="SIMULATION"?"DIRECT_HELD_SIMULATION_V1":"DIRECT_HELD_LIVE_V1",JSON.stringify({bytes}),sha(bytes)]);
   return await this.readHeldExact(db,id,parentId,this.#now())?id:null;
  }catch(e){this.#clearHeld();throw e;}finally{this.#running=false;}
 }
 async readHeldExact(db:Query,id:string,parentId:string,now:number):Promise<DirectHeldEvaluation|null>{
  return this.#readHeld(db,id,parentId,now,false);
 }
 /** Distinguish authentic expired evidence from corruption at the locked
  * signed-exit fence. Never grants send permission: the caller must enforce
  * the remaining lifetime at the actual transport boundary. */
 async verifyHeldForFinalFence(db:Query,id:string,parentId:string,now:number,expected:unknown):Promise<boolean>{
  const source=await this.#readHeld(db,id,parentId,now,true);
  return source!==null&&canonical(source)===canonical(expected);
 }
 async #readHeld(db:Query,id:string,parentId:string,now:number,allowExpired:boolean):Promise<DirectHeldEvaluation|null>{
  this.assertExecutorBinding(this.#environment==="SIMULATION"?"SIMULATION":"LIVE",this.#scope);
  if(!UUID.test(id)||!time(now))return null;
  await this.#assertDatabase(db);
  const pos=await this.#heldPosition(db,parentId);
  if(!pos)return null;
  const r=await db.query("SELECT payload,digest FROM public.v13_production_observation WHERE id=$1 AND account_id=$2 "+
   "AND kind=$3 FOR SHARE",[id,this.#scope.accountId,this.#environment==="SIMULATION"?"DIRECT_HELD_SIMULATION_V1":"DIRECT_HELD_LIVE_V1"]);
  const row=r.rows[0],bytes=row?.payload?.bytes;
  if(r.rows.length!==1||typeof bytes!=="string"||Buffer.byteLength(bytes)>65536||sha(bytes)!==row.digest)return null;
  try{
   const receipt=JSON.parse(bytes) as HeldReceipt,{producerSeal,...unsigned}=receipt,s=receipt.source;
   if(!HASH.test(producerSeal)||!timingSafeEqual(Buffer.from(producerSeal,"hex"),Buffer.from(this.#seal(JSON.stringify(unsigned)),"hex")))return null;
   if(JSON.stringify(receipt)!==bytes||receipt.version!==1||receipt.account!==this.#scope.accountId||receipt.owner!==this.#scope.ownerId||
    s.id!==id||s.position_id!==parentId||s.account_id!==this.#scope.accountId||s.market_ticker!==pos.market||s.side!==pos.side||
    s.quantity_hundredths!==pos.quantity_hundredths||s.owner_user_id!==this.#scope.ownerId||
    canonical(s.worker_pin)!==canonical(this.#scope.worker??null)||
    s.evaluation_source!==(this.#environment==="SIMULATION"?"direct_held_simulation_v1":"direct_held_live_v1")||s.execution_environment!==this.#environment||
    s.strategy_parameter_hash!==V13_CHAMPION_PARAMETER_HASH||s.strategy_parameter_set_id!==V13_CHAMPION_PARAMETER_SET.id||
    s.feed_freshness!=="current"||!time(s.original_oldest_ms)||!time(s.market_close_ms)||!time(Date.parse(s.evaluated_at))||
    s.original_oldest_ms>Date.parse(s.evaluated_at)||Date.parse(s.evaluated_at)>now||Date.parse(s.evaluated_at)>=s.market_close_ms||
    (!allowExpired&&(now-s.original_oldest_ms>AGE||now>=s.market_close_ms)))return null;
   const decision=evaluateV13Strategy({marketTicker:s.market_ticker,btcPrice:s.btc_price,target:s.target,previousBuffer:null,
    velocity:s.velocity,upOffer:s.up_offer,downOffer:s.down_offer,freshness:"current",position:{status:"open",direction:s.side==="YES"?"up":"down"}});
   return decision.signal==="EXIT"&&decision.positionExitReason?Object.freeze(s):null;
  }catch{return null;}
 }

}

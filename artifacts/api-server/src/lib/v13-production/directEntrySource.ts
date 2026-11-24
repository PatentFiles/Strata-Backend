import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from "node:crypto";
import type {Pool,PoolClient} from "@workspace/db";
import {evaluateV13Strategy,needsV13EntryPrice,V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET,V13_ENTRY_POLICY_VERSION} from "@workspace/v13-strategy";
import {createPublicForwardTestFeeds,type ForwardTestFeeds} from "../forwardTestFeeds";
import {createPublicBookReader,type ReadonlyResearchBook} from "../forwardTestOrderbookDepth";
import {readForwardCycleFeeds} from "../forwardFeedReadScope";
import {assertChampionSourceReference} from "./sourceReference";
import {requireProof} from "./types";

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
export type DirectScope=Readonly<{accountId:string;ownerId:string|null}>;
type Environment="LIVE_OBSERVATION"|"SIMULATION";
export type DirectEvaluation={
 id:string;evaluation_source:"direct_live_v1"|"direct_simulation_v1";execution_environment:Environment;
 market_ticker:string;crossing_key:string;entry_policy_version:string;strategy_parameter_set_id:string;strategy_parameter_hash:string;
 evaluated_at:string;market_open_ms:number;market_close_ms:number;
 btc_price:number;target:number;signed_buffer:number;velocity:number;previous_side:"UP"|"DOWN"|"AT";
 up_offer:number;down_offer:number;entry_offer:number;signal:"SCOUT"|"CONFIRM";direction:"UP"|"DOWN";
 qualifying_trigger:true;fresh_cross:true;crossing_consumed:true;position_was_open:false;feed_freshness:"current";
 btc_provider_age_ms:number;btc_receive_age_ms:number;market_age_ms:number;
};
type Point={price:number;provider:number;received:number};
type Prior={ticker:string;target:number;open:number;close:number;point:Point};
type Quote={timestampAuthority:"LOCAL_RECEIPT_ONLY";started:number;headers:number;completed:number;
 digest:string;yesBid:number;noBid:number};
type Unsigned={version:1;account:string;owner:string|null;ticker:string;evaluation:string;oldest:number;observed:number;closesAt:number;
 environment:Environment;source:DirectEvaluation;quote:Quote;};
type Receipt=Unsigned&{producerSeal:string};
type Query=Pick<Pool|PoolClient,"query">;
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
  completed:book.bodyCompletedAtMs,digest:book.rawResponseDigest,yesBid,noBid};
}
/**
 * Independent producer and exact committed-source reader for the existing
 * executor. Public provider observations only; no paper ledger, positions,
 * fills, notifications or simulation stake.
 *
 * The seal is process-local custody, NOT an exchange signature. Restart or
 * another producer instance cannot adopt a receipt. A crossing is durably
 * unique even after expiry; a lost commit cannot be retried as a new crossing.
 * The real-market factory remains observation-only pending qualification.
 */
export class DirectEntrySource{
 readonly #secret=randomBytes(32);
 readonly #scope:DirectScope;
 readonly #environment:Environment;
 #prior:Prior|null=null;#points:Point[]=[];#running=false;#lastClock=-1;
 private constructor(scope:DirectScope,environment:Environment,private readonly feeds:ForwardTestFeeds,private readonly clock:()=>number){
  requireProof(typeof scope.accountId==="string"&&scope.accountId.length>0&&scope.accountId.length<=128&&
   (scope.ownerId===null||UUID.test(scope.ownerId)),"direct_entry_scope_invalid");
  this.#scope=Object.freeze({...scope});this.#environment=environment;
 }
 get environment(){return this.#environment;}
 matches(scope:DirectScope){return this.#scope.accountId===scope.accountId&&this.#scope.ownerId===scope.ownerId;}
 static marketObservation(scope:DirectScope){
  const feeds=createPublicForwardTestFeeds();
  return new DirectEntrySource(scope,"LIVE_OBSERVATION",{...feeds,book:createPublicBookReader()},Date.now);
 }
 static isolatedSimulation(scope:DirectScope,feeds:ForwardTestFeeds,clock:()=>number){
  requireProof(simulationEnvironment(),"direct_entry_simulation_requires_disposable");
  return new DirectEntrySource(scope,"SIMULATION",feeds,clock);
 }
 assertSimulationBinding(scope:DirectScope){
  requireProof(this.#environment==="SIMULATION"&&simulationEnvironment()&&this.matches(scope),
   "direct_entry_simulation_binding_invalid");
 }
 async #assertDatabase(db:Query){
  if(this.#environment==="SIMULATION"){
   requireProof(simulationEnvironment(),"direct_entry_simulation_requires_disposable");
   const r=await db.query("SELECT current_database() AS db,host(inet_server_addr()) AS host");
   requireProof(r.rows.length===1&&r.rows[0].db===new URL(process.env.V13_DISPOSABLE_DATABASE_URL!).pathname.slice(1)&&
    r.rows[0].host==="127.0.0.1","direct_entry_simulation_requires_disposable");
  }
 }
 #now(){const n=this.clock();requireProof(time(n)&&n>=this.#lastClock,"direct_entry_clock_regressed");this.#lastClock=n;return n;}
 #seal(bytes:string){return createHmac("sha256",this.#secret).update(bytes,"utf8").digest("hex");}
 async capture(db:Query,signal?:AbortSignal):Promise<string|null>{
  if(this.#running)return null;this.#running=true;
  try{
   await this.#assertDatabase(db);
   const cycle=this.#now(),deadline=AbortSignal.timeout(AGE);
   const {btc,market}=await readForwardCycleFeeds(this.feeds,undefined,signal,deadline);
   const now=this.#now(),provider=btc.providerAt.getTime(),received=btc.receivedAt.getTime(),
    fetched=market.fetchedAt.getTime(),open=market.startsAt?.getTime(),close=market.endsAt?.getTime();
   requireProof(time(open)&&time(close)&&close-open===900000&&open<=cycle&&now<close&&
    TICKER.test(market.ticker)&&["open","active"].includes(market.status)&&market.result===null&&
    finite(market.target)&&market.target>0&&finite(btc.price)&&btc.price>0&&time(provider)&&time(received)&&
    provider<=received&&cycle<=received&&cycle<=fetched&&[cycle,provider,received,fetched].every(x=>time(x)&&x<=now&&now-x<=AGE),
    "direct_entry_market_or_feed_invalid");
   const point={price:btc.price,provider,received},prior=this.#prior,target=market.target;
   if(prior&&prior.ticker===market.ticker&&(prior.target!==target||prior.open!==open||prior.close!==close))
    throw Error("direct_entry_market_identity_changed");
   // No crossing across restart, rollover, repeated provider time or data gap.
   const continuous=!!prior&&prior.ticker===market.ticker&&provider>prior.point.provider&&
    received>prior.point.received&&provider-prior.point.provider<=AGE&&received-prior.point.received<=AGE;
   if(!continuous)this.#points=[];
   this.#points=[...this.#points.filter(p=>provider-p.provider<=30000),point].slice(-180);
   this.#prior={ticker:market.ticker,target,open,close,point};
   if(!continuous||!prior)return null;
   const oldestPoint=this.#points[0]!,minutes=(provider-oldestPoint.provider)/60000;
   const velocity=minutes>0?(btc.price-oldestPoint.price)/minutes:null,previousBuffer=prior.point.price-target;
   const input={marketTicker:market.ticker,btcPrice:btc.price,target,previousBuffer,velocity,
    freshness:"current" as const,position:null};
   if(!needsV13EntryPrice(input)||velocity===null||!this.feeds.book)return null;
   const book=await this.feeds.book(market.ticker,signal?AbortSignal.any([signal,deadline]):deadline);
   const observed=this.#now();deadline.throwIfAborted();signal?.throwIfAborted();
   const quote=top(book,market.ticker,cycle,observed);
   const oldest=Math.min(cycle,provider,received,fetched,quote.started);
   requireProof(observed-oldest<=AGE&&oldest>=open&&observed<close,"direct_entry_original_source_expired");
   const up=(10000-quote.noBid)/10000,down=(10000-quote.yesBid)/10000;
   const decision=evaluateV13Strategy({...input,upOffer:up,downOffer:down});
   if(!decision.qualifyingTrigger||!decision.freshCross||decision.entrySideOffer===null||
    (decision.signal!=="SCOUT"&&decision.signal!=="CONFIRM")||(decision.direction!=="UP"&&decision.direction!=="DOWN"))return null;
   const id=randomUUID(),account=this.#scope.accountId,ticker=market.ticker,crossing=ticker+":first";
   const source:DirectEvaluation={id,evaluation_source:this.#environment==="SIMULATION"?"direct_simulation_v1":"direct_live_v1",
    execution_environment:this.#environment,market_ticker:ticker,crossing_key:crossing,
    entry_policy_version:V13_ENTRY_POLICY_VERSION,strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,
    strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,evaluated_at:new Date(observed).toISOString(),market_open_ms:open,market_close_ms:close,
    btc_price:btc.price,target,signed_buffer:btc.price-target,velocity,previous_side:previousBuffer>0?"UP":previousBuffer<0?"DOWN":"AT",
    up_offer:up,down_offer:down,entry_offer:decision.entrySideOffer,signal:decision.signal,direction:decision.direction,
    qualifying_trigger:true,fresh_cross:true,crossing_consumed:true,position_was_open:false,feed_freshness:"current",
    btc_provider_age_ms:observed-provider,btc_receive_age_ms:observed-received,market_age_ms:observed-fetched};
   assertChampionSourceReference(source);
   const unsigned:Unsigned={version:1,account,owner:this.#scope.ownerId,ticker,evaluation:id,oldest,observed,closesAt:close,
    environment:this.#environment,source,quote};
   const receipt:Receipt={...unsigned,producerSeal:this.#seal(JSON.stringify(unsigned))};
   const bytes=JSON.stringify(receipt);
   const r=await db.query(
    "INSERT INTO public.strata_direct_entry_source (id,account_id,market_ticker,crossing_key,observed_at,oldest_source_at,closes_at,evidence_bytes,evidence_sha256) "+
    "SELECT $1,a.id,$3,$4,$5,$6,$7,$8,$9 FROM public.v13_production_account a "+
    "WHERE a.id=$2 AND a.owner_user_id IS NOT DISTINCT FROM $10::uuid "+
    "ON CONFLICT(account_id,crossing_key) DO NOTHING RETURNING id",
    [id,account,ticker,crossing,new Date(observed),new Date(oldest),new Date(close),bytes,sha(bytes),this.#scope.ownerId]);
   if(r.rows.length!==1||r.rows[0].id!==id)return null;
   return await this.readExact(db,id,this.#now())?id:null;
  }catch(e){this.#prior=null;this.#points=[];throw e;}
  finally{this.#running=false;}
 }
 async readExact(db:Query,id:string,now:number):Promise<DirectEvaluation|null>{
  if(!UUID.test(id)||!time(now))return null;
  await this.#assertDatabase(db);
  const r=await db.query(
   "SELECT s.*,a.owner_user_id::text AS owner_id FROM public.strata_direct_entry_source s "+
   "JOIN public.v13_production_account a ON a.id=s.account_id "+
   "WHERE s.id=$1 AND s.account_id=$2 AND a.owner_user_id IS NOT DISTINCT FROM $3::uuid FOR SHARE OF s",
   [id,this.#scope.accountId,this.#scope.ownerId]);
  if(r.rows.length!==1)return null;
  const row=r.rows[0],bytes=row.evidence_bytes;
  if(typeof bytes!=="string"||Buffer.byteLength(bytes)>65536||row.evidence_sha256!==sha(bytes))return null;
  try{
   const receipt=JSON.parse(bytes) as Receipt,{producerSeal,...unsigned}=receipt;
   if(typeof producerSeal!=="string"||!HASH.test(producerSeal)||!timingSafeEqual(Buffer.from(producerSeal,"hex"),Buffer.from(this.#seal(JSON.stringify(unsigned)),"hex")))return null;
   const s=receipt.source;
   if(JSON.stringify(receipt)!==bytes||receipt.version!==1||receipt.environment!==this.#environment||
    receipt.account!==this.#scope.accountId||receipt.owner!==this.#scope.ownerId||row.owner_id!==this.#scope.ownerId||
    receipt.evaluation!==id||s.id!==id||s.execution_environment!==this.#environment||
    s.evaluation_source!==(this.#environment==="SIMULATION"?"direct_simulation_v1":"direct_live_v1")||
    receipt.ticker!==row.market_ticker||receipt.ticker!==s.market_ticker||s.crossing_key!==row.crossing_key||
    s.crossing_key!==s.market_ticker+":first"||!time(receipt.oldest)||!time(receipt.observed)||!time(receipt.closesAt)||
    receipt.oldest>receipt.observed||receipt.observed>now||now-receipt.oldest>AGE||now>=receipt.closesAt||
    new Date(row.oldest_source_at).getTime()!==receipt.oldest||new Date(row.observed_at).getTime()!==receipt.observed||
    new Date(row.closes_at).getTime()!==receipt.closesAt||Date.parse(s.evaluated_at)!==receipt.observed||
    s.market_close_ms!==receipt.closesAt||s.market_open_ms>receipt.oldest||s.entry_policy_version!==V13_ENTRY_POLICY_VERSION||
    s.strategy_parameter_hash!==V13_CHAMPION_PARAMETER_HASH||s.strategy_parameter_set_id!==V13_CHAMPION_PARAMETER_SET.id||
    !s.qualifying_trigger||!s.fresh_cross||!s.crossing_consumed||s.position_was_open||s.feed_freshness!=="current")return null;
   assertChampionSourceReference(s);
   return Object.freeze(s);
  }catch{return null;}
 }
}

/**
 * Research-only post-event Kalshi REST depth receipts.
 * ALWAYS called after a successfully committed PAPER_ONLY position transition.
 * Nonblocking failures never rewrite paper history or cause a retry/duplicate
 * trade. No live order endpoints, signatures or account credentials here.
 */
import {db, forwardTestBookSnapshotTable} from "@workspace/db";
import {fetchKalshiPublicBook, simulateBookCapacity, type OrderbookRead,
  type ReadonlyResearchBook, type DepthQuote} from "./forwardTestOrderbookDepth";
import {eq,desc} from "drizzle-orm";

export type PaperBookCaptureEvent={
 positionId:string;engineId:string;marketTicker:string;
 phase:"ENTRY"|"EXIT";direction:"UP"|"DOWN";
 contracts:number;quotePrice:number;eventAt:Date;
};
export type PaperDepthReceipt={
 id:string;phase:"ENTRY"|"EXIT";
 status:"CAPTURED"|"UNAVAILABLE";
 eventAt:string;startedAt:string;receivedAt:string|null;
 captureLagMs:number|null;
 simulatedPriceLimitedFill:number|null;
 simulatedUnfilled:number|null;
 actualFillVerified:false;
 timestampAuthority:"LOCAL_RECEIPT_ONLY";
};
function priceTicks(x:number):number|null{
 const n=Math.round(x*10000);
 return Number.isFinite(x)&&x>=0&&x<=1&&
   Math.abs(x*10000-n)<0.000001?n:null;
}
const codeOf=(e:unknown):string=>{
 const msg=e instanceof Error?e.message:"unavailable";
 return /^[a-z_]{3,60}$/.test(msg)?msg:"research_book_unavailable";
};
export async function savePostActionPaperBook(
 event:PaperBookCaptureEvent,read:OrderbookRead=fetchKalshiPublicBook,
):Promise<PaperDepthReceipt|null>{
 if(!/^KXBTC15M-[A-Z0-9-]{5,90}$/.test(event.marketTicker)||
    !event.positionId||!event.engineId||!Number.isSafeInteger(event.contracts)||
    event.contracts<1||event.contracts>1_000_000||
    !Number.isFinite(event.eventAt.getTime()))return null;
 const limit=priceTicks(event.quotePrice);
 if(limit===null)return null;
 const started=Date.now();
 let book:ReadonlyResearchBook|null=null,capacity:DepthQuote|null=null;
 let reason:string|null=null;
 try{
  // The book is AFTER the action, not an atomic time-travel snapshot.
  book=await read(event.marketTicker,AbortSignal.timeout(1900));
  if(book.ticker!==event.marketTicker||
    book.requestStartedAtMs<started-250||
    book.receivedAtMs<book.requestStartedAtMs||
    book.receivedAtMs>Date.now()+250)throw Error("book_capture_timestamp_mismatch");
  capacity=simulateBookCapacity(book,event.direction==="UP"?"yes":"no",
    event.phase==="ENTRY"?"buy":"sell",
    event.contracts,limit,
    event.phase==="ENTRY"?5_000_000n:undefined);
 }catch(error){
  reason=codeOf(error);book=null;capacity=null;
 }
 const status=book&&capacity?"CAPTURED":"UNAVAILABLE";
 const id=event.positionId+":"+event.phase;
 try{
  await db.insert(forwardTestBookSnapshotTable).values({
    id,engineId:event.engineId,paperPositionId:event.positionId,
    marketTicker:event.marketTicker,phase:event.phase,
    positionDirection:event.direction,requestedContracts:event.contracts,
    eventAt:event.eventAt,startedAt:new Date(started),
    receivedAt:book?new Date(book.receivedAtMs):null,status,
    bidLevels:book?{yes:book.yesBids,no:book.noBids}:null,
    capacity:capacity?{
      requestedContracts:capacity.requestedContracts,
      modeledFilledContracts:capacity.modeledFilledContracts,
      modeledUnfilledContracts:capacity.modeledUnfilledContracts,
      modeledCashMicros:capacity.modeledCashMicros,
      modeledAveragePriceTicks:capacity.modeledAveragePriceTicks,
      bestPriceTicks:capacity.bestPriceTicks,
      usedPriceLevels:capacity.usedPriceLevels,
      interpretation:capacity.interpretation,
    }:null,errorCode:status==="UNAVAILABLE"?(reason??"unavailable"):null,
  }).onConflictDoNothing();
 }catch {
   // Schema not yet deployed, network or DB errors are never paper-trading
   // decisions; explicit receipts are absent and completeness metrics stay low.
   return null;
 }
 return {id,phase:event.phase,status,
  eventAt:event.eventAt.toISOString(),startedAt:new Date(started).toISOString(),
  receivedAt:book?new Date(book.receivedAtMs).toISOString():null,
  captureLagMs:book?book.receivedAtMs-event.eventAt.getTime():null,
  simulatedPriceLimitedFill:capacity?.modeledFilledContracts??null,
  simulatedUnfilled:capacity?.modeledUnfilledContracts??null,
  actualFillVerified:false,timestampAuthority:"LOCAL_RECEIPT_ONLY"};
}
export async function readPaperBookCaptureCoverage(engineId:string){
 const receipts=await db.select().from(forwardTestBookSnapshotTable)
    .where(eq(forwardTestBookSnapshotTable.engineId,engineId))
    .orderBy(desc(forwardTestBookSnapshotTable.createdAt)).limit(2500);
 const captured=receipts.filter(r=>r.status==="CAPTURED");
 const missing=receipts.length-captured.length;
 const missed=receipts.filter(r=>r.status==="CAPTURED"&&
   r.receivedAt&&r.receivedAt.getTime()-r.eventAt.getTime()>2500).length;
 const potentialPartials=captured.filter(r=>r.capacity&&
    r.capacity.modeledUnfilledContracts>0).length;
 const potentialZero=captured.filter(r=>r.capacity&&
    r.capacity.modeledFilledContracts===0).length;
 return {mode:"POST_ACTION_REST_OBSERVATION_ONLY" as const,
   proofOfActualExecution:false as const,
   exchangeTimestampVerified:false as const,
   feeScheduleProviderVerified:false as const,
   receipts:receipts.length,captured:captured.length,missing,
   lateBeyond2500Ms:missed,potentialPartials,potentialZero,
   entries:receipts.filter(r=>r.phase==="ENTRY").length,
   exits:receipts.filter(r=>r.phase==="EXIT").length,
   readLimit:2500,source:"KALSHI_PUBLIC_REST" as const,
   warning:"REST books arrived after paper decisions, may be late or stale, and contain no venue fills, provider timestamps, or verified fee evidence"};
}

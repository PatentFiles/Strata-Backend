/** Standalone public-data comparison. No account, DB, order methods or writes. */
import {setTimeout as pause} from "node:timers/promises";
import {createPublicForwardTestFeeds} from "../src/lib/forwardTestFeeds";
import type {RolloverStrikeEvent} from "../src/lib/rolloverStrikeDiagnostics";

async function main() {
 const boundary=Number(process.argv[2]);
 const here=Date.now();
 if(process.argv.length!==3||!Number.isSafeInteger(boundary)||boundary%900_000!==0||
    boundary!==Math.floor(here/900_000)*900_000+900_000){
  throw Error("Pass only the immediately upcoming quarter-hour boundary in Unix milliseconds.");
 }
 await pause(Math.max(0,boundary-Date.now()));
 if(Date.now()>=boundary+2_500)throw Error("Rollover observer missed the boundary.");
 let exactAt:number|null=null, nestedAt:number|null=null;
 let nestedStrike:number|null=null, exactStrike:number|null=null, acceptedTicker:string|null=null, exactTicker:string|null=null;
 let observations=0, invalid=0, failures=0, conflicts=0;
 const diagnostics=(e:RolloverStrikeEvent)=>{
  if(e.phase!=="ready"||!e.ticker||e.strike?.value==null||Date.parse(e.windowStartedAt)!==boundary)return;
  exactAt??=Date.parse(e.observedAt);exactStrike??=e.strike.value;exactTicker??=e.ticker;
 };
 const api=createPublicForwardTestFeeds(fetch,()=>new Date(),()=>performance.now(),diagnostics,undefined,
  {rolloverEventStrike:"verified_recovery"});
 for(let i=0;i<12;i++){
  const now=Date.now();
  const scheduled=boundary+i*2_500;
  if(scheduled<now-250)continue;
  if(scheduled>now)await pause(scheduled-now);
  if(Date.now()>=boundary+30_000)break;
  try{
   const market=await api.market(undefined,AbortSignal.timeout(Math.max(1,Math.min(2_000,boundary+30_000-Date.now()))));
   observations++;
   if(!market.target){invalid++;continue;}
   if(market.strikeSource==="kalshi_nested_event_metadata"){
    if(nestedAt===null){nestedAt=Date.now();nestedStrike=market.target;acceptedTicker=market.ticker;}
    else if(nestedStrike!==market.target||acceptedTicker!==market.ticker)conflicts++;
   }
   if(exactAt!==null&&(nestedAt!==null||observations>=3))break;
  }catch{failures++;}
 }
 const matched=exactStrike!==null&&nestedStrike===exactStrike&&exactTicker===acceptedTicker&&conflicts===0;
 console.log(JSON.stringify({mode:"ORDERS_OFF_METADATA_COMPARISON",boundary,observations,invalid,failures,conflicts,
  exactTicker,acceptedTicker,exactOffsetMs:exactAt===null?null:exactAt-boundary,nestedOffsetMs:nestedAt===null?null:nestedAt-boundary,
  matchingStrike:matched,leadMs:matched&&exactAt!==null&&nestedAt!==null?exactAt-nestedAt:null,
  executableQuoteEarlier:"NOT_MEASURED",orderAuthority:false}));
}
void main().catch(error=>{console.error(String(error?.message??"Observer failed."));process.exitCode=1;});

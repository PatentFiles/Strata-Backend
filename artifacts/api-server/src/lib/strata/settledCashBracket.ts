import {classifyOwnedKalshiReadFailure,getOwnedProductionKalshiJson,readOwnedKalshiFeeds,scopeEcho,type OwnedKalshiRead} from './personalExchangeRead';
import {readSubaccountSpendableCash} from './personalMarketAdapter';
import {canonical} from '../v13-production/types';

const BALANCE='/trade-api/v2/portfolio/balance';
const QUERY='?subaccount=1&exchange_index=2';
const MAX_AGE=5000;
type Credentials=Parameters<typeof readOwnedKalshiFeeds>[0];
type Read=typeof getOwnedProductionKalshiJson;
type Result=OwnedKalshiRead|{ok:false;reason:string};
const time=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const refuse=(reason:string):Result=>({ok:false,reason});
export function balanceEvidence(input:unknown,at:number) {
 if(!scopeEcho(input))return null;
 const row=input as Record<string,unknown>;
 // Kalshi's scoped balance body does not promise the requested pair is echoed.
 // The authenticated, production-pinned GET has an exact query; any supplied
 // aliases must agree. Never infer scope from aggregate balance_breakdown.
 const agrees=(x:unknown,n:number)=>x===undefined||x===n||x===String(n);
 if(!agrees(row.subaccount,1)||!agrees(row.subaccount_number,1)||!agrees(row.exchange_index,2)||
    !time(row.updated_ts)||row.updated_ts===0)return null;
 const cash=readSubaccountSpendableCash({subaccount:1,exchangeIndex:2,observedAtMs:at,nowMs:at,maxAgeMs:MAX_AGE,subaccountBalance:row,primaryBalance:{}});
 return cash.ok?{cash:cash.cashMicros,updated:row.updated_ts}:null;
}

const history=(r:OwnedKalshiRead)=>canonical({cash:r.cashMicros,
 orders:r.orders.map(canonical).sort(),fills:r.fills.map(canonical).sort(),
 positions:r.positions.map(canonical).sort(),settlements:r.settlements.map(canonical).sort()});

/** Recovery only: two complete signed histories and three exact scoped balances
 * share ONE five-second deadline and normal quota admission. Production balance
 * updated_ts can advance with identical cash/history; never treat it as an atomic
 * version. Reject regressing stamps, any cash change and any history difference.
 * The closing reads verify, never replace, the original evidence. No retry or
 * write is performed; locked ledger/settlement/conservation checks still follow. */
export async function readBracketedSettledCash(
 creds:Credentials,observedAt:number,options:{get?:Read;now?:()=>number}={},
):Promise<Result>{
 const now=options.now??Date.now,get=options.get??getOwnedProductionKalshiJson;
 const start=now();
 if(!time(observedAt)||!time(start)||start<observedAt||start-observedAt>=MAX_AGE)
  return refuse('recovery_signed_bracket_clock_invalid');
 const signal=AbortSignal.timeout(MAX_AGE-(start-observedAt));
 let last=start;
 const usable=()=>{const n=now();if(!time(n)||n<last||n-observedAt>MAX_AGE||signal.aborted)return false;last=n;return true;};
 const balances:NonNullable<ReturnType<typeof balanceEvidence>>[]=[];
 let balanceFailure:string|null=null;
 const pinnedGet:Read=async(c,path,query,fetchImpl,_host,_owner,inner)=>{
  if(!usable())throw Error('recovery_signed_bracket_expired');
  if(path===BALANCE&&query!==QUERY)throw Error('recovery_signed_bracket_scope_invalid');
  const reply=await get(c,path,query,fetchImpl,undefined,undefined,inner?AbortSignal.any([signal,inner]):signal);
  if(!usable())throw Error('recovery_signed_bracket_expired');
  if(path===BALANCE){
   const next=balanceEvidence(reply,observedAt),prior=balances.at(-1);
   if(!next)balanceFailure='recovery_signed_bracket_balance_invalid';
   else if(prior&&(next.cash!==prior.cash||next.updated<prior.updated))balanceFailure='recovery_signed_bracket_changed';
   if(balanceFailure)throw Error(balanceFailure);
   balances.push(next!);
  }
  return reply;
 };
 const scan=await readOwnedKalshiFeeds(creds,observedAt,pinnedGet,{mode:'bounded_history_reads_v1',signal});
 if(!usable())return refuse('recovery_signed_bracket_expired');
 if(balanceFailure)return refuse(balanceFailure);
 if(!scan.ok)return refuse(scan.reason);
 const initial=balances[0];
 if(!initial||scan.cashMicros!==initial.cash||scan.historicalCoverageComplete!==true)
  return refuse('recovery_signed_bracket_history_incomplete');
 const verification=await readOwnedKalshiFeeds(creds,observedAt,pinnedGet,{mode:'bounded_history_reads_v1',signal});
 if(!usable())return refuse('recovery_signed_bracket_expired');
 if(balanceFailure)return refuse(balanceFailure);
 if(!verification.ok)return refuse(verification.reason);
 if(verification.historicalCoverageComplete!==true||balances.length!==2||history(scan)!==history(verification))
  return refuse('recovery_signed_bracket_history_changed');
 try{
  const closing=await pinnedGet(creds,BALANCE,QUERY,undefined,undefined,undefined,signal);
  if(!usable())return refuse('recovery_signed_bracket_expired');
  const tail=balanceEvidence(closing,last);
  if(!tail)return refuse('recovery_signed_bracket_balance_invalid');
  if(tail.cash!==initial.cash||Number(balances.length)!==3)return refuse('recovery_signed_bracket_changed');
  return scan;
 }catch(error){return refuse(!usable()?'recovery_signed_bracket_expired':balanceFailure??classifyOwnedKalshiReadFailure(error));}
}

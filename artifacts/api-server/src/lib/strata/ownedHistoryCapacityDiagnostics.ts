import {createHash} from 'node:crypto';
const FEEDS=new Set(['orders','fills','positions','settlements','historical_orders','historical_fills']);
export function createOwnedHistoryCapacityReporter(
 emit:(value:Record<string,unknown>)=>void=value=>console.warn(JSON.stringify(value)),
 now:()=>number=Date.now,
){
 const seen=new Map<string,{at:number;reached:boolean}>();
 return (keyId:string,feed:string,pages:number,rows:number,hasMore:boolean)=>{
  try{
   if(!FEEDS.has(feed)||!Number.isSafeInteger(pages)||pages<16||pages>20||!Number.isSafeInteger(rows)||rows<0)return;
   // Credential scope is account-bound by the existing owned reader. Neither
   // credential identifiers nor cursors are emitted or retained in this map.
   const scope=createHash('sha256').update(keyId).digest('hex');
   const key=scope+':'+feed,at=now(),reached=pages===20&&hasMore,prior=seen.get(key);
   if(!Number.isFinite(at))return;
   if(prior&&at>=prior.at&&at-prior.at<300000&&(!reached||prior.reached))return;
   if(!seen.has(key)&&seen.size>=128)seen.delete(seen.keys().next().value!);
   seen.set(key,{at,reached});
   emit({event:'strata_owned_history_capacity',status:reached?'PAGE_CAP_REACHED':'APPROACHING_PAGE_CAP',
    feed,pageCount:pages,rowCount:rows,pageCap:20,requestPageLimit:200,hasMore,
    subaccount:1,exchangeIndex:2});
  }catch{/* Observability cannot alter signed-read completeness or STOP behavior. */}
 };
}
export const reportOwnedHistoryCapacity=createOwnedHistoryCapacityReporter();

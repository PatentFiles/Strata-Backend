/** Current market-inventory evidence only. No pending-cash or execution authority. */
const LIMIT=200,MAX_PAGES=20;
const ticker=/^[A-Z0-9][A-Z0-9._-]{0,255}$/;
const quantity=/^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const obj=(x:unknown):Record<string,unknown>|null=>x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null;
const pair=(r:Record<string,unknown>)=>
 (!Object.hasOwn(r,'subaccount')||r.subaccount===1)&&
 (!Object.hasOwn(r,'subaccount_number')||r.subaccount_number===1)&&
 (!Object.hasOwn(r,'exchange_index')||r.exchange_index===2);
const no=(reason:string)=>({status:'unsettled_positions_unverified' as const,reason,
 laneComplete:false as const,inventoryRowsPresent:null,pendingCashCompletenessVerified:false as const,
 authenticatedExchangeFlat:false as const,tradingAuthorized:false as const});
/** Transport must be the code-owned authenticated fixed owner/pair positions GET.
 * Per-page optional scope echoes cannot disagree; each market row must explicitly
 * name the exchange. Event rows without shard echo remain possible inventory.
 */
export async function readStrictUnsettledPositions(get:(query:string,signal:AbortSignal)=>Promise<unknown>,signal:AbortSignal){
 let cursor='',marketRows=0,eventRows=0;
 const cursors=new Set<string>(),markets=new Set<string>(),events=new Set<string>();
 try{
  for(let n=0;n<MAX_PAGES;n++){
   if(signal.aborted)return no('deadline');
   // No count_filter: a zero net contract row can still be unsettled.
   const query='?limit='+LIMIT+'&subaccount=1&exchange_index=2&settlement_status=unsettled'+(cursor?'&cursor='+encodeURIComponent(cursor):'');
   const p=obj(await get(query,signal));
   if(signal.aborted)return no('deadline');
   if(!p||!pair(p)||!Object.hasOwn(p,'cursor')||typeof p.cursor!=='string'||p.cursor.length>2048||
    (p.cursor!==''&&(!p.cursor.trim()||/[\x00-\x1f\x7f]/.test(p.cursor)))||
    !Array.isArray(p.market_positions)||!Array.isArray(p.event_positions)||
    p.market_positions.length>LIMIT*10||p.event_positions.length>LIMIT)
     return no('ambiguous_page');
   for(const raw of p.market_positions){
    const r=obj(raw);
    if(!r||!pair(r)||r.exchange_index!==2||typeof r.ticker!=='string'||!ticker.test(r.ticker)||
       typeof r.position_fp!=='string'||!quantity.test(r.position_fp)||markets.has(r.ticker))
      return no('invalid_market_row');
    markets.add(r.ticker);marketRows++;
   }
   for(const raw of p.event_positions){
    const r=obj(raw);
    if(!r||!pair(r)||typeof r.event_ticker!=='string'||!ticker.test(r.event_ticker)||events.has(r.event_ticker))
      return no('invalid_event_row');
    events.add(r.event_ticker);eventRows++;
   }
   if(p.cursor==='')return {
    status:'unsettled_positions_page_set_complete' as const,reason:null,laneComplete:true as const,
    inventoryRowsPresent:marketRows+eventRows>0,marketRows,eventRows,
    pendingCashCompletenessVerified:false as const,authenticatedExchangeFlat:false as const,tradingAuthorized:false as const,
   };
   if(cursors.has(p.cursor))return no('cursor_cycle');
   cursors.add(p.cursor);cursor=p.cursor;
  }
  return no('page_cap');
 }catch{return no(signal.aborted?'deadline':'source_unavailable');}
}

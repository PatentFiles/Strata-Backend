/** Pure, read-only strategy comparison from authoritative closed ledger rows.
 * PASS records and speculative missed fills NEVER contribute to financial P&L.
 * Every metric is tagged with its evidence coverage, not a promise of profit. */
export type ResearchRow={
 row_id:string;observed_at:string;record_type:'LIVE_DECISION'|'LEDGER_INTENT';
 status:string;submitted_orders:number;fill_count:string;bot_id?:string|null;
 bot_source?:string|null;details:Record<string,unknown>;reason_code?:string|null;
};
export type BotScore={
 botId:string;closedTrades:number;wins:number;losses:number;flat:number;
 netPnlMicros:string;grossWinningMicros:string;grossLosingMicros:string;
 maxRealizedDrawdownMicros:string;orders:number;intentsWithFills:number;
 feeEvidenceMissing:number;entryPriceSamples:number;meanAdverseEntrySlippageMicros:string|null;
 p95AdverseEntrySlippageMicros:string|null;qualifiedSignals:number;
 qualifiedWithoutLinkedIntent:number;
 notes:string[];
};
const integer=(v:unknown):bigint|null=>typeof v==='string'&&/^-?\d+$/.test(v)?BigInt(v):null;
const number=(v:unknown)=>typeof v==='number'?v:
 typeof v==='string'&&/^-?\d+(?:\.\d+)?$/.test(v)?Number(v):NaN;
const normalizedBot=(r:ResearchRow)=>r.bot_source==='RECORDED_INTENT'||
 r.bot_source==='RECORDED_OBSERVATION'?r.bot_id:null;
export function scoreRecordedBots(rows:ResearchRow[]):BotScore[]{
 const buckets=new Map<string,ResearchRow[]>();
 for(const r of rows){
  const bot=normalizedBot(r);if(!bot)continue;
  const batch=buckets.get(bot)??[];batch.push(r);buckets.set(bot,batch);
 }
 return [...buckets].map(([botId,entries])=>{
  const ledger=entries.filter(r=>r.record_type==='LEDGER_INTENT');
  const intents=new Map<string,ResearchRow>();
  for(const r of ledger)intents.set(r.row_id,r);
  const financial=ledger.filter(r=>r.details.intentKind==='ENTRY'&&
   integer(r.details.closedTradeNetPnlMicros)!==null &&
   ['SETTLED_WIN','SETTLED_LOSS','CLOSED_WIN','CLOSED_LOSS','BREAKEVEN'].includes(r.status));
  // Later updates to an entry must never create an additional closed trade.
  const close=new Map(financial.map(r=>[String(r.details.intentId??r.row_id),r]));
  const chronological=[...close.values()].sort((a,b)=>
   Date.parse(a.observed_at)-Date.parse(b.observed_at)||a.row_id.localeCompare(b.row_id));
  let equity=0n,peak=0n,worst=0n,net=0n,wins=0,losses=0,flat=0;
  let grossWin=0n,grossLoss=0n;
  for(const r of chronological){
   const pnl=integer(r.details.closedTradeNetPnlMicros)!;net+=pnl;equity+=pnl;
   if(equity>peak)peak=equity;
   if(peak-equity>worst)worst=peak-equity;
   if(pnl>0n){wins++;grossWin+=pnl;}else if(pnl<0n){losses++;grossLoss+=-pnl;}else flat++;
  }
  const entry=ledger.filter(r=>r.details.intentKind==='ENTRY');
  const fills=entry.filter(r=>(integer(r.details.filledHundredths)??0n)>0n);
  const slippages:number[]=[];
  for(const r of fills){
   const original=number(r.details.quotedEntryOffer);
   const actual=integer(r.details.entryFillPriceMicros);
   if(!Number.isFinite(original)||original<0||original>1||actual===null||actual<0n||actual>1000000n)continue;
   slippages.push(Number(actual)-Math.round(original*1_000_000));
  }
  slippages.sort((a,b)=>a-b);
  const mean=slippages.length?Math.round(slippages.reduce((a,b)=>a+b,0)/slippages.length):null;
  const p95=slippages.length?slippages[Math.ceil(slippages.length*0.95)-1]:null;
  const qualified=entries.filter(r=>r.record_type==='LIVE_DECISION'&&r.status==='QUALIFIED');
  const sources=new Set(entry.map(r=>String(r.details.directSourceId??'')).filter(Boolean));
  const missing=qualified.filter(r=>!sources.has(String(r.details.directSourceId??''))).length;
  return {botId,closedTrades:chronological.length,wins,losses,flat,
   netPnlMicros:net.toString(),grossWinningMicros:grossWin.toString(),
   grossLosingMicros:grossLoss.toString(),maxRealizedDrawdownMicros:worst.toString(),
   orders:ledger.reduce((n,r)=>n+r.submitted_orders,0),intentsWithFills:fills.length,
   feeEvidenceMissing:ledger.filter(r=>r.details.closedTradeNetPnlMicros!==null&&
     r.details.closedTradeTotalFeesMicros==null).length,
   entryPriceSamples:slippages.length,
   meanAdverseEntrySlippageMicros:mean===null?null:String(mean),
   p95AdverseEntrySlippageMicros:p95===null?null:String(p95),
   qualifiedSignals:qualified.length,qualifiedWithoutLinkedIntent:missing,
   notes:['Closed-trade P&L is event-derived after recorded fees; missing fee evidence is reported separately.',
    'Drawdown is realized closed-trade drawdown, not mark-to-market portfolio drawdown.',
    'Qualified-without-linked-intent is a missed-execution proxy, not a hypothetical profit estimate.',
    'Comparisons omit inferred and unattributed bot identities to avoid false attribution.'],
  };
 });
}

import { stressV13ResearchQuotes, type ResearchQuoteRoundTrip } from "./v13ResearchExecutionStress";

/**
 * Non-authorizing, deliberately pessimistic paper research overlay.
 * This does NOT rewrite forward_test_positions or certify an executable fill:
 * historical paper trades store top-of-book prices, not entry/exit depth,
 * queue priority, confirmed fills, authorized market-specific fee evidence,
 * or provider settlement receipts.
 */
export type HistoricalPaperQuote = {
  id:string; marketTicker:string; status:string;
  entryOffer:number; exitPrice:number|null; stake:number;
  contracts:number; pnl:number|null;
};
export type PaperExecutionAudit = {
  mode:"PAPER_RESEARCH_ONLY";
  tradingAuthority:false;
  fillsVerified:false;
  feeScheduleProviderVerified:false;
  depthEvidenceAvailable:false;
  netPnlVerified:null;
  quoteGrossUsd:number;
  quoteGrossExLargestWinnerUsd:number;
  largestQuoteWinnerUsd:number;
  completed:number;
  assessedQuotes:number;
  excludedQuotes:number;
  hypotheticalScenarios:Array<{
    label:string;
    assumedMaxContracts:number;
    adverseEntryTicks:number;
    adverseExitTicks:number;
    assumedQuadraticCoefficientBps:number;
    modeledTrades:number;
    assumedNetUsd:number;
    assumedNetExLargestWinnerUsd:number;
    depthCoverage:number;
    netIsExecutable:false;
  }>;
  warnings:string[];
};
const usd=(micro:string)=>Math.round(Number(BigInt(micro))/10_000)/100;
const dollars=(cents:number)=>Math.round(cents)/100;
const ticks=(price:number,allowZero=false):number|null=>{
  if(!Number.isFinite(price)||price<(allowZero?0:0.0001)||price>(allowZero?1:0.9999))return null;
  const n=Math.round(price*10_000);
  return Math.abs(price*10_000-n)<0.000001&&n>=0&&n<=10_000?n:null;
};
export function auditHistoricalPaperExecution(rows:readonly HistoricalPaperQuote[]):PaperExecutionAudit{
 if(rows.length>100_000)throw Error("paper_audit_row_limit_exceeded");
 const completed=rows.filter(r=>r.status==="CLOSED"||r.status==="SETTLED");
 const cents=completed.map(r=>Number.isFinite(r.pnl)?Math.round((r.pnl??0)*100):0);
 const sum=cents.reduce((a,b)=>a+b,0);
 const largest=cents.reduce((m,n)=>Math.max(m,n),0);
 const largestQuoteId=completed.find(r=>r.pnl!==null&&
   Math.round(r.pnl*100)===largest)?.id??null;
 const accepted:ResearchQuoteRoundTrip[]=[];
 const ids=new Set<string>();
 let excluded=0;
 for(const r of completed){
  // Settlements require venue evidence; this is strictly an EXIT quote stress.
  if(r.status!=="CLOSED"){excluded++;continue;}
  const entry=ticks(r.entryOffer),exit=r.exitPrice===null?null:ticks(r.exitPrice,true);
  if(!r.id||ids.has(r.id)||!r.marketTicker.startsWith("KXBTC15M-")||
     entry===null||exit===null||!Number.isFinite(r.stake)||r.stake<=0||
     !Number.isFinite(r.contracts)||r.contracts<=0||
     !Number.isFinite(r.pnl)||r.pnl===null){excluded++;continue;}
  ids.add(r.id);
  accepted.push({id:r.id,marketTicker:r.marketTicker,
    entryOfferTicks:entry,exitBidTicks:exit,
    entryDepthContracts:null,exitDepthContracts:null});
 }
 const cases=[
  {label:"1-contract capacity stress",max:1,entry:100,exit:100},
  {label:"5-contract capacity stress",max:5,entry:100,exit:100},
  {label:"20-contract capacity stress",max:20,entry:100,exit:100},
 ];
 const scenarios=cases.map(c=>{
  const assumptions={
   stakeCents:500,adverseEntryTicks:c.entry,adverseExitTicks:c.exit,
   maxContractsPerTrade:c.max,assumedQuadraticCoefficientBps:700,
   feeInclusiveEntryBudget:true,
  };
  const result=stressV13ResearchQuotes(accepted,assumptions);
  const outlierExcluded=stressV13ResearchQuotes(
   accepted.filter(r=>r.id!==largestQuoteId),assumptions);
  return {label:c.label,assumedMaxContracts:c.max,adverseEntryTicks:c.entry,
   adverseExitTicks:c.exit,assumedQuadraticCoefficientBps:700,
   modeledTrades:result.modeledTrades,
   assumedNetUsd:usd(result.modeledNetMicros),
   assumedNetExLargestWinnerUsd:usd(outlierExcluded.modeledNetMicros),
   depthCoverage:result.observedDepthCoverage,netIsExecutable:false as const};
 });
 return {
  mode:"PAPER_RESEARCH_ONLY",tradingAuthority:false,
  fillsVerified:false,feeScheduleProviderVerified:false,
  depthEvidenceAvailable:false,netPnlVerified:null,
  quoteGrossUsd:dollars(sum),
  quoteGrossExLargestWinnerUsd:dollars(sum-largest),
  largestQuoteWinnerUsd:dollars(largest),completed:completed.length,
  assessedQuotes:accepted.length,excludedQuotes:excluded,
  hypotheticalScenarios:scenarios,
  warnings:[
   "Historical entry/exit book depth and signed IOC fills are absent; no scenario is executable or validated net P&L",
   "All stress scenarios assume 1/5/20 contracts of immediate liquidity at their stressed quote prices; actual fill size may be zero",
   "A 1-cent adverse move is assumed on each leg, not measured slippage, and 7% quadratic coefficient is illustrative, not an approved exact-market fee schedule",
   "Model uses whole-contract quantities and a $5 fee-inclusive entry cash ceiling, with illustrative per-order cent rounding; real venue may have different effective fees",
   "Coinbase-versus-CF Benchmarks BRTI settlement basis and actual provider settlement remain unverified",
   "Legacy gross P&L is retained unchanged; no historical rows are overwritten or relabeled as real money",
  ],
 };
}

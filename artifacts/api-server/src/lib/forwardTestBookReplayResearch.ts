/**
 * Independent, read-only paper accounting and post-action order-book replay.
 *
 * Research-only: never inserts trades, changes champion parameters, or grants
 * execution authority. REST depth receipts are sampled AFTER paper decisions,
 * so even a modeled full round trip is NOT an exchange fill or live P&L.
 * Quotes/stake/payout are recorded dollars; use bigint microdollars internally.
 */
import { illustrativeQuadraticFeeCents } from "./v13ResearchExecutionStress";

export interface PaperPositionEvidence {
  id: string;
  status: "CLOSED" | "SETTLED";
  contracts: number;
  entryOffer: number;
  exitPrice: number;
  stake: number;
  payout: number;
  pnl: number;
}
export interface PaperBookEvidence {
  paperPositionId: string;
  phase: "ENTRY" | "EXIT";
  status: "CAPTURED" | "UNAVAILABLE";
  requestedContracts: number;
  modeledFilledContracts: number | null;
  eventAtMs: number;
  receivedAtMs: number | null;
  /** Always local REST receipt time, not an exchange book sequence. */
  timestampAuthority: "LOCAL_RECEIPT_ONLY";
}
export interface PaperDepthResearchReport {
  mode: "PAPER_ONLY_RESEARCH";
  tradingAuthority: false;
  certifiedExecutableNetUsd: null;
  liveFeeScheduleVerified: false;
  positions: number;
  grossPaperUsd: number;
  recalculatedGrossUsd: number;
  maxAccountingDifferenceUsd: number;
  accountingDifferencesOverHalfCent: number;
  missingBookPairs: number;
  bothBooksCaptured: number;
  fullyModeledPostActionPairs: number;
  postActionOrUnsequencedSnapshots: number;
  entryPriceLimitedZeroFill: number;
  exitPriceLimitedZeroFill: number;
  unverifiedLargeProfitIds: string[];
  /** Single-fill quadratic reference sensitivity; NOT venue-approved fees. */
  illustrativeSevenPercentFeesUsd: number;
  illustrativeQuoteOnlyNetUsd: number;
}
const micros = (usd: number): bigint => {
  if (!Number.isFinite(usd) || Math.abs(usd)>1_000_000_000)
    throw new Error("invalid_paper_money");
  return BigInt(Math.round(usd * 1_000_000));
};
const numUsd = (value: bigint): number => Number(value)/1_000_000;
const abs=(n:bigint):bigint=>n<0n?-n:n;
const safePrice=(n:number)=>Number.isFinite(n)&&n>=0&&n<=1;
export function auditPostActionPaperBooks(
  positions:readonly PaperPositionEvidence[],
  receipts:readonly PaperBookEvidence[],
):PaperDepthResearchReport {
  if(positions.length>100_000 || receipts.length>200_000) throw Error("paper_research_limit");
  const books=new Map<string,PaperBookEvidence>();
  for(const r of receipts){
    const key=r.paperPositionId+"|"+r.phase;
    if(!r.paperPositionId || !["ENTRY","EXIT"].includes(r.phase) || books.has(key) ||
       !Number.isSafeInteger(r.requestedContracts) || r.requestedContracts<1 ||
       (r.modeledFilledContracts!==null &&
        (!Number.isSafeInteger(r.modeledFilledContracts) || r.modeledFilledContracts<0 ||
         r.modeledFilledContracts>r.requestedContracts)) ||
       !Number.isFinite(r.eventAtMs) ||
       (r.receivedAtMs!==null && !Number.isFinite(r.receivedAtMs)) ||
       r.timestampAuthority!=="LOCAL_RECEIPT_ONLY") throw Error("invalid_research_book");
    books.set(key,r);
  }
  const ids=new Set<string>();
  let paper=0n,recomputed=0n,largestDiff=0n,invalid=0,
      both=0,full=0,late=0,zeroEntry=0,zeroExit=0,feeCents=0n;
  const unverifiedLargeProfitIds:string[]=[];
  for(const p of positions){
    if(!p.id || ids.has(p.id) || (p.status!=="CLOSED"&&p.status!=="SETTLED") ||
       !Number.isSafeInteger(p.contracts) || p.contracts<=0 ||
       !safePrice(p.entryOffer) || !safePrice(p.exitPrice) ||
       p.entryOffer<=0 || p.stake<0 || p.payout<0)
       throw Error("invalid_paper_position");
    ids.add(p.id);
    const gross=micros(p.payout)-micros(p.stake);
    const reported=micros(p.pnl);
    const diff=abs(gross-reported);
    paper+=reported; recomputed+=gross;
    if(diff>largestDiff)largestDiff=diff;
    if(diff>5_001n)invalid++;
    const stakeDiff=abs(micros(p.stake)-BigInt(p.contracts)*micros(p.entryOffer));
    if(stakeDiff>1n)invalid++;
    const entryTicks=Math.round(p.entryOffer*10000);
    const exitTicks=Math.round(p.exitPrice*10000);
    if(Math.abs(entryTicks-p.entryOffer*10000)>0.000001 ||
       Math.abs(exitTicks-p.exitPrice*10000)>0.000001)
       throw Error("non_fixed_point_paper_price");
    feeCents+=illustrativeQuadraticFeeCents(p.contracts,entryTicks,700);
    if(p.status==="CLOSED")
      feeCents+=illustrativeQuadraticFeeCents(p.contracts,exitTicks,700);
    const entry=books.get(p.id+"|ENTRY");
    const exit=books.get(p.id+"|EXIT");
    const usable=(r:PaperBookEvidence|undefined)=>r?.status==="CAPTURED" &&
      r.requestedContracts===p.contracts && r.modeledFilledContracts!==null &&
      r.receivedAtMs!==null;
    if(usable(entry) && entry!.modeledFilledContracts===0)zeroEntry++;
    if(usable(exit) && exit!.modeledFilledContracts===0)zeroExit++;
    if(usable(entry) && usable(exit)){
      both++;
      if(entry!.modeledFilledContracts===p.contracts &&
         exit!.modeledFilledContracts===p.contracts)full++;
    }
    // None of these REST receipts carries a venue sequence or fill assertion.
    if(entry || exit)late+=Number(Boolean(
      (entry && entry.receivedAtMs!==null && entry.receivedAtMs>entry.eventAtMs) ||
      (exit && exit.receivedAtMs!==null && exit.receivedAtMs>exit.eventAtMs)));
    if(p.pnl>20 && !(usable(entry)&&usable(exit) &&
        entry!.modeledFilledContracts===p.contracts &&
        exit!.modeledFilledContracts===p.contracts))
        unverifiedLargeProfitIds.push(p.id);
  }
  return {
    mode:"PAPER_ONLY_RESEARCH",tradingAuthority:false,
    certifiedExecutableNetUsd:null,liveFeeScheduleVerified:false,
    positions:positions.length,grossPaperUsd:numUsd(paper),
    recalculatedGrossUsd:numUsd(recomputed),
    maxAccountingDifferenceUsd:numUsd(largestDiff),
    accountingDifferencesOverHalfCent:invalid,
    missingBookPairs:positions.length-both,
    bothBooksCaptured:both,
    fullyModeledPostActionPairs:full,
    postActionOrUnsequencedSnapshots:late,
    entryPriceLimitedZeroFill:zeroEntry,
    exitPriceLimitedZeroFill:zeroExit,
    unverifiedLargeProfitIds,
    illustrativeSevenPercentFeesUsd:Number(feeCents)/100,
    illustrativeQuoteOnlyNetUsd:numUsd(paper)-Number(feeCents)/100,
  };
}

/** Deterministic research stress: local state only, no worker/exchange calls. */
export type PaperPilotFault="LOSS"|"LOW_LIQUIDITY"|"ONE_CENT_EXIT"|
   "KALSHI_429"|"UNKNOWN_ORDER"|"WORKER_RESTART"|"UNSIGNED_RECONCILE";
export interface PaperPilotStressReport {
  researchOnly:true;tradingAuthority:false;openingCashCents:2500;
  finalCashCents:number;modeledRiskStakesCents:number[];
  blocked:boolean;blockers:string[];
  partialOrAbsentFills:number;restarts:number;
}
export function simulateFiveDollarPilotFaults(events:readonly PaperPilotFault[]):PaperPilotStressReport {
  if(events.length>1000)throw Error("pilot_research_event_limit");
  let cash=2500,halt=false,skips=0,restarts=0;
  const blockers=new Set<string>(),stakes:number[]=[];
  for(const ev of events){
    if(ev==="WORKER_RESTART"){restarts++;continue;}
    if(ev==="UNKNOWN_ORDER"){halt=true;blockers.add("unknown_order_requires_signed_exchange_reconciliation");continue;}
    if(ev==="KALSHI_429"){halt=true;blockers.add("official_fee_source_unavailable");continue;}
    if(ev==="UNSIGNED_RECONCILE"){halt=true;blockers.add("unsigned_reconciliation_is_not_authority");continue;}
    if(ev==="LOW_LIQUIDITY"){skips++;continue;}
    if(ev==="LOSS" || ev==="ONE_CENT_EXIT"){
      if(halt){skips++;continue;}
      const budget=Math.min(500,Math.floor(cash*20/100));
      if(budget<=0){halt=true;blockers.add("insufficient_cash");continue;}
      stakes.push(budget);
      // ONE_CENT_EXIT: illustrative 10 contracts entered at 50c,
      // recovered at 1c, capped by budget. Excludes unpredictable fees.
      const outcome=ev==="LOSS"?0:Math.floor(budget/50);
      cash-=budget;
      if(ev==="ONE_CENT_EXIT")cash+=outcome;
    }else throw Error("invalid_pilot_fault");
  }
  return {researchOnly:true,tradingAuthority:false,openingCashCents:2500,
    finalCashCents:cash,modeledRiskStakesCents:stakes,blocked:halt,
    blockers:[...blockers],partialOrAbsentFills:skips,restarts};
}

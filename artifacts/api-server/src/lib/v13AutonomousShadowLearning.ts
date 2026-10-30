/**
 * Self-improving V1.3 research lane — NEVER an execution strategy.
 *
 * Learns a new strict-subset candidate using time-ordered, completed PAPER_ONLY
 * champion outcomes. Any selected candidate is a new immutable SHADOW version,
 * evaluated on FUTURE crossings only. Does not alter the pinned champion.
 *
 * No model may optimize protective exits, change a risk policy, arm an account,
 * manufacture fills/fees, or authorize trading. The modeled net is a research
 * sensitivity, not verified Kalshi after-fee P&L.
 */
import { and, desc, eq, gte, like } from "drizzle-orm";
import { db, forwardTestPositionTable, v13StrategyParameterSetTable } from "@workspace/db";
import {
 V13_CHAMPION_PARAMETER_SET, V13_CHAMPION_PARAMETER_HASH, V13_ENTRY_POLICY_VERSION,
 assertV13HistoricalTuningCandidate, type V13StrategyParameters,
} from "@workspace/v13-strategy";
import { forwardTestStartupDecision } from "./forwardTestStartupGate";
import { hashV13StrategyParameters, parametersFromResearchRow } from "./v13StrategyResearch";

export type AutolearnCompletedTrade={
 id:string; enteredAt:Date; trigger:"SCOUT"|"CONFIRM";
 entryOffer:number; entrySpread:number; entryBuffer:number;
 exitPrice:number; contracts:number; pnl:number;
 settled:boolean;
};
export type AutolearnCandidate={
 parameters:V13StrategyParameters; parameterHash:string;
 trainImprovementUsd:number; validateImprovementUsd:number;
 trainKept:number; validateKept:number;
 scoreUsd:number;
};
export type AutolearnDecision={
 status:"INSUFFICIENT_PROSPECTIVE_DATA"|"NO_ROBUST_IMPROVEMENT"|"CANDIDATE";
 reason:string; samples:number; distinctDays:number;
 trainTrades:number;validationTrades:number; candidate:AutolearnCandidate|null;
 executionAuthority:false; evidence:"UNVERIFIED_QUOTE_COST_PROXY_ONLY";
};
const DAY=86_400_000;
const MAX_LOOKBACK_DAYS=30;
const MIN_ELAPSED_DAYS=7;
const MIN_COMPLETED=60;
const MIN_DISTINCT_DAYS=5;
const MIN_TRAIN=35;
const MIN_VALIDATION=20;
const MIN_PARTICIPATION=0.70;
const MIN_IMPROVEMENT=2; // Net quote proxy dollars, each segment.
const RESEARCH_FEE_COEFFICIENT=0.07; // Illustrative ONLY: overrides may differ.
const MAX_ACTIVE_AUTOGEN=4;
const MAX_TOTAL_AUTOGEN=20;
export const AUTONOMOUS_RESEARCH_FLAG="STRATA_AUTONOMOUS_SHADOW_LEARNING_ENABLED";
const AUTO_PREFIX="v13-auto-shadow-";

/** Strict env gate: on by opt-in only, gated behind paper worker auth. */
export function autonomousShadowLearningConfigured(env:NodeJS.ProcessEnv=process.env){
 return env.NODE_ENV==="production"&&
   forwardTestStartupDecision(env,V13_ENTRY_POLICY_VERSION).ready&&
   env.STRATA_SHADOW_EVALUATION_WRITES_ENABLED!=="false"&&
   env[AUTONOMOUS_RESEARCH_FLAG]==="true";
}
const centsUp=(n:number)=>Math.ceil(n*100-1e-8)/100;
export function netResearchQuoteProxy(row:AutolearnCompletedTrade):number{
 const q=row.contracts, ep=row.entryOffer,xp=row.exitPrice;
 const entryFee=centsUp(RESEARCH_FEE_COEFFICIENT*q*ep*(1-ep));
 const exitFee=row.settled?0:centsUp(RESEARCH_FEE_COEFFICIENT*q*xp*(1-xp));
 const adversePrice=row.entrySpread*q*(row.settled?1:2);
 return row.pnl-entryFee-exitFee-adversePrice;
}
function valid(r:AutolearnCompletedTrade,now:Date){
 return Boolean(r.id&&r.enteredAt instanceof Date&&Number.isFinite(r.enteredAt.getTime())&&
  r.enteredAt.getTime()<=now.getTime()&&
  (r.trigger==="SCOUT"||r.trigger==="CONFIRM")&&
  [r.entryOffer,r.entrySpread,r.entryBuffer,r.exitPrice,r.contracts,r.pnl].every(Number.isFinite)&&
  r.entryOffer>0&&r.entryOffer<1&&r.exitPrice>=0&&r.exitPrice<=1&&
  r.entrySpread>=0&&r.entrySpread<=0.10&&r.contracts>0&&r.contracts<=1_000_000);
}
function keeps(r:AutolearnCompletedTrade,p:V13StrategyParameters){
 const b=Math.abs(r.entryBuffer);
 return r.trigger==="SCOUT"
  ? b>=p.scoutMinSeparation&&b<=p.scoutMaxSeparation&&r.entryOffer<=p.scoutMaxOffer
  : b>=p.confirmMinSeparation&&r.entryOffer<=p.confirmMaxOffer;
}
function segmentScore(rows:AutolearnCompletedTrade[],p:V13StrategyParameters){
 // Trim the largest favorable original champion quote event IN BOTH arms;
 // avoids promoting rules just because they retain a single 333-contract win.
 const outlier=rows.reduce<AutolearnCompletedTrade|null>((a,b)=>
    a===null||b.pnl>a.pnl?b:a,null);
 const filtered=rows.filter(r=>r.id!==outlier?.id);
 let champ=0,candidate=0,kept=0;
 for(const r of filtered){
  const modeled=netResearchQuoteProxy(r);
  champ+=modeled;
  if(keeps(r,p)){kept++;candidate+=modeled;}
 }
 return {improvement:candidate-champ,kept,total:filtered.length};
}
const round=(v:number)=>Math.round(v*100)/100;
const dayKey=(d:Date)=>d.toISOString().slice(0,10);

/** Offline retrospective search only, never a promotion recommendation. */
export function proposeAutonomousShadowCandidate(
 input:AutolearnCompletedTrade[],now:Date=new Date(),
 existingHashes:Iterable<string>=[],
):AutolearnDecision{
 const base={
   executionAuthority:false as const,
   evidence:"UNVERIFIED_QUOTE_COST_PROXY_ONLY" as const,
 };
 if(!Number.isFinite(now.getTime()))throw Error("invalid research clock");
 // Incomplete and unknown-order events cannot become learned "winners".
 const ordered=input.filter(r=>valid(r,now)&&
   r.enteredAt.getTime()>=now.getTime()-MAX_LOOKBACK_DAYS*DAY)
   .sort((a,b)=>a.enteredAt.getTime()-b.enteredAt.getTime()||a.id.localeCompare(b.id));
 const dates=new Set(ordered.map(r=>dayKey(r.enteredAt)));
 const span=ordered.length?now.getTime()-ordered[0]!.enteredAt.getTime():0;
 const basic={...base,samples:ordered.length,distinctDays:dates.size,
   trainTrades:0,validationTrades:0,candidate:null};
 if(span<MIN_ELAPSED_DAYS*DAY||ordered.length<MIN_COMPLETED||dates.size<MIN_DISTINCT_DAYS)
  return {...basic,status:"INSUFFICIENT_PROSPECTIVE_DATA",
    reason:"Require >=7 calendar days elapsed, >=5 distinct observed UTC dates and >=60 completed, qualified paper positions"};
 // Split by MARKET DATE rather than rows. No one market/calendar date may
 // appear in both fit and holdout. The largest quote winner is trimmed.
 const days=[...dates].sort();
 const boundary=days[Math.max(0,Math.floor(days.length*0.70)-1)]!;
 const train=ordered.filter(r=>dayKey(r.enteredAt)<=boundary);
 const hold=ordered.filter(r=>dayKey(r.enteredAt)>boundary);
 const size={...basic,trainTrades:train.length,validationTrades:hold.length};
 if(train.length<MIN_TRAIN||hold.length<MIN_VALIDATION)
  return {...size,status:"INSUFFICIENT_PROSPECTIVE_DATA",
   reason:"Chronological by-day split requires >=35 training and >=20 later holdout closed trades"};
 const seen=new Set(existingHashes);
 seen.add(V13_CHAMPION_PARAMETER_HASH);
 const champion=V13_CHAMPION_PARAMETER_SET.parameters;
 let leader:AutolearnCandidate|null=null;
 // Bounded, deterministic grid; all candidates tighten champion *entry*
 // conditions only. No exit, sizing, leverage or risk parameter adjustments.
 for(const scoutCents of [45,46,47,48,49,50,51]){
  for(const confirmCents of [46,47,48,49,50,51,52]){
   for(const confirmMin of [20,22,24]){
    const p:V13StrategyParameters={...champion,
      scoutMaxOffer:scoutCents/100,
      confirmMaxOffer:confirmCents/100,
      confirmMinSeparation:confirmMin,
    };
    try{assertV13HistoricalTuningCandidate(p)}catch{continue;}
    const hash=hashV13StrategyParameters(p);
    if(seen.has(hash))continue;
    const a=segmentScore(train,p),b=segmentScore(hold,p);
    if(a.total===0||b.total===0||
       a.kept/a.total<MIN_PARTICIPATION||b.kept/b.total<MIN_PARTICIPATION||
       a.improvement<MIN_IMPROVEMENT||b.improvement<MIN_IMPROVEMENT)
       continue;
    // Holdout dominates. A good in-sample fit must also survive later dates.
    const score=0.30*a.improvement+0.70*b.improvement;
    const candidate={parameters:p,parameterHash:hash,
      trainImprovementUsd:round(a.improvement),
      validateImprovementUsd:round(b.improvement),
      trainKept:a.kept,validateKept:b.kept,scoreUsd:round(score)};
    if(!leader||candidate.scoreUsd>leader.scoreUsd||
      (candidate.scoreUsd===leader.scoreUsd&&hash<leader.parameterHash))
      leader=candidate;
   }
  }
 }
 return leader?{...size,status:"CANDIDATE",candidate:leader,
   reason:"Retrospective quote-proxy candidate; requires NEW prospective SHADOW evidence; cannot promote"}:
   {...size,status:"NO_ROBUST_IMPROVEMENT",
    reason:"No bounded challenger beat champion cost proxy in both independent time blocks"};
}

function releaseDay(now:Date){
 return now.toISOString().slice(0,10).replaceAll("-","");
}
/**
 * Once per UTC date; 1 new candidate max, bounded total active/ever,
 * transactionally conflict-safe on id AND day version. Existing research
 * versions are immutable; failure cannot affect champion paper processing.
 */
export async function runAutonomousShadowResearch(
 now=new Date(),signal?:AbortSignal,
):Promise<{status:"DISABLED"|"COLLECTING"|"NO_CHANGE"|"CREATED"|"CAPACITY";
 candidateId?:string;reason:string}>{
 if(!autonomousShadowLearningConfigured()||signal?.aborted)
   return {status:"DISABLED",reason:"Explicit paper-only autonomous research flag required"};
 const date=releaseDay(now),candidateId=AUTO_PREFIX+date;
 // Resolve a prior uncertain commit by exact durable day ID before training
 // or trying another insert. A newest-N research list is not an identity proof.
 const [today]=await db.select({id:v13StrategyParameterSetTable.id})
  .from(v13StrategyParameterSetTable)
  .where(eq(v13StrategyParameterSetTable.id,candidateId)).limit(1);
 if(today)return {status:"NO_CHANGE",candidateId,reason:"Today's autonomous version is already recorded"};
 // Lifetime/active capacity applies only to autogenerated versions, including
 // old versions beyond the latest 200 manually-created research rows.
 const generated=await db.select({id:v13StrategyParameterSetTable.id,state:v13StrategyParameterSetTable.state})
  .from(v13StrategyParameterSetTable)
  .where(like(v13StrategyParameterSetTable.id,AUTO_PREFIX+"%"))
  .limit(MAX_TOTAL_AUTOGEN);
 if(generated.length>=MAX_TOTAL_AUTOGEN||
    generated.filter(x=>x.state==="SHADOW").length>=MAX_ACTIVE_AUTOGEN)
   return {status:"CAPACITY",reason:"Bounded autonomous candidate slots full; owner review of retired/active research required"};
 const existing=await db.select().from(v13StrategyParameterSetTable)
   .orderBy(desc(v13StrategyParameterSetTable.createdAt)).limit(200);
 const closed=await db.select({
  id:forwardTestPositionTable.id,enteredAt:forwardTestPositionTable.enteredAt,
  trigger:forwardTestPositionTable.triggerType,
  entryOffer:forwardTestPositionTable.entryOffer,
  entrySpread:forwardTestPositionTable.entrySpread,
  entryBuffer:forwardTestPositionTable.entryBuffer,
  exitPrice:forwardTestPositionTable.exitPrice,
  contracts:forwardTestPositionTable.contracts,pnl:forwardTestPositionTable.pnl,
  status:forwardTestPositionTable.status,
 }).from(forwardTestPositionTable)
 .where(and(
  eq(forwardTestPositionTable.engineId,"v1.3-paper"),
  eq(forwardTestPositionTable.strategyParameterSetId,V13_CHAMPION_PARAMETER_SET.id),
  eq(forwardTestPositionTable.strategyParameterHash,V13_CHAMPION_PARAMETER_HASH),
  gte(forwardTestPositionTable.enteredAt,new Date(now.getTime()-MAX_LOOKBACK_DAYS*DAY)),
 ))
 .orderBy(desc(forwardTestPositionTable.enteredAt)).limit(1200);
 const qualified:AutolearnCompletedTrade[]=closed.flatMap(r=>
   (r.status==="CLOSED"||r.status==="SETTLED")&&
   r.entrySpread!==null&&r.exitPrice!==null&&r.pnl!==null&&
   (r.trigger==="SCOUT"||r.trigger==="CONFIRM")?
   [{id:r.id,enteredAt:r.enteredAt,trigger:r.trigger,
     entryOffer:r.entryOffer,entrySpread:r.entrySpread,
     entryBuffer:r.entryBuffer,exitPrice:r.exitPrice,
     contracts:r.contracts,pnl:r.pnl,settled:r.status==="SETTLED"}]:[]);
 const proposal=proposeAutonomousShadowCandidate(
  qualified,now,existing.map(r=>r.parameterHash));
 if(proposal.status!=="CANDIDATE"||!proposal.candidate)
   return {status:proposal.status==="INSUFFICIENT_PROSPECTIVE_DATA"?"COLLECTING":"NO_CHANGE",
      reason:proposal.reason};
 if(signal?.aborted||!autonomousShadowLearningConfigured())
  return {status:"DISABLED",reason:"Paper producer shut down or research paused"};
 const p=proposal.candidate;
 await db.insert(v13StrategyParameterSetTable).values({
   id:candidateId,version:Number(date),
   supersedesParameterSetId:null,
   label:"AUTO PAPER HOLDOUT · UNVERIFIED QUOTE COST · "+date,
   state:"SHADOW",classifierVersion:"V1.3",
   ...p.parameters,parameterHash:p.parameterHash,
   executionAuthority:false,
   createdBy:"system:paper-autonomous-shadow",
   activatedBy:"system:paper-autonomous-shadow",
   activatedAt:now, // Prospective starts NOW; no historical outcomes backfilled.
 }).onConflictDoNothing();
 const [saved]=await db.select().from(v13StrategyParameterSetTable)
  .where(eq(v13StrategyParameterSetTable.id,candidateId)).limit(1);
 if(!saved||saved.executionAuthority!==false||
    saved.parameterHash!==p.parameterHash||
    saved.state!=="SHADOW")
   throw Error("Autonomous research row was not verifiably persisted as intended");
 if(hashV13StrategyParameters(parametersFromResearchRow(saved))!==p.parameterHash)
   throw Error("Autonomous research row hash mismatch");
 return {status:"CREATED",candidateId,reason:"Versioned prospective SHADOW challenger only; never champion or live authorization"};
}

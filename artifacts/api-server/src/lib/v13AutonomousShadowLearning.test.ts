import assert from "node:assert/strict";
import test from "node:test";
import {V13_CHAMPION_PARAMETER_SET,V13_CHAMPION_PARAMETER_HASH,
 assertV13HistoricalTuningCandidate} from "@workspace/v13-strategy";
import {autonomousShadowLearningConfigured,netResearchQuoteProxy,
 proposeAutonomousShadowCandidate,type AutolearnCompletedTrade} from "./v13AutonomousShadowLearning";

const NOW=new Date("2026-11-04T12:00:00.000Z");
const DAY=86_400_000;
function dataset(opts:{validationWin?:boolean;hugeOutlier?:boolean}={}):AutolearnCompletedTrade[]{
 return Array.from({length:100},(_,i)=>{
  const day=Math.floor(i/10);
  const high=i%5===0; // 20% high-priced entries are consistently weak.
  const validationLoss=opts.validationWin&&day>=7;
  return {
   id:"paper-"+i,enteredAt:new Date(NOW.getTime()-(10-day)*DAY+i*1000),
   trigger:"SCOUT" as const,entryOffer:high?0.51:0.45,
   entrySpread:0.01,entryBuffer:10,exitPrice:high?0.30:0.60,
   contracts:10,
   pnl:opts.hugeOutlier&&i===3?318.02:high?(validationLoss?1.4:-2.1):1.5,
   settled:false,
  };
 });
}
test("paper-only autonomous research disabled by default and never becomes trade authority",()=>{
 assert.equal(autonomousShadowLearningConfigured({NODE_ENV:"production",
  FORWARD_TEST_WORKER_ENABLED:"true",FORWARD_TEST_PRODUCTION_WORKER_ENABLED:"true"} as NodeJS.ProcessEnv),false);
 assert.equal(autonomousShadowLearningConfigured({NODE_ENV:"development",
  FORWARD_TEST_WORKER_ENABLED:"true",FORWARD_TEST_PRODUCTION_WORKER_ENABLED:"true",
  STRATA_AUTONOMOUS_SHADOW_LEARNING_ENABLED:"true"} as NodeJS.ProcessEnv),false);
 assert.equal(autonomousShadowLearningConfigured({NODE_ENV:"production",
  FORWARD_TEST_WORKER_ENABLED:"true",FORWARD_TEST_PRODUCTION_WORKER_ENABLED:"true",
  STRATA_AUTONOMOUS_SHADOW_LEARNING_ENABLED:"true"} as NodeJS.ProcessEnv),true);
 assert.equal(Object.isFrozen(V13_CHAMPION_PARAMETER_SET),true);
});
test("requires prospective historical span and chronological by-day holdout, not a recent backfit",()=>{
 const fresh=dataset().map(r=>({...r,
   enteredAt:new Date(NOW.getTime()-2*DAY)}));
 assert.equal(proposeAutonomousShadowCandidate(fresh,NOW).status,"INSUFFICIENT_PROSPECTIVE_DATA");
 const tooFew=dataset().slice(0,30);
 assert.equal(proposeAutonomousShadowCandidate(tooFew,NOW).status,"INSUFFICIENT_PROSPECTIVE_DATA");
});
test("learns a strict-subset version from training and later validation, NOT champion changes",()=>{
 const result=proposeAutonomousShadowCandidate(dataset(),NOW);
 assert.equal(result.status,"CANDIDATE");
 assert.equal(result.executionAuthority,false);
 assert.equal(result.evidence,"UNVERIFIED_QUOTE_COST_PROXY_ONLY");
 if(!result.candidate)throw Error("expected research candidate");
 const p=result.candidate.parameters;
 assertV13HistoricalTuningCandidate(p);
 assert.ok(p.scoutMaxOffer<=0.50); // rejected consistently harmful 51c entry
 assert.equal(p.wrongSideRecrossSeparation,8);
 assert.equal(p.exitOnMomentumInvalidation,true);
 assert.equal(V13_CHAMPION_PARAMETER_SET.parameters.scoutMaxOffer,0.52);
 assert.ok(result.candidate.trainImprovementUsd>=2);
 assert.ok(result.candidate.validateImprovementUsd>=2);
 assert.ok(result.candidate.trainKept>=20);
 assert.ok(result.candidate.validateKept>=20);
 const noDuplicate=proposeAutonomousShadowCandidate(dataset(),NOW,[result.candidate.parameterHash]);
 assert.notEqual(noDuplicate.candidate?.parameterHash,result.candidate.parameterHash);
 assert.notEqual(result.candidate.parameterHash,V13_CHAMPION_PARAMETER_HASH);
});
test("refuses a fitted candidate that loses its independent validation",()=>{
 const result=proposeAutonomousShadowCandidate(dataset({validationWin:true}),NOW);
 assert.notEqual(result.status,"CANDIDATE");
});
test("single giant quote winner cannot create a phantom decision edge",()=>{
 const plain=proposeAutonomousShadowCandidate(dataset(),NOW);
 const outlier=proposeAutonomousShadowCandidate(dataset({hugeOutlier:true}),NOW);
 assert.equal(outlier.status,"CANDIDATE");
 assert.equal(plain.candidate?.parameterHash,outlier.candidate?.parameterHash);
 assert.equal(plain.candidate?.scoreUsd,outlier.candidate?.scoreUsd);
});
test("missing/invalid paper quotes are excluded, and modeled fees are explicitly approximate",()=>{
 const rows=dataset().map((r,i)=>i<90?{...r,entrySpread:Number.NaN}:r);
 assert.equal(proposeAutonomousShadowCandidate(rows,NOW).status,"INSUFFICIENT_PROSPECTIVE_DATA");
 assert.ok(netResearchQuoteProxy(dataset()[0]!)<dataset()[0]!.pnl);
});

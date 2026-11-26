import {ProductionWorker} from './worker';
import {readDirectIndependentPgReplay,rereadDirectIndependentPgReplay,type DirectReplayQuery} from './directIndependentPgReplay';
import {replayDirectHeld,type DirectHeldReplayScope} from './directHeldPgReplay';
import type {IndependentReplayGate,IndependentReplayScope} from './independentWorkerReplay';

type HeldQuery=Parameters<typeof replayDirectHeld>[0];
type Binding={scope:DirectHeldReplayScope;observationId:string};

export interface IndependentPgFixture {
  entrySelect: DirectReplayQuery;
  heldDb: HeldQuery;
  now(): number;
  gate(scope:Readonly<IndependentReplayScope>):Promise<IndependentReplayGate|null>;
  /** Must be exactly pinned to the provided held position. Never a paper or
   * active-market feed, and never accept the observation ID from a client. */
  heldBinding(scope:Readonly<IndependentReplayScope>,positionId:string):Promise<Binding|null>;
}

/** Explicit test assembly; no registration in API startup, production
 * factories, environment flags, or operator controls. */
export function wireIndependentPgReplay(scope:IndependentReplayScope,fixture:IndependentPgFixture){
  return ProductionWorker.createIndependentReplay(scope,{
    now:()=>fixture.now(),
    readGate:s=>fixture.gate(s),
    discoverEntries:(s,t,hint)=>readDirectIndependentPgReplay(fixture.entrySelect,s,t,hint),
    rereadEntry:(s,t,p)=>rereadDirectIndependentPgReplay(fixture.entrySelect,s,t,p),
    readHeld:async(s,position,market,maxAge)=>{
      const link=await fixture.heldBinding(s,position);
      if(!link||link.scope.owner!==s.ownerId||link.scope.account!==s.accountId||
        link.scope.position!==position||link.scope.ticker!==market)return null;
      const proof=await replayDirectHeld(fixture.heldDb,link.scope,link.observationId,maxAge);
      if(proof.kind!=='READY')return null;
      return {ownerId:s.ownerId,accountId:s.accountId,positionId:position,marketTicker:market,
        observationId:proof.sourceId,evidenceSha256:proof.sourceDigest,
        originalOldestMs:proof.oldestAtMs,originalObservedMs:proof.observedAtMs,
        marketCloseMs:proof.marketCloseMs,submissionAuthorized:false};
    },
  });
}

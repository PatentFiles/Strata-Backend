/**
 * Isolated worker assembly for no-submit integration. It cannot obtain an
 * executor, exchange transport, signing credential, intent writer or paper
 * port. Its result is a test observation, never an execution decision.
 */
export interface IndependentReplayScope { ownerId: string; accountId: string }
export interface IndependentReplayGate extends IndependentReplayScope {
  revision: string;
  fence: string;
  stop: boolean;
  unknown: boolean;
  revoked: boolean;
  positionId: string | null;
  heldMarket: string | null;
  maxAgeMs: number;
}
export interface IndependentReplayEntryProof extends IndependentReplayScope {
  sourceId: string;
  marketTicker: string;
  crossingKey: string;
  evidenceSha256: string;
  originalOldestMs: number;
  originalObservedMs: number;
  marketCloseMs: number;
  submissionAuthorized: false;
}
export interface IndependentReplayHeldProof extends IndependentReplayScope {
  positionId: string;
  marketTicker: string;
  observationId: string;
  evidenceSha256: string;
  originalOldestMs: number;
  originalObservedMs: number;
  marketCloseMs: number;
  submissionAuthorized: false;
}
export interface IndependentReplayPorts {
  readGate(scope: Readonly<IndependentReplayScope>): Promise<IndependentReplayGate | null>;
  discoverEntries(scope: Readonly<IndependentReplayScope>, now: number, hintedSource: string | null): Promise<readonly IndependentReplayEntryProof[]>;
  rereadEntry(scope: Readonly<IndependentReplayScope>, now: number, prepared: Readonly<IndependentReplayEntryProof>): Promise<IndependentReplayEntryProof | null>;
  readHeld(scope: Readonly<IndependentReplayScope>, positionId: string, market: string, maxAgeMs: number, now: number): Promise<IndependentReplayHeldProof | null>;
  now(): number;
}
type Result = {
  status: 'observed_entry'|'observed_held_exit'|'no_fresh_work'|'stopped_or_unverified'|'busy';
  inspected: number;
  submissionAuthorized: false;
};
const result=(status:Result['status'],inspected=0):Result=>({status,inspected,submissionAuthorized:false});
const hash=/^[0-9a-f]{64}$/;
const integer=(ms:number)=>Number.isSafeInteger(ms)&&ms>=0;
const scopeSame=(x:IndependentReplayScope,s:IndependentReplayScope)=>x.ownerId===s.ownerId&&x.accountId===s.accountId;
const usable=(s:IndependentReplayScope,g:IndependentReplayGate|null):g is IndependentReplayGate=>!!g&&scopeSame(g,s)&&
  !!g.revision&&!!g.fence&&g.stop===false&&g.unknown===false&&g.revoked===false&&
  Number.isSafeInteger(g.maxAgeMs)&&g.maxAgeMs>0&&g.maxAgeMs<=5000&&
  ((g.positionId===null&&g.heldMarket===null)||(!!g.positionId&&!!g.heldMarket));
const keys=(g:IndependentReplayGate)=>JSON.stringify([g.accountId,g.ownerId,g.revision,g.fence,g.stop,g.unknown,
  g.revoked,g.positionId,g.heldMarket,g.maxAgeMs]);
type ClockProof=Pick<IndependentReplayEntryProof,'originalOldestMs'|'originalObservedMs'|'marketCloseMs'|'submissionAuthorized'|'evidenceSha256'>;
const fresh=(x:ClockProof,now:number,max:number)=>x.submissionAuthorized===false&&hash.test(x.evidenceSha256)&&
  [now,x.originalOldestMs,x.originalObservedMs,x.marketCloseMs].every(integer)&&
  x.originalOldestMs<=x.originalObservedMs&&x.originalObservedMs<=now&&now<x.marketCloseMs&&
  now-x.originalOldestMs<=max;
const sameProof=(a:ClockProof,b:ClockProof)=>a.evidenceSha256===b.evidenceSha256&&
  a.originalOldestMs===b.originalOldestMs&&a.originalObservedMs===b.originalObservedMs&&
  a.marketCloseMs===b.marketCloseMs;

export class IndependentWorkerReplay {
  #running=false;
  #seen=new Set<string>();
  readonly #scope:Readonly<IndependentReplayScope>;
  constructor(scope:IndependentReplayScope,private readonly reads:IndependentReplayPorts) {
    this.#scope=Object.freeze({ownerId:scope.ownerId,accountId:scope.accountId});
  }
  async tick(committedHint:string|null=null):Promise<Result>{
    if(this.#running)return result('busy');
    this.#running=true;
    try {
      const scope=this.#scope;
      if(!scope.ownerId||!scope.accountId)return result('stopped_or_unverified');
      const first=await this.reads.readGate(scope);
      if(!usable(scope,first))return result('stopped_or_unverified');
      const gate=Object.freeze({...first});
      const pinned=keys(gate);
      const gateCheck=async()=>{
        const a=await this.reads.readGate(scope);
        return usable(scope,a)&&keys(a)===pinned;
      };
      if(gate.positionId&&gate.heldMarket){
        // Held source is read by the position's immutable market, never active
        // entry market or a paper lookup. Entry isn't evaluated while held.
        const p=await this.reads.readHeld(scope,gate.positionId,gate.heldMarket,gate.maxAgeMs,this.reads.now());
        const heldMatches=(v:IndependentReplayHeldProof|null):v is IndependentReplayHeldProof=>!!v&&
          scopeSame(v,scope)&&v.positionId===gate.positionId&&v.marketTicker===gate.heldMarket&&
          !!v.observationId&&fresh(v,this.reads.now(),gate.maxAgeMs);
        if(!heldMatches(p))return result('stopped_or_unverified');
        const pinnedSource=Object.freeze({...p});
        const tail=await this.reads.readHeld(scope,gate.positionId,gate.heldMarket,gate.maxAgeMs,this.reads.now());
        if(!heldMatches(tail)||tail.observationId!==pinnedSource.observationId||
          !sameProof(pinnedSource,tail)||!await gateCheck()||
          !fresh(pinnedSource,this.reads.now(),gate.maxAgeMs))return result('stopped_or_unverified');
        return result('observed_held_exit',1);
      }
      // Notification is only an optimisation. A regular tick supplies null
      // and still discovers committed, in-window, account-bound source rows.
      const rows=await this.reads.discoverEntries(scope,this.reads.now(),committedHint);
      if(!Array.isArray(rows)||rows.length>100)return result('stopped_or_unverified');
      let n=0;
      for(const raw of rows as readonly IndependentReplayEntryProof[]){
        const p=Object.freeze({...raw}); // preserve the original selected bytes/clocks identity
        if(!scopeSame(p,scope)||!p.sourceId||!p.marketTicker||p.crossingKey!==p.marketTicker+':first'||
          !fresh(p,this.reads.now(),gate.maxAgeMs)||this.#seen.has(p.crossingKey))continue;
        const tail=await this.reads.rereadEntry(scope,this.reads.now(),p);
        if(!tail||!scopeSame(tail,scope)||tail.sourceId!==p.sourceId||tail.marketTicker!==p.marketTicker||
          tail.crossingKey!==p.crossingKey||!sameProof(p,tail)||!fresh(tail,this.reads.now(),gate.maxAgeMs)||
          !await gateCheck()||!fresh(p,this.reads.now(),gate.maxAgeMs))return result('stopped_or_unverified');
        this.#seen.add(p.crossingKey);n++;
        if(this.#seen.size>512){
          const oldest=this.#seen.values().next().value;
          if(oldest!==undefined)this.#seen.delete(oldest);
        }
      }
      return n?result('observed_entry',n):result('no_fresh_work');
    } catch {
      return result('stopped_or_unverified');
    } finally {
      this.#running=false;
    }
  }
}

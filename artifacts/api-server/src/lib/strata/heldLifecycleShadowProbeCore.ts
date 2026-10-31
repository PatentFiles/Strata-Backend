import type {RolloverStrikeEvent} from '../rolloverStrikeDiagnostics';
export type HeldLifecycleScope={ownerId:string;accountId:string;expectedSha:string;boundaryMs:number};
export type ShadowFrame={generation:number;sid:number;receivedAtMs:number;raw:string};
export type ShadowObserver={onSubscribed:(e:{generation:number;sid:number;receivedAtMs:number})=>void;
 onEnvelope:(e:ShadowFrame)=>void;onInvalidated:(e:unknown)=>void};
export type ShadowHandle={start:()=>void;stop:()=>void;snapshot:()=>{stopped:boolean}};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TRANSPORT_REASONS=new Set(['cancelled','invalid_clock','observer_failed','authorization_revoked','duration_limit','attempt_limit','invalid_cooldown','cooldown_exceeds_window','invalid_signed_scope','stale_handshake','provider_subscription_error','handshake_timeout','signing_failed','socket_creation_failed','invalid_socket','subscription_send_failed','frame_limit','message_rate_limit','malformed_json','invalid_subscription','unexpected_envelope','socket_error','socket_closed']);
const TICKER=/^KXBTC15M-[A-Z0-9-]{1,80}$/;
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const safeInt=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0&&x<=8640000000000000;
type StrikeReceipt={ticker:string;strike:number;receivedAtMs:number;generation:number;seq:number|null;canonicalWindow:boolean;exchangeIndexVerified:boolean;providerSentAtMs:number|null;sourceAgeMs:number|null;sourceTimestampValid:boolean};
/** Observations only. No synthetic baseline, readiness cache or quote output exists. */
export class HeldLifecycleComparison {
 private lastTransportReason:string|null=null;private lastTransportFailure:string|null=null;
 private generation=-1;private sid=-1;private lastSeq:number|null=null;
 private firstSubscribedAtMs:number|null=null;private subscriptions=0;private frames=0;private gaps=0;private invalidations=0;
 private receipts=new Map<string,StrikeReceipt>();private overflow=false;private conflicts=0;
 private rest:RolloverStrikeEvent|null=null;private firstRest:RolloverStrikeEvent|null=null;
 constructor(private boundaryMs:number){}
 observer:ShadowObserver={
  onSubscribed:e=>{this.generation=e.generation;this.sid=e.sid;this.lastSeq=null;this.subscriptions++;this.firstSubscribedAtMs??=e.receivedAtMs;},
  onInvalidated:e=>{this.invalidations++;this.lastSeq=null;this.generation=-1;this.sid=-1;
   const reason=object(e)&&typeof e.reason==='string'&&TRANSPORT_REASONS.has(e.reason)?e.reason:'unknown_transport_invalidation';
   this.lastTransportReason=reason;if(!['cancelled','duration_limit'].includes(reason))this.lastTransportFailure=reason;},
  onEnvelope:e=>{
   if(e.generation!==this.generation||e.sid!==this.sid||!safeInt(e.receivedAtMs)||e.raw.length>16384)return;
   let f:unknown;try{f=JSON.parse(e.raw)}catch{return}if(!object(f))return;
   this.frames=Math.min(Number.MAX_SAFE_INTEGER,this.frames+1);
   const seq=safeInt(f.seq)?f.seq:null;
   if(seq===null||this.lastSeq!==null&&seq!==this.lastSeq+1)this.gaps++;
   this.lastSeq=seq;
   if(f.type!=='market_lifecycle_v2'||!object(f.msg))return;
   const m=f.msg,ticker=m.market_ticker;
   if(typeof ticker!=='string'||!TICKER.test(ticker)||!['created','activated','metadata_updated'].includes(String(m.event_type)))return;
   if(typeof m.open_ts==='number'&&m.open_ts!==this.boundaryMs/1000||typeof m.close_ts==='number'&&m.close_ts!==(this.boundaryMs+900000)/1000)return;
   if(this.firstRest?.ticker&&ticker!==this.firstRest.ticker)return;
   const data=m.event_type==='created'?m.additional_metadata:m;
   if(!object(data)||typeof data.floor_strike!=='number'||!Number.isFinite(data.floor_strike)||data.floor_strike<=0||
      data.strike_type!=='greater_or_equal'||data.cap_strike!=null)return;
   if(e.receivedAtMs<this.boundaryMs-900000||e.receivedAtMs>this.boundaryMs+30000)return;
   if(this.receipts.has(ticker)){if(this.receipts.get(ticker)!.strike!==data.floor_strike)this.conflicts++;return;}
   if(this.receipts.size>=2){this.overflow=true;return;}
   this.receipts.set(ticker,{ticker,strike:data.floor_strike,receivedAtMs:e.receivedAtMs,generation:e.generation,seq,
    canonicalWindow:m.open_ts===this.boundaryMs/1000&&m.close_ts===(this.boundaryMs+900000)/1000,
    exchangeIndexVerified:m.exchange_index===2,
    providerSentAtMs:safeInt(f.sending_ts_ms)?f.sending_ts_ms:null,
    sourceAgeMs:safeInt(f.sending_ts_ms)?e.receivedAtMs-f.sending_ts_ms:null,
    sourceTimestampValid:safeInt(f.sending_ts_ms)&&e.receivedAtMs-f.sending_ts_ms>=-250&&e.receivedAtMs-f.sending_ts_ms<=5000});
  },
 };
 observeRest(e:RolloverStrikeEvent){
  if(Date.parse(e.windowStartedAt)!==this.boundaryMs||!e.ticker||!TICKER.test(e.ticker))return;
  this.firstRest??=e;for(const key of this.receipts.keys())if(key!==this.firstRest.ticker)this.receipts.delete(key);if(e.phase==='ready'&&!this.rest)this.rest=e;
 }
 summary(){
  const ticker=this.rest?.ticker??this.firstRest?.ticker??null;
  const ws=ticker?this.receipts.get(ticker)??null:null;
  const restAt=this.rest?Date.parse(this.rest.observedAt):null;
  return {mode:'HELD_LIFECYCLE_SHADOW',tradingAuthority:false,protocolBaseline:'UNPROVEN',
   quoteReadiness:'NOT_MEASURED',quoteAgeMs:null,executableEarlier:'NOT_PROVEN',maxQuoteAgeMs:5000,
   authenticatedSubscriptionAcknowledged:this.subscriptions>0,
   lifecycleReceiptCurrentGeneration:ws?ws.generation===this.generation:false,leadQualification:'RAW_RECEIPT_ONLY_NOT_EXECUTABLE',
   boundaryMs:this.boundaryMs,firstSubscribedAtMs:this.firstSubscribedAtMs,subscriptions:this.subscriptions,
   lastTransportReason:this.lastTransportReason,lastTransportFailure:this.lastTransportFailure,
   framesObserved:this.frames,sequenceDiscontinuities:this.gaps,invalidations:this.invalidations,metadataOverflow:this.overflow,strikeConflicts:this.conflicts,
   exactTicker:ticker,firstRestObservedAtMs:this.firstRest?Date.parse(this.firstRest.observedAt):null,
   restStrikeReadyAtMs:restAt,lifecycleStrikeReceipt:ws,
   lifecycleLeadMs:ws&&restAt!==null?restAt-ws.receivedAtMs:null,
   strikesAgree:ws&&typeof this.rest?.strike?.value==='number'?ws.strike===this.rest.strike.value:null,
   continuityQualified:false};
 }
}
export type HeldProbeDependencies={now:()=>number;sha:()=>string;
 checkHeld:()=>Promise<{credentialBinding:string}|null>;
 createTransport:(binding:string,observer:ShadowObserver,authorized:()=>boolean,durationMs:number)=>Promise<ShadowHandle>;
 subscribeRest:(observe:(e:RolloverStrikeEvent)=>void)=>()=>void;
 pause:(ms:number)=>Promise<void>;save:(summary:ReturnType<HeldLifecycleComparison['summary']>&{reason:string})=>void;
};
/** A bounded, serialized watchdog. Async operations never overlap or revive an expired authorization. */
export async function runHeldLifecycleShadowProbe(scope:HeldLifecycleScope,deps:HeldProbeDependencies){
 const started=deps.now(),deadline=scope.boundaryMs+30000;
 if(!UUID.test(scope.ownerId)||!/^strata-account-[a-f0-9]{24}$/.test(scope.accountId)||!/^[a-f0-9]{40}$/.test(scope.expectedSha)||
  deps.sha()!==scope.expectedSha||!safeInt(started)||!safeInt(scope.boundaryMs)||scope.boundaryMs%900000!==0||
  scope.boundaryMs!==Math.floor(started/900000)*900000+900000||deadline-started>1080000)return {ok:false,reason:'held_lifecycle_scope_invalid'};
 const compare=new HeldLifecycleComparison(scope.boundaryMs);
 let transport:ShadowHandle|null=null,unsubscribe=()=>{},binding='',allowedUntil=0,lastNow=started,ended=false,reason='completed';
 const authorized=()=>{const now=deps.now();return !ended&&safeInt(now)&&now>=lastNow&&now<allowedUntil&&now<deadline&&deps.sha()===scope.expectedSha;};
 try{
  const initial=await deps.checkHeld();const at=deps.now();
  if(!initial||!/^[a-f0-9]{64}$/.test(initial.credentialBinding)||!safeInt(at)||at<started||at-started>=2500||at>=deadline||deps.sha()!==scope.expectedSha)
   return {ok:false,reason:'held_lifecycle_preflight_failed'};
  binding=initial.credentialBinding;allowedUntil=at+5000;lastNow=at;
  transport=await deps.createTransport(binding,compare.observer,authorized,deadline-at);
  if(!authorized())throw Error('held_lifecycle_authorization_expired');
  unsubscribe=deps.subscribeRest(e=>compare.observeRest(e));transport.start();
  let nextCheckAt=at+2500;
  while(true){
   const currentTime=deps.now();if(!safeInt(currentTime)||currentTime<lastNow)throw Error('held_lifecycle_clock_invalid');
   if(currentTime>=deadline)break;
   await deps.pause(Math.max(0,Math.min(nextCheckAt-currentTime,deadline-currentTime)));
   const before=deps.now();if(!safeInt(before)||before<lastNow)throw Error('held_lifecycle_clock_invalid');
   if(before>=deadline)break;
   if(!authorized())throw Error('held_lifecycle_authorization_expired');
   const current=await deps.checkHeld();const after=deps.now();
   if(!current||current.credentialBinding!==binding||!safeInt(after)||after<before||after-before>=2500||!authorized())throw Error('held_lifecycle_hold_lost');
   lastNow=after;allowedUntil=after+5000;nextCheckAt=before+2500;
   if(transport.snapshot().stopped){reason='transport_stopped';break;}
  }
 }catch{reason='held_lifecycle_failed_closed';}
 finally{ended=true;try{transport?.stop()}catch{}try{unsubscribe()}catch{}if(transport)try{deps.save({...compare.summary(),reason})}catch{}}
 return {ok:reason==='completed',reason};
}

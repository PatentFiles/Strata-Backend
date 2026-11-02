import {createHash} from "node:crypto";
import {beginPublicMetadataRead} from "./publicMetadataReadRateLimit";
import {annotateFeeFailure} from "./feeFailureDiagnostics";
import type {MetadataBodyCapture,MetadataCaptureManifest} from "./metadataCapture";
import type {CommittedForwardSourceHint} from "../forwardTestSignalWake";

const ORIGIN="https://external-api.kalshi.com/trade-api/v2";
const ticker=/^KXBTC15M-[A-Za-z0-9-]{1,100}$/;
const identifier=/^[A-Za-z0-9_.:-]{1,128}$/;
type Body=Record<string,unknown>;
const plain=(v:unknown):v is Body=>!!v&&typeof v==="object"&&!Array.isArray(v);
const hash=(v:string|Uint8Array)=>createHash("sha256").update(v).digest("hex");
const error=(reason="entry_metadata_prefetch_unavailable")=>new Error(reason);
const freeze=(value:unknown)=>{const pending=[value];while(pending.length){const v=pending.pop();if(v&&typeof v==="object"){pending.push(...Object.values(v));Object.freeze(v);}}};
export type MetadataPrefetchScope=Readonly<{accountId:string;ownerId:string;releaseSha:string;holderId:string;fence:string;policyHash:string}>;
export type PreparedMetadataSource=Readonly<{evaluationId:string;marketTicker:string;evaluatedAtMs:number;btcProviderAgeMs:number;btcReceiveAgeMs:number;marketAgeMs:number}>;
export type PrefetchedPublicMetadata=Readonly<{read:(path:string)=>Promise<Body>;capture:()=>MetadataCaptureManifest}>;
export type MetadataPhaseBinding=Readonly<{phase:"FINAL_MARKET"|"WIRE_FEE";intentId:string}>;
export type PhaseMetadataIdentity=MetadataPhaseBinding;
type MetadataAttempt<S extends PreparedMetadataSource>={
  readonly source:S;
  consume(scope:MetadataPrefetchScope,source:PreparedMetadataSource,phase?:MetadataPhaseBinding):PrefetchedPublicMetadata;
  pause():void;
  discard(reason?:string):void;
  /** Settles after all actual fetch/body operations settle, not merely a timeout race. */
  readonly drained:Promise<void>;
};

export type MetadataPrefetchAttempt=MetadataAttempt<CommittedForwardSourceHint>;
export type PhaseMetadataPrefetchAttempt=Omit<MetadataAttempt<PreparedMetadataSource>,"consume">&{
 consume(scope:MetadataPrefetchScope,source:PreparedMetadataSource,phase:MetadataPhaseBinding):PrefetchedPublicMetadata;
};

export type PhaseMetadataAttempt=PhaseMetadataPrefetchAttempt;

type Queued={allowed:()=>boolean;signal:AbortSignal;start:()=>void;reject:(error:Error)=>void};
/** One instance must be shared by every owned session in one process. An aborted
 * adapter that ignores cancellation retains its budget slot until actually settled.
 * No retry, signed request, order method, database read or eligibility clock here.
 */
export class CommittedPublicMetadataCoordinator {
  private active=0;
  private queue:Queued[]=[];
  private accounts=new Map<string,{discard(reason?:string):void;drained:Promise<void>}>();
  private seen=new Map<string,number>();
  constructor(private readonly fetchImpl:typeof fetch=globalThis.fetch,
    private readonly wallNow=Date.now,private readonly monotonicNow=()=>performance.now(),
    private readonly limits={requests:3,accounts:2,seen:32,timeoutMs:5_000}) {
    if(![limits.requests,limits.accounts,limits.seen,limits.timeoutMs].every(x=>Number.isSafeInteger(x)&&x>0)||
      limits.requests>3||limits.accounts>2||limits.seen>32||limits.timeoutMs>5_000)throw error("entry_metadata_budget_invalid");
  }
  diagnostics(){return Object.freeze({activeRequests:this.active,queuedRequests:this.queue.length,accounts:this.accounts.size,seen:this.seen.size});}
  private pump(){
    this.queue=this.queue.filter(q=>{if(q.signal.aborted){q.reject(error("entry_metadata_prefetch_cancelled"));return false;}return true;});
    while(this.active<this.limits.requests){const index=this.queue.findIndex(q=>q.allowed());if(index<0)break;
      this.active++;this.queue.splice(index,1)[0]!.start();}
  }
  private schedule<T>(signal:AbortSignal,allowed:()=>boolean,run:()=>Promise<T>):Promise<T>{
    return new Promise<T>((resolve,reject)=>{
      if(signal.aborted){reject(error("entry_metadata_prefetch_cancelled"));return;}
      const abort=()=>this.pump();
      const entry:Queued={signal,allowed,reject,start:()=>{
        signal.removeEventListener("abort",abort);
        Promise.resolve().then(()=>{if(signal.aborted)throw error("entry_metadata_prefetch_cancelled");return run();})
          .then(resolve,reject).finally(()=>{this.active--;this.pump();});
      }};
      signal.addEventListener("abort",abort,{once:true});
      this.queue.push(entry);this.pump();
    });
  }
  start(scopeInput:MetadataPrefetchScope,hintInput:CommittedForwardSourceHint):MetadataPrefetchAttempt|null {
    return this.startScoped(scopeInput,hintInput);
  }
  /** Advisory only. Unlike PREPARE, these scopes originate from an already
   * persisted intent. Never manufacture a producer committedAt timestamp.
   * The same global/account slots and original source deadline still apply. */
  startPhase(scopeInput:MetadataPrefetchScope,source:PreparedMetadataSource,
    binding:MetadataPhaseBinding):PhaseMetadataPrefetchAttempt|null {
    if(!binding||!["FINAL_MARKET","WIRE_FEE"].includes(binding.phase)||
      typeof binding.intentId!=="string"||!identifier.test(binding.intentId))return null;
    return this.startScoped(scopeInput,source,binding);
  }
  private startScoped<S extends PreparedMetadataSource>(scopeInput:MetadataPrefetchScope,hintInput:S,
    phaseInput?:MetadataPhaseBinding):MetadataAttempt<S>|null {
    const at=this.wallNow(),mono=this.monotonicNow();
    if(phaseInput&&(!Number.isFinite(mono)||mono<0))return null;
    for(const [key,end] of this.seen)if(end<=at)this.seen.delete(key);
    const ages=[hintInput.btcProviderAgeMs,hintInput.btcReceiveAgeMs,hintInput.marketAgeMs];
    if(![scopeInput.accountId,scopeInput.ownerId,scopeInput.holderId,hintInput.evaluationId,hintInput.marketTicker].every(v=>typeof v==="string")||!identifier.test(scopeInput.accountId)||!identifier.test(scopeInput.ownerId)||!identifier.test(scopeInput.holderId)||
      !/^[0-9]+$/.test(scopeInput.fence)||!/^[a-f0-9]{40}$/.test(scopeInput.releaseSha)||!/^[a-f0-9]{64}$/.test(scopeInput.policyHash)||
      !identifier.test(hintInput.evaluationId)||!ticker.test(hintInput.marketTicker)||
      ![hintInput.evaluatedAtMs,at,...ages].every(Number.isSafeInteger)||ages.some(x=>x<0)||
      hintInput.evaluatedAtMs>at)return null;
    if(!phaseInput){
      const committed=hintInput as unknown as CommittedForwardSourceHint;
      if(committed.qualifyingTrigger!==true||!Number.isSafeInteger(committed.committedAtMs)||
        committed.evaluatedAtMs>committed.committedAtMs||committed.committedAtMs>at)return null;
    }
    // Conservative budget only. All existing policy/source/price clocks still run.
    const expires=hintInput.evaluatedAtMs+5_000-Math.max(...ages);
    const key=JSON.stringify(phaseInput?[scopeInput.accountId,hintInput.evaluationId,phaseInput.phase,phaseInput.intentId]:[scopeInput.accountId,hintInput.evaluationId]);
    if(expires<=at||this.accounts.has(scopeInput.accountId)||this.accounts.size>=this.limits.accounts||
      this.seen.has(key)||this.seen.size>=this.limits.seen)return null;
    const scope=Object.freeze({...scopeInput}),hint=Object.freeze({...hintInput});
    const phase=phaseInput?Object.freeze({...phaseInput}):undefined;
    this.seen.set(key,expires);
    const controller=new AbortController(),bodies=new Map<string,Body>(),captures=new Map<string,MetadataBodyCapture>();
    const requests:Promise<unknown>[]=[];
    const pendingBodies=new Map<string,Promise<Body>>();
    let failure:unknown,failed=false,consumed=false,finished=false,discarded=false,allowed=true,eventTicker:string|undefined;
    let rejectCancelled!:(e:Error)=>void;
    const cancelled=new Promise<never>((_,reject)=>{rejectCancelled=reject;});
    // Handler is attached before any fetch is launched; speculative failure never escapes.
    void cancelled.catch(()=>{});
    const fail=(e:unknown)=>{if(!failed){failed=true;failure=e;}};
    const discard=(reason="entry_metadata_prefetch_cancelled")=>{
      if(discarded)return;discarded=true;fail(error(reason));controller.abort();rejectCancelled(failure as Error);
      if(finished)this.accounts.delete(scope.accountId);
    };
    const timer=setTimeout(()=>discard("entry_metadata_prefetch_expired"),Math.min(this.limits.timeoutMs,expires-at));
    timer.unref?.();
    const fresh=(includeProviderFailure=true)=>{
      const now=this.wallNow(),elapsed=this.monotonicNow()-mono;
      if((phase&&(!Number.isFinite(now)||!Number.isFinite(elapsed)))||now<at||now>=expires||elapsed<0||elapsed>=Math.min(this.limits.timeoutMs,expires-at))discard("entry_metadata_prefetch_expired");
      if(discarded||(includeProviderFailure&&failed))throw failure;
    };
    const load=(path:string):Promise<Body>=>{
      // Consumer completion and resource completion are distinct. A transport
      // failure is observable immediately, but its slot stays held until every
      // cancellation operation we own has actually settled.
      let resolveBody!:(body:Body)=>void,rejectBody!:(error:unknown)=>void;
      const delivered=new Promise<Body>((resolve,reject)=>{resolveBody=resolve;rejectBody=reject;});
      void delivered.catch(fail);
      const task=this.schedule(controller.signal,()=>allowed,async()=>{
        fresh();const started=this.wallNow(),attempt=beginPublicMetadataRead(this.fetchImpl,path);
        let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
        const cancellations:Promise<unknown>[]=[];
        const cancelBody=(body:{cancel():Promise<unknown>}|null|undefined)=>{
          if(!body)return;
          try{const pending=body.cancel();cancellations.push(pending);void pending.catch(()=>{});}catch{/* A synchronous cancellation failure has settled. */}
        };
        const abort=()=>cancelBody(reader);
        controller.signal.addEventListener("abort",abort,{once:true});
        let status:number|undefined,failureReason="provider_request_failed";
        try{
          const response=await this.fetchImpl(ORIGIN+path,{method:"GET",redirect:"error",cache:"no-store",credentials:"omit",headers:{Accept:"application/json"},signal:controller.signal});
          status=response.status;failureReason=status!==200?"provider_http_rejected":"provider_response_invalid";attempt.response(response);
          if(controller.signal.aborted){cancelBody(response.body);throw failure;}
          const length=Number(response.headers.get("content-length")??"0");
          if(status!==200||(response.url&&response.url!==ORIGIN+path)||response.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json"||
            !Number.isSafeInteger(length)||length<0||length>256_000||!response.body){cancelBody(response.body);throw error();}
          reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
          while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>256_000)throw error();chunks.push(next.value);}
          fresh(false);if(size<2)throw error();const bytes=new Uint8Array(size);let offset=0;
          for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
          const body:unknown=JSON.parse(new TextDecoder().decode(bytes));if(!plain(body))throw error();
          const captured=this.wallNow();if(captured<started)throw error("entry_metadata_capture_clock_invalid");
          freeze(body);const capture=Object.freeze({path,requestStartedAtMs:started,capturedAtMs:captured,rawSha256:hash(bytes),normalizedSha256:hash(JSON.stringify(body))});
          fresh(false);bodies.set(path,body);captures.set(path,capture);attempt.success();resolveBody(body);return body;
        }catch(e){
          abort();const rejected=annotateFeeFailure(error("production_market_metadata_unavailable"),{phase:"provider_transport",reason:controller.signal.aborted?"provider_read_timeout":failureReason,path,httpStatus:status},e);
          rejectBody(rejected);throw rejected;
        }finally{
          controller.signal.removeEventListener("abort",abort);try{reader?.releaseLock();}catch{}
          await Promise.allSettled(cancellations);
        }
      });
      pendingBodies.set(path,delivered);requests.push(task);
      void task.catch(e=>{fail(e);rejectBody(e);});
      return delivered;
    };
    const marketPath=`/markets/${hint.marketTicker}`;
    const market=load(marketPath),series=load("/series/KXBTC15M"),changes=load("/series/fee_changes?series_ticker=KXBTC15M&show_historical=false");
    const events=market.then(async body=>{
      fresh();const row=body.market;
      if(!plain(row)||row.ticker!==hint.marketTicker||row.exchange_index!==2||typeof row.event_ticker!=="string"||!ticker.test(row.event_ticker))throw error("entry_metadata_scope_invalid");
      eventTicker=row.event_ticker;
      return Promise.all([load(`/events/${eventTicker}`),load(`/events/fee_changes?event_ticker=${eventTicker}&limit=100`)]);
    });
    const complete=Promise.all([market,series,changes,events]).then(()=>undefined).catch(e=>{fail(e);throw e;});
    void complete.catch(()=>{});

    const drained=Promise.allSettled([complete,events]).then(async()=>{await Promise.allSettled(requests);finished=true;if(discarded)this.accounts.delete(scope.accountId);});
    const attempt:MetadataAttempt<S>=Object.freeze({source:hint,drained,discard,pause:()=>{allowed=false;},
      consume:(expectedScope:MetadataPrefetchScope,source:PreparedMetadataSource,expectedPhase?:MetadataPhaseBinding)=>{
        if(consumed)throw error("entry_metadata_prefetch_already_consumed");consumed=true;
        if((phase?(expectedPhase?.phase!==phase.phase||expectedPhase?.intentId!==phase.intentId):expectedPhase!==undefined)||
          Object.keys(scope).some(k=>scope[k as keyof MetadataPrefetchScope]!==expectedScope[k as keyof MetadataPrefetchScope])||
          source.evaluationId!==hint.evaluationId||source.marketTicker!==hint.marketTicker||source.evaluatedAtMs!==hint.evaluatedAtMs||
          source.btcProviderAgeMs!==hint.btcProviderAgeMs||source.btcReceiveAgeMs!==hint.btcReceiveAgeMs||source.marketAgeMs!==hint.marketAgeMs){
          discard("entry_metadata_scope_changed");
        }
        allowed=true;this.pump();
        return Object.freeze({
          read:async(path:string)=>{
            fresh(false);
            if(!pendingBodies.has(path)){
              if(!/^\/events\/(?:KXBTC15M-[A-Za-z0-9-]+|fee_changes\?event_ticker=KXBTC15M-[A-Za-z0-9-]+&limit=100)$/.test(path))throw error("entry_metadata_scope_invalid");
              await Promise.race([market,cancelled]);
            }
            const pending=pendingBodies.get(path);
            if(!pending){if(failed)throw failure;throw error("entry_metadata_scope_invalid");}
            const body=await Promise.race([pending,cancelled]);fresh(false);return body;
          },
          capture:()=>{fresh();if(!eventTicker||captures.size!==5)throw error("entry_metadata_capture_incomplete");
            return Object.freeze({marketTicker:hint.marketTicker,eventTicker,exchangeIndex:2 as const,records:Object.freeze([...captures.values()])});},
        });
      },
    });
    this.accounts.set(scope.accountId,attempt);
    void drained.then(()=>{if(discarded)clearTimeout(timer);});
    return attempt;
  }
}
/** Dormant until explicitly injected into a local prototype session. */
export const processCommittedPublicMetadata=new CommittedPublicMetadataCoordinator();

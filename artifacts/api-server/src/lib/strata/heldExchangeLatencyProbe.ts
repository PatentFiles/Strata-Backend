import {createHash,randomUUID} from 'node:crypto';
import {pool} from '@workspace/db';
import {logger} from '../logger';
import {getScopedKalshiJson} from '../kalshiAccountClient';
import {dedicatedSignerFingerprint} from './commissioning';
import {reserveKalshiBalanceReadSlot} from './kalshiBalanceQuota';
import {readOwnedKalshiFeeds,PERSONAL_KALSHI_HOST} from './personalExchangeRead';
import {deployedGitSha} from './deployedGitSha';

type Credentials={keyId:string;privateKey:string};
type Scope={ownerId:string;accountId:string;expectedSha:string};
export type HeldSource={id:string;evaluatedAtMs:number;qualifying:boolean;btcProviderAgeMs:number;btcReceiveAgeMs:number;marketAgeMs:number};
export function heldSourceDecision(source:HeldSource|null,decisionAtMs:number){
 const age=source?decisionAtMs-source.evaluatedAtMs:null;
 const ages=source&&age!==null?[source.btcProviderAgeMs,source.btcReceiveAgeMs,source.marketAgeMs].map(v=>v+age):[];
 const valid=source!==null&&age!==null&&Number.isFinite(age)&&age>=0&&
  [source.btcProviderAgeMs,source.btcReceiveAgeMs,source.marketAgeMs].every(v=>Number.isFinite(v)&&v>=0);
 const fresh=valid&&age!==null&&age<=5000&&ages.every(v=>v<=5000);
 return {measurementKind:'HELD_PAPER_SOURCE_DIAGNOSTIC',evaluationId:source?.id??null,decisionAtMs,evaluationAgeMs:age,
  sourceToDecisionAgeMs:valid?Math.max(age!,...ages):null,maxQuoteAgeMs:5000,
  freshnessDecision:!valid?'SOURCE_UNAVAILABLE':fresh?'FRESH':'STALE',
  qualifyingSignal:source?.qualifying??false,tradingEligible:false,eligibilityReason:'ACCOUNT_HELD',
  fullEntryQualificationPerformed:false};
}
export type HeldTransportReceipt={path:string;httpStatus:number;providerRttMs:number;responseSha256:string};
/** Timing begins at transport, after quota/signing; includes response body download.
 * Only a digest survives, never account data or credential-bearing headers. */
export function heldReceiptFetch(fetcher:typeof fetch,record:(receipt:HeldTransportReceipt)=>void):typeof fetch{
 return async(input,init)=>{
  if(init?.method!=='GET')throw Error('held_probe_get_only');
  const path=new URL(String(input)).pathname;
  if(!PATHS.has(path))throw Error('held_probe_path_refused');
  const began=performance.now(),response=await fetcher(input,init);
  const bytes=await response.arrayBuffer(),providerRttMs=performance.now()-began;
  record({path,httpStatus:response.status,providerRttMs,
   responseSha256:createHash('sha256').update(Buffer.from(bytes)).digest('hex')});
  return new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
 };
}
type Sample={sample:number;dbGateMs:number;signedReadMs:number;paths:Array<{path:string;elapsedMs:number}>;
 transportReceipts:HeldTransportReceipt[];quotaWaitMs:number;sourceDecision:ReturnType<typeof heldSourceDecision>;
 ledgerReconciliationMs:null;ledgerReconciliationPerformed:false;
 signedSnapshot:{sha256:string;observedAtMs:number;orders:number;positions:number;fills:number;settlements:number;
 cashMicros:string;ledgerCashMicros:string|null;ledgerReservedMicros:string|null;cashMatchesLedger:boolean|null;
 historyCoverage:'ALL_REQUIRED_PATHS_SUCCEEDED'|'INCOMPLETE_OR_UNOBSERVED';cashMatchesExpected2500Cents:boolean}};
type Deps={sha:()=>string;held:()=>Promise<boolean>;credentials:()=>Promise<Credentials>;
 get:typeof getScopedKalshiJson;save:(sample:Sample)=>Promise<void>;pause:()=>Promise<void>;
 source?:()=>Promise<HeldSource|null>;ledgerBalance?:()=>Promise<{cashMicros:string;reservedMicros:string}|null>;transportReceipts?:()=>HeldTransportReceipt[];quotaWaitMs?:()=>number};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PATHS=new Set(['balance','orders','fills','positions','settlements'].map(x=>'/trade-api/v2/portfolio/'+x)
 .concat(['/trade-api/v2/historical/orders','/trade-api/v2/historical/fills']));

/** Diagnostics only: never imports an executor, changes approvals, or sends a mutation.
 * A held/released account is checked before every sample and before recording it.
 * Failure terminates this bounded run; there is no automatic retry or grant.
 */
export async function runHeldExchangeLatencyProbe(scope:Scope,deps:Deps){
 if(!UUID.test(scope.ownerId)||!/^strata-account-[a-f0-9]{24}$/.test(scope.accountId)||
    !/^[a-f0-9]{40}$/.test(scope.expectedSha)||deps.sha()!==scope.expectedSha)
  return {ok:false,reason:'held_probe_scope_invalid',samples:0};
 let completed=0;
 try{
  if(!await deps.held())return {ok:false,reason:'held_probe_account_not_released',samples:0};
  const creds=await deps.credentials();
  for(let sample=0;sample<5;sample++){
   const started=performance.now();
   if(!await deps.held())throw Error('held_probe_account_not_released');
   const dbGateMs=performance.now()-started,paths:Sample['paths']=[];
   const source=deps.source?await deps.source():null;
   const get:typeof getScopedKalshiJson=async(c,path,query)=>{
    if(!PATHS.has(path))throw Error('held_probe_path_refused');
    const began=performance.now();
    const result=await deps.get(c,path,query);
    paths.push({path,elapsedMs:performance.now()-began});return result;
   };
   const began=performance.now();
   const read=await readOwnedKalshiFeeds(creds,Date.now(),get);
   if(!read.ok)throw Error('held_probe_signed_read_failed');
   const signedReadMs=performance.now()-began;
   // Conservative maintenance preflight: nonempty historical inventory requires
   // explicit investigation, never an assertion that it is safe to trade.
   if(read.orders.length||read.positions.length)throw Error('held_probe_inventory_requires_review');
   if(!await deps.held())throw Error('held_probe_account_not_released');
   const sourceDecision=heldSourceDecision(source,Date.now());
   const transportReceipts=deps.transportReceipts?.()??[];
   const ledger=deps.ledgerBalance?await deps.ledgerBalance():null;
   // Fail closed if the account changes while gathering the private receipt.
   if(!await deps.held())throw Error('held_probe_account_not_released');
   await deps.save({sample,dbGateMs,signedReadMs,paths,sourceDecision,
    transportReceipts,quotaWaitMs:deps.quotaWaitMs?.()??0,
    ledgerReconciliationMs:null,ledgerReconciliationPerformed:false,
    signedSnapshot:{sha256:createHash('sha256').update(JSON.stringify(read)).digest('hex'),
     observedAtMs:read.observedAtMs,cashMicros:read.cashMicros,
     ledgerCashMicros:ledger?.cashMicros??null,ledgerReservedMicros:ledger?.reservedMicros??null,
     cashMatchesLedger:ledger?ledger.cashMicros===read.cashMicros:null,
     historyCoverage:[...PATHS].every(path=>transportReceipts.some(r=>r.path===path&&r.httpStatus===200))&&
      transportReceipts.every(r=>r.httpStatus===200)?'ALL_REQUIRED_PATHS_SUCCEEDED':'INCOMPLETE_OR_UNOBSERVED',
     orders:read.orders.length,positions:read.positions.length,fills:read.fills.length,
     settlements:read.settlements.length,cashMatchesExpected2500Cents:read.cashMicros==='25000000'}});completed++;
   if(sample<4)await deps.pause();
  }
  return {ok:true,reason:'held_signed_reads_measured_no_order_authority',samples:completed};
 }catch{return {ok:false,reason:'held_probe_incomplete_no_order_authority',samples:completed};}
}

export const HELD_PROBE_SQL=`SELECT a.id FROM public.v13_production_account a
 JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
 WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND a.subaccount=1 AND a.exchange_index=2
 AND w.state='released' AND w.arm_requested=false
 AND NOT EXISTS(SELECT 1 FROM public.v13_production_position p WHERE p.account_id=a.id AND p.quantity_hundredths>0)
 AND NOT EXISTS(SELECT 1 FROM public.v13_production_intent i WHERE i.account_id=a.id
   AND (i.terminal=false OR i.state IN ('PREPARED','DISPATCHED','UNKNOWN')))
 LIMIT 2`;

export function startHeldExchangeLatencyProbe(env:NodeJS.ProcessEnv=process.env){
 if(env.NODE_ENV!=='production'||env.STRATA_HELD_EXCHANGE_PROBE_ENABLED!=='true')return;
 const scope={ownerId:env.STRATA_HELD_EXCHANGE_PROBE_OWNER??'',accountId:env.STRATA_HELD_EXCHANGE_PROBE_ACCOUNT??'',
  expectedSha:env.STRATA_HELD_EXCHANGE_PROBE_SHA??''};
 const runId=randomUUID(),budget=AbortSignal.timeout(45_000);
 let receipts:HeldTransportReceipt[]=[],quotaWaitMs=0;
 const boundedFetch:typeof fetch=heldReceiptFetch(async(input,init)=>{
  if(init?.method!=='GET')throw Error('held_probe_get_only');
  return fetch(input,{...init,signal:AbortSignal.any([budget,AbortSignal.timeout(7_000)])});
 },receipt=>receipts.push(receipt));
 void runHeldExchangeLatencyProbe(scope,{
  sha:deployedGitSha,
  held:async()=>!budget.aborted&&(await pool.query(HELD_PROBE_SQL,[scope.accountId,scope.ownerId])).rows.length===1,
  credentials:async()=>{
   const r=await pool.query(`SELECT c.key_fingerprint,s.decrypted_secret
    FROM public.v13_production_account a JOIN private.kalshi_connection_credentials c
      ON c.owner_user_id=a.owner_user_id AND c.financial_account_id=a.kalshi_connection_id
      AND c.key_fingerprint=a.key_fingerprint
    JOIN vault.decrypted_secrets s ON s.id=c.vault_secret_id
    WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND c.role='restricted_execution'
      AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified' LIMIT 2`,
   [scope.accountId,scope.ownerId]);
   if(r.rows.length!==1)throw Error('held_probe_signer_unavailable');
   const parsed=JSON.parse(String(r.rows[0].decrypted_secret));
   const creds={keyId:parsed.api_key_id,privateKey:parsed.private_key};
   if(typeof creds.keyId!=='string'||typeof creds.privateKey!=='string'||
      dedicatedSignerFingerprint(creds.keyId,creds.privateKey)!==r.rows[0].key_fingerprint)
    throw Error('held_probe_signer_invalid');
   return creds;
  },
  ledgerBalance:async()=>{
   const r=await pool.query(`SELECT cash_micros::text,reserved_micros::text FROM public.v13_production_account
    WHERE id=$1 AND owner_user_id=$2::uuid`,[scope.accountId,scope.ownerId]);
   return r.rows.length===1?{cashMicros:r.rows[0].cash_micros,reservedMicros:r.rows[0].reserved_micros}:null;
  },
  source:async()=>{
   const r=await pool.query(`SELECT id,evaluated_at,qualifying_trigger,btc_provider_age_ms,
    btc_receive_age_ms,market_age_ms FROM public.forward_test_evaluations
    WHERE evaluation_source='paper' AND evaluated_at>=now()-interval '60 seconds'
    ORDER BY evaluated_at DESC,id DESC LIMIT 1`);
   const e=r.rows[0];return e?{id:e.id,evaluatedAtMs:new Date(e.evaluated_at).getTime(),
    qualifying:e.qualifying_trigger===true,btcProviderAgeMs:e.btc_provider_age_ms??NaN,
    btcReceiveAgeMs:e.btc_receive_age_ms??NaN,marketAgeMs:e.market_age_ms??NaN}:null;
  },
  transportReceipts:()=>{const out=receipts;receipts=[];return out},
  quotaWaitMs:()=>{const out=quotaWaitMs;quotaWaitMs=0;return out},
  get:async(creds,path,query)=>{
   if(budget.aborted)throw Error('held_probe_deadline');
   if(path==='/trade-api/v2/portfolio/balance'){const began=performance.now();
    await reserveKalshiBalanceReadSlot(creds.keyId,scope.ownerId,undefined,
    dedicatedSignerFingerprint(creds.keyId,creds.privateKey));quotaWaitMs+=performance.now()-began;}
   return getScopedKalshiJson(creds,path,query,boundedFetch,PERSONAL_KALSHI_HOST,scope.ownerId);
  },
  save:async sample=>{
   const payload={runId,releaseSha:scope.expectedSha,mode:'HELD_GET_ONLY',tradingAuthority:false,...sample};
   await pool.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
    VALUES($1,$2,'HELD_EXCHANGE_LATENCY',$3::jsonb,$4)`,[randomUUID(),scope.accountId,JSON.stringify(payload),
    createHash('sha256').update(JSON.stringify(payload)).digest('hex')]);
   // Exact cash comparison is retained only in the private diagnostic observation.
   // Never copy balances, account payloads, or raw provider bodies into runtime logs.
   const {signedSnapshot:_privateSnapshot,...publicTiming}=payload;
   logger.info(publicTiming,'Held signed exchange latency sample; no order authority');
  },
  pause:()=>new Promise(resolve=>setTimeout(resolve,1000)),
 }).then(result=>logger.info({runId,...result},'Held exchange probe finished; authorization unchanged'),
 ()=>logger.warn({runId},'Held exchange probe failed; authorization unchanged'));
}

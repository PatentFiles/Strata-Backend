import {createHash,randomUUID} from 'node:crypto';
import {pool} from '@workspace/db';
import {logger} from '../logger';
import {getScopedKalshiJson} from '../kalshiAccountClient';
import {dedicatedSignerFingerprint} from './commissioning';
import {reserveKalshiBalanceReadSlot} from './kalshiBalanceQuota';
import {deployedGitSha} from './deployedGitSha';
import {normalizePrimaryDisplayMoney} from './primaryDisplayMoney';

const HOST='https://external-api.kalshi.com';
const PATH='/trade-api/v2/portfolio/balance';
const QUERY='?subaccount=0';
type Scope={ownerId:string;accountId:string;expectedSha:string};
type Credentials={keyId:string;privateKey:string};
type Receipt={httpStatus:number;providerRttMs:number};
export const HELD_PRIMARY_SQL=`SELECT a.id FROM public.v13_production_account a
 JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
 WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND a.subaccount=1 AND a.exchange_index=2
 AND w.state='released' AND w.arm_requested=false AND a.reserved_micros=0
 AND NOT EXISTS(SELECT 1 FROM public.v13_production_position p WHERE p.account_id=a.id AND p.quantity_hundredths<>0)
 AND NOT EXISTS(SELECT 1 FROM public.v13_production_intent i WHERE i.account_id=a.id
   AND (NOT i.terminal OR i.state IN ('PREPARED','DISPATCHED','UNKNOWN') OR i.reserved_micros<>0))
 AND NOT EXISTS(SELECT 1 FROM private.strata_emergency_exit_reservations r WHERE r.execution_account_id=a.id
   AND r.state IN ('PREPARED','DISPATCHED','UNKNOWN'))`;
// Same verified role used by owner wallet display, with no legacy/fallback key.
export const PRIMARY_CREDENTIAL_SQL=`SELECT c.vault_secret_id::text,c.key_fingerprint
 FROM public.v13_production_account a
 JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id AND fa.provider='kalshi'
 JOIN private.provider_connections pc ON pc.financial_account_id=fa.id
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=fa.user_id
  AND c.financial_account_id=fa.id AND c.provider_connection_id=pc.id
 WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND c.role='account_setup_execution'
 AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified' LIMIT 2`;

export const PRIMARY_SECRET_SQL=`SELECT s.decrypted_secret FROM (${PRIMARY_CREDENTIAL_SQL}) c JOIN vault.decrypted_secrets s ON s.id=c.vault_secret_id::uuid WHERE c.vault_secret_id=$3 AND c.key_fingerprint=$4 AND EXISTS(${HELD_PRIMARY_SQL}) AND (SELECT count(*) FROM (${PRIMARY_CREDENTIAL_SQL}) candidates)=1`;

export const PRIMARY_OBSERVATION_SQL=`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
    SELECT $3,a.id,'HELD_PRIMARY_BALANCE',$4::jsonb,$5 FROM (${HELD_PRIMARY_SQL}) a
    WHERE (SELECT count(*) FROM (${PRIMARY_CREDENTIAL_SQL}) c)=1
    AND EXISTS(SELECT 1 FROM (${PRIMARY_CREDENTIAL_SQL}) c WHERE c.vault_secret_id=$6 AND c.key_fingerprint=$7)`;

/** Never retain arbitrary provider strings. Invalid values survive only as type labels. */
export function sanitizePrimaryBalance(raw:unknown){
 const row=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 const values:Record<string,string|number>={},types:Record<string,string>={};
 for(const key of ['balance_dollars','balance','portfolio_value','updated_ts']){
  if(!Object.hasOwn(row,key)){types[key]='absent';continue;}
  const v=row[key];types[key]=v===null?'null':Array.isArray(v)?'array':typeof v;
  if(key==='balance_dollars'){
   if(typeof v==='string'&&v.length<=64&&/^\d+(?:\.\d{1,6})?$/.test(v))values[key]=v;
  }else if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)values[key]=v;
 }
 return {values,types};
}
/** Single-use transport, strict live primary GET, no redirects, bounded body/deadline. */
export function primaryProbeFetch(fetcher:typeof fetch,budget:AbortSignal,record:(r:Receipt)=>void):typeof fetch{
 let used=false;
 return async(input,init)=>{
  if(used||String(input)!==HOST+PATH+QUERY||init?.method!=='GET'||init.redirect!=='manual'||init.body!=null)
   throw Error('primary_probe_transport_refused');
  used=true;budget.throwIfAborted();
  const began=performance.now();
  const response=await fetcher(input,{...init,redirect:'manual',signal:AbortSignal.any([budget,AbortSignal.timeout(7000)])});
  const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  if(reader){try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
   if(size>16384)throw Error('primary_probe_body_limit');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}}
  record({httpStatus:response.status,providerRttMs:performance.now()-began});
  return new Response(Buffer.concat(chunks),{status:response.status});
 };
}
type Sample={sanitized:ReturnType<typeof sanitizePrimaryBalance>;display:ReturnType<typeof normalizePrimaryDisplayMoney>;
 receipt:Receipt|null;observedAtMs:number;signedReadMs:number;quotaWaitMs:number;ledgerReconciliationPerformed:false;tradingAuthority:false};
type Deps={sha:()=>string;held:()=>Promise<boolean>;credentials:()=>Promise<Credentials>;sameBinding:()=>Promise<boolean>;
 reserve:(c:Credentials)=>Promise<void>;get:(c:Credentials)=>Promise<unknown>;receipt:()=>Receipt|null;save:(s:Sample)=>Promise<void>};
export async function runHeldPrimaryBalanceProbe(scope:Scope,deps:Deps){
 const result=(ok:boolean,outcome:string)=>({ok,outcome});
 const scoped=()=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(scope.ownerId)&&/^strata-account-[a-f0-9]{24}$/.test(scope.accountId)&&
  /^[a-f0-9]{40}$/.test(scope.expectedSha)&&deps.sha()===scope.expectedSha;
 try{
  if(!scoped()||!await deps.held())return result(false,'scope_or_hold_refused');
  const credentials=await deps.credentials();
  const quotaBegan=performance.now();await deps.reserve(credentials);const quotaWaitMs=performance.now()-quotaBegan;
  if(!scoped()||!await deps.held()||!await deps.sameBinding())return result(false,'scope_or_hold_refused');
  const began=performance.now(),raw=await deps.get(credentials),observedAtMs=Date.now();
  const signedReadMs=performance.now()-began;
  const sanitized=sanitizePrimaryBalance(raw),display=normalizePrimaryDisplayMoney(raw);
  if(!scoped()||!await deps.held()||!await deps.sameBinding())return result(false,'scope_or_hold_refused');
  await deps.save({sanitized,display,receipt:deps.receipt(),observedAtMs,signedReadMs,quotaWaitMs,
   ledgerReconciliationPerformed:false,tradingAuthority:false});
  return result(true,'primary_read_recorded');
 }catch{return result(false,'primary_read_incomplete');}
}
let started=false;
export function startHeldPrimaryBalanceProbe(env:NodeJS.ProcessEnv=process.env){
 if(started||env.NODE_ENV!=='production'||env.STRATA_HELD_PRIMARY_BALANCE_PROBE_ENABLED!=='true')return;
 started=true;
 const scope={ownerId:env.STRATA_HELD_EXCHANGE_PROBE_OWNER??'',accountId:env.STRATA_HELD_EXCHANGE_PROBE_ACCOUNT??'',expectedSha:env.STRATA_HELD_EXCHANGE_PROBE_SHA??''};
 const runId=randomUUID(),budget=AbortSignal.timeout(30000),params=[scope.accountId,scope.ownerId];
 let receipt:Receipt|null=null,binding:{vault_secret_id:string;key_fingerprint:string}|null=null;
 const held=async()=>{if(budget.aborted)return false;const rows=(await pool.query(HELD_PRIMARY_SQL,params)).rows;return !budget.aborted&&rows.length===1;};
 const sameBinding=async()=>{const rows=(await pool.query(PRIMARY_CREDENTIAL_SQL,params)).rows;
  return !budget.aborted&&rows.length===1&&binding!==null&&rows[0].vault_secret_id===binding.vault_secret_id&&rows[0].key_fingerprint===binding.key_fingerprint;};
 const transport=primaryProbeFetch(fetch,budget,r=>{receipt=r});
 void runHeldPrimaryBalanceProbe(scope,{
  sha:()=>deployedGitSha(env),held,sameBinding,
  credentials:async()=>{
   const rows=(await pool.query(PRIMARY_CREDENTIAL_SQL,params)).rows;
   if(rows.length!==1)throw Error('primary_probe_credential_unavailable');
   binding=rows[0];
   if(!await held()||deployedGitSha(env)!==scope.expectedSha)throw Error('primary_probe_hold_changed');
   const secrets=(await pool.query(PRIMARY_SECRET_SQL,[...params,binding!.vault_secret_id,binding!.key_fingerprint])).rows;
   if(secrets.length!==1)throw Error('primary_probe_credential_unavailable');
   const parsed=JSON.parse(String(secrets[0].decrypted_secret)),creds={keyId:parsed.api_key_id,privateKey:parsed.private_key};
   if(typeof creds.keyId!=='string'||typeof creds.privateKey!=='string'||dedicatedSignerFingerprint(creds.keyId,creds.privateKey)!==binding!.key_fingerprint)
    throw Error('primary_probe_credential_invalid');
   return creds;
  },
  reserve:async creds=>{await reserveKalshiBalanceReadSlot(creds.keyId,scope.ownerId,undefined,dedicatedSignerFingerprint(creds.keyId,creds.privateKey));},
  get:creds=>getScopedKalshiJson(creds,PATH,QUERY,transport,HOST,scope.ownerId),receipt:()=>receipt,
  save:async sample=>{
   budget.throwIfAborted();if(deployedGitSha(env)!==scope.expectedSha||!await sameBinding())throw Error('primary_probe_scope_changed');
   const payload=JSON.stringify({runId,releaseSha:scope.expectedSha,mode:'HELD_PRIMARY_GET_ONLY',...sample});
   const r=await pool.query(PRIMARY_OBSERVATION_SQL,
    [...params,randomUUID(),payload,createHash('sha256').update(payload).digest('hex'),binding!.vault_secret_id,binding!.key_fingerprint]);
   if(r.rowCount!==1)throw Error('primary_probe_hold_changed');
  },
 }).then(result=>logger.info({runId,releaseSha:/^[a-f0-9]{40}$/.test(scope.expectedSha)?scope.expectedSha:'invalid_sha',outcome:result.outcome},'Held primary diagnostic finished; authority unchanged'),
 ()=>logger.warn({runId,releaseSha:/^[a-f0-9]{40}$/.test(scope.expectedSha)?scope.expectedSha:'invalid_sha',outcome:'primary_read_incomplete'},'Held primary diagnostic finished; authority unchanged'));
}

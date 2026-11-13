import {heldLifecycleBoundedQuery} from './heldLifecycleBoundedQuery';
import {createPrivateKey,randomUUID} from 'node:crypto';
import {pool} from '@workspace/db';
import {logger} from '../logger';
import {subscribeHeldRolloverDiagnostics} from '../rolloverStrikeDiagnostics';
import {dedicatedSignerFingerprint} from './commissioning';
import {deployedGitSha} from './deployedGitSha';
import {HELD_PRIMARY_SQL} from './heldPrimaryBalanceProbe';
import {runHeldLifecycleShadowProbe} from './heldLifecycleShadowProbeCore';
import {LifecycleShadowTransport,createRsaPssSigner,nativeSocketFactory} from './lifecycleShadowTransport';
const CREDENTIAL_SQL=`SELECT c.key_fingerprint,c.vault_secret_id FROM public.v13_production_account a
 JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id AND fa.provider='kalshi'
 JOIN private.provider_connections pc ON pc.financial_account_id=fa.id
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id
 AND c.financial_account_id=a.kalshi_connection_id AND c.provider_connection_id=pc.id AND c.key_fingerprint=a.key_fingerprint
 WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND a.subaccount=1 AND a.exchange_index=2
 AND c.role='restricted_execution' AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL
 AND c.verification_reason='credential_verified' LIMIT 2`;
export const HELD_LIFECYCLE_CREDENTIAL_SQL=`WITH held AS (${HELD_PRIMARY_SQL}) SELECT c.key_fingerprint FROM (${CREDENTIAL_SQL}) c
 WHERE (SELECT count(*) FROM held)=1`;
export const HELD_LIFECYCLE_SECRET_SQL=`WITH held AS (${HELD_PRIMARY_SQL}) SELECT c.key_fingerprint,s.decrypted_secret
 FROM (${CREDENTIAL_SQL}) c JOIN vault.decrypted_secrets s ON s.id=c.vault_secret_id
 WHERE c.key_fingerprint=$3 AND (SELECT count(*) FROM held)=1 AND (SELECT count(*) FROM (${CREDENTIAL_SQL}) candidates)=1`;
let attempted=false;
/** Explicit bounded held qualification only. Disabled startup does no work. */
export function startHeldLifecycleShadowProbe(env:NodeJS.ProcessEnv=process.env):void {
 if(env.NODE_ENV!=='production'||env.STRATA_HELD_LIFECYCLE_PROBE_ENABLED!=='true'||attempted)return;
 attempted=true;
 const scope={ownerId:env.STRATA_HELD_LIFECYCLE_PROBE_OWNER??'',accountId:env.STRATA_HELD_LIFECYCLE_PROBE_ACCOUNT??'',
  expectedSha:env.STRATA_HELD_LIFECYCLE_PROBE_SHA??'',boundaryMs:Number(env.STRATA_HELD_LIFECYCLE_PROBE_BOUNDARY_MS)};
 const runId=randomUUID();
 const boundedQuery=(sql:string,values:unknown[])=>heldLifecycleBoundedQuery(()=>pool.connect(),sql,values);
 void runHeldLifecycleShadowProbe(scope,{
  now:Date.now,sha:deployedGitSha,
  checkHeld:async()=>{
   // One statement gives a consistent snapshot of hold and credential binding.
   const result=await boundedQuery(HELD_LIFECYCLE_CREDENTIAL_SQL,[scope.accountId,scope.ownerId]);
   return result.rows.length===1?{credentialBinding:String(result.rows[0].key_fingerprint)}:null;
  },
  createTransport:async(binding,observer,authorized,durationMs)=>{
   if(!authorized())throw Error('held_lifecycle_authorization_expired');
   const result=await boundedQuery(HELD_LIFECYCLE_SECRET_SQL,[scope.accountId,scope.ownerId,binding]);
   if(result.rows.length!==1||!authorized())throw Error('held_lifecycle_signer_unavailable');
   const parsed=JSON.parse(String(result.rows[0].decrypted_secret));
   if(typeof parsed.api_key_id!=='string'||typeof parsed.private_key!=='string'||dedicatedSignerFingerprint(parsed.api_key_id,parsed.private_key)!==binding)
    throw Error('held_lifecycle_signer_invalid');
   const pem=parsed.private_key.trim().replaceAll('\\n','\n').replace(/(-----BEGIN [A-Z ]+-----)\s*/,'$1\n').replace(/\s*(-----END [A-Z ]+-----)/,'\n$1');
   const socketScope={ownerId:scope.ownerId,accountId:scope.accountId,credentialBinding:binding};
   return new LifecycleShadowTransport({scope:socketScope,signer:createRsaPssSigner(socketScope,parsed.api_key_id,createPrivateKey(pem)),
    socketFactory:nativeSocketFactory,isAuthorized:authorized,observer,maxDurationMs:Math.min(durationMs,1080000),maxAttempts:6});
  },
  subscribeRest:subscribeHeldRolloverDiagnostics,pause:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  save:summary=>logger.info({runId,releaseSha:scope.expectedSha,...summary},'Held lifecycle comparison; no trading authority'),
 }).then(result=>logger.info({runId,...result},'Held lifecycle probe ended'),()=>logger.warn({runId},'Held lifecycle probe failed closed'));
}

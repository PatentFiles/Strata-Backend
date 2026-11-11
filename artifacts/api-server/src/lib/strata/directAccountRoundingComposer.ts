import {dedicatedSignerFingerprint} from './commissioning';
import {validateDirectNumberedCapabilityRecords} from './directAccountRoundingRecords';
import {currentDirectAccountRoundingEvidence,directAccountRoundingIdentity,type DirectAccountRoundingIdentity,type DirectAccountRoundingEvidence} from './directAccountRoundingEvidence';
import type {CredentialProbeMaterial} from './accountCredentialProbe';
/** Server-owned dependency boundary, never a request body or client supplied
 * callback. Registry must enforce commissioned account ownership, active reviewed
 * documentation policy and revocation; credential resolver is account-scoped.
 * Transport must authenticate to production Kalshi only, without redirection or
 * caching, with enforced request timeout/abort bounded by receipt expiry. This module performs no order calls and cannot grant policy approval.
 * No production caller is installed by this candidate. */
export type DirectRoundingOwnedDependencies={
 now:()=>number;
 readCurrentAuthority:(accountId:string)=>Promise<DirectAccountRoundingIdentity|null>;
 resolveAccountCredential:(accountId:string,role:'restricted_execution'|'verification',fingerprint:string)=>Promise<CredentialProbeMaterial|null>;
 productionSignedGet:(credential:CredentialProbeMaterial,path:'/trade-api/v2/api_keys'|'/trade-api/v2/portfolio/subaccounts/balances')=>Promise<unknown>;
};
export type DirectRoundingComposeResult={ok:true;evidence:Readonly<DirectAccountRoundingEvidence>}|{ok:false;reason:string};
/** At most two reads; concrete transport MUST enforce timeouts. No retries. Starts observation BEFORE I/O, rejects changed
 * authority after I/O, never stamps old evidence fresh at completion. Call off
 * signal path; a successful receipt does not extend five-second quote freshness. */
export async function composeDirectAccountRoundingEvidence(accountId:string,deps:DirectRoundingOwnedDependencies):Promise<DirectRoundingComposeResult>{
 const fail=(reason:string):DirectRoundingComposeResult=>({ok:false,reason});
 try{
  const authority=await deps.readCurrentAuthority(accountId);
  if(!authority||authority.accountId!==accountId)return fail('direct_authority_unavailable');
  const scope=structuredClone(authority),started=deps.now();
  const placeholder={...scope,observedAtMs:started,expiresAtMs:Math.min(started+15000,scope.authorityExpiresAtMs),balanceResponseDigest:'a'.repeat(64),keyMetadataDigest:'b'.repeat(64)};
  if(!currentDirectAccountRoundingEvidence(placeholder,scope,started))return fail('direct_authority_invalid');
  const resolvedExecution=await deps.resolveAccountCredential(accountId,'restricted_execution',scope.executionCredentialFingerprint);
  const execution=resolvedExecution?Object.freeze({keyId:resolvedExecution.keyId,privateKey:resolvedExecution.privateKey}):null;
  const resolvedVerification=await deps.resolveAccountCredential(accountId,'verification',scope.verificationCredentialFingerprint);
  const verification=resolvedVerification?Object.freeze({keyId:resolvedVerification.keyId,privateKey:resolvedVerification.privateKey}):null;
  if(!execution||!verification||dedicatedSignerFingerprint(execution.keyId,execution.privateKey)!==scope.executionCredentialFingerprint||dedicatedSignerFingerprint(verification.keyId,verification.privateKey)!==scope.verificationCredentialFingerprint||execution.keyId.trim()===verification.keyId.trim())return fail('direct_credential_binding_failed');
  const keyMetadata=await deps.productionSignedGet(verification,'/trade-api/v2/api_keys');
  const restrictedBalances=await deps.productionSignedGet(execution,'/trade-api/v2/portfolio/subaccounts/balances');
  const records=validateDirectNumberedCapabilityRecords({executionKeyId:execution.keyId,verificationKeyId:verification.keyId,keyMetadata,restrictedBalances});
  if(!records.ok)return fail(records.reason);
  const evidence={...scope,observedAtMs:started,expiresAtMs:placeholder.expiresAtMs,balanceResponseDigest:records.balanceResponseDigest,keyMetadataDigest:records.keyMetadataDigest};
  const current=await deps.readCurrentAuthority(accountId),finished=deps.now();
  if(!current||!currentDirectAccountRoundingEvidence(evidence,current,finished)||finished<started)return fail('direct_authority_changed_or_expired');
  // Explicit identity comparison documents that observations cannot alter policy.
  if(JSON.stringify(directAccountRoundingIdentity(evidence))!==JSON.stringify(directAccountRoundingIdentity({...placeholder,...current})))return fail('direct_authority_changed_or_expired');
  return {ok:true,evidence:Object.freeze(evidence)};
 }catch{return fail('direct_evidence_read_failed');}
}

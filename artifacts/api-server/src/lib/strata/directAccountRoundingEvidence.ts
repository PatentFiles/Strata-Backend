/** Candidate evidence envelope only. A structurally valid object is NOT an
 * execution capability or proof that its source was authenticated. The owned
 * reader must obtain and bind source records through its trusted transport and
 * currently reviewed account authority. Never populate this from client input.
 * No provider I/O or approval mutation happens in this module. */
export const DIRECT_ROUNDING_EVIDENCE_VERSION='KALSHI_DIRECT_NUMBERED_SUBACCOUNT_V1' as const;
export type DirectAccountRoundingIdentity={
 version:typeof DIRECT_ROUNDING_EVIDENCE_VERSION;
 accountId:string;subaccount:1;exchangeIndex:2;
 executionCredentialFingerprint:string;verificationCredentialFingerprint:string;
 documentationPolicyDigest:string;scopeGeneration:number;
 authorityIssuedAtMs:number;authorityExpiresAtMs:number;
};
export type DirectAccountRoundingEvidence=DirectAccountRoundingIdentity&{
 observedAtMs:number;expiresAtMs:number;
 balanceResponseDigest:string;keyMetadataDigest:string;
};
const identityKeys=['version','accountId','subaccount','exchangeIndex','executionCredentialFingerprint','verificationCredentialFingerprint','documentationPolicyDigest','scopeGeneration','authorityIssuedAtMs','authorityExpiresAtMs'] as const;
const evidenceKeys=[...identityKeys,'observedAtMs','expiresAtMs','balanceResponseDigest','keyMetadataDigest'];
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
/** Pure integrity/shape validation. Caller separately verifies source authority,
 * exact scope, revocation and current time. Unknown evidence cannot select the
 * direct precision model; it must use the existing non-direct fallback. */
export function validDirectAccountRoundingEvidence(value:unknown):value is DirectAccountRoundingEvidence{
 if(!record(value)||Object.keys(value).sort().join(',')!==[...evidenceKeys].sort().join(','))return false;
 if(value.version!==DIRECT_ROUNDING_EVIDENCE_VERSION||typeof value.accountId!=='string'||
 value.accountId.length<1||value.accountId.length>200||value.accountId.trim()!==value.accountId||/[\x00-\x1f\x7f]/.test(value.accountId)||
 value.subaccount!==1||value.exchangeIndex!==2||
 !hash(value.executionCredentialFingerprint)||!hash(value.verificationCredentialFingerprint)||
 value.executionCredentialFingerprint===value.verificationCredentialFingerprint||
 !hash(value.documentationPolicyDigest)||!hash(value.balanceResponseDigest)||!hash(value.keyMetadataDigest)||
 typeof value.scopeGeneration!=='number'||!Number.isSafeInteger(value.scopeGeneration)||value.scopeGeneration<1||
 !time(value.authorityIssuedAtMs)||!time(value.authorityExpiresAtMs)||
 !time(value.observedAtMs)||!time(value.expiresAtMs))return false;
 return value.authorityIssuedAtMs<=value.observedAtMs&&value.observedAtMs<value.expiresAtMs&&
 value.expiresAtMs<=value.authorityExpiresAtMs&&value.expiresAtMs-value.observedAtMs<=15000;
}
/** Stable semantic identity: renewing an observation cannot renew or replace
 * authority, or invalidate an otherwise-identical original pinned intent. */
export function directAccountRoundingIdentity(e:unknown):DirectAccountRoundingIdentity|null{
 if(!validDirectAccountRoundingEvidence(e))return null;
 return Object.fromEntries(identityKeys.map(key=>[key,e[key]])) as DirectAccountRoundingIdentity;
}
/** `scope` comes from current trusted runtime authority, never the receipt being
 * checked. This is necessary but not sufficient: caller must also check that
 * this policy remains independently reviewed and unrevoked. */
export function currentDirectAccountRoundingEvidence(value:unknown,scope:DirectAccountRoundingIdentity,nowMs:number):value is DirectAccountRoundingEvidence{
 if(!validDirectAccountRoundingEvidence(value)||!record(scope)||!time(nowMs)||nowMs<value.observedAtMs||nowMs>=value.expiresAtMs)return false;
 return identityKeys.every(key=>value[key]===scope[key]);
}

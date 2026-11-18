'use strict';
const {verifyQualificationCandidate}=require('./verify-artifact.cjs');
/** Server-only resolver, not request data. Every invocation must receive fresh
 * authenticated GitHub reads and immutable bytes from the configured loader.
 * This digest binds consent, not full recovery or deployment authority. */
function createMachineCandidateResolver(config,load,transport,clock=Date.now){
 const pin=structuredClone(config);
 function freeze(o){if(o&&typeof o==='object'){for(const v of Object.values(o))freeze(v);Object.freeze(o);}return o;}freeze(pin);
 return async function resolve(signal){
  const deny=reason=>({ok:false,reason,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false});
  try{
   if(signal?.aborted)return deny('verification_cancelled');
   const loaded=await load(signal);
   if(!Buffer.isBuffer(loaded?.policyBytes)||!Buffer.isBuffer(loaded?.archiveBytes))return deny('machine_candidate_bytes_required');
   const policyBytes=Buffer.from(loaded.policyBytes),archiveBytes=Buffer.from(loaded.archiveBytes);
   const result=await verifyQualificationCandidate(pin,policyBytes,archiveBytes,transport,clock(),clock,signal);
   if(!result.ok)return deny(result.reason);
   return {ok:true,releaseSha:result.metadata.releaseSha,evidenceDigest:result.metadata.artifactDigest.slice(7),validUntil:result.metadata.validUntil,qualificationPolicySha256:result.manifest.policySha256,consentBindingOnly:true,deployedBytesVerified:false,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false,independentHumanReview:false};
  }catch{return deny('machine_candidate_binding_unavailable');}
 };
}
module.exports={createMachineCandidateResolver};

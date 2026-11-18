'use strict';
const {createPrivateKey,createPublicKey,createHash,sign}=require('node:crypto');
const hash=b=>createHash('sha256').update(b).digest('hex');
const scopeKeys=['accountId','ownerId','requestId','revision','controlSequence','workerFence','consentEpoch','credentialFingerprint','policyHash'];
/** Server composition only. Neither dependency may be supplied by an HTTP
 * request. measureLockedRuntime must measure the actual deployed process,
 * required role/schema and every writer under the caller-held account barrier.
 * This factory does NOT manufacture that measurement or configure a key. */
function createRuntimeWitnessSigner(config,{loadSigningKey,measureLockedRuntime},clock=Date.now){
 const c=structuredClone(config);
 if(!c.runtimeWitness||typeof loadSigningKey!=='function'||typeof measureLockedRuntime!=='function')throw Error('signer_server_configuration_required');
 const w=c.runtimeWitness;
 if(!/^[a-f0-9]{64}$/.test(w.publicKeySha256)||typeof w.keyId!=='string'||!w.keyId)throw Error('signer_trust_pin_required');
 return async function signScoped(scope,tx,signal){
  const deny=reason=>({ok:false,reason,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false});
  let secret;
  try{
   const s=structuredClone(scope);
   if(!s||scopeKeys.some(k=>typeof s[k]!=='string'||!s[k])||Object.keys(s).sort().join()!==[...scopeKeys].sort().join())return deny('signer_scope_invalid');
   if(['revision','controlSequence','workerFence','consentEpoch'].some(k=>!/^\d+$/.test(s[k]))||['credentialFingerprint','policyHash'].some(k=>!/^[a-f0-9]{64}$/.test(s[k])))return deny('signer_scope_invalid');
   if(signal?.aborted)return deny('signer_cancelled');
   const began=clock();
   const m=structuredClone(await measureLockedRuntime(s,tx,signal));
   const fields=['projectId','environmentId','serviceId','deploymentId','runtimeRole','sessionRole','databaseIdentity','permissionProbeSha256','writerCoverageSha256'];
   if(fields.some(k=>typeof w[k]!=='string'||!w[k]||m?.[k]!==w[k])||m?.releaseSha!==c.releaseSha||m?.sourceTree!==c.expectedTree||m?.policySha256!==c.policySha256||m?.artifactDigest!==c.artifactDigest||JSON.stringify(m?.scope)!==JSON.stringify(s))return deny('signer_measurement_scope_mismatch');
   if(m.completeRoleSchemaCoverage!==true||m.completeWriterCoverage!==true||!Array.isArray(m.permissionFindings)||m.permissionFindings.length||!/^[a-f0-9]{64}$/.test(m.bundleManifestSha256)||m.loadedBundleManifestSha256!==m.bundleManifestSha256)return deny('signer_measurement_incomplete');
   let now=clock();
   if(!Number.isSafeInteger(began)||!Number.isSafeInteger(now)||now<began||!Number.isSafeInteger(m.observedAt)||m.observedAt<began||m.observedAt>now||now-m.observedAt>=5000)return deny('signer_measurement_stale');
   // Loader transfers ownership of a short-lived Buffer. Never log or return it.
   secret=await loadSigningKey(signal);
   if(!Buffer.isBuffer(secret)||secret.length<32||secret.length>16384)return deny('signer_key_unavailable');
   const key=createPrivateKey(secret);secret.fill(0);secret=null;
   if(key.asymmetricKeyType!=='ed25519'||hash(createPublicKey(key).export({type:'spki',format:'der'}))!==w.publicKeySha256)return deny('signer_key_pin_mismatch');
   now=clock();if(signal?.aborted||now<m.observedAt||now>=m.observedAt+5000)return deny('signer_measurement_stale');
   const a={schema:'strata.runtime-release-witness.v1',keyId:w.keyId,releaseSha:c.releaseSha,sourceTree:c.expectedTree,policySha256:c.policySha256,artifactDigest:c.artifactDigest,scope:s};
   for(const k of fields)a[k]=m[k];
   Object.assign(a,{permissionFindings:[],completeRoleSchemaCoverage:true,completeWriterCoverage:true,bundleManifestSha256:m.bundleManifestSha256,loadedBundleManifestSha256:m.loadedBundleManifestSha256,observedAt:m.observedAt,expiresAt:m.observedAt+5000});
   const witnessBytes=Buffer.from(JSON.stringify(a)),signature=sign(null,witnessBytes,key);
   return {ok:true,witnessBytes,signature,witnessDigest:hash(witnessBytes),validUntil:a.expiresAt,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false};
  }catch{return deny('signer_evidence_unavailable')}
  finally{if(Buffer.isBuffer(secret))secret.fill(0)}
 };
}
module.exports={createRuntimeWitnessSigner,scopeKeys};

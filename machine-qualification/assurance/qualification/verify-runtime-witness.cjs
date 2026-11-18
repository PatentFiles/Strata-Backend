'use strict';
const {createPublicKey,verify,createHash}=require('node:crypto');
const {verifyQualificationCandidate}=require('./verify-artifact.cjs');
const hash=b=>createHash('sha256').update(b).digest('hex');
/** Trust config is adopted outside candidate code/request bodies. The Ed25519
 * witness must be a provisioned deployed-runtime evidence service, NOT this
 * verifier or the owner browser. No private key or production certificate is
 * created here. A verified witness still does not insert/consume authority. */
async function verifyScopedReleaseAssurance(config,policyBytes,archiveBytes,witnessBytes,signature,transport,now=Date.now(),clock=Date.now,signal){
 const deny=reason=>({ok:false,reason,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false});
 try{
  const c=structuredClone(config),w=c.runtimeWitness;
  if(!w||!Buffer.isBuffer(witnessBytes)||witnessBytes.length>32768||!Buffer.isBuffer(signature)||signature.length!==64)return deny('runtime_witness_input_invalid');
  const key=createPublicKey(w.publicKeyPem);
  if(key.asymmetricKeyType!=='ed25519'||hash(key.export({type:'spki',format:'der'}))!==w.publicKeySha256||!verify(null,witnessBytes,key,signature))return deny('runtime_witness_signature_invalid');
  const a=JSON.parse(witnessBytes);
  if(a.schema!=='strata.runtime-release-witness.v1'||a.keyId!==w.keyId||a.releaseSha!==c.releaseSha||a.sourceTree!==c.expectedTree||a.policySha256!==c.policySha256||a.artifactDigest!==c.artifactDigest)return deny('runtime_witness_build_mismatch');
  const scope=['accountId','ownerId','requestId','revision','controlSequence','workerFence','consentEpoch','credentialFingerprint','policyHash'];
  if(!w.scope||scope.some(k=>typeof w.scope[k]!=='string'||!w.scope[k]||a.scope?.[k]!==w.scope[k])||Object.keys(a.scope||{}).sort().join()!==scope.sort().join())return deny('runtime_witness_scope_mismatch');
  for(const k of ['projectId','environmentId','serviceId','deploymentId','runtimeRole','sessionRole','databaseIdentity','permissionProbeSha256','writerCoverageSha256'])if(typeof w[k]!=='string'||!w[k]||a[k]!==w[k])return deny('runtime_witness_identity_mismatch');
  if(!Array.isArray(a.permissionFindings)||a.permissionFindings.length||a.completeRoleSchemaCoverage!==true||a.completeWriterCoverage!==true||a.loadedBundleManifestSha256!==a.bundleManifestSha256)return deny('runtime_witness_incomplete');
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(a.observedAt)||!Number.isSafeInteger(a.expiresAt)||a.observedAt>now||now-a.observedAt>5000||a.expiresAt<=now||a.expiresAt>a.observedAt+5000)return deny('runtime_witness_stale');
  const q=await verifyQualificationCandidate(c,policyBytes,archiveBytes,transport,now,clock,signal);if(!q.ok)return deny(q.reason);
  if(a.bundleManifestSha256!==q.manifest.bundleManifestSha256)return deny('runtime_witness_bundle_mismatch');
  const end=clock();if(signal?.aborted||!Number.isSafeInteger(end)||end<now||end>=a.expiresAt||end>=q.metadata.validUntil)return deny('runtime_witness_expired_during_verification');
  return {ok:true,kind:'SIGNED_SCOPED_RELEASE_ASSURANCE_CANDIDATE',scope:structuredClone(a.scope),releaseSha:c.releaseSha,artifactDigest:c.artifactDigest,witnessDigest:hash(witnessBytes),validUntil:Math.min(a.expiresAt,q.metadata.validUntil),issuerRepositoryId:q.metadata.repositoryId,issuerWorkflowId:q.metadata.workflowId,issuerRunId:q.metadata.runId,issuerRunAttempt:q.metadata.runAttempt,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false};
 }catch{return deny('runtime_witness_verification_failed');}
}
module.exports={verifyScopedReleaseAssurance};

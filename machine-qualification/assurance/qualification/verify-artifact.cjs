'use strict';
const cp=require('node:child_process'),path=require('node:path');const {verifyGithubBuild,sha256}=require('../verify.cjs');
/** Server-side offline candidate. Artifact buffer may be untrusted: verified
 * only against authenticated metadata + separately pinned configuration. */
async function verifyQualificationCandidate(config,policyBytes,archiveBytes,transport,now=Date.now(),clock=Date.now,signal){
 const deny=reason=>({ok:false,reason,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false});
 try{
  if(!Buffer.isBuffer(policyBytes)||policyBytes.length>65536||sha256(policyBytes)!==config.policySha256||!/^[a-f0-9]{40}$/.test(config.expectedTree)||!Buffer.isBuffer(archiveBytes)||archiveBytes.length>2097152)return deny('qualification_input_invalid');
  const policy=JSON.parse(policyBytes);if(policy.enabled!==true||policy.schema!=='strata.offline-qualification.v1')return deny('qualification_policy_disabled');
  // A matching digest authenticates bytes, not a usable behavioral policy.
  // Mirror the producer's bounded plan requirements before any external read.
  const relative=s=>typeof s==='string'&&s.length>0&&!s.includes('\\')&&!s.startsWith('/')&&s.split('/').every(x=>x&&x!=='.'&&x!=='..');
  const argvOk=x=>Array.isArray(x)&&x.length>0&&x.length<=64&&x.every(v=>typeof v==='string'&&v.length>0&&v.length<=4096&&!v.includes('\0'));
  if(!relative(policy.buildDirectory)||!argvOk(policy.build)||!Array.isArray(policy.checks)||!policy.checks.length||policy.checks.length>20||policy.checks.some(x=>!argvOk(x))||!Array.isArray(policy.sourceInputs)||!policy.sourceInputs.length||policy.sourceInputs.length>100||policy.sourceInputs.some(x=>!relative(x))||new Set(policy.sourceInputs).size!==policy.sourceInputs.length)return deny('qualification_policy_invalid');
  const meta=await verifyGithubBuild(config,transport,now,clock,signal);if(!meta.ok)return deny(meta.reason);
  if('sha256:'+sha256(archiveBytes)!==meta.artifactDigest)return deny('archive_digest_mismatch');
  if(signal?.aborted)return deny('verification_cancelled');
  const parsed=cp.spawnSync('python3',[path.join(__dirname,'read-archive.py')],{input:archiveBytes,timeout:5000,maxBuffer:1048576});
  if(parsed.error||parsed.status!==0)return deny('archive_invalid');
  const m=JSON.parse(parsed.stdout.toString('utf8'));
  if(m.schema!==policy.schema||m.kind!=='OFFLINE_QUALIFICATION_CANDIDATE'||m.source?.commit!==meta.releaseSha||m.source?.tree!==config.expectedTree||m.policySha256!==config.policySha256||['evidenceIssued','recoveryAuthorized','tradingAuthorized','independentHumanReview'].some(k=>m[k]!==false))return deny('manifest_scope_mismatch');
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const hashOk=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
  const commandOk=x=>x&&hashOk(x.stdoutSha256)&&hashOk(x.stderrSha256);
  if(!commandOk(m.build)||!same(m.build.argv,policy.build)||!Array.isArray(m.checks)||!same(m.checks.map(c=>c.argv),policy.checks)||m.checks.some(x=>!commandOk(x)))return deny('manifest_checks_mismatch');
  const safe=s=>typeof s==='string'&&!s.includes('\\')&&s.split('/').every(x=>x&&x!=='.'&&x!=='..')&&!s.startsWith('/');
  function inventoryOk(xs,max){return Array.isArray(xs)&&xs.length>0&&xs.length<=max&&new Set(xs.map(x=>x.path)).size===xs.length&&xs.every(x=>safe(x.path)&&Number.isSafeInteger(x.size)&&x.size>=0&&x.size<=16777216&&hashOk(x.sha256));}
  if(!inventoryOk(m.sourceInputs,100)||!same(m.sourceInputs.map(x=>x.path),policy.sourceInputs)||!inventoryOk(m.bundle,2000)||m.bundle.some(x=>!x.path.startsWith(policy.buildDirectory+'/'))||m.bundle.reduce((n,x)=>n+x.size,0)>104857600||sha256(JSON.stringify(m.bundle))!==m.bundleManifestSha256)return deny('manifest_inventory_invalid');
  const finished=clock();if(!Number.isSafeInteger(finished)||finished<meta.verifiedAt||finished>=meta.validUntil)return deny('qualification_expired_during_verification');
  return {ok:true,kind:'QUALIFICATION_ARTIFACT_BYTES_CANDIDATE',metadata:meta,manifest:m,deployedBytesVerified:false,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false,independentHumanReview:false};
 }catch{return deny('qualification_verification_failed');}
}
module.exports={verifyQualificationCandidate};

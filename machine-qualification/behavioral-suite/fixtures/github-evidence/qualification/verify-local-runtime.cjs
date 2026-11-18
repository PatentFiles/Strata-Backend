'use strict';
const fs=require('node:fs'),path=require('node:path');const {sha256}=require('../verify.cjs');const {verifyQualificationCandidate}=require('./verify-artifact.cjs');
/** Exact comparison to a server-selected LOCAL directory only. It does not assert
 * where bytes are deployed, which process loaded them or external dependencies. */
async function verifyLocalRuntimeCandidate(config,policyBytes,archiveBytes,localDirectory,transport,now=Date.now(),clock=Date.now,signal){
 const deny=reason=>({ok:false,reason,localBytesVerified:false,deployedBytesVerified:false,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false});
 try{
  const verified=await verifyQualificationCandidate(config,policyBytes,archiveBytes,transport,now,clock,signal);if(!verified.ok)return deny(verified.reason);
  if(typeof localDirectory!=='string'||!path.isAbsolute(localDirectory))return deny('local_directory_must_be_absolute');
  // Reject symlinks in every component, including the configured root path.
  let prefix=path.parse(localDirectory).root;for(const part of localDirectory.slice(prefix.length).split(path.sep)){if(!part)continue;prefix=path.join(prefix,part);if(fs.lstatSync(prefix).isSymbolicLink())return deny('local_symlink_rejected');}
  const policy=JSON.parse(policyBytes),root=fs.realpathSync(localDirectory);if(!fs.statSync(root).isDirectory())return deny('local_directory_invalid');
  const expected=verified.manifest.bundle.map(x=>({path:x.path.slice(policy.buildDirectory.length+1),size:x.size,sha256:x.sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  function inventory(){const actual=[];let total=0;function walk(folder,rel,depth){if(depth>32)throw Error('local_path_too_deep');for(const name of fs.readdirSync(folder).sort()){const abs=path.join(folder,name),r=rel?rel+'/'+name:name;const st=fs.lstatSync(abs);if(st.isSymbolicLink())throw Error('local_symlink_rejected');if(st.isDirectory())walk(abs,r,depth+1);else{if(!st.isFile()||st.size>16777216)throw Error('local_file_invalid');total+=st.size;if(actual.length>=2000||total>104857600)throw Error('local_bundle_oversize');const fd=fs.openSync(abs,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const before=fs.fstatSync(fd);if(!before.isFile()||before.size!==st.size)throw Error('local_file_changed');const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ino!==before.ino)throw Error('local_file_changed');actual.push({path:r,size:bytes.length,sha256:sha256(bytes)});}finally{fs.closeSync(fd);}}}}walk(root,'',0);return actual.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);}
  const actual=inventory();if(JSON.stringify(actual)!==JSON.stringify(expected))return deny('local_bundle_bytes_mismatch');
  // Re-read to detect ordinary concurrent writes. Not an atomic filesystem
  // snapshot: a compromised filesystem can still swap between observations.
  if(JSON.stringify(actual)!==JSON.stringify(inventory()))return deny('local_bundle_changed_during_comparison');
  const finished=clock();if(signal?.aborted||!Number.isSafeInteger(finished)||finished<verified.metadata.verifiedAt||finished>=verified.metadata.validUntil)return deny('local_comparison_expired');
  return {ok:true,kind:'LOCAL_ARTIFACT_BYTE_COMPARISON',localBytesVerified:true,deployedBytesVerified:false,fileCount:actual.length,bundleManifestSha256:verified.manifest.bundleManifestSha256,artifactDigest:verified.metadata.artifactDigest,releaseSha:verified.metadata.releaseSha,validUntil:verified.metadata.validUntil,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false};
 }catch(e){return deny(e?.message?.match(/^local_[a-z_]+$/)?e.message:'local_comparison_unavailable');}
}
module.exports={verifyLocalRuntimeCandidate};

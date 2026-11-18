'use strict';
const {createHash}=require('node:crypto');
const sha256=b=>createHash('sha256').update(b).digest('hex');
/** Server-only configuration. Never accept config, credentials or transport from an HTTP body.
 * This proves bounded GitHub metadata only, not test completeness or deployed runtime safety. */
async function verifyGithubBuild(config, transport=fetch, now=Date.now(), clock=Date.now, signal) {
 const deny=reason=>({ok:false,reason,recoveryAuthorized:false,tradingAuthorized:false,evidenceIssued:false,independentHumanReview:false});
 const fail=reason=>{throw new Error(reason)};
 try {
  const c=config;
  if(!c||[c.repositoryId,c.workflowId,c.runId,c.artifactId].some(id=>!Number.isSafeInteger(id)||id<=0)||typeof c.token!=='string'||!Number.isSafeInteger(c.repositoryId)||!Number.isSafeInteger(c.workflowId)||!Number.isSafeInteger(c.runId)||!Number.isSafeInteger(c.artifactId)||!Number.isSafeInteger(c.runAttempt)||c.runAttempt<1||!/^[\w.-]+\/[\w.-]+$/.test(c.repository)||!/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(c.workflowPath)||!/^([a-f0-9]{40})$/.test(c.releaseSha)||!/^([a-f0-9]{64})$/.test(c.workflowSha256)||!/^sha256:[a-f0-9]{64}$/.test(c.artifactDigest)||!c.token||!c.branch||!c.artifactName||!Array.isArray(c.requiredJobs)||!c.requiredJobs.length||c.requiredJobs.some(j=>typeof j!=='string'||!j)||!c.requiredSteps||c.requiredJobs.some(j=>!Array.isArray(c.requiredSteps[j])||!c.requiredSteps[j].length||c.requiredSteps[j].some(x=>typeof x!=='string'||!x)||new Set(c.requiredSteps[j]).size!==c.requiredSteps[j].length)||new Set(c.requiredJobs).size!==c.requiredJobs.length||!Number.isSafeInteger(c.maxAgeMs)||c.maxAgeMs<=0||c.maxAgeMs>86400000||!Number.isSafeInteger(now)) return deny('trusted_configuration_invalid');
  let lastObserved=now;
  const observedTime=()=>{const t=clock();if(!Number.isSafeInteger(t)||t<lastObserved)fail('verification_clock_invalid');lastObserved=t;return t;};
  let calls=0;
  const get=async path=>{
   if(signal?.aborted)fail('verification_cancelled');
   if(++calls>6)fail('request_budget_exceeded');
   const r=await transport('https://api.github.com'+path,{method:'GET',redirect:'error',headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+c.token,'X-GitHub-Api-Version':'2022-11-28'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
   if(!r.ok)fail('github_read_unavailable');
   if(!r.body)fail('github_body_missing'); const reader=r.body.getReader(); let size=0; const chunks=[];
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576)fail('github_response_too_large');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
   try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{fail('github_response_invalid')}
  };
  const prefix='/repos/'+c.repository;
  const repo=await get(prefix);
  if(repo.id!==c.repositoryId||repo.full_name!==c.repository||repo.archived||repo.disabled)fail('repository_mismatch');
  const run=await get(prefix+'/actions/runs/'+c.runId);
  const created=Date.parse(run.created_at),updated=Date.parse(run.updated_at),started=Date.parse(run.run_started_at);
  if(run.repository?.id!==c.repositoryId||run.path!==c.workflowPath||run.id!==c.runId||run.workflow_id!==c.workflowId||run.run_attempt!==c.runAttempt||run.head_sha!==c.releaseSha||run.head_repository?.id!==c.repositoryId||run.head_branch!==c.branch||!['push','workflow_dispatch'].includes(run.event)||run.status!=='completed'||run.conclusion!=='success'||!Number.isFinite(created)||!Number.isFinite(updated)||!Number.isFinite(started)||started<created||started>updated||created>updated||updated>now||now-updated>c.maxAgeMs)fail('run_scope_or_status_invalid');
  if(Array.isArray(run.pull_requests)&&run.pull_requests.length)fail('pull_request_run_not_release');
  const wf=await get(prefix+'/contents/'+c.workflowPath+'?ref='+c.releaseSha);
  if(wf.path!==c.workflowPath||wf.type!=='file'||wf.encoding!=='base64'||typeof wf.content!=='string'||!Number.isSafeInteger(wf.size)||wf.size<=0||wf.size>262144||Buffer.from(wf.content,'base64').length!==wf.size||sha256(Buffer.from(wf.content,'base64'))!==c.workflowSha256)fail('workflow_content_mismatch');
  const jobs=await get(prefix+'/actions/runs/'+c.runId+'/attempts/'+c.runAttempt+'/jobs?per_page=100');
  if(!Array.isArray(jobs.jobs)||!Number.isSafeInteger(jobs.total_count)||jobs.total_count!==jobs.jobs.length||jobs.total_count>100)fail('jobs_incomplete');
  for(const j of jobs.jobs)if(j.run_id!==c.runId||j.run_attempt!==c.runAttempt||j.head_sha!==c.releaseSha||j.status!=='completed'||j.conclusion!=='success')fail('job_scope_or_status_invalid');
  for(const name of c.requiredJobs){const matches=jobs.jobs.filter(j=>j.name===name);if(matches.length!==1)fail('required_job_missing_or_duplicate');for(const step of c.requiredSteps[name]){const steps=matches[0].steps?.filter(s=>s.name===step);if(!steps||steps.length!==1||steps[0].status!=='completed'||steps[0].conclusion!=='success')fail('required_step_missing_or_failed');}}
  const artifacts=await get(prefix+'/actions/runs/'+c.runId+'/artifacts?per_page=100');
  if(!Array.isArray(artifacts.artifacts)||artifacts.total_count!==artifacts.artifacts.length||artifacts.total_count>100)fail('artifacts_incomplete');
  const matches=artifacts.artifacts.filter(a=>a.name===c.artifactName);
  const a=matches[0];
  const artifactObservedAt=observedTime();
  if(matches.length!==1||a.id!==c.artifactId||a.expired!==false||!Number.isFinite(Date.parse(a.expires_at))||Date.parse(a.expires_at)<=artifactObservedAt||a.digest!==c.artifactDigest||a.workflow_run?.id!==c.runId||a.workflow_run?.head_sha!==c.releaseSha||a.workflow_run?.repository_id!==c.repositoryId)fail('artifact_scope_or_digest_invalid');
  // Creation time is a necessary temporal proxy, not cryptographic attempt provenance.
  const artifactCreated=Date.parse(a.created_at);
  if(!Number.isFinite(artifactCreated)||artifactCreated<started||artifactCreated>artifactObservedAt)fail('artifact_creation_outside_attempt');
  const finalRun=await get(prefix+'/actions/runs/'+c.runId);
  for(const key of ['id','workflow_id','run_attempt','head_sha','head_branch','event','path','status','conclusion','created_at','updated_at','run_started_at'])if(finalRun[key]!==run[key])fail('run_changed_during_verification');
  const completedAt=observedTime();
  if(finalRun.repository?.id!==c.repositoryId||finalRun.head_repository?.id!==c.repositoryId||completedAt-updated>=c.maxAgeMs||Date.parse(a.expires_at)<=completedAt)fail('evidence_stale_at_completion');
  return {ok:true,kind:'GITHUB_BUILD_METADATA',repositoryId:c.repositoryId,workflowId:c.workflowId,runId:c.runId,runAttempt:c.runAttempt,releaseSha:c.releaseSha,workflowSha256:c.workflowSha256,artifactId:c.artifactId,artifactDigest:c.artifactDigest,verifiedAt:completedAt,validUntil:Math.min(updated+c.maxAgeMs,Date.parse(a.expires_at)),recoveryAuthorized:false,tradingAuthorized:false,evidenceIssued:false,independentHumanReview:false};
 } catch(e) { return deny(e?.message?.match(/^[a-z_]+$/)?e.message:'github_verification_unavailable'); }
}
module.exports={verifyGithubBuild,sha256};

'use strict';
// Offline candidate. Invoke ONLY from an approved pinned workflow with an
// independently pinned policy digest. Never expose these arguments as an API.
const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');const {createHash}=require('node:crypto');
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=m=>{throw Error(m)};
function produce({root,policyPath,trustedPolicyDigest,expectedCommit,expectedTree}){
 const bytes=fs.readFileSync(policyPath);
 if(!/^[a-f0-9]{64}$/.test(trustedPolicyDigest)||hash(bytes)!==trustedPolicyDigest)fail('untrusted_policy');
 const p=JSON.parse(bytes);root=fs.realpathSync(root);
 const relative=s=>typeof s==='string'&&s.length>0&&!path.isAbsolute(s)&&s.split(/[\\/]/).every(x=>x&&x!=='.'&&x!=='..');
 if(p.schema!=='strata.offline-qualification.v1'||p.enabled!==true||!relative(p.buildDirectory)||!Array.isArray(p.checks)||!p.checks.length||p.checks.length>20||!Array.isArray(p.build)||!p.build.length||!Array.isArray(p.sourceInputs)||!p.sourceInputs.length||p.sourceInputs.length>100||p.sourceInputs.some(x=>!relative(x)))fail('policy_invalid');
 function run(argv){if(!Array.isArray(argv)||!argv.length||argv.some(x=>typeof x!=='string'||!x))fail('command_invalid');const r=cp.spawnSync(argv[0],argv.slice(1),{cwd:root,encoding:null,timeout:120000,maxBuffer:1048576,shell:false,env:{PATH:process.env.PATH,HOME:process.env.HOME,CI:'true',LANG:'C.UTF-8',EXPECTED_COMMIT:expectedCommit,EXPECTED_TREE:expectedTree}});if(r.error||r.status!==0)fail('command_failed');return {argv,stdoutSha256:hash(r.stdout||''),stderrSha256:hash(r.stderr||'')};}
 function git(...args){return run(['git',...args]);}
 function gitText(...args){const r=cp.execFileSync('git',args,{cwd:root,timeout:10000,maxBuffer:1048576,encoding:'utf8'});return r.trim();}
 function source(){const commit=gitText('rev-parse','HEAD'),tree=gitText('rev-parse','HEAD^{tree}');if(commit!==expectedCommit||tree!==expectedTree||!/^[a-f0-9]{40}$/.test(commit)||!/^[a-f0-9]{40}$/.test(tree)||gitText('status','--porcelain','--untracked-files=all'))fail('source_not_exact_clean_commit');return {commit,tree};}
 function safeFile(rel){if(!relative(rel))fail('unsafe_path');let at=root;for(const part of rel.split('/')){at=path.join(at,part);if(fs.lstatSync(at).isSymbolicLink())fail('symlink_rejected');}const s=fs.statSync(at);if(!s.isFile()||s.size>16777216)fail('file_invalid_or_oversize');return {path:rel,size:s.size,sha256:hash(fs.readFileSync(at))};}
 const src=source();const inputs=p.sourceInputs.map(safeFile);for(const i of inputs)git('ls-files','--error-unmatch','--',i.path);
 const built=run(p.build);
 function inventory(){const list=[];let total=0;function walk(rel){if(rel.split('/').length>32)fail('bundle_path_too_deep');let at=root;for(const part of rel.split('/')){at=path.join(at,part);if(fs.lstatSync(at).isSymbolicLink())fail('symlink_rejected');}const abs=path.join(root,rel);const st=fs.lstatSync(abs);if(st.isSymbolicLink())fail('symlink_rejected');if(st.isDirectory()){for(const name of fs.readdirSync(abs).sort())walk(rel+'/'+name);}else{const f=safeFile(rel);total+=f.size;if(list.length>=2000||total>104857600)fail('bundle_oversize');list.push(f);}}walk(p.buildDirectory);if(!list.length)fail('bundle_empty');return list;}
 const bundle=inventory();const checks=p.checks.map(run);const after=inventory();if(JSON.stringify(bundle)!==JSON.stringify(after))fail('bundle_changed_during_checks');source();if(JSON.stringify(inputs)!==JSON.stringify(p.sourceInputs.map(safeFile)))fail('inputs_changed');
 return {schema:p.schema,kind:'OFFLINE_QUALIFICATION_CANDIDATE',source:src,policySha256:trustedPolicyDigest,sourceInputs:inputs,build:built,checks,bundle,bundleManifestSha256:hash(JSON.stringify(bundle)),evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false,independentHumanReview:false};
}
module.exports={produce,hash};
if(require.main===module){try{const [root,policyPath]=process.argv.slice(2);const result=produce({root,policyPath,trustedPolicyDigest:process.env.TRUSTED_POLICY_SHA256,expectedCommit:process.env.EXPECTED_COMMIT,expectedTree:process.env.EXPECTED_TREE});process.stdout.write(JSON.stringify(result,null,2)+'\n');}catch{process.stderr.write('qualification_candidate_failed\n');process.exitCode=1;}}

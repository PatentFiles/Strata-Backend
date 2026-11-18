'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const sha256=b=>require('node:crypto').createHash('sha256').update(b).digest('hex');
const modules=['index','pino-file','pino-pretty','pino-worker','thread-stream-worker'];
function inspectStrataBundle(directory,expected){
 const fail=reason=>({ok:false,reason,behavioralQualification:false,evidenceIssued:false,tradingAuthorized:false});
 try{
  const names=fs.readdirSync(directory).sort(),wanted=[...modules.flatMap(n=>[n+'.mjs',n+'.mjs.map']),'official-fee-schedule.pdf'].sort();
  if(JSON.stringify(names)!==JSON.stringify(wanted))return fail('release_file_set_mismatch');
  for(const name of names){const s=fs.lstatSync(path.join(directory,name));if(!s.isFile()||s.isSymbolicLink()||s.size>16777216)return fail('release_file_invalid');}
  const fee=fs.readFileSync(path.join(directory,'official-fee-schedule.pdf'));
  if(fee.length!==281129||sha256(fee)!=='c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601')return fail('fee_asset_mismatch');
  const index=fs.readFileSync(path.join(directory,'index.mjs'),'utf8');
  const identities=[...index.matchAll(/define_BTC_RELEASE_default\s*=\s*\{\s*revision:\s*"([^"]+)",\s*tree:\s*"([^"]+)",\s*dirty:\s*(true|false),\s*provenance:\s*"([^"]+)"\s*\}/g)];
  if(identities.length!==1||identities[0][3]!=='false'||identities[0][4]!=='git-at-build'||!/^([a-f0-9]{40})$/.test(identities[0][1])||!/^([a-f0-9]{40})$/.test(identities[0][2]))return fail('exact_clean_build_identity_unavailable');
  if(!expected||identities[0][1]!==expected.commit||identities[0][2]!==expected.tree)return fail('build_identity_mismatch');
  for(const m of modules){const result=cp.spawnSync(process.execPath,['--check',path.join(directory,m+'.mjs')],{timeout:10000,maxBuffer:65536,env:{PATH:process.env.PATH,HOME:process.env.HOME}});if(result.error||result.status!==0)return fail('compiled_module_syntax_invalid');const map=JSON.parse(fs.readFileSync(path.join(directory,m+'.mjs.map'),'utf8'));if(map.version!==3||!Array.isArray(map.sources))return fail('source_map_invalid');}
  return {ok:true,kind:'STRATA_BUNDLE_STRUCTURE_AND_SYNTAX',fileCount:names.length,commit:expected.commit,tree:expected.tree,behavioralQualification:false,deployedBytesVerified:false,evidenceIssued:false,tradingAuthorized:false};
 }catch{return fail('release_inspection_unavailable');}
}
module.exports={inspectStrataBundle};
if(require.main===module){const result=inspectStrataBundle(process.argv[2],{commit:process.env.EXPECTED_COMMIT,tree:process.env.EXPECTED_TREE});console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;}

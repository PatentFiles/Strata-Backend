import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname,delimiter,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const output=join(root,'docs/platform-fee-native/local-evidence');mkdirSync(output,{recursive:true});
const env={};
for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC'])if(process.env[key])env[key]=process.env[key];
env.PATH=dirname(process.execPath)+delimiter+(env.PATH||env.Path||'');
const bash=process.env.BASH_BIN||(process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash');
function run(command,args,options={}){
 const r=spawnSync(command,args,{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:600000,maxBuffer:32*1024*1024,...options});
 if(r.status!==0)throw Error(`${command} failed: ${r.error?.message||r.stderr||r.stdout}`);
 return r.stdout.trim();
}
run('docker',['info','--format','{{.OSType}}']);
const results=[];
for(const major of [16,17]){
 run('docker',['pull',`postgres:${major}`]);
 for(const scenario of ['fresh','upgrade']){
  const token=randomBytes(32).toString('hex');let container;
  try{
   container=run('docker',['run','--detach','--network','none','--label',`strata.native-fee-run=${token}`,
    '-e','POSTGRES_PASSWORD=disposable_ci_only','-e','POSTGRES_DB=strata_platform_fee_disposable',`postgres:${major}`]);
   assert.match(container,/^[a-f0-9]{64}$/);
   for(let attempt=0;;attempt++){
    const ready=spawnSync('docker',['exec',container,'pg_isready','-U','postgres','-d','strata_platform_fee_disposable'],{env,stdio:'ignore',windowsHide:true,timeout:5000});
    if(ready.status===0)break;
    if(attempt===59)throw Error('disposable_postgres_startup_timeout');
    await new Promise(ok=>setTimeout(ok,500));
   }
   const r=spawnSync(bash,['docs/platform-fee-native/run.sh'],{cwd:root,env:{...env,STRATA_NATIVE_FEE_RUN:token,TEST_CONTAINER:container,TEST_PG_MAJOR:String(major),TEST_SCENARIO:scenario},encoding:'utf8',windowsHide:true,timeout:600000,maxBuffer:32*1024*1024});
   writeFileSync(join(output,`pg${major}-${scenario}.log`),r.stdout+'\n'+r.stderr);
   assert.equal(r.status,0,`PostgreSQL ${major} ${scenario}: inspect local-evidence log`);
   results.push({postgres:major,scenario,status:'PASS'});console.log(`PASS PostgreSQL ${major} ${scenario}`);
  }finally{
   if(container){
    assert.equal(run('docker',['inspect','--format','{{ index .Config.Labels "strata.native-fee-run" }}',container]),token);
    run('docker',['rm','--force',container]);
   }
  }
 }
}
writeFileSync(join(output,'results.json'),JSON.stringify({head:run('git',['rev-parse','HEAD']),results},null,2));

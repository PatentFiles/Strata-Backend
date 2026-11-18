'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process'),{pathToFileURL}=require('node:url'),{createHash}=require('node:crypto');
const launcher=path.join(__dirname,'strict-measured-launch.mjs'),sha=x=>createHash('sha256').update(x).digest('hex');
function run(files,entry='main.mjs',change={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'strata-strict-'));
 try{
  const sources={};for(const [name,source]of Object.entries(files)){const f=path.join(dir,name);fs.writeFileSync(f,source);sources[pathToFileURL(f).href]=sha(source);}
  for(const [name,source]of Object.entries(change))fs.writeFileSync(path.join(dir,name),source);
  const manifest=path.join(dir,'manifest.json');fs.writeFileSync(manifest,JSON.stringify({schema:'strata.strict-launch.v1',entry:pathToFileURL(path.join(dir,entry)).href,sources}));
  return spawnSync(process.execPath,['--permission',`--allow-fs-read=${dir}`,`--allow-fs-read=${__dirname}`,'--disallow-code-generation-from-strings',launcher,manifest],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
const deny=r=>{assert.notEqual(r.status,0);assert.doesNotMatch(r.stdout,/UNMEASURED_EXECUTED/);};
test('strict real launch pins both ESM and CJS dependencies',()=>{const r=run({'main.mjs':"import x from './dep.cjs';console.log(x)",'dep.cjs':"module.exports='MEASURED_CJS';"});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/MEASURED_CJS/);});
test('strict real CJS entry pins require dependencies',()=>{const r=run({'main.cjs':"console.log(require('./dep.cjs'))",'dep.cjs':"module.exports='MEASURED_CJS';"},'main.cjs');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/MEASURED_CJS/);});
test('changed CJS rejected before execution',()=>deny(run({'main.cjs':"require('./dep.cjs')",'dep.cjs':'module.exports=1;'},'main.cjs',{'dep.cjs':"console.log('UNMEASURED_EXECUTED')"})));
test('worker override denied, not merely inherited',()=>{const r=run({'main.mjs':"import {Worker} from 'node:worker_threads';new Worker(\"console.log('UNMEASURED_EXECUTED')\",{eval:true,execArgv:[]});"});deny(r);assert.match(r.stderr,/execution_boundary_denied/);});
test('CJS native addon and subprocess paths refused',()=>{for(const s of ["require('node:child_process').execSync('echo UNMEASURED_EXECUTED')","process.dlopen(module,'/tmp/not-an-addon.node')","require('node:vm').runInThisContext(\"console.log('UNMEASURED_EXECUTED')\")"]){const r=run({'main.cjs':s},'main.cjs');deny(r);assert.match(r.stderr,/execution_boundary_denied|ERR_DLOPEN_DISABLED/);}});
test('alternate module-hook registration entry point refused',()=>{const r=run({'main.cjs':"process.getBuiltinModule('module').registerHooks({});console.log('UNMEASURED_EXECUTED')"},'main.cjs');deny(r);assert.match(r.stderr,/execution_boundary_denied/);});
test('dynamic string execution refused',()=>{const r=run({'main.cjs':"eval(\"console.log('UNMEASURED_EXECUTED')\")"},'main.cjs');deny(r);assert.match(r.stderr,/Code generation from strings disallowed/);});

test('CJS constructor cannot replace hooks or compile unpinned bytes',()=>{for(const code of ["module.constructor.registerHooks({});console.log('UNMEASURED_EXECUTED')","module._compile(\"console.log('UNMEASURED_EXECUTED')\",__filename)"]){const r=run({'main.cjs':code},'main.cjs');deny(r);assert.match(r.stderr,/strict_launch_(execution_boundary_denied|cjs_compile_mismatch)/);}});

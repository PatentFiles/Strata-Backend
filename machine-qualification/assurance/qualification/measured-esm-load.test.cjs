'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const sha=x=>createHash('sha256').update(x).digest('hex');
async function factory(source='export const x=1',emit=()=>{}){const {createMeasuredEsmLoad}=await import('./measured-esm-load.mjs');return createMeasuredEsmLoad({sources:{'file:///app/index.mjs':sha(source)},emit});}
test('hashes exact returned loader bytes and retains no mutable view',async()=>{const source=Buffer.from('export const x=1'),events=[],load=await factory(source,e=>events.push(e));const r=await load('file:///app/index.mjs',{},async()=>({format:'module',source,shortCircuit:true}));source.fill(0);assert.equal(r.source.toString(),'export const x=1');assert.equal(events[0].sha256,sha(r.source));assert.equal(events[0].completeRuntimeClosure,false);});
test('refuses altered bytes before returning to engine',async()=>{const load=await factory();await assert.rejects(load('file:///app/index.mjs',{},async()=>({format:'module',source:'changed'})),/source_mismatch/);});
test('refuses unlisted dynamic dependency',async()=>{const load=await factory();await assert.rejects(load('file:///app/dependency.mjs',{},async()=>({format:'module',source:'export const x=1'})),/unpinned/);});
test('refuses CJS and native/unobservable loads',async()=>{const load=await factory();for(const format of ['commonjs','addon','json'])await assert.rejects(load('file:///app/index.mjs',{},async()=>({format,source:null})),/unobservable/);});
test('does not treat Node builtins as application source',async()=>{const load=await factory(),r={format:'builtin',source:null};assert.equal(await load('node:fs',{},async()=>r),r);});
test('emit failure prevents execution instead of losing measurement',async()=>{const load=await factory(undefined,()=>{throw Error('audit_failed')});await assert.rejects(load('file:///app/index.mjs',{},async()=>({format:'module',source:'export const x=1'})),/audit_failed/);});
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{pathToFileURL}=require('node:url'),{spawnSync}=require('node:child_process');
function nativeCase({tamper=false,unlisted=false,worker=false,cjs=false,workerOverride=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'strata-measured-load-'));
 try{
  const entry=path.join(dir,'main.mjs'),dep=path.join(dir,cjs?'dep.cjs':'dep.mjs'),log=path.join(dir,'events.jsonl'),loader=path.join(dir,'loader.mjs'),workerPath=path.join(dir,'worker.mjs');
  const depSource=cjs?'module.exports = 7;':'export default 7;';
  const main=worker?"import {Worker} from 'node:worker_threads';const w=new Worker(new URL('./worker.mjs',import.meta.url),WORKER_OPTIONS);w.on('message',x=>console.log(x));w.on('error',e=>{console.error(e);process.exitCode=1;});":`import x from './${path.basename(dep)}';console.log('executed:'+x);`;
  const workerSource="import {parentPort} from 'node:worker_threads';parentPort.postMessage('worker-executed');";
  const actualMain=main.replace('WORKER_OPTIONS',workerOverride?' {execArgv:[]} ':'{}');
  fs.writeFileSync(entry,actualMain);fs.writeFileSync(dep,tamper?'export default 99;':depSource);fs.writeFileSync(workerPath,workerSource);
  const sources={[pathToFileURL(entry).href]:sha(actualMain)};
  if(!unlisted)sources[pathToFileURL(dep).href]=sha(depSource);
  if(worker)sources[pathToFileURL(workerPath).href]=sha(workerSource);
  fs.writeFileSync(loader,`import {createMeasuredEsmLoad} from ${JSON.stringify(pathToFileURL(path.join(__dirname,'measured-esm-load.mjs')).href)};import {appendFileSync} from 'node:fs';export const load=createMeasuredEsmLoad({sources:${JSON.stringify(sources)},emit:e=>appendFileSync(${JSON.stringify(log)},JSON.stringify(e)+'\\n')});`);
  const r=spawnSync(process.execPath,['--no-warnings','--experimental-loader',pathToFileURL(loader).href,entry],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});
  return {...r,events:fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse):[]};
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('real Node process executes measured ESM dependency bytes',()=>{const r=nativeCase();assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/executed:7/);assert.equal(r.events.length,2);});
test('real Node refuses changed and unpinned dependency before effect',()=>{for(const opts of [{tamper:true},{unlisted:true},{cjs:true}]){const r=nativeCase(opts);assert.notEqual(r.status,0);assert.doesNotMatch(r.stdout,/executed:/);assert.match(r.stderr,/measured_loader_/);}});
test('real inherited-loader worker observes worker source',()=>{const r=nativeCase({worker:true});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/worker-executed/);assert.ok(r.events.some(e=>e.url.endsWith('/worker.mjs')));});

test('worker override demonstrates explicitly unproved closure',()=>{const r=nativeCase({worker:true,workerOverride:true});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/worker-executed/);assert.equal(r.events.some(e=>e.url.endsWith('/worker.mjs')),false);assert.ok(r.events.every(e=>e.completeRuntimeClosure===false));});

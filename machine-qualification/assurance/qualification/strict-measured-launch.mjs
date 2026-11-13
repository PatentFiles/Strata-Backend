import {readFileSync,realpathSync} from 'node:fs';
import Module,{registerHooks,createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
// Nonproduction strict-launch candidate. Not an adversarial sandbox or a
// provider-signed attestation. It intentionally refuses worker/native/CJS
// escape paths rather than marking unobserved execution as measured.
if(Number(process.versions.node.split('.')[0])<24||!process.permission||!process.execArgv.includes('--permission'))throw Error('strict_launch_node_permission_required');
for(const capability of ['worker','child','addons'])if(process.permission.has(capability))throw Error('strict_launch_capability_must_be_denied');
if(process.env.NODE_OPTIONS||process.env.NODE_PATH)throw Error('strict_launch_external_loader_configuration');
if(process.execArgv.some(x=>/^(--(?:import|require|loader|experimental-loader|inspect|allow-worker|allow-child-process|allow-addons|permission-audit))(?:=|$)/.test(x)))throw Error('strict_launch_unqualified_startup_flag');
if(!process.execArgv.includes('--disallow-code-generation-from-strings'))throw Error('strict_launch_dynamic_code_must_be_denied');
const filename=process.argv[2];if(!filename||!path.isAbsolute(filename))throw Error('strict_launch_manifest_absolute_required');
const raw=readFileSync(filename);if(raw.length>1048576)throw Error('strict_launch_manifest_oversize');
const manifest=JSON.parse(raw);if(manifest.schema!=='strata.strict-launch.v1'||typeof manifest.sources!=='object'||!manifest.sources||Array.isArray(manifest.sources)||typeof manifest.entry!=='string')throw Error('strict_launch_manifest_invalid');
const pins=new Map(Object.entries(manifest.sources));if(pins.size<1||pins.size>2000||!pins.has(manifest.entry))throw Error('strict_launch_pins_invalid');
for(const [url,hash]of pins){const u=new URL(url);if(u.protocol!=='file:'||u.hostname||u.search||u.hash||!/^[a-f0-9]{64}$/.test(hash))throw Error('strict_launch_pin_invalid');if(realpathSync(fileURLToPath(u))!==fileURLToPath(u))throw Error('strict_launch_symlink_rejected');}
const forbidden=new Set(['module','worker_threads','child_process','cluster','vm','inspector','inspector/promises']);
const builtinName=s=>s.startsWith('node:')?s.slice(5):s;
let loaded=0,total=0;
registerHooks({
 resolve(specifier,context,next){if(forbidden.has(builtinName(specifier)))throw Error('strict_launch_execution_boundary_denied');return next(specifier,context);},
 load(url,context,next){
  const result=next(url,context);
  if(result.format==='builtin'){if(forbidden.has(builtinName(url)))throw Error('strict_launch_execution_boundary_denied');return result;}
  if(!pins.has(url))throw Error('strict_launch_unpinned_source');
  if(!['module','commonjs','json'].includes(result.format))throw Error('strict_launch_unobservable_format');
  // Sync hooks also govern createRequire/CJS. For a null CJS source, provide
  // the exact pinned bytes to Node ourselves rather than hashing after load.
  const raw=result.source??readFileSync(fileURLToPath(url));
  const bytes=typeof raw==='string'?Buffer.from(raw):Buffer.from(raw);
  if(++loaded>2000||bytes.length>16777216||(total+=bytes.length)>104857600)throw Error('strict_launch_budget_exceeded');
  if(createHash('sha256').update(bytes).digest('hex')!==pins.get(url))throw Error('strict_launch_source_mismatch');
  return {...result,source:bytes};
 }
});
// getBuiltinModule bypasses JS resolve hooks. Remove only this alternate
// builtin entry point; never claim the hook is a malicious-code sandbox.
const getBuiltin=process.getBuiltinModule.bind(process);
Object.defineProperty(process,'getBuiltinModule',{configurable:false,writable:false,value:name=>{if(forbidden.has(builtinName(name)))throw Error('strict_launch_execution_boundary_denied');return getBuiltin(name);}});
// CJS exposes its constructor even when importing 'module' is denied.
// Close that concrete hook-replacement path as well.
const denied=()=>{throw Error('strict_launch_execution_boundary_denied');};
for(const name of ['registerHooks','register'])Object.defineProperty(Module,name,{configurable:false,writable:false,value:denied});
const originalCompile=Module.prototype._compile;
Object.defineProperty(Module.prototype,'_compile',{configurable:false,writable:false,value:function(content,filename,...rest){
 const key=pathToFileURL(filename).href;
 if(!pins.has(key)||typeof content!=='string'||createHash('sha256').update(content).digest('hex')!==pins.get(key))throw Error('strict_launch_cjs_compile_mismatch');
 return originalCompile.call(this,content,filename,...rest);
}});
Object.freeze(Module._extensions);
for(const name of ['_load','_resolveFilename'])Object.defineProperty(Module,name,{configurable:false,writable:false,value:Module[name]});
const entry=fileURLToPath(manifest.entry);
if(entry.endsWith('.cjs'))createRequire(import.meta.url)(entry);else await import(pathToFileURL(entry).href);

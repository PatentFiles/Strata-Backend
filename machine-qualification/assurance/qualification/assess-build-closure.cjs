'use strict';
const {isBuiltin}=require('node:module');
/** Build-metadata diagnostic, NOT a deployment or loaded-module attestation.
 * Feed the exact esbuild metafile from the qualified build, not a hand-written
 * list of configured externals (many configured externals are never imported).
 */
function assessBuildClosure(bytes){
 const base={deployedBytesVerified:false,loadedBytesVerified:false,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false};
 try{
  if(!Buffer.isBuffer(bytes)||bytes.length>4194304)throw Error('build_metadata_size_invalid');
  const m=JSON.parse(bytes),outputs=m.outputs;
  if(!outputs||Array.isArray(outputs)||typeof outputs!=='object'||!Object.keys(outputs).length||Object.keys(outputs).length>2000)throw Error('build_outputs_invalid');
  const external=new Set(),unresolved=new Set();let count=0;
  for(const [name,o] of Object.entries(outputs)){
   if(!name||!o||!Number.isSafeInteger(o.bytes)||o.bytes<0||!Array.isArray(o.imports)||o.imports.length>2000)throw Error('build_output_invalid');
   for(const i of o.imports){
    if(++count>20000||typeof i.path!=='string'||!i.path||typeof i.kind!=='string')throw Error('build_import_invalid');
    if(i.external){if(!isBuiltin(i.path))external.add(i.path);}
    else if(!Object.hasOwn(outputs,i.path))unresolved.add(i.path);
   }
  }
  return {...base,ok:true,kind:'BUILD_IMPORT_CLOSURE_DIAGNOSTIC',externalImports:[...external].sort(),unresolvedOutputImports:[...unresolved].sort(),
   // Metafiles cannot establish dynamic require, native side loads, process
   // flags, worker identity or an authenticated deployment. Never infer true.
   completeRuntimeClosure:false,requiresRuntimeLoaderInventory:true};
 }catch(e){return {...base,ok:false,reason:/^build_[a-z_]+$/.test(e.message)?e.message:'build_metadata_invalid'};}
}
module.exports={assessBuildClosure};

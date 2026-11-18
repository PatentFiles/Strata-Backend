import {createHash} from 'node:crypto';
/** Verifies the exact ESM source returned to Node, not a later disk reread.
 * Server/launcher-selected manifest only. This is NOT a sandbox: CJS loaders,
 * vm/eval, native code, subprocesses and worker overrides need separate proof.
 * Therefore a successful observation cannot issue release authority.
 */
export function createMeasuredEsmLoad({sources,emit,maxSourceBytes=16777216,maxTotalBytes=104857600}){
 if(!sources||typeof sources!=='object'||Array.isArray(sources)||Object.keys(sources).length<1||Object.keys(sources).length>2000||typeof emit!=='function')throw Error('measured_loader_configuration_invalid');
 if(!Number.isSafeInteger(maxSourceBytes)||maxSourceBytes<1||maxSourceBytes>16777216||!Number.isSafeInteger(maxTotalBytes)||maxTotalBytes<1||maxTotalBytes>104857600)throw Error('measured_loader_bounds_invalid');
 const pins=new Map(Object.entries(sources));
 for(const [url,hash] of pins){if(!url.startsWith('file:')||!/^([a-f0-9]{64})$/.test(hash))throw Error('measured_loader_pin_invalid');const u=new URL(url);if(u.search||u.hash||u.hostname)throw Error('measured_loader_url_invalid');}
 let bytes=0,loads=0;
 return async function load(url,context,nextLoad){
  const result=await nextLoad(url,context);
  if(result.format==='builtin'&&url.startsWith('node:'))return result;
  if(++loads>2000)throw Error('measured_loader_load_limit');
  // Node can load commonjs without returning its source. Never hash the
  // pathname and pretend it is the byte stream that Node actually executes.
  if(result.format!=='module'||result.source===null||result.source===undefined)throw Error('measured_loader_source_unobservable');
  if(!pins.has(url))throw Error('measured_loader_unpinned_source');
  const source=typeof result.source==='string'?Buffer.from(result.source):result.source instanceof ArrayBuffer?Buffer.from(result.source):ArrayBuffer.isView(result.source)?Buffer.from(result.source.buffer,result.source.byteOffset,result.source.byteLength):null;
  if(!source||source.length>maxSourceBytes||(bytes+=source.length)>maxTotalBytes)throw Error('measured_loader_size_limit');
  const observed=Buffer.from(source);
  const sha256=createHash('sha256').update(observed).digest('hex');
  if(sha256!==pins.get(url))throw Error('measured_loader_source_mismatch');
  // Copy the observed bytes: subsequent mutation of a shared view cannot
  // cause Node to execute different bytes after the digest check.
  await emit(Object.freeze({schema:'strata.esm-source-observation.v1',url,sha256,size:observed.length,format:'module',completeRuntimeClosure:false,deployedBytesVerified:false,evidenceIssued:false}));
  return {...result,source:observed};
 };
}

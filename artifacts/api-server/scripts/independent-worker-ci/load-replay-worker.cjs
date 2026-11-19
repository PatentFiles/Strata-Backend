'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {runInNewContext}=require('node:vm');
const {transformSync}=require('esbuild');
const root=path.join(__dirname,'../../src/lib/v13-production');
const allowed=new Set(['./independentWorkerPgAssembly','./independentWorkerReplay','./worker','./directIndependentPgReplay','./directHeldPgReplay']);
function assembly(env={NODE_ENV:'test'}){
  const loaded=new Map();
  const poison=p=>new Proxy(Object.create(null),{get(){throw Error('live capability unavailable: '+p)}});
  const load=p=>{
    if(p==='node:crypto')return require(p);
    // Imports from the original production class exist, but the replay
    // execution cannot inspect or call any of those live dependencies.
    if(!allowed.has(p))return poison(p);
    if(loaded.has(p))return loaded.get(p).exports;
    const mod={exports:{}};loaded.set(p,mod);
    const file=path.join(root,p+'.ts');
    const c=transformSync(fs.readFileSync(file,'utf8'),{loader:'ts',format:'cjs',target:'node24'});
    runInNewContext(c.code,{module:mod,exports:mod.exports,require:load,
      process:Object.freeze({env:Object.freeze({...env})}),Date,Buffer,structuredClone,
      fetch:()=>{throw Error('no network')}},
      {filename:file});
    return mod.exports;
  };
  return load('./independentWorkerPgAssembly').wireIndependentPgReplay;
}
module.exports={assembly};

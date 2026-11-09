import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const api=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function childEnvironment(path,home,fence){
 return {PATH:path,HOME:home,NODE_ENV:'test',TZ:'UTC',PGTZ:'UTC',
  DATABASE_URL:'postgresql://offline:offline@127.0.0.1:1/offline',
  NODE_PATH:join(api,'node_modules'),NODE_OPTIONS:`--require=${JSON.stringify(fence)}`};
}
export const networkFence=`
'use strict';
let attempts=0;
const deny=()=>{attempts++;throw Error('UNKNOWN_RECOVERY_NETWORK_FORBIDDEN');};
for(const [name,methods] of [['node:net',['connect','createConnection']],['node:tls',['connect']],
 ['node:http',['get','request']],['node:https',['get','request']],['node:dns',['lookup','resolve']]]){
 const mod=require(name);for(const method of methods)mod[method]=deny;
}
require('node:net').Socket.prototype.connect=deny;
require('node:net').Server.prototype.listen=deny;
globalThis.fetch=deny;
process.on('exit',()=>{process.stderr.write('unknown_recovery_network_attempts='+attempts+'\\n');if(attempts)process.exitCode=1;});
`;
export const offlineTests=[
 'src/lib/strata/ownerUnknownRecoveryPlan.test.ts',
 'src/lib/strata/ownerUnknownRecoveryFence.test.ts',
 'src/lib/strata/ownerUnknownRecoveryHeld.test.ts',
 'src/lib/strata/ownerUnknownRecoveryService.test.ts',
 'src/lib/strata/ownerUnknownRecoverySchema.test.ts',
 'src/routes/ownerUnknownRecoveryRouter.test.ts',
 'src/lib/strata/ownerSignedExchangeReleaseProof.test.ts',
 'src/lib/strata/ownerStaleLeaseRecovery.test.ts',
 'src/lib/strata/personalFillTimestamp.test.ts',
];
export function main(args=process.argv.slice(2)){
 if(args.length)throw Error('usage: run-owner-unknown-recovery.mjs');
 const root=mkdtempSync(join(tmpdir(),'owner-unknown-offline-'));
 const fence=join(root,'network-fence.cjs');writeFileSync(fence,networkFence);
 const env=childEnvironment(process.env.PATH,process.env.HOME,fence);
 function run(command,args){
  const r=spawnSync(command,args,{cwd:api,env,stdio:'inherit',timeout:180000});
  if(r.error||r.status!==0)throw Error('owner_unknown_offline_command_failed',{cause:r.error});
 }
 try{
  const options={entryPoints:offlineTests,bundle:true,platform:'node',format:'cjs',outbase:'src',
   outdir:root,outExtension:{'.js':'.cjs'},external:['pg-native','pdfjs-dist','pino','pino-pretty','express']};
  run(process.execPath,['--eval',`require(${JSON.stringify(join(api,'node_modules/esbuild'))}).buildSync(JSON.parse(process.argv[1]));`,JSON.stringify(options)]);
  run(process.execPath,['--test',...offlineTests.map(p=>join(root,p.replace(/^src\//,'').replace(/\.ts$/,'.cjs')))]);
 }finally{rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();

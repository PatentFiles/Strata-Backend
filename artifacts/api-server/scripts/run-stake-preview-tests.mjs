import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
// Staging-only, credential-free qualification. No supplied DB URL or live flags survive.
const api=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dir=mkdtempSync(join(tmpdir(),'strata-stake-preview-'));
const env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',TZ:'UTC',
 NODE_PATH:join(api,'node_modules'),DATABASE_URL:'postgres://fixture:fixture@127.0.0.1:1/never_connect'};
const entries=['src/lib/entryBudgetChoice.test.ts','src/lib/entryBudgetFundingLimits.test.ts',
 'src/lib/entryBudgetFinalFence.test.ts','src/lib/strata/referenceStakeLadder.test.ts',
 'src/routes/walletEntryBudgetPreviewRouter.test.ts'];
try {
 const fence=join(dir,'network-fence.cjs');
 writeFileSync(fence,`const net=require('node:net'),connect=net.Socket.prototype.connect;
 net.Socket.prototype.connect=function(...args){let o=args[0];if(Array.isArray(o))o=o[0];
 const host=typeof o==='object'?(o.host||o.hostname):typeof args[1]==='string'?args[1]:'localhost';
 if(typeof o==='object'&&o.path)throw Error('staging_external_socket_forbidden');
 if(host&&!['127.0.0.1','::1','localhost'].includes(host))throw Error('staging_external_network_forbidden');
 return connect.apply(this,args);};
 const fetch=globalThis.fetch;globalThis.fetch=(...args)=>{const u=new URL(typeof args[0]==='string'||args[0] instanceof URL?args[0]:args[0].url);
 if(!['127.0.0.1','[::1]','localhost'].includes(u.hostname))throw Error('staging_external_fetch_forbidden');return fetch(...args);};`);
 const files=[];
 for(let i=0;i<entries.length;i++){
  const outfile=join(dir,i+'.cjs');
  await build({absWorkingDir:api,entryPoints:[entries[i]],bundle:true,platform:'node',format:'cjs',outfile,
   external:['pg-native','pdfjs-dist','pdfjs-dist/*','pino','pino-pretty','express']});files.push(outfile);
 }
 const result=spawnSync(process.execPath,['--require',fence,'--test',...files],{cwd:api,env,stdio:'inherit',timeout:120000});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error('stake_preview_tests_failed:'+result.status);
} finally {rmSync(dir,{recursive:true,force:true});}

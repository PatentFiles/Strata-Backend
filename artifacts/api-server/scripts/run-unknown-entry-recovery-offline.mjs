import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const api=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const root=mkdtempSync(join(tmpdir(),'strata-entry-recovery-offline-'));
const entries=['strata/boundedUnknownEntryRecovery','strata/unknownEntryRecoveryHold','strata/boundedUnknownEntryReadRunner',
 'strata/ownedProductionKalshiRead','strata/heldProtectiveMarketFee','strata/unknownEntryRecoveryAbort','v13-production/heldSessionSchedulerIntegration','v13-production/workerUnknownEntryRecovery','v13-production/heldReconciliationFence',
 'v13-production/reconciliationReceiptLink','v13-production/workerProtectiveRecovery','v13-production/workerTechnicalRenewalDebt',
 'v13-production/workerSignalWake','strata/personalExecution','strata/personalExchangeReadCoverage','strata/personalFillTimestamp'];
try{
 const fence=join(root,'offline.cjs');
 writeFileSync(fence,"require('node:net').Socket.prototype.connect=function(){throw Error('entry_recovery_test_socket_denied');};globalThis.fetch=()=>{throw Error('entry_recovery_test_fetch_denied');};");
 await build({entryPoints:entries.map(p=>join(api,'src/lib',p+'.test.ts')),bundle:true,platform:'node',format:'cjs',outdir:root,
  outbase:join(api,'src/lib'),outExtension:{'.js':'.cjs'},external:['pg-native','pino','pino-pretty','pdfjs-dist']});
 const result=spawnSync(process.execPath,['--test',...entries.map(p=>join(root,p+'.test.cjs')),join(api,'scripts/held-recovery-disabled-supervisor.test.mjs')],{
  cwd:api,stdio:'inherit',timeout:90000,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',
   NODE_PATH:join(api,'node_modules'),DATABASE_URL:'postgresql://unused:unused@127.0.0.1:1/unused',NODE_OPTIONS:`--require=${fence}`}});
 if(result.status!==0)throw Error(`entry_recovery_offline_tests_failed:${result.status}`);
}finally{rmSync(root,{recursive:true,force:true});}

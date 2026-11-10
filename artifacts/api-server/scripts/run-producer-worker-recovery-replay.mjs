import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Fixed entry lists; no user-supplied paths, database URLs or connected fallback.
const args=process.argv.slice(2);
if(args.length>1||(args.length===1&&args[0]!=='--with-regressions'))throw Error('unsupported_replay_argument');
const api=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const repo=resolve(api,'../..');
const temporary=mkdtempSync(join(tmpdir(),'strata-timing-recovery-replay-'));
const regressionEntries=[
 'forwardTransactionTiming','forwardCycleDiagnostics',
 'v13-production/workerSignalWake','v13-production/workerPublicMetadataPrefetch',
 'v13-production/executorStageTiming','v13-production/entryQuoteEvidence',
 'v13-production/workerUnknownEntryRecovery','v13-production/workerProtectiveRecovery',
 'strata/entryWireClock','strata/boundedUnknownEntryRecovery',
 'strata/boundedUnknownEntryReadRunner','strata/unknownEntryRecoveryHold',
 'strata/workerUncertainOrderGate','strata/protectiveExitSourceFreshness',
];
const entries=['v13-production/producerWorkerRecoveryReplay','v13-production/workerLifecycle',...(args.length?regressionEntries:[])];
try{
 const fence=join(temporary,'offline.cjs');
 writeFileSync(fence,`
 const deny=()=>{throw Error('timing_recovery_replay_external_io_denied');};
 require('node:net').Socket.prototype.connect=deny;
 require('node:tls').connect=deny;
 require('node:dgram').createSocket=deny;
 require('node:http').request=deny;require('node:http').get=deny;
 require('node:https').request=deny;require('node:https').get=deny;
 globalThis.fetch=deny;
 `);
 await build({entryPoints:entries.map(p=>join(api,'src/lib',p+'.test.ts')),
  bundle:true,platform:'node',format:'cjs',outdir:temporary,outbase:join(api,'src/lib'),
  outExtension:{'.js':'.cjs'},external:['pg-native','pino','pino-pretty','pdfjs-dist'],
  alias:{'@workspace/db/schema':join(repo,'lib/db/src/schema/index.ts'),
   '@workspace/db/pool-checkout-timing':join(repo,'lib/db/src/poolCheckoutTiming.ts'),
   '@workspace/db':join(repo,'lib/db/src/index.ts'),
   '@workspace/v13-strategy':join(repo,'lib/v13-strategy/src/index.ts'),
   '@workspace/api-zod':join(repo,'lib/api-zod/src/index.ts')}});
 const result=spawnSync(process.execPath,['--unhandled-rejections=strict','--require',fence,'--test',
  ...entries.map(p=>join(temporary,p+'.test.cjs')),
  join(api,'scripts/producer-worker-recovery-replay-fence.test.mjs')],{
  cwd:api,stdio:'inherit',timeout:90000,
  env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',TZ:'UTC',
   NODE_PATH:join(api,'node_modules'),DATABASE_URL:'postgresql://unused:unused@127.0.0.1:1/unused'}});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error(`timing_recovery_replay_failed:${result.status}:${result.signal??'no_signal'}`);
}finally{rmSync(temporary,{recursive:true,force:true});}

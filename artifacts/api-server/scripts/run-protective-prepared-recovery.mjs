import {buildSync} from 'esbuild';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// CMD groups do not create a subshell: `(cd ../.. && node ...)` changes the
// working directory of later commands. Give each child an explicit directory
// so both original protective-recovery suites run on Windows and POSIX alike.
const api=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(api,'../..');
for(const name of ['ownerFeeEmergencyExitReserve','ownerFeeEmergencyExitUnknownCommit']){
 const out=path.join(api,'dist',name+'.test.cjs');
 buildSync({entryPoints:[path.join(api,'src/lib/strata',name+'.test.ts')],outfile:out,
  bundle:true,platform:'node',format:'cjs',external:['pg-native','pdfjs-dist','pino','pino-pretty']});
 const result=spawnSync(process.execPath,['--test',out],{cwd:root,env:process.env,stdio:'inherit',timeout:120000});
 if(result.status!==0)throw Error('protective_prepared_recovery_test_failed');
}

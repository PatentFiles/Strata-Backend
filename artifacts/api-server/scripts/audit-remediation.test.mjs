import {buildSync} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {mkdirSync,rmSync,mkdtempSync,readdirSync} from 'node:fs';
import path from 'node:path';
const root=process.cwd();mkdirSync('dist',{recursive:true});const out=mkdtempSync(path.join(root,'dist/audit-tests-'));
try{
 buildSync({entryPoints:['src/lib/strata/runtimeAuthRelation.test.ts','src/lib/runtimeShutdown.test.ts','src/lib/v13-production/boundedAnalyticsQueue.test.ts','../../lib/db/src/poolConfig.test.ts'],outdir:out,outbase:path.resolve('../..'),bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},logLevel:'silent'});
 const collect=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?collect(path.join(dir,e.name)):[path.join(dir,e.name)]);
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(?:PATH|Path|SystemRoot|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|COMSPEC)$/.test(key)));
 const tests=[...collect(out),'../../scripts/build-metadata.test.mjs','../../scripts/release-change-scope.test.mjs'];
 const result=spawnSync(process.execPath,['--test',...tests],{cwd:root,env:{...env,NODE_ENV:'test'},stdio:'inherit',timeout:120000});
 if(result.status!==0)throw Error('audit_remediation_tests_failed');
}finally{rmSync(out,{recursive:true,force:true});}

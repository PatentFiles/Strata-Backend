import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
// This runner never inherits database URLs, venue credentials or live flags.
const api=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dir=mkdtempSync(join(tmpdir(),'strata-economic-')),socket=join(dir,'socket'),data=join(dir,'pg'),out=join(dir,'out');
const native=process.argv.includes('--native');let pg='',started=false;
const env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',TZ:'UTC',NODE_PATH:join(api,'node_modules'),PGUSER:'postgres'};
const run=(cmd,args,extra={})=>{const r=spawnSync(cmd,args,{cwd:api,env:{...env,...extra},stdio:'inherit',timeout:180000});if(r.status!==0)throw Error(`economic_test_command_failed:${cmd}:${r.status}`);};
const bundle=(entry,file)=>run(join(api,'node_modules/.bin/esbuild'),[entry,'--bundle','--platform=node','--format=cjs',`--outfile=${file}`,'--external:pg-native','--external:pdfjs-dist','--external:pino','--external:pino-pretty','--external:express']);
try{
 mkdirSync(out);const fence=join(dir,'network-fence.cjs');writeFileSync(fence,`
 const net=require('node:net'),connect=net.Socket.prototype.connect;
 net.Socket.prototype.connect=function(...args){let o=args[0];if(Array.isArray(o))o=o[0];
 const host=typeof o==='object'?(o.host||o.hostname):typeof args[1]==='string'?args[1]:'localhost';
 const path=typeof o==='object'?o.path:null;if(path&&!path.startsWith(${JSON.stringify(socket+'/')}))throw Error('economic_external_socket_forbidden');
 if(!path&&host&&!['127.0.0.1','::1','localhost'].includes(host))throw Error('economic_external_network_forbidden');
 return connect.apply(this,args);};
 const fetch=globalThis.fetch;globalThis.fetch=(...args)=>{const url=new URL(typeof args[0]==='string'||args[0] instanceof URL?args[0]:args[0].url);
 if(!['127.0.0.1','[::1]','localhost'].includes(url.hostname))throw Error('economic_external_fetch_forbidden');return fetch(...args);};
 `);env.NODE_OPTIONS=`--require=${fence}`;
 if(native){
  const version=process.env.STRATA_ECONOMIC_PG_VERSION;
  if(version&&!/^(16|17)$/.test(version))throw Error('test_pg_version_invalid');
  if(version)pg=`/usr/lib/postgresql/${version}/bin`;else {const roots=readdirSync('/usr/lib/postgresql').filter(v=>/^(16|17)$/.test(v)).sort().reverse();pg=`/usr/lib/postgresql/${roots[0]}/bin`;}
  if(!existsSync(join(pg,'initdb')))throw Error('isolated_postgres_binary_missing');
  mkdirSync(socket);run(join(pg,'initdb'),['-D',data,'-U','postgres','-A','trust','--no-locale']);
  writeFileSync(join(data,'postgresql.auto.conf'),`listen_addresses = ''\nunix_socket_directories = '${socket}'\nport = 5544\n`);
  run(join(pg,'pg_ctl'),['-D',data,'-l',join(dir,'pg.log'),'start']);started=true;
  run(join(pg,'createdb'),['-h',socket,'-p','5544','-U','postgres','strata_economic_fixture']);
  const file=join(out,'native.cjs');bundle('src/lib/strata/ownerEconomicSettlement.native.ts',file);
  run(process.execPath,['--test',file],{DATABASE_URL:`postgresql:///strata_economic_fixture?host=${encodeURIComponent(socket)}&port=5544&user=postgres`,STRATA_ISOLATED_ECONOMIC_TEST:'1',STRATA_ECONOMIC_SOCKET:socket});
 }else{
  const entries=['src/lib/strata/ownerEconomicSettlementProof.test.ts','src/routes/ownerEconomicSettlementRoute.test.ts'];
  const files=entries.map((p,i)=>{const f=join(out,`${i}.cjs`);bundle(p,f);return f;});
  run(process.execPath,['--test',...files],{DATABASE_URL:'postgres://fixture:fixture@127.0.0.1:1/never_connect'});
 }
}finally{
 if(started)spawnSync(join(pg,'pg_ctl'),['-D',data,'-m','immediate','stop'],{env,stdio:'ignore',timeout:10000});
 rmSync(dir,{recursive:true,force:true});
}
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
const api=resolve(dirname(fileURLToPath(import.meta.url)),".."),root=mkdtempSync(join(tmpdir(),"strata-prefetch-unit-"));
const stub=join(root,"db-stub.ts"),fence=join(root,"offline.cjs");
writeFileSync(stub,`const blocked=()=>{throw Error("prefetch_unit_database_io_forbidden")}; export const pool={query:blocked,connect:blocked};export const db=new Proxy({},{get:blocked});export const microLiveFeeVerificationTable=new Proxy({},{get:blocked});export const microLiveConfigTable=new Proxy({},{get:blocked});`);
writeFileSync(fence,`require("node:net").Socket.prototype.connect=function(){throw Error("prefetch_unit_socket_io_forbidden")};globalThis.fetch=async()=>{throw Error("prefetch_unit_external_fetch_forbidden")};`);
const tests=["strata/committedPublicMetadata","strata/metadataCapture","strata/entryMetadataSnapshot","strata/twoSourceFeeEvidence","strata/ownedMarketFeeMetadata","strata/gatherReadOnlyMarketEvidence","v13-production/workerPublicMetadataPrefetch","v13-production/workerSignalWake","v13-production/workerTechnicalRenewalDebt","v13-production/executorStageTiming"];
const env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:"test",NODE_PATH:join(api,"node_modules"),NODE_OPTIONS:`--require=${fence}`};
function run(cmd,args){const result=spawnSync(cmd,args,{cwd:api,env,stdio:"inherit",timeout:120000});if(result.status!==0)throw Error(`prefetch_unit_command_failed:${result.status}`);}
try{
 run(join(api,"node_modules/.bin/esbuild"),[...tests.map(t=>`src/lib/${t}.test.ts`),"--bundle","--platform=node","--format=cjs",`--outdir=${root}/out`,`--outbase=src/lib`,"--out-extension:.js=.cjs",`--alias:@workspace/db=${stub}`,`--alias:@workspace/db/pool-checkout-timing=${join(api,"../../lib/db/src/poolCheckoutTiming.ts")}`,"--external:pg-native","--external:pdfjs-dist","--external:pino","--external:pino-pretty"]);
 run(process.execPath,["--test",...tests.map(t=>`${root}/out/${t}.test.cjs`)]);
}finally{rmSync(root,{recursive:true,force:true});}

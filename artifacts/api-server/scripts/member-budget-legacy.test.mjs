import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {build} from 'esbuild';
const root=process.cwd();mkdirSync('dist',{recursive:true});const dir=mkdtempSync(path.join(root,'dist/member-legacy-'));
const entries={trading:'kalshiTradingClient',funding:'kalshiPairFundingClient',subaccounts:'microLiveSubaccountCreation',pairKeys:'generatePairRestrictedKalshiKey',keys:'generateRestrictedKalshiKey',recovery:'verifyProvisioningRecovery',rounding:'strata/directRoundingTransport'};
const contents=Object.entries(entries).map(([alias,file])=>`export * as ${alias} from './src/lib/${file}';`).join('\n')+`\nexport {pool as testPool} from '@workspace/db';`;
await build({stdin:{contents,resolveDir:root,loader:'ts'},outfile:path.join(dir,'bundle.cjs'),bundle:true,platform:'node',format:'cjs',external:['pg-native','pino','pino-pretty','pdfjs-dist'],plugins:[{name:'private-reader-test-exports',setup(b){b.onLoad({filter:/\/(kalshiTradingClient|kalshiPairFundingClient|generatePairRestrictedKalshiKey|verifyProvisioningRecovery)\.ts$/},args=>{let s=readFileSync(args.path,'utf8');if(args.path.endsWith('/kalshiTradingClient.ts')){s=s.replace('const signed = signature(creds, method, path.split', 'globalThis.__memberTicketSignDelay?.();const signed = signature(creds, method, path.split');return {contents:s,loader:'ts',resolveDir:path.dirname(args.path)};}s+=args.path.endsWith('/kalshiPairFundingClient.ts')?'\nexport {signedGet as testSignedGet};':args.path.endsWith('/generatePairRestrictedKalshiKey.ts')?'\nexport {request as testRequest};':'\nexport {read as testRead};';return {contents:s,loader:'ts',resolveDir:path.dirname(args.path)};});}}],logLevel:'silent'});
const modules=createRequire(import.meta.url)(path.join(dir,'bundle.cjs'));
const previous=process.env.STRATA_MEMBER_READ_BUDGET;
const originalFetch=globalThis.fetch;let networkCalls=0;globalThis.fetch=async()=>{networkCalls++;throw Error("synthetic_network_blocked");};
const calls=[
 ['funding GET',()=>modules.funding.testSignedGet('/trade-api/v2/portfolio/balance','',{keyId:'invalid',privateKey:'invalid'})],
 ['funding Read POST',()=>modules.funding.postOneShotPairFunding('fixture')],
 ['subaccount GET',()=>modules.subaccounts.signedProvisioningRequest(async()=>{throw Error('network');},'GET','/trade-api/v2/api_keys')],
 ['subaccount Read POST',()=>modules.subaccounts.signedProvisioningRequest(async()=>{throw Error('network');},'POST','/trade-api/v2/portfolio/subaccounts')],
 ['pair key GET',()=>modules.pairKeys.testRequest('verifier','GET','/trade-api/v2/api_keys')],
 ['pair key Read POST',()=>modules.pairKeys.testRequest('provisioning','POST','/trade-api/v2/api_keys/generate')],
 ['standalone key Read POST',()=>modules.keys.generateRestrictedKalshiKey()],
 ['recovery GET',()=>modules.recovery.testRead({},'/trade-api/v2/portfolio/orders')],
];
for(const [label,call] of calls)test(label+' refuses before signature/network only when enabled',async()=>{
 process.env.STRATA_MEMBER_READ_BUDGET='experimental_v1';networkCalls=0;
 await assert.rejects(call,/^Error: kalshi_member_budget_transport_unsupported$/);assert.equal(networkCalls,0);
 delete process.env.STRATA_MEMBER_READ_BUDGET;
 await assert.rejects(call,error=>!String(error).includes('kalshi_member_budget_transport_unsupported'));
});
test('legacy trading admission is GET-only, production order-only transports untouched',()=>{
 const s=readFileSync('src/lib/kalshiTradingClient.ts','utf8');assert.match(s,/if\(method === "GET" && baseUrl\(\)==="https:\/\/external-api.kalshi.com" && memberReadBudgetEnabled\(\)\)\{\s+readTicket=await reserveMemberRead/);
 for(const file of ['v13-production/transport.ts','strata/accountProductionSession.ts','strata/ownerFeeEmergencyExitSignedDispatch.ts'])assert.doesNotMatch(readFileSync('src/lib/'+file,'utf8'),/assertMemberBudgetUnsupported|reserveMemberRead/);
});
test('mapped trading and precision GETs debit exact costs before real signing; unavailable binding sends nothing',async()=>{
 const privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'}).toString();
 const env={STRATA_MEMBER_READ_BUDGET:'experimental_v1',STRATA_MEMBER_BUDGET_OWNER_ID:'11111111-1111-4111-8111-111111111111',STRATA_MEMBER_BUDGET_ACCOUNT_ID:'fixture-account',STRATA_MEMBER_BUDGET_CONNECTION_ID:'22222222-2222-4222-8222-222222222222',KALSHI_BOT_SUBACCOUNT:'1',KALSHI_API_ENVIRONMENT:'production',KALSHI_API_KEY_ID:'fixture-key',KALSHI_API_PRIVATE_KEY:privateKey,MICRO_LIVE_ACCOUNT_MODE:'exclusive'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 const originalQuery=modules.testPool.query;let admitted=true,expectedCost=2,queries=0,sends=0;
 modules.testPool.query=async(sql,args)=>{queries++;assert.equal(args[5],expectedCost);assert.match(args[3],/^[a-f0-9]{64}$/);return {rows:[{admitted,binding_verified:admitted}]};};
 const synthetic=async(url,init)=>{sends++;assert.equal(init.method,'GET');assert.ok(init.headers['KALSHI-ACCESS-SIGNATURE']);return new Response('{}',{headers:{'content-type':'application/json'}});};
 try{
  const client=modules.trading.createKalshiTradingClient({fetchImpl:synthetic,verifySubaccount:async()=>true});
  // Response intentionally lacks order fields; transport admission/signing is
  // the tested boundary, not fabricated exchange order success.
  await assert.rejects(()=>client.getOrder('fixture-order'));assert.equal(sends,1);assert.equal(queries,1);
  expectedCost=10;await modules.rounding.createDirectRoundingTransport({fetch:synthetic})({keyId:'fixture-key',privateKey},'/trade-api/v2/api_keys');assert.equal(sends,2);assert.equal(queries,2);
  const stall=()=>{const started=performance.now();while(performance.now()-started<550){}};
  globalThis.__memberTicketSignDelay=stall;expectedCost=2;
  await assert.rejects(()=>client.getOrder('fixture-order'));assert.equal(sends,2,'expired post-sign trading ticket must send nothing');
  delete globalThis.__memberTicketSignDelay;expectedCost=10;
  await assert.rejects(()=>modules.rounding.createDirectRoundingTransport({fetch:synthetic,now:()=>{stall();return Date.now();}})({keyId:'fixture-key',privateKey},'/trade-api/v2/api_keys'));
  assert.equal(sends,2,'expired pre-sign precision ticket must send nothing');
  admitted=false;expectedCost=2;await assert.rejects(()=>client.getOrder('fixture-order'),/kalshi_member_budget_unavailable/);assert.equal(sends,2);
  expectedCost=10;await assert.rejects(()=>modules.rounding.createDirectRoundingTransport({fetch:synthetic})({keyId:'fixture-key',privateKey},'/trade-api/v2/api_keys'),/kalshi_member_budget_unavailable/);assert.equal(sends,2);
 }finally{delete globalThis.__memberTicketSignDelay;modules.testPool.query=originalQuery;for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test.after(()=>{globalThis.fetch=originalFetch;if(previous===undefined)delete process.env.STRATA_MEMBER_READ_BUDGET;else process.env.STRATA_MEMBER_READ_BUDGET=previous;rmSync(dir,{recursive:true,force:true});});

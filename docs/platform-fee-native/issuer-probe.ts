import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pool} from '../../lib/db/src/index';
import {capturePlatformOfficialFeeV5,readPlatformOfficialFeeV5} from '../../artifacts/api-server/src/lib/strata/independentOfficialFeeV5';
import {verifyMonetaryFeeContract} from '../../artifacts/api-server/src/lib/strata/monetaryFeeContract';

// External requests are public GETs only. No Kalshi account, signer, order,
// production database, customer data, or synthetic provider response.
async function main(){
 const url=new URL(process.env.DATABASE_URL!);
 assert.equal(process.env.GITHUB_ACTIONS,'true');
 assert.equal(process.env.NODE_ENV,'test');
 assert.equal(url.hostname,'127.0.0.1');
 assert.equal(url.pathname,'/strata_platform_fee_disposable');
 assert.ok(!process.env.STRATA_PUBLIC_SELF_SERVICE_QUALIFIED_SHA);
 const db=(await pool.query("SELECT current_database() AS db, (SELECT count(*)::int FROM private.strata_platform_official_fee_capture_v1) AS captures, (SELECT count(*)::int FROM public.v13_production_account) AS accounts")).rows[0];
 assert.deepEqual(db,{db:'strata_platform_fee_disposable',captures:0,accounts:0});
 const capture=await capturePlatformOfficialFeeV5();
 console.log('GENUINE_ISSUER_CAPTURE',JSON.stringify(capture));
 assert.ok(capture.ok,'Canonical issuer capture refused: '+capture.reason);
 const source=await readPlatformOfficialFeeV5();
 assert.ok(source.ok,'Captured source readback refused: '+source.reason);
 assert.equal(createHash('sha256').update(source.bytes).digest('hex'),capture.digest);
 assert.equal(source.originalCapturedAt,capture.originalCapturedAt);
 assert.equal(source.effectiveDate,capture.effectiveDate);
 const fee=await verifyMonetaryFeeContract('STEP_9');
 console.log('GENUINE_ISSUER_MARKET_PROOF',JSON.stringify(fee));
 assert.ok(fee.ok&&fee.monetaryFeeAuthorized,'Actual market fee proof refused: '+fee.reason);
 assert.equal(fee.sourceDigest,capture.digest);
 assert.equal(fee.tradingAuthorized,false);
 assert.equal(fee.policyApproved,false);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.v13_production_account")).rows[0].n,0);
 console.log('GENUINE_ISSUER_PROBE_PASS: native database, actual collector, current market metadata, no customers or orders');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>pool.end());

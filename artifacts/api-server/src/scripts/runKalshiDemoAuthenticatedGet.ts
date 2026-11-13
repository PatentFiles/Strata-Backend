/**
 * Manual demo-only CI smoke test. No order creation, no production origin,
 * no frontend route. Credentials must be supplied through the protected
 * kalshi-demo GitHub Actions environment as encrypted secrets.
 *
 * Run via the workflow_dispatch "Kalshi authenticated DEMO GET" job only.
 */
import {probeAuthenticatedDemoBalance} from "../lib/strata/kalshiDemoAuthenticatedProbe";

async function main():Promise<void>{
  const keyId=process.env.STRATA_DEMO_KALSHI_KEY_ID;
  const privateKeyPem=process.env.STRATA_DEMO_KALSHI_PRIVATE_KEY_PEM;
  if(!keyId || !privateKeyPem){
    process.stdout.write(JSON.stringify({
      environment:"KALSHI_DEMO",method:"GET",authenticated:false,
      reason:"isolated_demo_secrets_not_configured",
      tradingAuthorized:false,
    })+"\n");
    process.exitCode=2;
    return;
  }
  // Do not log credentials, raw response bodies, private balances, or keys.
  const result=await probeAuthenticatedDemoBalance({keyId,privateKeyPem});
  process.stdout.write(JSON.stringify(result)+"\n");
  if(!result.authenticated||!result.responseShapeVerified)
    process.exitCode=1;
}
void main().catch(()=>{
  process.stdout.write(JSON.stringify({
    environment:"KALSHI_DEMO",method:"GET",
    authenticated:false,reason:"demo_probe_unexpected_failure",
    tradingAuthorized:false,
  })+"\n");
  process.exitCode=1;
});

/** Release-controlled historical bytes, NOT a live issuer capture or authenticity proof. */
import {readFile} from 'node:fs/promises';import {resolve} from 'node:path';import {createHash} from 'node:crypto';
import {verifyOfficialFeePdfBytes} from '../microLiveFeeArtifact';
export const HISTORICAL_FEE_VERSION='owner_attested_historical_terms_v1';
export const HISTORICAL_BASELINE_ID='repository-july-07-2026-c326a69f-v1';
export const HISTORICAL_BASELINE_SHA256='c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601';
export const HISTORICAL_SOURCE_KIND='OWNER_ATTESTED_HISTORICAL_BASELINE';
export const HISTORICAL_MIGRATION_CONFIRM='I_ATTEST_AND_APPROVE_REPOSITORY_JULY_07_2026_HISTORICAL_BASELINE_V1';
export const HISTORICAL_RISK_ACCEPTANCE='I_ACCEPT_UNVERIFIED_SOURCE_AUTHENTICITY_AND_CURRENT_BASE_RATES_CHANGE_DETECTION_GAPS_AND_UNBOUNDED_FEE_EXITS_MAY_BLOCK_V1';
export const HISTORICAL_MODEL_CONFIRM='I_APPROVE_OWNER_ATTESTED_HISTORICAL_FEE_TERMS_V1';
export function historicalBaselineEnabled(){return process.env.STRATA_DURABLE_HISTORICAL_BASELINE_ENABLED==='true';}
export async function readHistoricalBaselineBytes(){
 if(!historicalBaselineEnabled())return null;
 for(const p of ['dist/official-fee-schedule.pdf','artifacts/api-server/dist/official-fee-schedule.pdf','../../attached_assets/0_kalshi-fee-schedule_1790474920034.pdf','attached_assets/0_kalshi-fee-schedule_1790474920034.pdf']){
  let bytes:Buffer;try{bytes=await readFile(resolve(process.cwd(),p));}catch{continue;}
  if(createHash('sha256').update(bytes).digest('hex')!==HISTORICAL_BASELINE_SHA256)continue;
  const parsed=await verifyOfficialFeePdfBytes(bytes);
  if(parsed.ok&&parsed.digest===HISTORICAL_BASELINE_SHA256&&parsed.effectiveDate==='2026-07-07')return {...parsed,bytes};
 }
 return null;
}

import { createHash, timingSafeEqual } from "node:crypto";

export type DirectReplayScope = Readonly<{ accountId: string; ownerId: string }>;
export type DirectIndependentReplayCandidate = Readonly<DirectReplayScope & {
  sourceId: string;
  marketTicker: string;
  crossingKey: string;
  evidenceSha256: string;
  originalOldestMs: number;
  originalObservedMs: number;
  marketCloseMs: number;
  submissionAuthorized: false;
}>;
export type DirectReplayQuery = (
  sql: string, parameters: [accountId: string, ownerId: string, nowMs: number, notifiedSourceId: string | null],
) => Promise<{ rows: readonly Record<string, unknown>[] }>;

const BATCH = 16;
const AGE_MS = 5000;
const key = /^[a-zA-Z0-9._:-]{1,160}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ticker = /^KXBTC15M-[A-Z0-9-]{1,128}$/;
const hex = /^[a-f0-9]{64}$/;
const validTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const matches = (re: RegExp, v: unknown): v is string => typeof v === "string" && re.test(v);

// A notification is an optional ordering hint only, never evidence, authority or
// the sole selection filter. A missed/invalid notification retains a bounded
// freshness scan. This is not durable once evidence individually expires.
const SELECT = `SELECT s.id, s.account_id, a.owner_user_id::text AS owner_id,
 s.market_ticker, s.crossing_key, s.evidence_bytes, s.evidence_sha256,
 (extract(epoch FROM s.oldest_source_at)*1000)::text AS oldest_ms,
 (extract(epoch FROM s.observed_at)*1000)::text AS observed_ms,
 (extract(epoch FROM s.closes_at)*1000)::text AS close_ms
 FROM public.strata_direct_entry_source s
 JOIN public.v13_production_account a ON a.id=s.account_id
 WHERE s.account_id=$1 AND a.owner_user_id=$2::uuid
 AND s.oldest_source_at >= to_timestamp(($3::bigint-5000)::double precision/1000)
 AND s.observed_at <= to_timestamp($3::double precision/1000)
 AND s.closes_at > to_timestamp($3::double precision/1000)
 AND octet_length(s.evidence_bytes) <= 65536
 ORDER BY (s.id IS NOT DISTINCT FROM $4::text) DESC, s.oldest_source_at DESC, s.id
 LIMIT 16`;

function timestamp(value: unknown): number | null {
  if (!matches(/^[0-9]{1,16}(?:\.0{1,12})?$/, value)) return null;
  const parsed = Number(value);
  return validTime(parsed) ? parsed : null;
}

function verify(row: Record<string, unknown>, scope: DirectReplayScope, now: number): DirectIndependentReplayCandidate | null {
  const {id,account_id,owner_id,market_ticker,crossing_key,evidence_bytes,evidence_sha256}=row;
  if (!matches(key,id) || account_id!==scope.accountId || owner_id!==scope.ownerId ||
      !matches(ticker,market_ticker) || crossing_key!==market_ticker+":first" ||
      typeof evidence_bytes!=="string" || Buffer.byteLength(evidence_bytes)>65536 ||
      !matches(hex,evidence_sha256)) return null;
  if (!timingSafeEqual(createHash("sha256").update(evidence_bytes,"utf8").digest(),
      Buffer.from(evidence_sha256,"hex"))) return null;
  const oldest=timestamp(row.oldest_ms), observed=timestamp(row.observed_ms), close=timestamp(row.close_ms);
  if (oldest===null || observed===null || close===null || oldest>observed ||
      observed>now || now>=close || now-oldest>AGE_MS) return null;
  try {
    const e=JSON.parse(evidence_bytes);
    if (!e || typeof e!=="object" || Array.isArray(e) || JSON.stringify(e)!==evidence_bytes ||
        e.version!==1 || e.account!==account_id || e.ticker!==market_ticker || e.evaluation!==id ||
        e.oldest!==oldest || e.observed!==observed || e.closesAt!==close) return null;
  } catch { return null; }
  // Evidence integrity only. A matching database row/hash is not proof of
  // market data authenticity, eligibility, or a qualified publisher.
  return Object.freeze({ sourceId:id,accountId:scope.accountId,ownerId:scope.ownerId,
    marketTicker:market_ticker,crossingKey:crossing_key,evidenceSha256:evidence_sha256,
    originalOldestMs:oldest,originalObservedMs:observed,marketCloseMs:close,submissionAuthorized:false });
}

export async function readDirectIndependentPgReplay(
  query: DirectReplayQuery, scope: DirectReplayScope, nowMs: number, notifiedSourceId: string | null = null,
): Promise<readonly DirectIndependentReplayCandidate[]> {
  const accountId=scope.accountId, ownerId=scope.ownerId;
  if (!matches(key,accountId) || !matches(uuid,ownerId) || !validTime(nowMs) || nowMs>253402300799999) return [];
  const pinned=Object.freeze({accountId,ownerId});
  const result=await query(SELECT,[accountId,ownerId,nowMs,matches(key,notifiedSourceId)?notifiedSourceId:null]);
  if (result.rows.length>BATCH) throw Error("direct_replay_unbounded_query_result");
  const seen=new Set<string>();
  const candidates: DirectIndependentReplayCandidate[]=[];
  for(const row of result.rows){
    const candidate=verify(row,pinned,nowMs);
    if(!candidate)continue;
    if(seen.has(candidate.crossingKey))throw Error("direct_replay_duplicate_crossing_result");
    seen.add(candidate.crossingKey);
    candidates.push(candidate);
  }
  return Object.freeze(candidates);
}

// Independent final read: use the specific prepared source ID, never replace it
// with another fresh candidate. Caller may supply a transaction-bound query.
const SELECT_EXACT = SELECT.replace(
  / ORDER BY[\s\S]* LIMIT 16$/,
  " AND s.id=$4::text LIMIT 1",
);
export async function rereadDirectIndependentPgReplay(
  query: DirectReplayQuery, scope: DirectReplayScope, nowMs: number, prepared: DirectIndependentReplayCandidate,
): Promise<DirectIndependentReplayCandidate | null> {
  const accountId=scope.accountId, ownerId=scope.ownerId;
  if (!matches(key,accountId)||!matches(uuid,ownerId)||!validTime(nowMs)||nowMs>253402300799999||
      prepared.accountId!==accountId||prepared.ownerId!==ownerId||prepared.submissionAuthorized!==false||
      !matches(key,prepared.sourceId)||!matches(hex,prepared.evidenceSha256)) return null;
  const p=Object.freeze({...prepared});
  const scopePin=Object.freeze({accountId,ownerId});
  const {rows}=await query(SELECT_EXACT,[accountId,ownerId,nowMs,p.sourceId]);
  if(rows.length!==1)return null;
  const row=verify(rows[0]!,scopePin,nowMs);
  return row&&row.sourceId===p.sourceId&&row.crossingKey===p.crossingKey&&row.marketTicker===p.marketTicker&&
    row.evidenceSha256===p.evidenceSha256&&row.originalOldestMs===p.originalOldestMs&&
    row.originalObservedMs===p.originalObservedMs&&row.marketCloseMs===p.marketCloseMs?row:null;
}

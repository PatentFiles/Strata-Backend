import {digest,requireProof} from './types';

/** Integrity checksum of the compact producer receipt, NOT a provider signature.
 * The full-book hash is pinned but cannot be reconstructed from omitted ladders. */
export function canonicalEntryQuoteEvidenceDigest(value:Record<string,unknown>):string {
 const {evidenceDigest:_,...receipt}=value;
 return digest(receipt);
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).sort().join('|')===expected.sort().join('|');
/** Mandatory for LIVE ENTRY only; historical rows are not rewritten. Existing
 * champion classification, signed depth, fees and final authorization still apply. */
export function assertCanonicalEntryQuoteEvidence(value:unknown,nowMs:number):void {
 const fail='production_entry_quote_evidence_invalid';
 requireProof(object(value),fail);
 const s=value,e=s.entry_quote_evidence;
 requireProof(object(e)&&Buffer.byteLength(JSON.stringify(e),'utf8')<=2048,fail);
 requireProof(keys(e,['version','source','purpose','marketTicker','requestStartedAtMs','responseHeadersAtMs',
  'bodyCompletedAtMs','yesBidTicks','noBidTicks','yesAskTicks','noAskTicks','normalizedBookDigest',
  'rawResponseDigest','capacity','evidenceDigest']),fail);
 requireProof(e.version===1&&e.source==='KALSHI_PUBLIC_ORDERBOOK'&&e.purpose==='PRE_QUALIFICATION'&&
  typeof e.marketTicker==='string'&&/^KXBTC15M-[A-Z0-9-]{5,90}$/.test(e.marketTicker)&&e.marketTicker===s.market_ticker&&
  hash(e.normalizedBookDigest)&&(e.rawResponseDigest===null||hash(e.rawResponseDigest))&&
  hash(e.evidenceDigest)&&e.evidenceDigest===canonicalEntryQuoteEvidenceDigest(e),fail);
 const start=e.requestStartedAtMs,headers=e.responseHeadersAtMs,body=e.bodyCompletedAtMs;
 const evaluated=new Date(s.evaluated_at as string|number|Date).getTime();
 requireProof(integer(nowMs)&&integer(evaluated)&&integer(start)&&integer(headers)&&integer(body)&&
  evaluated<=start&&start<=headers&&headers<=body&&body<=nowMs&&nowMs-evaluated<=5000&&nowMs-start<=5000,
  'production_entry_quote_evidence_expired');
 for(const v of [e.yesBidTicks,e.noBidTicks,e.yesAskTicks,e.noAskTicks])requireProof(integer(v)&&v>0&&v<10000,fail);
 const yb=e.yesBidTicks as number,nb=e.noBidTicks as number,ya=e.yesAskTicks as number,na=e.noAskTicks as number;
 requireProof(yb+nb<=10000&&ya===10000-nb&&na===10000-yb&&s.up_offer===ya/10000&&s.down_offer===na/10000,fail);
 const side=s.direction==='UP'?'YES':s.direction==='DOWN'?'NO':null;
 const ref=side==='YES'?ya:na,c=e.capacity;
 requireProof(side&&s.entry_offer===ref/10000&&object(c)&&keys(c,['side','referencePriceTicks','stakeMicros',
  'requestedContracts','modeledFilledContracts','modeledUnfilledContracts','modeledCashMicros']),fail);
 requireProof(c.side===side&&c.referencePriceTicks===ref&&c.stakeMicros==='5000000'&&
  integer(c.requestedContracts)&&c.requestedContracts>0&&c.requestedContracts===Math.floor(5_000_000/(ref*100))&&
  c.modeledFilledContracts===c.requestedContracts&&c.modeledUnfilledContracts===0&&
  typeof c.modeledCashMicros==='string'&&/^(0|[1-9]\d{0,6})$/.test(c.modeledCashMicros)&&
  BigInt(c.modeledCashMicros)>0n&&BigInt(c.modeledCashMicros)<=5_000_000n&&
  BigInt(c.modeledCashMicros)<=BigInt(c.requestedContracts)*BigInt(ref)*100n,fail);
}

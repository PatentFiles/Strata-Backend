import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCanonicalEntryQuoteEvidence,canonicalEntryQuoteEvidenceDigest} from './entryQuoteEvidence';
import {receiptFixture} from "./entryQuoteEvidence.fixture";
test('compact receipt valid on both sides and inclusive original 5s boundary',()=>{
 for(const side of ['UP','DOWN'] as const){const s=receiptFixture(100000,side);assertCanonicalEntryQuoteEvidence(s,105000);assert.throws(()=>assertCanonicalEntryQuoteEvidence(s,105001),/expired/);}
});
test('missing, stripped, malformed, oversized and changed receipts cannot qualify',()=>{
 for(const value of [null,{},[],{...receiptFixture().entry_quote_evidence,evidenceDigest:'b'.repeat(64)},
 {...receiptFixture().entry_quote_evidence,raw:'x'.repeat(2200)}]){
 assert.throws(()=>assertCanonicalEntryQuoteEvidence({...receiptFixture(),entry_quote_evidence:value},100000),/evidence_invalid/);
 }
});
test('recomputed checksums do not authorize contradictory identity, timing, prices or capacity',()=>{
 const edits=[{marketTicker:'KXBTC15M-WRONG-000'},{source:'KALSHI_PUBLIC_REST'},{yesAskTicks:5100},
 {requestStartedAtMs:99999},{responseHeadersAtMs:100001},{bodyCompletedAtMs:100001},
 {normalizedBookDigest:'invalid'},{rawResponseDigest:'invalid'},
 ...[{side:'NO'},{requestedContracts:9},{modeledFilledContracts:9,modeledUnfilledContracts:1},{stakeMicros:'6000000'},
 {modeledCashMicros:'5000001'},{modeledCashMicros:'0'}].map(c=>({capacity:{...(receiptFixture().entry_quote_evidence.capacity as object),...c}}))];
 for(const edit of edits){const s=receiptFixture();Object.assign(s.entry_quote_evidence,edit);s.entry_quote_evidence.evidenceDigest=canonicalEntryQuoteEvidenceDigest(s.entry_quote_evidence);
 assert.throws(()=>assertCanonicalEntryQuoteEvidence(s,100000),/entry_quote_evidence/);}
});
test('source quotes, direction and original clock are independently bound',()=>{
 for(const edit of [{entry_offer:.49},{up_offer:.51},{down_offer:.51},{direction:'DOWN'},{evaluated_at:new Date(100001)}])
 assert.throws(()=>assertCanonicalEntryQuoteEvidence({...receiptFixture(),...edit},100000),/entry_quote_evidence/);
});
test('sorted compact digest is stable across JSONB key order but not payload mutation',()=>{
 const e=receiptFixture().entry_quote_evidence;
 assert.equal(canonicalEntryQuoteEvidenceDigest(Object.fromEntries(Object.entries(e).reverse())),e.evidenceDigest);
 assert.notEqual(canonicalEntryQuoteEvidenceDigest({...e,bodyCompletedAtMs:100001}),e.evidenceDigest);
});

import {quoteFromEntryBook} from '../forwardEntryBookQuote';
test('actual producer evidence and digest are accepted by LIVE validator on both sides',()=>{
const at=1793450000000,ticker='KXBTC15M-26OCT310715-15';
const market={ticker,target:100000,startsAt:new Date(at-10000),endsAt:new Date(at+900000),yesAsk:.007,noAsk:.994,yesBid:.006,noBid:.993,yesPrice:.0065,noPrice:.9935,fetchedAt:new Date(at),status:'open',result:null};
const book={ticker,source:'KALSHI_PUBLIC_REST' as const,timestampAuthority:'LOCAL_RECEIPT_ONLY' as const,requestStartedAtMs:at+20,receivedAtMs:at+30,bodyCompletedAtMs:at+40,yesBids:[{priceTicks:5100,contractsHundredths:100000}],noBids:[{priceTicks:4800,contractsHundredths:100000}]};
for(const side of ['YES','NO'] as const){const q=quoteFromEntryBook(book,market,at,at+50,side,5);assert.equal(q.evidence.evidenceDigest,canonicalEntryQuoteEvidenceDigest(q.evidence));assertCanonicalEntryQuoteEvidence({market_ticker:ticker,evaluated_at:new Date(at),direction:side==='YES'?'UP':'DOWN',up_offer:q.market.yesAsk,down_offer:q.market.noAsk,entry_offer:side==='YES'?q.market.yesAsk:q.market.noAsk,entry_quote_evidence:q.evidence},at+50);}

});

import {canonicalEntryQuoteEvidenceDigest} from "./entryQuoteEvidence";
export function receiptFixture(now=100000,side:'UP'|'DOWN'='UP') {
 const evidence:Record<string,unknown>={version:1,source:'KALSHI_PUBLIC_ORDERBOOK',purpose:'PRE_QUALIFICATION',marketTicker:'KXBTC15M-TEST-000',
 requestStartedAtMs:now,responseHeadersAtMs:now,bodyCompletedAtMs:now,yesBidTicks:5000,noBidTicks:5000,yesAskTicks:5000,noAskTicks:5000,
 normalizedBookDigest:'a'.repeat(64),rawResponseDigest:null,capacity:{side:side==='UP'?'YES':'NO',referencePriceTicks:5000,stakeMicros:'5000000',
 requestedContracts:10,modeledFilledContracts:10,modeledUnfilledContracts:0,modeledCashMicros:'5000000'}};
 evidence.evidenceDigest=canonicalEntryQuoteEvidenceDigest(evidence);
 return {market_ticker:evidence.marketTicker,evaluated_at:new Date(now),direction:side,up_offer:0.5,down_offer:0.5,entry_offer:0.5,entry_quote_evidence:evidence};
}

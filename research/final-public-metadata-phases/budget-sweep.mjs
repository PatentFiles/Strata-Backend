// Offline arithmetic only; no network, account identifiers or private receipts.
// Rounded example timing envelope: expiry400ms, final public240ms, downstream300ms.
// Wire public share is UNKNOWN. Values below are assumptions, not observations.
export function sweep({baselineEffectiveAgeMs=5400,finalPublicMs=240,wireTotalMs=300,deadlineMs=5000}={}){
 return [0,50,100,175,200,250,wireTotalMs].map(assumedWirePublicMs=>({
  assumedWirePublicMs,assumedWireVerificationRemainderMs:wireTotalMs-assumedWirePublicMs,
  optimisticEffectiveAgeMs:baselineEffectiveAgeMs-finalPublicMs-assumedWirePublicMs,
  optimisticMarginMs:deadlineMs-(baselineEffectiveAgeMs-finalPublicMs-assumedWirePublicMs),
  conditions:'both public intervals fully hidden; zero added overhead/contention; unchanged evidence; NOT a fill prediction',
 }));
}
if(import.meta.url===`file://${process.argv[1]}`)console.log(JSON.stringify({classification:'ASSUMPTION_SWEEP_NOT_EXECUTION_REPLAY',rows:sweep()},null,2));

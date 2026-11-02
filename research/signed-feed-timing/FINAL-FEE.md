# Final preparation and fee attribution (local diagnostic delta)

Existing `fee_verification` events carry a branded monotonic total, the elapsed existing injected public fee probe, and **verification remainder**. Remainder includes all work outside that callback (local work, DB review, standing renewal and scheduling); it is not DB-only latency. Probe time includes parsing/validation and any shared metadata promise waiting, not provider RTT. Overlapping probe calls make the split unknown instead of subtracting overlapping intervals.

Existing `final_preparation` success/error events now carry the already branded read DAG timings from the final market object (or the original gather error after sibling drain). Never sum parallel endpoint durations. No extra requests, log events, authority wall-clock samples, snapshot fields or proof fingerprint changes. Failure error identity and serialized proof/error bodies remain unchanged. Read timings missing before gathering starts remain missing, not zero.

These diagnostics attribute work, do not rescue latency, relax the five-second freshness check or prove fills. Full combined PG safety and independent review remain required before publication; no production actions were taken.

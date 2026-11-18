# Nov18 first live qualifying attempt (read-only evidence)

Exact deployment: `3c54f992bfa2255ba37a06f4220cfced5eaff7b4`.
Source evaluation: `7bca9866-eda5-4dc3-81ce-3391d20277dc`.
Intent: `fa6b7ac9-7612-492a-a520-448ab1ab5f62`.

Application clock timeline (Railway ingestion lagged roughly 58 seconds):

| Boundary | UTC | Elapsed / evidence |
|---|---|---|
| Source evaluation | 13:45:35.953 | BTC provider already 1537ms old |
| Producer commit returned | 13:45:36.591 | 638ms after evaluation |
| PREPARE metadata coordinator | 13:45:36.621 | Original source clocks retained |
| Reconciliation complete | 13:45:38.103 | 1480.696ms; signed snapshot950.613ms, ledger362.894ms, postchecks139.277ms |
| Preparation complete | 13:45:38.901 | 696.270ms |
| Dispatch claim timestamp | 13:45:39.063 | NOT proof of an exchange POST |
| Original provider freshness deadline | 13:45:39.416 | 5000ms minus original1537ms |
| Final signed snapshot complete | 13:45:40.537 | 638.348ms |
| Final preparation rejected | 13:45:40.728 | 1338.573ms; effective source age6312ms |

Terminal BLOCKED; durable PROVEN_NOT_POSTED; zero filled contracts, no exchange order ID. Source DB fields match the prepared source (timestamps compared at JS serialization precision). Canonical source and PREPARE book were both NO52¢. This was expiry, not a higher-price rejection.

## Limits and offline verification

`source-budget.test.mjs` verifies arithmetic from observed application timestamps only. It is not a transport simulation.
The added historical native `observed_source_expiry` case exercises the real executor and historical fee verifier with source age1537ms and dispatch prefix3110ms. Provider/grant/lease ports are synthetic. It is NOT an exact historical market replay, a successful fill guarantee or production authorization proof.

FINAL/WIRE overlap wiring exists and exact variable name is present in Railway, but OAuth redacts values. Source review found no lost capability. Do not infer flag enabled from name presence or change runtime configuration during this investigation.

A final-history digest query batch can save three round trips for the observed two-fill/two-settlement account; it cannot resolve the1312ms deficit. Fresh FINAL market/snapshot overlap could save roughly316ms but requires invocation-local draining, STOP/revocation and failure-race tests. Neither justifies weakening freshness, repricing or refreshing original timestamps.

## Isolated candidate scope (not deployed)

- Final proof and reconciliation event digests are batched within the existing account transaction; exact per-event equality and rollback remain mandatory.
- PREPARE pending-intent and capacity reads are combined, preserving pending refusal before capacity parsing and existing stake locks.
- Historical fee verification hashes actual database bytes on every locked read using PostgreSQL SHA-256. Both the calculated and declared digest must match the immutable pinned digest. Historical authenticity/currentness disclosures remain false. The historical field shrinks from562,260 bytes of bytea text to64 digest characters; this is a payload measurement, not a measured latency saving.
- Fresh FINAL signed snapshot overlap is an internal, default-off executor prototype. It is not wired into production configuration. It drains even on market failure before releasing the transaction, retains original clocks and final guards, and leaves EXIT sequential.
- Bounded signed snapshot phase diagnostics preserve existing await order and authority clocks.

The fixed3110ms dispatch-prefix native case remains a rejection regression, not a measure of PREPARE optimization. A separate unpadded paired sensitivity replay is required to quantify cumulative changes. Existing synthetic901ms-provider-age replay improved with snapshot overlap, but the observed1537ms-provider-age case still refused. No successful live rescue or fill is claimed.

### Producer attribution correction

The638ms interval is not a measured transaction duration: evaluation time precedes public market/feed reads, preview/book work and the transaction. The exact attempt has no sampled transaction-phase record. A nearby same-run sample measured363.289ms across transaction phases, with roughly28ms per SQL round trip. The commit wake is already after successful commit with no intentional scheduling delay. Do not move trading admission before commit or reset the source timestamp to hide this work.

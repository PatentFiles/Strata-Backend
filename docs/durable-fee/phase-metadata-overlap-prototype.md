# Isolated durable FINAL/WIRE overlap prototype

This builds on the separately reviewed PREPARE overlap and FINAL/held transaction-lock repair. It has not been deployed or enabled. No live account control, provider request or order was performed.

- PREPARE provenance remains a separate WeakMap namespace.
- FINAL and WIRE start new independent five-GET captures at existing executor scheduling boundaries, with original coordinator wall and monotonic clocks.
- New opaque handles require an active, exact owning dispatch invocation, intent, scope and stage. They are single-use for durable verification; clones/serialized handles are invalid.
- Locked model, historical provenance, revocation, owner authority, account fence and signed book/account checks still run. No cached authority, cross-phase body reuse, fallback retry or freshness/price relaxation.
- Existing process/account quotas, cancellation and explicit final-prefetch feature flag remain. Production flag state is not changed here.

## Verification

Workspace typecheck passes. Phase suite18, prefetch92, native four-scenario retained historical fixture pass. Durable offline final rerun recorded separately. Native coverage includes successful distinct FINAL/WIRE captures, provider503 bounded3reads/no replacement, cancellation/no post, and650ms post-sign delay rejected by actual final raw-wire source clock with zero posts. Existing private grant/lease ports are synthetic; historical durable model SQL and verifier, ledger/executor, locking and source clocks are real. Fixture tables are minimal row shapes, not complete migration/approval proof.

Timing assumptions are synthetic:181ms per public GET,1094ms initial/final signed snapshot,901ms original provider age and optimistic dispatch age2123ms. Two scratch runs reached raw-wire effective source age4551/4536ms (449/464ms margin), compared with4913–4935ms for PREPARE+lock repair. Do not call these live latency measurements, guaranteed savings or a rescued historical fill. Original missed signal's ask moved49→51 cents and never reached FINAL; its ceiling remains unchanged.

Independent final review and broader aggregate validation remain release gates. Live timing needs deployment-specific readback after separately authorized rollout; no unconditional five-second execution guarantee is possible.

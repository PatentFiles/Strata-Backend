# Strata #403 cutover checklist

This is the runbook branch, not a deploy target. The sole code target is [Backend PR #403](https://github.com/PatentFiles/Strata-Backend/pull/403). No dashboard change, new migration, fee/policy change, stake change, or additional test run is part of this cutover.

## Pinned release
- Reviewed PR head: `728cdad28b9dea8c9641d5173388bbbe2d265850`
- Qualified Git tree: `6376c7d987d120a8ff595c8472d09d974b54e023`
- Expected current main / rollback build: `70f563cefb1382b8c3af2ce2b738d6e2dd5a35f5` (#401).
- Four source/test changes to the reserve path only. All 14 PR workflows passed. Isolated PostgreSQL 16/17 checks and the exact-tree two-account Wallets rehearsal passed. The simulated second worker remained running through the reserve release; this does **not** establish rolling backend deploy continuity.
- The production reserve-evidence index documented in #402 is already in place. Confirm it is ready/valid; do not reinstall it or merge #402 as a release prerequisite.

## Cutover
1. Confirm the active worker owner has stopped while flat and will not restart until the all-clear. Verify zero armed or current owned worker leases, no held positions, and no current order/exposure that requires protection; an idle position count alone is not a stopped worker. If another worker is active, do not merge into the connected branch.
2. Confirm the PR head, CI, expected main, current deployment and rollback point have not drifted. Coordinate and snapshot live settings without exposing secrets. Merge only #403 via GitHub with the expected head. Verify the merge tree is byte-for-byte identical to the tested tree and still main. Coordinate the reserve feature's exact build SHA pin; do not change unrelated flags or enable an order path as part of the release.
3. Check whether Railway already queued the exact merge SHA. If not, deploy latest once on the existing Strata-Backend service. Do not deploy this runbook branch or paper service. Verify the successful serving deployment and health, not merely the Git merge or build status. Hold owner reactivation until the maintenance all-clear.
4. Use authenticated Wallets on the exact stopped account. Check the saved reserve request and durable receipts; if already recorded, stop and verify that receipt. If confirmed unposted, cancel only that saved request and acknowledge its terminal state. Obtain one fresh signed preview. If the preview confirms the same reserve and unchanged cash, submit once with the owner's authorization. Do not replay a stale or unknown request, bypass evidence checks, move funds, repost settlement or change the historical exit status.
5. Verify one durable release receipt on the serving build, reserve zero, unchanged cash and settlement, historical exit still UNKNOWN, and account still stopped/disarmed. If receipt or UI is uncertain, read back rather than retry. Verify Dashboard readiness and any exact-build owner requirements; the owner personally performs Arm then Start. After Start, verify the actual new worker heartbeat and live admission separately; readiness is not a live order or proof of a fill.

## Rollback
- If the new backend fails to become healthy or its SHA or settings disagree, keep accounts stopped, coordinate the previous known healthy #401 deployment and matching SHA pin, and verify actual serving health and flags. Do not automatically restore any trading authorization.
- A rollback does not undo a durable reserve receipt. If the release may have recorded on the new build, verify the exact saved outcome and ledger before deciding next actions. Never reapply or reverse it just because the application is rolled back.

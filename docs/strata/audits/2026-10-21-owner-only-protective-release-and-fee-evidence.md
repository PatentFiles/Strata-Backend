# Strata — owner-controlled protective-exit release and official fee evidence
**Validated source baseline:** PatentFiles/Strata-Backend `main` `7ef2bf41a1112d9adaf88034beef52eda600647d`; this document is a read-only release architecture handoff, **NOT** production authorization.

## Decision: legacy external reviewer is not required for the owner-SHA pathway
The existing [`OWNER_SHA_V1`](/artifacts/api-server/src/lib/strata/ownerShaRelease.ts) implementation already replaces the routine second-person attestation. **Do not remove the protective-exit dispatcher, one-shot UNKNOWN marker, final transactional fences or account/global kill switches.** The earlier distinct-reviewer API remains available solely for backward-compatible, previously independently approved releases; it is not a gate on a qualifying new owner-SHA release.

The accountable release actor is the authenticated, MFA/AAL2 owner, derived server-side from Supabase JWT; there is no browser-provided owner impersonation. Every user controls only their own commissioned account. The separate global safety release remains privileged, and the owner cannot turn it on by authorizing a SHA.

1. Verify the **actual running Railway Git commit** with `RAILWAY_GIT_COMMIT_SHA`; all three current GitHub PR/main CI suites passing is necessary but not proof of deployed runtime.
2. Read current personal Kalshi production balance, complete paginated current/historical orders and fills, positions and settlements using the restricted Exchange Index 2 key. Reconcile with Strata ledger and unresolved/UNKNOWN intents. Qualification must bind this proof, the current official fee-source digest, exact owner/account identity, strategy policy/stake, $0.01 protective floor and deployed SHA; no orders are submitted.
3. Require a separately typed personal owner confirmation before touching a historical `awaiting_account_commissioning` freeze; **only** after both authenticated zero exchange exposure and zero local financial history are transactionally proven. Genuine market-risk freezes are never cleared by this route.
4. Owner explicitly authorizes the exact SHA through `/api/strata/me/production/protective-release/owner-authorize` with `qualificationId`, `OWNER_SHA_RELEASE_CONFIRM`, and where applicable `provisionalRepairConfirmation`. The backend stores a revocable exact SHA approval in `private.strata_owner_sha_approvals`. It cannot submit orders, or start the worker. `owner-revoke` remains available subject to no exposure/active worker.
5. Only a separately authenticated Dashboard ARM and START request after healthy deployment, fee, account, kill-switch, signed protective-exit and final order checks may operate the worker. Test CI, shadow fills and read-only API checks are **never** execution authority.

### Owner path machine-checkable safety invariants
- Startup accepts a unique **revocable owner SHA** bound to that owner, execution account and deployed SHA without touching the historical independent reviewer table. Missing, duplicate, stale SHA, revoked, uncommissioned, kill-on or disabled account block.
- Final protective-exit signed one-use IOC performs a second lock-protected exact SHA and owner check, verifies fee and reduce-only market order, never double-POSTs after UNKNOWN/partial/timeout or ambiguous DB COMMIT, and requires authenticated exchange reconciliation. These are offline-code regression facts, NOT live Kalshi execution evidence.
- Explicit privilege boundary: owner cannot grant/review on another owner's behalf; privileged global kill and shared infrastructure approvals are separate. State remains frozen if no current official fee receipt.
- In this code update, production qualification now refuses reads whose clock is not bounded to the authenticated API observation; a historical freeze additionally requires an explicit separate owner consent.

## Fee-source evidence — actual outstanding dependency
- Publisher's [official fee PDF](https://kalshi.com/docs/kalshi-fee-schedule.pdf) is publicly retrievable in a web-reader on 2026-10-21. Visible document is 12 pages, updated/effective **July 7, 2026**, and states taker `round_up(M*0.07*C*P*(1-P))`, maker `round_up(M*0.0175*C*P*(1-P))`, rounded to centicent-plus-position-cost, with non-standard series exceptions.
- This **does not** prove that Strata's own server or verified fixed-origin Supabase Edge fetcher received those bytes, current hash, HTTPS redirect chain, strict reviewed parser or authorized market-specific exception metadata. As of 2026-10-21 14:24:37 UTC, production table `public.strata_official_fee_captures` had **zero rows**. An expired hardcoded lease, uploaded or copied PDF, web search result, or a one-time manual digest is not a provider-origin receipt and cannot silently qualify Steps 9/11/12.
- Production bridge and direct fetch may retry the canonical provider after cooldown, with pinned origin, SHA, byte length, PDF syntax/table validation, recent capture, current `KXBTC15M` series+event+market fee and scheduled change crosschecks. A genuine auth/TLS/429 or parser failure continues to block owner authorization and new orders. A separately **reviewed, versioned official API source** is a distinct policy and requires its own authorization; do not relabel API fee metadata as PDF provenance.

## Release and verification boundary
Missing external evidence: current canonical Kalshi PDF receipt; Railway connector must have access to EXISTING `terrific-embrace` project/service; authenticated current financial/exchange reconciliation; production proof of protective-exit lifecycle; exact backend build healthy; publishing parity for frontend.

No live order, credential movement, global/account kill change, duplicate trade, database override, fake attestation or SHA approval is created by this change. The current production release is **NO-GO** until those genuine prerequisites pass.

## Rollback
If a new frontend or backend release has unexpected behavior, revert to last recorded passing SHA via controlled GitHub/Railway/Bolt deployment, preserving database audit rows. Do not delete signed release/ledger history or bypass account/global kill switches. Existing old-review records remain immutable historical evidence.

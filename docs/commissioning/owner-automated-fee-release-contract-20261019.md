# Owner-authorized automated fee verification — release contract

Status: **PROPOSED, NOT APPROVED, NOT DEPLOYED**. Keep the original execution kill switches and reviewer-dependent source route unchanged until a complete replacement passes review and automated tests.

## Preserved implementation
- `artifacts/api-server/src/lib/strata/ownerFeeEvidencePreflight.ts` offers a read-only official Kalshi KXBTC15M exact-market metadata probe. A positive result has `monetaryScheduleVerified: false` and never approves policy, account commissioning or trading.
- Existing `twoSourceFeeEvidence.ts` obtains series, individual market, event, series fee changes and event fee changes, rejecting mismatch, override, ambiguity and stale evidence.
- Fee reference calculations in `apiFeeRateReference.ts` are conservative risk estimates, **not** provider-confirmed settlement or charged fees.

## Remaining acceptance criteria before replacing human review
1. Establish versioned official-source proof for 0.07 coefficient, applicable maker/taker rules, monetary rounding, market-specific exclusions and effective date, alongside live multiplier and no impending fee overrides. Reject any missing/untrusted source.
2. Bind canonical signed server-side evidence to exact series, account scope, coefficient, rounding, policy revision, expiry and provider observation. Distinguish fee estimate from charged execution fees. Include a revocation/expiry path.
3. Explicit owner-authenticated Step 9 acceptance of the exact persisted evidence and seven policy limits. No inferred consent from a previous UI checkbox or chat message.
4. Update Step 11 commissioning, final-order entry, every emergency/protective exit and failover path to recompute or validate the same fee evidence and conservative all-in cost. Avoid inconsistent source-policy URLs or stale digests.
5. Test wrong exchange index, changed multiplier, fee overrides, pending changes, missing market, stale quote, cancelled grant, partial fill, UNKNOWN order and unavailable Kalshi; all fail closed without retries or money movement.
6. Complete review, CI and deployment provenance check before enabling a production switch. If any precondition fails, preserve kill switches, refuse Start and show a specific reason.

**No one is represented as an independent reviewer by this document.** The user's owner authorization is a real in-app action still required when monetary evidence is available.

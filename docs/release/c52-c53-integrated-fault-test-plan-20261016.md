# C52/C53 integration and protective-exit failure qualification

Status: REVIEW-ONLY, NOT A LIVE-TRADING RELEASE. Prepared 2026-10-16 CT.

## Branch inventory and provenance
- This branch was cut from PR #60 head `3192752111604dce5fc775d83cacb9eb253d35a5`; includes the offline #59 recovery reducer and the #60 review-only durable UNKNOWN marker.
- **NOT IN THIS BRANCH:** #53, #54, #55, #56 integration, #57 market fee origin/index changes. Do not report an integrated pass before these are deliberately incorporated and exact-head tests run.
- Reference proposed integration: #56 `dffab7d317d7286459ce1a2d235236f1af3ada17` (11 files, #53–55) and #57 `7ddcedf5702fa44c78f96f5fef6a8e55c635463c` (5 files).
- The shared workflow `.github/workflows/owner-fee-source-regression.yml` must retain both #56 regression suites AND #60 emergency IOC suites when resolving concurrent edits.

## Integration process for authorized developer
1. Independently approve or request changes on #53–55, #57, #59 and #60. Record named reviewers and exact head SHAs.
2. Review a single integration diff containing all of #56, #57 and #60; confirm no file was inadvertently replaced; use a *new isolated branch*, not `main`.
3. Run the exact integrated SHA through full ChatGPT V13 diagnostics, operator fee-source authorization/final-order regression, two-source fee preflight, canonical metadata smoke, PDF provenance probe, typecheck and isolated restart tests.
4. Do not interpret a successful *PDF provenance probe job* as valid provenance: require a genuine provider artifact, verified bytes/digest, freshness and market/event fee evidence.
5. Capture test run URLs, SHA, actual passed/failed assertions and a reviewed signoff. No merge to protected main until independent authorization.

## Mandatory fault-injection matrix
| Fault | Expected behavior | Evidence |
|---|---|---|
| No reservation/foreign owner/account/INDEX2 mismatch | Fail closed; no network POST | Auth/identity test |
| Stale fencing token or duplicate worker | No second authorization; no POST | Parallel lease test |
| Ambiguous/failed DB COMMIT | Fail closed; never infer durable authorization | Transaction fault test |
| Crash after UNKNOWN marker, before POST | No blind replay on restart; terminal UNKNOWN pending authenticated reconciliation | Restart test |
| HTTP timeout, 429, 5xx, missing response | UNKNOWN, no blind retry | Transport stub test |
| Zero IOC fill with complete history | Terminal reconciliation; no second POST on same reservation | Exchange-stub proof |
| Partial IOC fill | Reconcile exact remaining actual position; never exceed held quantity | Exchange-stub proof |
| Full IOC fill | Terminal reconciliation, no position inversion | Exchange-stub proof |
| Incomplete or contradictory fill/order/position history | UNKNOWN, block entries/new exit attempt pending review | History fault test |
| Fee policy expired/revoked or stale event override | New entries disabled; exit policy separately verified; no unverified fee assumptions | Policy/fence test |
| Missing or malformed outstanding-intent count | Fail closed rather than treating as zero | Supervisor test |
| Duplicate client_order_id across restarts | Never submit duplicate ambiguous IOC; exact durable uniqueness | Recovery test |
| Wrong market ticker or unexpected redirect | Reject before fees/order | Market/fee test |
| Concurrent position change | Recheck exact position + intent under locks, do not flip or enlarge | DB concurrency test |

Mock/offline tests are *necessary but not sufficient*. The signer-equipped dispatcher still requires independent reviewed real/sandbox controlled evidence for supported Kalshi order semantics and signed, reduce-only IOC. No production keys or endpoints in testing.

## Release NO-GO conditions
- Missing independently APPROVED review; unverified official fee provenance or current tariff; uncommissioned owner account; uncertain account balance, holdings or signer; no protected operational emergency exit; repo publicly exposing proprietary logic; missing exact deployed SHA comparison.
- Keep global live OFF and master/account kill switches ON. Never turn on order POST, fund transfers or workers on the strength of this document.
- Cross-reference release blocker issues #46, #50, #52 and #58.

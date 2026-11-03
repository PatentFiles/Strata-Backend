# Local protective fee successor candidate

Base: exact0044 tree `ca9460790a1b22c64022dc4d10035c068c211fef`. No production query, deployment, publication or order was performed.

## Consent and authority boundaries

The standing fee OWNER confirmation authorizes the monetary model for the existing grant and approved account policy at an exact release SHA. It is not consent to entries or exits. The separate independent standing execution review explicitly includes reduce-only exits for the exact account/policy/SHA. This candidate requires both, preserving the final signed dispatcher as the only order authority. It reads neither continuous entry grants nor technical entry/fee observation leases and executes no UPDATE/renewal.

If a current-SHA standing fee delegation or standing execution review has ever existed for the relevant scope, that history latches standing mode. Revoked or expired history cannot fall back to the legacy path. Exactly one eligible current successor must exist. A genuinely authorized replacement can qualify despite old revoked rows; revocation is not permanent poison for new consent.

Without standing history, the original path requires exactly one unrevoked, unexpired original review. With standing history, an unrevoked original signed-before-issuance review remains mandatory lineage, but natural review expiry is replaced by the current independently signed standing model and OWNER delegation. Multiple original lineage reviews are allowed in successor mode, matching standing enrollment's EXISTS semantics; a deterministic latest original review ID is pinned across checks. At most 64 original lineage rows are considered; 65 or more fails closed. Duplicate original row identities or owner consent identities fail closed. Grants and original consents remain non-revoked, scoped, confirmed and chronologically bound to the approved policy.

Successor checks bind grant/policy/model/digest/scope/SHA, current independent monetary ADMIN and issuer ADMIN roles, confirmed reviewer accounts, standing exit review role and explicit confirmation, non-revocation, signing/granting chronology, positive bounded validity and unique eligible model/delegation/exit-review evidence. The standing model table has no confirmation field: authenticated signing checks the model confirmation at creation. Existing table fields and model linkage are checked here, not fabricated.

## Final transaction contract

`verifyReviewedProtectiveExitFeeAuthority(ownerId, accountId, exactSha, db)` is read-only. In a caller-owned final transaction, its FOR SHARE locks retain the grant, original review, original consent, account/policy, successor model/delegation/exit review and relevant role rows until COMMIT. No provider request belongs inside this helper.

The public verifier returns an `authorityFingerprint` pinning kind, owner/account/SHA, policy, grant, original consent/review and successor IDs. The final dispatcher must call the helper after its second provider proof, require exact fingerprint equality, and keep the locks through the final transaction COMMIT. COMMIT releases all locks before signing or network transmission; the immediate beforeSend check bounds the remaining natural validity, while the existing final account/exit fences retain their concurrency contract. The helper returns positive finite `validForMs`, calculated by PostgreSQL from the chosen review expiry or minimum model/delegation expiry, capped at one hour. The dispatcher must sample monotonic time BEFORE the helper and recheck elapsed time against validForMs at beforeSend. Identities, not elapsed budgets, comprise the fingerprint.

The helper/source alone is NOT an integrated deployable fix. Final dispatcher integration and regression coverage are owned by the parent task. UNKNOWN/duplicate dispatch fences are unchanged here.

## Provider clock correction

The outer verifier samples its decision clock after the fresh exact-market provider reader completes, checks safe finite time and rollback, and compares the unchanged provider observation timestamp against that completion time. It preserves the provider reader's own three-second budget, the outer three-second staleness/future guards, exact ticker, market-open and digest checks. A slow authority lookup no longer makes a newly completed genuine observation look future-dated. No timestamp is restamped. Provider exceptions return a fixed safe reason.

## Verification

- Unit tests: 9 passed, including delayed DB/provider, timestamp preservation, rollback/nonfinite/future/stale and thrown-provider cases.
- PostgreSQL 16 and 17 disposable local clusters: actual authority SQL passed legacy/successor, 40 negative mutations, duplicates, original lineage, history latch, authorized replacement, unchanged expired lease and transaction-held revocation lock checks. Fixture tables intentionally omit uniqueness constraints so duplicate rejection is tested; this is SQL behavior testing, not a full migration/application integration suite.
- Library build and API typecheck passed. Final API typecheck status is recorded in `typecheck.log`; build prerequisite results in `libs-typecheck.log`.
- No final dispatcher integration, external-network behavior, full safety aggregate or deployment is claimed by this candidate.

Independent actual-verifier/actual-reader clock regression: 16/16 passed, including provider budget preservation and backward/nonfinite/fractional completion clocks. Retained peer evidence: `protective-fee-contract-audit-20261103/CANDIDATE-TEST.log`.

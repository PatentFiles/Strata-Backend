# Protective provider-proof freshness receipt

## Reproduced gap

The prior composed candidate allowed a synthetic transport attempt at provider age 3121 milliseconds when the final real PostgreSQL authority query was delayed by 3.10 seconds. Model/delegation, reservation and heartbeat lifetimes still passed. The provider's three-second age was checked before final work, not at beforeSend. Evidence: `freshness-gap-pg16.log` in the isolated audit directory. This was a real dispatcher/helper SQL composition with synthetic provider observations and transport; no external order occurred.

## Narrow correction

The actual successful verifier proof is frozen and entered into a private WeakMap. The receipt stores a native monotonic completion anchor, sampled immediately before the completion wall-clock read, and the remaining provider-age budget: 3000 minus max(0, completion wall time minus the original provider observation time). Future-tolerated observations never receive more than 3000 milliseconds. The actual observation timestamp is unchanged.

The synchronous exported `isReviewedProtectiveExitFeeFresh(proof)` accepts only that exact object. It reads native monotonic time and rejects missing/copy/forged proof, exceptions, nonfinite/negative/regressed time, and elapsed time beyond the original remaining budget. Equality remains allowed, matching the existing inclusive age <=3000 contract. Checking never resets the anchor or budget. Successful proof fields cannot be mutated because they are frozen. The only production consumer found is the dispatcher, which reads rather than mutates those fields.

The dispatcher closes over the actual second verifier result in `providerFresh`, alongside its existing monetary-authority fingerprint verifier. The existing synchronous beforeSend condition checks it after SQL/pool/COMMIT/signing work and before attempted=true. Failure sets expired=true and follows the existing final_evidence_expired known-never-sent path, persisting BLOCKED/VOID when exact cleanup evidence is available. No new GET, await, authorization, retry, threshold extension, public port or production clock injection is introduced. Explicit preexisting local fee-double bypass remains unchanged; tests injecting both fee and final authority must now use an actual branded proof.

The original completion-clock fix is retained. Host wall time is not consulted by the freshness check after proof creation. Mint-time performance.now exceptions still fail before any send; unlike the synchronous checker, that initial sampling exception is not converted to a fixed result in this narrow patch.

## Verification

- Ten unit tests passed: the prior nine fee authority/clock tests plus private receipt checks covering exact boundary, partial age, future clamp, copied/forged/mutated proof, repeated checks from one anchor, monotonic rollback/nonfinite/throw, and wall-clock rollback/unavailability after proof creation.
- Actual PostgreSQL 16 and 17 composed test passed ten scenarios. Original five authority/expiry cases remain covered. Added final-query delay, pool-acquisition delay, post-COMMIT delay and real signing-path synthetic synchronous delay each prevent transport and persist exactly one no-send audit with VOID reservation/BLOCKED intent. Repeated attempts preserve those states and never post.
- First proof older than three seconds while second proof is fresh still permits exactly one synthetic uncertain transport attempt, retaining UNKNOWN. This demonstrates second-proof binding rather than requiring the first proof to stay fresh.
- Private receipt and final authority checks use distinct budgets. No timestamp is restamped.
- API typecheck is recorded in `freshness-typecheck.log`.

## Limits and integration

The composed tests use the existing minimal real SQL schema fixture rather than full migration constraints/triggers. Initial enrollment/reservation rows, provider observations and authenticated position observations are synthetic. Uncertain transport is synthetic, except the signing-delay case exercises actual signing with a test-only delayed Sign.prototype.sign and traps raw fetch (which must remain uncalled). No fills, external services or deployment are tested.

Copy only the two changed source files, new `protectiveFeeFreshnessReceipt.test.ts`, updated `protectiveActualAuthorityDispatch.postgres.test.ts`, and this report into the combined candidate. The optional personal-branded-fixture.delta.patch is a narrow reference for the existing fence-focused test; do not replace the combined personal integration file wholesale. No package scripts were changed here. Full combined-suite and independent peer clearance belong to the coordinating task.

# Guarded six-lane integration (isolated)

This checkout integrates the fresh-binding hybrid with one shared scheduler. The absolute process-wide cap is6, including all classes; the legacy/default-off class is independently capped2. Total active work per credential key is capped6. A queued legacy job is not denied merely because experimental jobs already occupy two slots for that key: FIFO among runnable jobs gives it the next available slot before later experimental jobs.

Only an active, verified, prepaid60-token snapshot context can issue high-class eligibility. It issues at most six enqueue permits, one per fixed first-page group. Callers cannot provide a concurrency number or arbitrary permit. Capture occurs inside the returned Promise executor so rejection participates in existing allSettled drainage. Eligibility rechecks original batch signal, active invocation, configured target tuple, exact experimental mode and original500ms quota deadline when queued work is considered and immediately before operation invocation. Closed, expired, canceled, exhausted-permit or changed-mode contexts refuse; they never downgrade to legacy or refresh quota silently. Operations retain their enqueue AsyncResource context.

Balance occurs before the batch and retains the legacy lane class plus its existing separate1.2-second quota. Held/abort/recovery reads remain serial through the unchanged supervisor option guard. Every initial history request still executes fresh binding-only SQL before signing; every later page still debits and validates independently. Initial-six reservation gives no trading authority or reused credential validity.

Mode drift is also checked at actual ticket dispatch. A null ticket in any batch context is rejected even if the environment flag was disabled, so the client's default-off branch cannot turn a queued prepaid request into an unmetered send. Existing tickets retain captured mode and target scope.

Tests cover default-off/flag-only concurrency2, high-class6, mixed global cap, runnable FIFO, six-permit ceiling, queue expiry/closure/abort including differing job and batch signals, actual client mode-off before GET/during fresh SQL, and overlapping same/different credential scans. The partial-expiry native fixture delays one group's actual GET by530ms; with six lanes all other five may already send, and they are drained. This does not claim zero sends after a sibling was admitted, only no newly authorized dispatch after observed cancellation or invalidity.

The separately reviewed balance-quota query fusion is included. Its actual unit/native tests are rerun; no numerical latency savings are attributed to it because the historical measured balance duration did not separate its database round trips.

All changes remain isolated. Final source-bound end-to-end replay and independent review are required before any rollout decision. No production flag, schema, credential, safety control or order was changed.

# Isolated quota-only reservation with fresh binding per first page

This alternative preserves the prepaid60-token batch and500ms one-use quota-ticket deadline, but does NOT reuse batch-time credential validity for dispatch. After its lane wait, every first-page claim runs a new independent READ COMMITTED binding-only query using the same owner/account/provider/fingerprint/verified/unrevoked role predicates as ordinary admission. Exactly one current row must match the exact credential row-ID and role captured at reservation. Configuration changes refuse before/after that query. Claiming is marked before the await, preventing duplicate concurrent claims.

The binding-only query never spends or refunds quota. Successful validation returns the ORIGINAL opaque ticket; it does not mint or restart any clock. Signing and synchronous dispatch still enforce the original500ms window. Failed/unknown validation, cancellation, changed scope/role, expired ticket or lost acknowledgement yields no send, no fallback and no refund. Later pages retain ordinary fresh admission.

Thus no additional credential-observation lag is introduced versus the per-request baseline. This does NOT eliminate the baseline race between a committed READ COMMITTED observation and dispatch; no credential lock is held across network I/O. A revocation committed after the binding snapshot is not retrospectively observed by that query. Existing application authorization, STOP/lease checks, source clocks and final wire guards are unchanged.

A normal scan uses eight database calls: balance binding, batch debit, and six fresh first-page bindings. That is one MORE than the seven-call per-request baseline, not a query-count optimization. It provides fair clean cold reservation without competing per-group startup debits. Greater lane concurrency is a separate experimental sensitivity; the standalone hybrid tree retains two lanes; this integrated checkout uses the guarded six-lane scheduler described in guarded-six.md. No live latency or fill guarantee follows from it.

Uniform cap750/refill300, the500ms debit-to-dispatch bound, cold zero/no-refund semantics and database-clock assumptions from credits.md still apply. Old-cap/no-ticket workers must be excluded before rollout. This tree and all schemas remain isolated and unapplied.

## Queued invocation-context correction

The earlier lane could start a queued operation from another job's completion context, inheriting the wrong AsyncLocalStorage scan. This was reproduced: queued scanB observed scanA. The hybrid binds each operation to its enqueue async context with `AsyncResource.bind`. The bound closure is retained only by its queued/in-flight job; canceled queue entries are removed and existing abort-listener cleanup remains. Never-settling admitted operations intentionally retain their slot/context until real settlement.

A direct ALS regression plus actual native overlapping same-fingerprint and different-fingerprint scans verify separate invocation credits,7 requests per scan, exactly120 combined token debit and global concurrency<=6 in this guarded integration (<=2 in the original hybrid). The frozen older credit candidate retains this known multi-scan limitation and must not be deployed as-is.

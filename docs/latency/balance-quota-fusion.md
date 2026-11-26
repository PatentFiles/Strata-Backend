# Balance bucket-routing SQL fusion

This alternative does not cache authorization or change credential-revocation
observation timing. It replaces only the two-statement balance bucket-routing
branch (no explicit owner, valid signer fingerprint) with one statement.

The MATERIALIZED identity lookup retains DISTINCT owner, verified/unrevoked
credential predicates and LIMIT2. Exactly one non-null owner produces the same
`member:<owner>` bucket; missing/ambiguous identity uses the same conservative
fallback. PostgreSQL SHA256 over UTF8 reproduces the original Node hash bytes.
The 1.2-second reservation, bounded saturated-queue rejection, returned wait,
and 15ms wait padding are unchanged. Explicit-owner and missing/invalid-fingerprint
paths retain their original one-statement reservation and do not require the
credential table. No row lock is held during network I/O.

The actual signed balance transport still reserves/waits first, then checks the
authoritative current member binding, then signs/sends. Abort during the wait or
revocation observed by the final binding prevents a provider request. There is
no new credential cache or earlier authoritative check.

Native tests compare original and fused exact bucket keys, initial reservation,
concurrent spacing, saturation refusal, revoked/unverified/ambiguous identities,
and explicit/fallback behavior without a credential table. Synthetic actual
transport tests verify final binding and abort ordering with zero failed sends.

This removes one SQL round trip from eligible balance reads. It does not prove
an end-to-end latency improvement by itself. A timed replay must distinguish
provider balance latency from the old identity and slot SQL costs; subtracting
26ms from an already aggregated balance duration without that decomposition
would double-count an unproven saving. Concurrent history-query coalescing also
cannot be assumed to save a round trip on the critical path when those queries
already run concurrently.

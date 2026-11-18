# Experimental snapshot process options

Both options default OFF. Only the exact environment string `true` is parsed
as enabled. They are scheduling options, not authorization, and are not exposed
through HTTP bodies, database approval records, or owner consent receipts.

- `STRATA_FINAL_ACCOUNT_SNAPSHOT_OVERLAP_ENABLED`: permits the existing
  ENTRY-only fresh account snapshot overlap for supported reviewed API/durable
  fee sources. EXIT dispatch behavior is unchanged.
- `STRATA_BOUNDED_HISTORY_READS_ENABLED`: permits the bounded signed snapshot
  lane for supported-source startup/ordinary snapshots and the exact ENTRY
  final-proof context. FINAL EXIT, held recovery, and administrative readers
  remain sequential. Original clocks and authority checks are unchanged.

Neither option is enabled by this patch. Provider aggregate rate-budget
readiness remains a prerequisite for any separately approved rollout. The
process-local lane cap is not a provider-wide or cross-replica quota.

The wiring test executes real supervisor START/open and constructs the real
executor. Authority, database and provider ports plus timer scheduling are
synthetic. Borrowed transaction/held contexts in this test are fixtures, not
native locking or authorization evidence. Native transaction, failure/zero-POST,
and timed efficacy tests remain separate requirements. Exact parser tests and
source assertions cover process construction; actual environment deployment
and live performance are not verified by these tests.

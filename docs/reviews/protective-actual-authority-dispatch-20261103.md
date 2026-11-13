# Actual authority + signed dispatcher composition

Local test artifact: `artifacts/api-server/src/lib/strata/protectiveActualAuthorityDispatch.postgres.test.ts`.

The source under test is frozen successor verifier `5fe487d65c8104d01f9d29efe8d9ed36ee2d01e3105dfd6f1e5ebbd45f892078`, composed with the dispatcher copied from `strata-protective-exit-integration-1509` on November 3 at 15:15 UTC. No shared integration file was edited.

## What executes for real

- Actual public fee verifier calls its real authority SQL twice, once before and once after UNKNOWN marking.
- The actual UNKNOWN marker checks real reservation/account/worker/position/financial-intent rows and atomically moves PREPARED reservation to UNKNOWN and EXIT intent to DISPATCHED.
- The actual final helper executes current successor SQL in the final transaction, not a stubbed successful authority response.
- Actual standing-history and standing-exit-review SQL, signed dispatcher reservation/lease/account/global-control/position/intent fence, COMMIT, and validity-beforeSend checks execute against PostgreSQL.
- The actual no-send finalizer checks its row scopes and persists audit plus BLOCKED/VOID when DB authority expires after final COMMIT.
- Actual strict quantity parser function is extracted unchanged from its checked-in SQL.

## Cases

1. Unchanged current successor fingerprint: one synthetic uncertain transport attempt, durable UNKNOWN reservation and DISPATCHED intent. Repeat submits nothing and retains UNKNOWN, without inventing a no-send audit.
2. Standing fee delegation revoked during the second provider observation, after that observation's authority read: final helper denies, zero transport attempts, UNKNOWN retained on repeat.
3. Standing exit-review ID changed during second provider observation: final helper identity fingerprint differs, zero transport attempts, UNKNOWN retained on repeat.
4. Model/delegation expiry set to 250/200 milliseconds during second provider observation, then a real PostgreSQL pg_sleep delays final successor SELECT by 350 milliseconds: current SQL denies, zero attempts, UNKNOWN retained.
5. The same bounded expiry passes final authority and reservation queries, but a 350-millisecond delay after final COMMIT consumes original DB validity: beforeSend denies, actual finalizer records one no-send audit, reservation VOID and intent BLOCKED. Repeat neither posts nor changes these durable distinctions or duplicates the audit.

Position quantity remains unchanged in every case.

## Exact limits

The tables are a minimal isolated schema with required columns, not the complete migrations or their full constraints/triggers. Initial approved authority, PREPARED reservation and intent are fixture setup, not live enrollment or reservation-creation coverage. Provider metadata and authenticated-position observations are synthetic. The outbound transport is a throwing test seam, so no external request, signature transport, actual fill or authenticated reconciliation is tested. All authority, marker and final-fence database queries are real PostgreSQL queries; none returns fabricated successful rows. Natural expiry testing intentionally uses brief real DB lifetimes, not production timeouts or a timing benchmark.

Disposable clusters bind only loopback on random ephemeral ports, strip credentials, install an external-network deny fence and stop after testing. No production query, order, publication or deployment occurred.

---
name: Durable fee verification fence
description: Why runtime fee observations and the final order interlock need a separate durable verification gate
---

Before observing live fee metadata or the canonical artifact for an existing approval, commit a closed verification attempt. A crash during the read must leave eligibility closed; later successful reads must not silently reopen a stranded attempt or a definitive invalidation. A temporary source outage is different from a definitive mismatch and does not revoke the approved artifact identity. A PDF read, even when successful, is not proof of current live series/event fees: only fresh authenticated market-fee evidence may mark the runtime gate verified.

**Why:** A process-local latch or an asynchronous config update can lose an observed mismatch on crash. More subtly, a config-row lock alone does not serialize the fee-verification state with the final exchange POST. Trying to update that same config row while its outer submission transaction holds it can deadlock. Treating PDF availability as verified runtime evidence—or allowing an unavailable gate through—can falsely authorize a real order.

On 2026-09-27, Kalshi's canonical fee PDF returned HTTP 429 with a Vercel challenge to the development server. The attached owner PDF could be parsed and matched the document's indexed text, but neither that upload nor a mocked 200 response establishes the pinned live source hash.

**Why:** Fixing a local text-parser false rejection can expose a second, independent source-availability gate. Treating those as the same error would encourage bypassing provenance when the official host challenges automated access.

**How to apply:** Normally keep source-verified review pending on a canonical-source 429. A separately labeled, incident-scoped commissioning-only owner attestation may bind the exact reviewed bytes to an approval record without pretending they were server-fetched. This cannot authorize a run or replace fresh, authenticated market-specific fee metadata; outside that explicit path, recheck exact canonical bytes when the official source becomes accessible.

**How to apply:** Keep the fee gate independent of the config row; precommit a pending attempt before I/O, persist its result synchronously, and hold the matching gate row lock in the final submission transaction only after the last live metadata read, through the POST. Require exact approval identity, matching evidence fingerprint and timestamp, and a fresh verified status at that barrier. A PDF outage can leave approval intact but does not count as live evidence; a fresh market-fee read can reverify. An orphaned pending attempt needs explicit administrator review/reapproval, not an automatic successful retry.
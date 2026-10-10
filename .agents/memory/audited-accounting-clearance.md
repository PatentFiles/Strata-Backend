---
name: Audited accounting clearance
description: Safety boundaries when a read-only exchange audit informs a later administrative accounting write.
---

For a narrow administrative clearance, keep the authenticated exchange scan GET-only and do not mistake its success for execution readiness. A separate durable decision must record the reviewed reason and a non-sensitive evidence fingerprint, and the write must leave trading gates closed.

**Why:** A complete audit can become stale while a transaction waits for a lock. Even a newly inserted blocked decision changes the evidence context; checking only successful or error decisions misses that concurrent ledger change.

**How to apply:** At the final locked write boundary, recheck audit age and supersession, all local ledger/decision changes, environment and database gates, account binding, and any one-use reservations. Reject and require a fresh audit on drift; do not grant readiness as a side effect of clearing an accounting marker.
---
name: Production paper-worker approval
description: Approval and safety boundary for rolling out the server-side V1.3 paper forward test.
---

The production paper worker had to stay disabled during initial deployment and verification. The user explicitly approved enabling the existing PAPER_ONLY startup gate after the production schema was verified; that approval does not authorize real orders, strategy changes, or fabricated results. Production schema changes must preserve existing data; publishing must not use the overwrite-data option.

**Why:** The user authorized a controlled production rollout, not an automatic start of background paper evaluations or a copy of development data into production.

**How to apply:** Treat a successful publish as a separate milestone from confirming the worker actually started. Verify production status, lease, and ongoing activity after activation. No real-order or trading-account functionality belongs in this worker.

A successful Reserved VM build does not prove Replit applied the managed production schema diff. In this rollout, the first publish was healthy at the process level while all five new forward-test tables remained absent and the same additive diff remained pending.

**Why:** Build health and database migration completion are separate checks; assuming they coincide would misreport the status API as ready.

**How to apply:** After any schema-related publish, inspect the production table catalog and compare Replit's pending diff again before considering worker activation. Never use a data overwrite or ad hoc production DDL to hide a missing migration.
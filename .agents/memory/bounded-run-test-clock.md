---
name: Bounded run test clock coherence
description: Safe fixture timing for simulated expiry and restart recovery.
---

When testing approval expiry with an injected clock, keep the post-arm signal timestamp after arming but not ahead of the injected clock. Also keep mocked account-history scan times fresh relative to both that clock and wall time; fee evidence has its own freshness window. Advancing only one timestamp can cause a different safety gate to block before the intended assertion.

**Why:** Several isolated tests initially failed at evaluation freshness or history-scan completeness, rather than reaching the intended expiry and restart gates.

**How to apply:** In disposable-schema expiry/recovery tests, align arming time, evaluation time, fee verification, account-history scan, and injected now before asserting a specific blocking reason. Never loosen the production freshness guards to accommodate fixtures.

Simulate a new process by resetting isolated process-local state, not by rotating the persisted run identity. The durable primary cash anchor belongs to the original run.

**Why:** Changing the run identifier to force a restart branch manufactured a baseline/run mismatch and prevented a valid recovery test from reaching its intended path.

**How to apply:** Preserve persisted run identity and baseline when testing restart; use an explicitly isolated test reset for in-memory readiness/operation state.
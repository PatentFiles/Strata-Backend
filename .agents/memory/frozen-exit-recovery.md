---
name: Frozen exit recovery
description: Why irreversible execution and cancellation barriers must not suppress later authenticated accounting reads.
---

An exit that has been submitted, become terminal, or acquired an irreversible cancellation claim must not silently regain execution readiness. But a permanent POST/DELETE prohibition is **not** a prohibition on authenticated GET-only reconciliation. Keep the gates frozen while ingesting later verified fills, fees, and terminal status on ordinary restarts, even if a previous read found the exit canceled without a local DELETE claim.

**Why:** An uncertain DELETE can still fill after the first read, and an exchange-terminal IOC can reveal fills after the first snapshot. An early "already attempted" return prevented both a repeated mutation and safe accounting recovery, leaving the local position and P&L stale. The safe distinction is between mutation authority and evidence collection, not between a claimed and unclaimed exit.

**How to apply:** Preserve durable single-use claims and never retry DELETE or restore POST readiness from frozen recovery. Verify exact order identity, complete account activity and authoritative fill totals before ledger writes; missing or conflicting evidence stays frozen for manual review. Mocked exchange behavior does not establish real account exclusivity or authorize live orders.

Cash eligibility is required before renewed execution, but must not be used as an early return that prevents already-frozen GET-only recovery from committing independently verified late fills.

Commit a one-use cancellation authorization before any exchange GET or DELETE, and require the process that acquired the worker lease to hold it through a fresh pre-DELETE check. A context flag or an observation of another process's lease is not ownership.

**Why:** An uncertain DELETE inside the authorization transaction could roll back its consumed marker; a restart could then remint it. A database lease read alone could let a non-owner process authorize mutation.

**How to apply:** Treat authorization persistence and network I/O as separate phases. On any error after commit, keep the marker spent, leave trading frozen, and use only authenticated GETs to resolve the order.

**Why:** A cash mismatch or stale available-balance snapshot can coexist with a real late exchange fill; discarding that fill leaves the frozen ledger less accurate without making execution safer.

**How to apply:** Keep frozen recovery non-ready, maintain accounting-unresolved gates where needed, and allow exact authenticated GET-only fill/status reconciliation before assessing eligibility for any separate reactivation.
---
name: Forward-test scope
description: Why persistent server forward-test state and browser-saved history must remain distinct.
---

The V1.3 server forward-test engine is a single service-wide paper-only process, not one engine per signed-in user. Its persistent state and research evaluations are distinct from the existing account-scoped browser paper/live history.

**Why:** The phased request calls for one active V1.3 engine while preserving existing saved history and behavior. Combining the records or totals would make it appear that a new server worker had produced historical browser trades, or that a user's private ledger was shared.

**How to apply:** When a worker is deliberately added later, keep its writes in the server forward-test domain and its status clearly labeled. Do not backfill, merge, or overwrite account history to make the server metrics look populated.

Read-only server history and dashboard totals must describe the same engine-owned position set, rather than mixing in unrelated test or diagnostic data. A position that is CLOSED with no settlement result is not market-settled, even if it has a realized paper P&L.

The user confirmed that the separate server display and explicit CLOSED/not-market-settled wording work as intended in the authenticated development UI.

**Why:** A shared server ledger and a private browser/account ledger answer different questions. Mixing scopes or treating an early exit as settlement makes a correct display look like missing or fabricated trades.

**How to apply:** Keep the server-history display separate from account history, match its total to the server-status scope, and use stored paper P&L rather than reconstructing it in the browser.

Lease integration tests need their own enabled fixture engine, which cannot coexist with the active development engine in the same database schema because of the singleton constraint.

**Why:** The singleton index correctly rejects a second enabled V1.3 engine; a test failure in that situation does not mean lease acquisition is broken.

**How to apply:** Use the test runner's disposable schema with an intact copy of the singleton index. Never pause, disable, or reset the development worker to accommodate tests; never run these tests against production.
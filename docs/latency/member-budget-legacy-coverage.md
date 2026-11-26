# Legacy authenticated REST transport coverage

This change does not enable the experimental budget. With the mode absent or
`off`, legacy transport admission remains unchanged. With experimental mode
active, every listed path below either shares token admission or refuses before
signing/sending; a failure never silently falls back to an unbudgeted request.

## Shared admission
- `kalshiTradingClient` production GETs: existing credential/account checks run
  first, exact path (without query) is charged before signing. Order detail costs
  2, other accepted fixed GETs use the captured schedule. Scope is rechecked
  after the asynchronous debit. POST/DELETE order methods are not charged by
  this Read-only hook and retain existing mutation authorization.
- `directRoundingTransport` API-key and subaccount-balance GETs: immutable local
  key material is bound to the debit, then used for signing. Each costs10.
- `kalshiAccountClient` central scoped GET and verifier changes are maintained
  separately in the same candidate; this document does not replace their tests.

## Explicitly unavailable while experimental mode is enabled
- Legacy funding-client GETs and subaccount transfer POST.
- Legacy provisioning signed GET/subaccount creation POST.
- Pair-key inventory/generation and standalone restricted-key generation.
- Provisioning recovery GETs.

These paths still have legacy credential or bucket-integration seams. Known
endpoint cost alone does not establish member identity or safely add the
separate balance limiter. They refuse `kalshi_member_budget_transport_unsupported`
before signing instead of creating per-key buckets or skipping shared admission.
This changes provisioning/funding/recovery availability and is a rollout blocker
where those workflows are required. It is not full legacy-feature availability.
Mapped modern scoped GET recovery remains available through the central client.

Order-only production executors and emergency exit mutation transports are
untouched. A legacy cancellation may still require a GET or verifier dependency;
its complete availability depends on those dependencies passing admission.
Unsigned public readers and authenticated WebSocket handshakes are separately
classified, not asserted to be covered by this REST Read-bucket implementation.
No external applications or uninstrumented replicas are controlled here.

## Test evidence and limits
`member-budget-legacy.test.mjs` bundles actual transport functions. Unsupported
branches refuse before signing/network; mapped trading and rounding cases use
real local RSA signing with synthetic database admission and synthetic fetch,
assert debit costs and no send after denied binding. This is not a live provider
or production database test. Existing legacy tests exercise default-off behavior.

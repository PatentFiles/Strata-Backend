# Strata engineering instructions — public self-service

## Current product contract
Strata is a public multi-tenant trading product, not a fixed pilot. A newly
registered eligible STANDARD customer owns and operates their own Kalshi
account: register, enter/reuse the five credential cards, Verify & Commission,
complete genuine owner financial decisions, then deliberately Start Trading.

Do not introduce customer UUID/account allowlists, second-person routine
commissioning, another customer's credentials, administrator enrollment or
per-customer deployment configuration. Platform-level release qualification
and emergency safety controls are not customer enrollment. Historical
private-pilot instructions are superseded for public onboarding; retain their
records and narrow recovery/compatibility paths, not their product limits.

## Authority boundaries
Derive customer scope from authenticated AAL2 identity and current DB-owned
account, exchange credential linkage, approved policy, cash conservation and
signed provider evidence. Scope resolution is not fee consent or a trading
permit. Never label owner consent or machine verification as human review.
Respect genuine external legal, provider and monetary requirements. Never
manufacture evidence, silently migrate approved financial terms, clear
unrelated freezes or bypass the kill switch. START remains a deliberate owner
action; final order authority requires the existing locked fee/risk/lease
and one-use wire checks. Preserve protective exits.

The public path is gated by platform-wide STRATA_PUBLIC_SELF_SERVICE_ENABLED
and STRATA_PUBLIC_SELF_SERVICE_QUALIFIED_SHA matching the actual Railway
deployed Git SHA. Do not set these to enable live execution before exact
release qualification. The historical pilot configuration is not consulted
when public mode is requested. No customer-specific environment variable is
permitted in the public path.

## Strategy and release
Preserve the verified V13/BTC15M strategy, champion, signal timing, entry/exit,
sizing, fees, risk settings and execution behavior. Do not infer original-bot
parity without an authoritative artifact. Keep historical documents as
historical evidence. Use two new independent STANDARD customers in native
disposable PostgreSQL and isolated browser tests, no live orders. Validate
migrations, exact-head CI, cross-tenant and restart behavior before protected
main merges. Distinguish recovery software release from live activation.

## Manual platform fee publication (supersedes recurring PDF retrieval)
In the explicit manual upload mode the platform administrator publishes the applicable official fee schedule, retaining original bytes, effective date, digest and uploader attestation. An upload is NOT a fresh issuer capture. No routine PDF downloads are required for approved durable terms. Preserve exact current market API checks, account-bound owner consent, changed-document invalidation, order and accounting safeguards. Only supported monetary rules may be accepted. Never claim issuer freshness or silently expand existing owner financial consent.

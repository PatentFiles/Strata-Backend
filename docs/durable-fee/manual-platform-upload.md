# Manual platform fee publication

The administrator downloads and explicitly uploads a supported official fee schedule once. The original bytes, digest, effective date and uploader attestation remain immutable. A successful upload is not proof of a fresh issuer HTTP response, not automatically current at the issuer, and not a customer trading grant. The existing durable owner model uses content-addressed uploaded evidence and explicit consent. Its normal exact market API/financial checks remain; there is no periodic PDF download requirement in manual mode.

Migration: lib/db/owner-self-release/007_platform_uploaded_fee_schedule.sql (after 0049 and the existing durable-fee migrations). Feature: STRATA_PLATFORM_FEE_UPLOAD_ENABLED=true only after qualification. Keep the public execution flags off until native schema, upload, full integration and runtime qualification pass. Disable the periodic collector in manual mode. Do not apply migration or set the flag on production without qualification.

Wallets provides ADMIN/AAL2-only review, explicit attestation, publication, active-document metadata, paginated history and explicit withdrawal. Roles are resolved from authenticated identity and checked again against verified, non-banned DB identity, profile and role assignment inside the publication transaction. Client role claims cannot publish. Preview parses the actual bytes without storing or granting authority; publication re-parses and checks the reviewed digest. Only the backend's database role can read/write the private registry; browser and service-role grants are revoked and RLS is forced.

The strict parser and existing schema support the complete reviewed July 7, 2026 text, including applicability and rounding. The normalized-text digest is `eea4ebde4c34bdbb79e26bfc4c5daebe6ef393bcb2e13cedfe042abe028ec1e8`; its supported-terms ID is `kalshi-july-07-2026-eea4ebde-v1`. Equivalent bytes with the same reviewed terms preserve applicable manual-source owner consent without rewriting immutable models. A genuinely different formula, date or applicability remains unsupported until parser, calculation-engine compatibility, database constraints and owner-specific consent transitions are qualified together. No different future publication is represented as tested here.

Replacement and withdrawal take the same exclusive publication advisory lock. Owner model insertion and risk approval take its shared lock. Database cutover inspection locks position, intent and worker-lease tables until commit, preventing phantom exposure. Replacement requires no open exposure, nonterminal intent, or owned/armed worker lease. Re-uploading the active PDF is idempotent. A superseded or withdrawn digest cannot regain active status. Withdrawal appends administrator identity and timestamp, retains bytes and history, and blocks prior manual models without clearing any unrelated financial hold. A missing/withdrawn latest publication never falls back to an older row.

Release reauthorization binds each owner's unchanged model, policy, credentials and new backend SHA. A stopped account can still finish an in-flight signed cash reconciliation; a revision-only race now rolls back and repeats all evidence reads, at most twice. Initial risk approval likewise retries full transactions only for PostgreSQL's definite transaction-abort codes 40001/40P01. Unknown commit/rollback outcomes remain blocked and never auto-retry.

## Disposable local qualification

Use Node.js 24 and pnpm 9.15.9. From the backend root, run `pnpm run test:platform-fee-native-local`. Docker must be running. The runner creates its own randomly labelled PostgreSQL 16/17 containers with `--network none`, no published port, and no copied application environment. It verifies the label before invoking the same CI harness or removing its containers. Four fresh/upgrade scenarios cover transactional DDL rollback, financial snapshots, immutable history, integrity, role/ACL denial, model scope, equivalent replacement, withdrawal and unresolved exposure. Logs live in ignored `docs/platform-fee-native/local-evidence/`.

From the sibling frontend checkout use `npm run test:wallets-native-local`; see its `scripts/onboarding-integration/README.md`. It uses the actual backend source and migrations, including this migration. The browser suite proves real route parsing/persistence, two STANDARD customers, forced overlapping serializable approvals, signed synthetic exchange reads, actual START/STOP routes, process restart, release reauthorization, safe replacement and withdrawal. It makes no issuer PDF request and sends no order or transfer.

## Production sequence

After exact candidate checks and main merges, apply the qualified `007` once to the verified Supabase project. It does not insert a publication or change customer balances. Stage these global flags for the user's next Railway deployment:

```text
STRATA_PLATFORM_FEE_UPLOAD_ENABLED=true
STRATA_PLATFORM_FEE_CAPTURE_ENABLED=false
STRATA_V5_RAILWAY_CAPTURE_ENABLED=false
STRATA_FEE_BRIDGE_CANARY_ON_BOOT=false
```

Preserve existing durable-owner, owner-activation and signed-protective configuration. Update Railway's exact source pin to the qualified backend main SHA; the user deploys Railway and publishes Bolt. The administrator must then upload and attest the applicable official PDF. Only after accepted stored evidence and exact deployed SHA verification may public self-service be enabled with `STRATA_PUBLIC_SELF_SERVICE_ENABLED=true`, `STRATA_PUBLIC_SELF_SERVICE_QUALIFIED_SHA=<actual deployed qualified SHA>`, and `STRATA_INDEPENDENT_LIVE_SOURCE_V1=true`. No synthetic test result constitutes authenticated production trading readiness. Customers still deliberately approve their own financial terms and START.

The strategy directory is unchanged. Champion `v13-champion-2-c52-confirm53` retains canonical parameter hash `314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161`.

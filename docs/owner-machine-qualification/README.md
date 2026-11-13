# Draft owner-only qualification tooling

This branch stages a manually dispatched qualification workflow and protected behavioral expectations. It changes no application runtime, migration, live approval, trading gate or order path. It has no push/PR trigger, no deploy step and no production credentials.

The workflow deliberately fails before dependency installation while completeOwnerRecoveryQualification and candidateApplicationPublished are false or unqualified coverage remains. No success or release evidence can be claimed from this draft. Source implementing the new owner-only path is not included in this tooling-only branch.

Locally verified against a separate candidate checkout: 145 behavioral scenarios (60 consent/router/readback, 26 native-ledger, 30 atomic credential/lifecycle/provider/runtime-diagnostic cases, 13 actual-writer cases, 9 provider-identity cases, 7 native role-probe cases), including before-send COMMIT failure and after-commit lost acknowledgment. These are synthetic provider/authority fixtures using disposable databases, not current account evidence.

Before a genuine run: add completed candidate implementation and protected assertions for all real writers, production-equivalent roles/schema/migration lifecycle, and mounted release behavior; freeze an exact revision; adopt workflow/policy pins outside candidate-controlled configuration; verify clean CI dependencies and the actual run/artifact. Then separately verify deployed bytes and current account state through permitted access. Do not merely change flags to true.

Fixture account identifiers are synthetic. No independent human review is represented or requested by this machinery. The owner remains responsible for the final live START.

The role probe models least-privilege and dangerous grants in disposable PostgreSQL. It detects missing required tables rather than treating absent schema as healthy. It does not prove deployed role/schema equivalence or inspect real accounts.

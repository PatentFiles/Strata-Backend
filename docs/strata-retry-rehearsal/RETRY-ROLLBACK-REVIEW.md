# Retry release binding and forward-safe rollback (orders-off design)

The release binding defaults off and is outside the migration journal. It never grants EXECUTE or enables a runtime. If a future approved matched worker calls the restricted wrapper, the application must consume the process-local typed first-read rejection **once**, bind it to the exact active lifecycle before issuing the SQL, and deny outdated/deposed loop ownership. SQL checks approval of exact account/owner/release, locks the account, and validates the lease, holder, fence, credential pin, armed status and heartbeat before invoking the one-shot receipt fence. The generic API connection must be unable to call this or write these tables. The wrapper only proves the stated DB facts; the separate writer's secret-bearing login and unexported capability are what authenticate origin. Do not grant EXECUTE to the ordinary runtime role.

Retiring a source while an unresolved intent or reserve exists remains impossible. No receipt can establish positive proof for historic attempts. A refused SQL write, lost result, clock failure or restart must not be reconstructed as a new receipt. The current source remains limited to sealed data and the original five-second limit.

## Required rollback bridge

Do not redeploy #372, #374, or unmodified #375 after the retry DDL activation: those binaries use a removed unique conflict target. Do not re-add observation uniqueness after a replacement has been stored; the original and replacement are both immutable and an intent can reference the replacement. Never delete or modify those historical rows to roll back a release.

A compatible rollback release must use the activated storage contract (`ON CONFLICT(id)` and current/unretired exact reads), must never record refusals, and must deny entries until the owner has completed an exact release authorization. Turning off receipt writes alone is insufficient: an already committed first receipt may leave this market eligible to select its one replacement. Add a distinct replacement-admission stop fence, enforced at claim in the same account transaction, and test disabling while capture races. Existing EXIT and order reconciliation remain on the existing path. Freeze and drain entries, verify venue/account outcomes, and preserve the active migration plus all source and intent rows. If there is no prequalified bridge, do not activate retry in production.

This packet does not provide an integrated trusted role, a continuity-tested rollback bridge or any production release evidence.

A retry switch is not an exchange STOP. A previously committed PREPARED intent has
already passed the insert fence. Before migration/rollback, close the actual
account entry gate, drain in-flight prepares and dispatches, and reconcile the
venue results. The exact future runtime must also deny an unsent generation-2
PREPARED intent at dispatch after the retry stop; test both prepare-before-stop
and dispatch-before-stop with the authenticated outcome unknown case. Neither
the switch nor the fixtures in this folder grant permission to retry a wire call.

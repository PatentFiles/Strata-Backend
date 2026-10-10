---
name: Shared-workspace subagent failures
description: Partial writes and browser-interception failures may survive a helper's failed attempt.
---

When a shared-workspace subagent reports an authorization failure, inspect the working tree and relevant files before repeating its task. The failure does not imply its edits were rolled back.

**Why:** During a Phase 4A safety follow-up, several subagents were denied before completion, but portions of their fixes were already present in the shared workspace. Blindly repeating their instructions would have risked conflicting edits.

**How to apply:** Compare the reported pending fixes with the current code, then make only the remaining changes and verify them.

Browser helper failures are not evidence that the application is broken. Do not assume its wrapper exposes every native Playwright interception method.

**Why:** An unsupported interception `abort()` produced the same exception during subsequent empty-context creation, before navigation. A separate isolated browser verified the application successfully.

**How to apply:** Establish read-only request guards using supported browser capabilities. If helper context creation fails, report that tooling limitation or use an independent isolated browser; never restart the application or permit history writes to work around the helper.
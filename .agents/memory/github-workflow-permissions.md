---
name: GitHub workflow permissions
description: Handling observed workflow-scope restrictions without replacing credentials.
---

The connected GitHub OAuth App has refused a push that changed a workflow file because it lacked the `workflow` scope. Treat this as an observed permission limitation, not proof that future credentials have the same scopes.

**Why:** The handoff allowed source, test and documentation work but prohibited credential changes. The existing CI already invoked a V13 safety-suite package command, so adding focused tests to that command supplied coverage without editing workflow configuration or widening permissions.

**How to apply:** For ordinary test additions, use an appropriate existing CI script entrypoint when available. If actual workflow configuration needs changing, obtain owner-approved authorization through the supported connection flow; do not replace credentials or repeatedly retry the same denied push.

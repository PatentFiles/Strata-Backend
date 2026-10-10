---
name: Historical strategy identity
description: Preserve unknown strategy provenance when adding or changing champion identity.
---

Never infer historical parameter identity from the currently selected champion.
Unknown historical records must remain explicitly unknown and cannot supply
execution authority.

**Why:** The user requires preserved history. A current-champion schema default
can silently relabel old observations without changing their trade amounts.

**How to apply:** Review identity defaults and migration/backfill behavior during
champion changes; verify historical provenance on a restored pre-upgrade dataset.
Test that unknown and partial identity cannot pass execution gates.

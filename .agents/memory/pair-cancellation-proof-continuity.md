---
name: Pair cancellation proof continuity
description: Why a frozen dedicated-pair cancellation needs consistent authorization context across layered signed-client guards
---

For a dedicated-pair exit, a durable one-use cancellation claim and a verified frozen recovery proof are necessary but not sufficient: every authorization check in the signed DELETE path must receive the same recovery mode and exact evidence digest. POST authorization must continue to require its separate final-POST proof.

**Why:** A nested generic request guard independently rechecked authorization with its default POST mode after the outer cancellation check passed. The real DELETE failed closed only after the irreversible cancellation claim was consumed; a permissive mock verifier missed it. A strict mocked signed-client test that accepts only the recovery mode and digest at both checks exposed the gap.

**How to apply:** When changing signed mutation wrappers, inspect inner generic transport guards as well as the outer method. Test exact proof context at each layer with a verifier that rejects default or alternate modes, without issuing a real exchange mutation.
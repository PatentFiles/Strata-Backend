import {runHeldReconciliationFence} from './heldReconciliationFence.postgres.fixture';

// Canonical disposable runner only: full schema plus the combined worker LOGIN.
// Reuses exactly seven existing restart outcomes without changing assertions.
runHeldReconciliationFence({restricted:true});

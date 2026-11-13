import { createHash, randomUUID } from "node:crypto";

/** No database/network imports: the real adapter and offline mocks use this same orchestration. */
export type Row = Record<string, unknown>;
export const REPAIR_REASON = "v13_dedicated_pair_commissioning_reconciliation";
export const LINKAGE_FIELDS = [
  "microLiveFundingAnchorSubaccount", "microLiveFundingAnchorExchangeIndex",
  "microLiveFundingAnchorTransferId", "microLiveFundingAnchorTransferAt",
  "microLiveFundingAnchorAmountCents", "microLivePairCashBaselineMicros",
  "microLivePairCashBaselineRunId", "microLivePairCashBaselineAt",
  "microLivePairCashBaselineEvidenceDigest", "microLiveAccountActivityCheckpointSubaccount",
  "microLiveAccountActivityCheckpointExchangeIndex", "microLiveAccountActivityCheckpointRunId",
  "microLiveAccountActivityCheckpointCursor", "microLiveAccountActivityCheckpointAt",
  "microLiveAccountActivityCheckpointEvidenceDigest", "microLiveRestrictedApiKeyId",
  "microLiveRestrictedKeyFingerprint",
] as const;
const MUTABLE = new Set<string>([
  ...LINKAGE_FIELDS, "microLiveRunId", "microLiveAccountMode",
  "microLiveSelectedSubaccount", "microLiveSelectedExchangeIndex", "updatedAt",
]);
export function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function requireRepair(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
export type Snapshot = {
  config: Row; original: Row; live: Row; boundary: Row;
  archive: Row; afterArchive?: Row; audit?: Row;
};
export type FreshProof = {
  keyId: string; fingerprint: string; cursor: string; checkpointDigest: string;
  scanAt: Date; checkedAt: Date;
};
export type Plan = { before: Row; after: Row; patch: Row; proof: FreshProof };
export interface RepairTransaction {
  read(expectedRun: string): Promise<Snapshot>;
  authenticate(snapshot: Snapshot, ticker: string): Promise<FreshProof>;
  write(plan: Plan, actor: string): Promise<void>;
}
export interface RepairPort {
  proveDevelopment(): Promise<void>;
  transaction<T>(apply: boolean, body: (tx: RepairTransaction) => Promise<T>): Promise<T>;
}
export type RepairRequest = {
  apply: boolean; actor: string; expectedRun: string; ticker: string;
  binding: { accountMode: string; subaccount: number; exchangeIndex: number };
};

export function parseRepairArguments(args: string[]): RepairRequest {
  const allowed = new Set(["dry-run", "apply-development-commissioning",
    "expected-run-id", "actor", "ticker", "account-mode", "subaccount", "exchange-index"]);
  const options = new Map<string, string>();
  for (const argument of args) {
    const match = /^--([a-z-]+)(?:=(.+))?$/.exec(argument);
    if (!match || !allowed.has(match[1]) || options.has(match[1])) throw new Error("invalid_arguments");
    options.set(match[1], match[2] ?? "true");
  }
  for (const flag of ["dry-run", "apply-development-commissioning"]) {
    if (options.has(flag) && options.get(flag) !== "true") throw new Error("invalid_arguments");
  }
  const dry = options.get("dry-run") === "true";
  const apply = options.get("apply-development-commissioning") === "true";
  if (dry === apply) throw new Error("exactly_one_explicit_mode_required");
  return { apply, actor: options.get("actor") ?? "", expectedRun: options.get("expected-run-id") ?? "",
    ticker: options.get("ticker") ?? "", binding: {
      accountMode: options.get("account-mode") ?? "",
      subaccount: Number(options.get("subaccount")),
      exchangeIndex: Number(options.get("exchange-index")),
    } };
}

function closed(config: Row, live: Row) {
  requireRepair(config.microLiveRunPhase === "FROZEN" &&
    config.manualKillSwitch === true && live.manualKillSwitch === true &&
    config.liveExecutionEnabled === false && config.microLiveProductionEnabled === false &&
    live.liveExecutionEnabled === false &&
    config.microLiveEntryAttempted === false && config.microLiveExitAttempted === false &&
    config.microLiveReservedMicros === 0 && config.microLiveAccountingUnresolved === false,
  "frozen_closed_unused_state_required");
}

export async function runCommissioningTransition(port: RepairPort, request: RepairRequest) {
  requireRepair(request.binding.accountMode === "exclusive" &&
    request.binding.subaccount === 1 && request.binding.exchangeIndex === 2,
  "dedicated_binding_required");
  requireRepair(/^[0-9a-f-]{36}$/i.test(request.expectedRun) &&
    /^[A-Za-z0-9_:@.-]{1,128}$/.test(request.actor) &&
    /^KXBTC15M-[A-Z0-9-]+$/.test(request.ticker), "explicit_identity_required");
  await port.proveDevelopment();
  return port.transaction(request.apply, async tx => {
    const state = await tx.read(request.expectedRun);
    const { config, original, live, boundary, archive, audit, afterArchive } = state;
    closed(config, live);
    requireRepair(original.microLiveRunId === request.expectedRun &&
      original.microLiveRunPhase === "FROZEN" &&
      original.microLiveRunCapMicros === 1_000_000 &&
      original.microLiveAccountMode === "primary_nonexclusive" &&
      original.microLiveSelectedSubaccount === 0 &&
      original.microLiveSelectedExchangeIndex === null &&
      original.microLiveRunFreezeReason === "entry_expired_without_proven_terminal_position" &&
      LINKAGE_FIELDS.every(field => original[field] === null) &&
      Object.entries(original).every(([field, value]) =>
        !/^microLivePrimary(CashBaseline|ActivityCheckpoint)/.test(field) || value === null),
    "expected_historical_snapshot_required");
    requireRepair(archive.priorRunId === request.expectedRun &&
      archive.snapshotDigest === digest(original), "historical_archive_mismatch");
    const already = !!audit;
    if (already) {
      requireRepair(audit.priorRunId === request.expectedRun &&
        audit.successorRunId === config.microLiveRunId &&
        audit.transitionReason === REPAIR_REASON && !!afterArchive &&
        afterArchive.priorRunId === config.microLiveRunId &&
        afterArchive.snapshotDigest === digest(config) &&
        canonical(afterArchive.snapshot) === canonical(config) &&
        boundary.initializedRunId === config.microLiveRunId &&
        boundary.state === "initialized", "transition_audit_mismatch");
      requireRepair(config.microLiveAccountMode === "exclusive" &&
        config.microLiveSelectedSubaccount === 1 && config.microLiveSelectedExchangeIndex === 2 &&
        LINKAGE_FIELDS.every(field => config[field] !== null && config[field] !== undefined),
      "reconciled_linkage_incomplete");
    } else {
      requireRepair(canonical(config) === canonical(original) &&
        LINKAGE_FIELDS.every(field => config[field] === null) &&
        boundary.state === "funded" && !boundary.initializedRunId,
      "partial_prepopulation_or_historical_state_conflict");
      requireRepair(original.microLiveRunArmedAt &&
        original.microLiveRunApprovalId &&
        /^[0-9a-f]{64}$/.test(String(original.microLiveRunApprovalDigest ?? "")),
      "historical_run_audit_provenance_missing");
    }
    for (const key of Object.keys(original)) {
      if (!MUTABLE.has(key)) requireRepair(
        canonical(original[key]) === canonical(config[key]), "unapproved_singleton_change");
    }
    // Fresh authenticated proof is required even on the idempotent read-only path.
    const proof = await tx.authenticate(state, request.ticker);
    requireRepair(boundary.subaccountNumber === 1 && boundary.exchangeIndex === 2 &&
      boundary.fundingAmountCents === 2500 && !!boundary.fundingTransferId &&
      !!boundary.fundingTransferredAt && boundary.postFundingBalanceMicros === "25000000" &&
      !!boundary.postFundingSnapshotAt &&
      /^[0-9a-f]{64}$/.test(String(boundary.postFundingEvidenceDigest ?? "")),
    "recorded_pair_funding_conflict");
    requireRepair(proof.checkedAt.getTime() - proof.scanAt.getTime() >= 0 &&
      proof.checkedAt.getTime() - proof.scanAt.getTime() <= 15_000 &&
      /^[0-9a-f]{64}$/.test(proof.fingerprint) &&
      /^[0-9a-f]{64}$/.test(proof.checkpointDigest) && !!proof.cursor,
    "fresh_authenticated_checkpoint_required");
    requireRepair(boundary.restrictedApiKeyId === proof.keyId &&
      boundary.restrictedKeyFingerprint === proof.fingerprint, "index2_fingerprint_mismatch");
    if (already) {
      requireRepair(config.microLiveRestrictedApiKeyId === proof.keyId &&
        config.microLiveRestrictedKeyFingerprint === proof.fingerprint &&
        config.microLiveFundingAnchorSubaccount === 1 &&
        config.microLiveFundingAnchorExchangeIndex === 2 &&
        config.microLiveFundingAnchorTransferId === boundary.fundingTransferId &&
        config.microLiveFundingAnchorAmountCents === boundary.fundingAmountCents &&
        canonical(config.microLiveFundingAnchorTransferAt) === canonical(boundary.fundingTransferredAt) &&
        config.microLivePairCashBaselineMicros === boundary.postFundingBalanceMicros &&
        canonical(config.microLivePairCashBaselineAt) === canonical(boundary.postFundingSnapshotAt) &&
        config.microLivePairCashBaselineEvidenceDigest === boundary.postFundingEvidenceDigest &&
        config.microLivePairCashBaselineRunId === config.microLiveRunId &&
        config.microLiveAccountActivityCheckpointRunId === config.microLiveRunId &&
        config.microLiveAccountActivityCheckpointSubaccount === 1 &&
        config.microLiveAccountActivityCheckpointExchangeIndex === 2 &&
        config.microLiveAccountActivityCheckpointCursor === boundary.activityCheckpointCursor &&
        config.microLiveAccountActivityCheckpointEvidenceDigest === boundary.activityCheckpointDigest &&
        canonical(config.microLiveAccountActivityCheckpointAt) === canonical(boundary.activityCheckpointAt),
      "reconciled_linkage_conflict");
      return { status: "already-reconciled" as const, changes: [], executionAuthority: "NONE" };
    }
    const runId = randomUUID();
    const patch: Row = {
      microLiveRunId: runId, microLiveAccountMode: "exclusive",
      microLiveSelectedSubaccount: 1, microLiveSelectedExchangeIndex: 2,
      microLiveRestrictedApiKeyId: proof.keyId,
      microLiveRestrictedKeyFingerprint: proof.fingerprint,
      microLiveFundingAnchorSubaccount: 1, microLiveFundingAnchorExchangeIndex: 2,
      microLiveFundingAnchorTransferId: boundary.fundingTransferId,
      microLiveFundingAnchorTransferAt: boundary.fundingTransferredAt,
      microLiveFundingAnchorAmountCents: boundary.fundingAmountCents,
      microLivePairCashBaselineMicros: boundary.postFundingBalanceMicros,
      microLivePairCashBaselineRunId: runId,
      microLivePairCashBaselineAt: boundary.postFundingSnapshotAt,
      microLivePairCashBaselineEvidenceDigest: boundary.postFundingEvidenceDigest,
      microLiveAccountActivityCheckpointRunId: runId,
      microLiveAccountActivityCheckpointSubaccount: 1,
      microLiveAccountActivityCheckpointExchangeIndex: 2,
      microLiveAccountActivityCheckpointCursor: proof.cursor,
      microLiveAccountActivityCheckpointAt: proof.scanAt,
      microLiveAccountActivityCheckpointEvidenceDigest: proof.checkpointDigest,
      updatedAt: proof.checkedAt,
    };
    const plan = { before: config, after: { ...config, ...patch }, patch, proof };
    closed(plan.after, live);
    if (request.apply) await tx.write(plan, request.actor);
    const redact = (field: string, value: unknown) =>
      /Id$|Fingerprint$|Digest$|Cursor$/.test(field) && value !== null
        ? "[REDACTED]" : value;
    return {
      status: request.apply ? "reconciled" as const : "dry-run" as const,
      changes: Object.entries(patch).map(([field, value]) => ({
        field, from: redact(field, config[field]), to: redact(field, value),
        reason: "bind preserved frozen state to recorded and freshly authenticated pair evidence",
      })),
      audit: "append historical run archive and exact successor commissioning snapshot; initialize boundary checkpoint",
      executionAuthority: "NONE",
    };
  });
}

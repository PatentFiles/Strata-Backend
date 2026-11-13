/**
 * Read-only live-readiness verifier.
 *
 * Performs PostgreSQL SELECT and Kalshi HTTP GET only.
 * Does not write the database, change configuration, transfer funds,
 * or submit, cancel, or amend orders.
 *
 * Run inside the existing Replit development environment, where
 * DATABASE_URL and the INDEX2 secrets already exist:
 *
 *   pnpm --filter @workspace/scripts exec tsx ./verify-live-readiness.ts
 *
 * INDEX2 environment names expected by this repository:
 *   KALSHI_INDEX2_API_KEY_ID
 *   KALSHI_INDEX2_PRIVATE_KEY
 * Shared credential names, used only for a presence and sameness check:
 *   KALSHI_API_KEY_ID
 *   KALSHI_API_PRIVATE_KEY
 *
 * The request signer below is the same RSA-PSS SHA-256 construction as
 * kalshiAccountClient.signRequest. That function is not exported, so this
 * file cannot call it without modifying application code. The message is
 * timestamp + GET + path, and the query string is not signed.
 */

import {
  constants as cryptoConstants,
  createHash,
  createPrivateKey,
  createSign,
} from "node:crypto";
import { pathToFileURL } from "node:url";

type Status = "VERIFIED" | "MISMATCH" | "INCOMPLETE";
type Presence = "PRESENT" | "MISSING";
type Compare = "MATCH" | "MISMATCH" | "UNKNOWN";
type Same = "SAME" | "DIFFERENT" | "UNKNOWN";

type QueryResult = { rows: Array<Record<string, unknown>> };
type ReadPool = {
  query: (text: string, values?: unknown[]) => Promise<QueryResult>;
  end: () => Promise<void>;
};

type EnvReport = {
  databaseUrl: Presence;
  databaseDestination: "DEVELOPMENT" | "PRODUCTION" | "UNKNOWN";
  runtime: "DEVELOPMENT" | "OTHER" | "UNKNOWN";
  nodeEnv: "development" | "production" | "other" | "missing";
  kalshiEnvironment: "PRODUCTION" | "NOT_PRODUCTION" | "MISSING";
  accountMode: string;
  configuredSubaccount: string;
  configuredExchangeIndex: string;
  index2: Presence;
  shared: Presence;
  sharedVersusIndex2: Same;
  index2FingerprintVersusBoundary: Compare;
};

type Section = {
  status: Status;
  lines: string[];
};

const PRODUCTION_HOST = "https://external-api.kalshi.com";
const API_PREFIX = "/trade-api/v2";
const EXPECTED_SUBACCOUNT = 1;
const EXPECTED_EXCHANGE_INDEX = 2;
const EXPECTED_FUNDING_CENTS = 2500;
const EXPECTED_CAP_MICROS = 1_000_000;
const MAX_PAGES = 20;

const reportLines: string[] = [];
const blocking: string[] = [];

function line(text: string): void {
  reportLines.push(text);
}

function block(reason: string): void {
  if (!blocking.includes(reason)) blocking.push(reason);
}

function presence(value: string | undefined): Presence {
  return value !== undefined && value.trim() !== "" ? "PRESENT" : "MISSING";
}

function normalizePem(raw: string): string {
  return raw.replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
}

function credentialMaterial(keyName: string, privateName: string): {
  present: boolean;
  keyId: string | null;
  privateKey: string | null;
} {
  const keyId = process.env[keyName]?.trim() ?? "";
  const secret = process.env[privateName]?.trim() ?? "";
  if (!keyId || !secret) return { present: false, keyId: null, privateKey: null };
  return { present: true, keyId, privateKey: normalizePem(secret) };
}

function fingerprint(keyId: string, privateKey: string): string {
  return createHash("sha256")
    .update(`${keyId}\u001f${privateKey}`)
    .digest("hex");
}

function compareFingerprint(installed: string | null, stored: unknown): Compare {
  if (!installed || typeof stored !== "string" || !/^[0-9a-f]{64}$/.test(stored)) {
    return "UNKNOWN";
  }
  return installed === stored ? "MATCH" : "MISMATCH";
}

function sameCredential(
  left: { present: boolean; keyId: string | null; privateKey: string | null },
  right: { present: boolean; keyId: string | null; privateKey: string | null },
): Same {
  if (!left.present || !right.present || !left.keyId || !left.privateKey ||
      !right.keyId || !right.privateKey) {
    return "UNKNOWN";
  }
  return fingerprint(left.keyId, left.privateKey) === fingerprint(right.keyId, right.privateKey)
    ? "SAME"
    : "DIFFERENT";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function stamp(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return "UNKNOWN";
}

function dollarsFromCents(cents: number | null): string {
  if (cents === null) return "UNKNOWN";
  return `$${(cents / 100).toFixed(2)} (${cents} cents)`;
}

function dollarsFromMicros(micros: number | null): string {
  if (micros === null) return "UNKNOWN";
  return `$${(micros / 1_000_000).toFixed(2)} (${micros} micros)`;
}

function fixedPointDollars(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+\.\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return `$${parsed.toFixed(2)}`;
}

function integerCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function kalshiTimestamp(value: unknown): string {
  const raw = integer(value);
  if (raw === null || raw <= 0) return "UNKNOWN";
  const milliseconds = raw < 100_000_000_000 ? raw * 1000 : raw;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "UNKNOWN";
}

function scopesAreExactRestrictedSet(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const scopes = new Set<string>();
  for (const scope of value) {
    if (typeof scope !== "string" || scope.trim() === "") return false;
    scopes.add(scope);
  }
  return scopes.size === 2 && scopes.has("read") && scopes.has("write::trade");
}

function safeReason(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_:. -]{1,160}$/.test(value)
    ? value
    : "UNSAFE_TO_DISPLAY";
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function dbFailure(error: unknown): "DATABASE_CONNECTION_FAILED" | "DATABASE_RELATION_MISSING" {
  if (error !== null && typeof error === "object" && "code" in error &&
      (error as { code?: unknown }).code === "42P01") {
    return "DATABASE_RELATION_MISSING";
  }
  return "DATABASE_CONNECTION_FAILED";
}

export function assertSelect(sql: string): void {
  const statement = sql.trim();
  if (!/^select\b/i.test(statement) ||
      /\b(insert|update|delete|upsert|alter|drop|truncate|create|grant|copy|call)\b/i.test(statement)) {
    throw new Error("DATABASE_QUERY_REFUSED");
  }
}

async function selectRows(
  pool: ReadPool,
  sql: string,
  values: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  assertSelect(sql);
  const result = await pool.query(sql, values);
  return result.rows;
}

function checkEnvironment(
  index2: ReturnType<typeof credentialMaterial>,
  shared: ReturnType<typeof credentialMaterial>,
): EnvReport {
  const node = process.env.NODE_ENV?.trim() ?? "";
  const nodeEnv = node === "development" || node === "production"
    ? node
    : node === "" ? "missing" : "other";
  const kalshi = process.env.KALSHI_API_ENVIRONMENT?.trim() ?? "";
  const mode = process.env.MICRO_LIVE_ACCOUNT_MODE?.trim() ?? "";
  const subaccount = process.env.KALSHI_BOT_SUBACCOUNT?.trim() ?? "";
  return {
    databaseUrl: presence(process.env.DATABASE_URL),
    databaseDestination: "UNKNOWN",
    runtime: nodeEnv === "development" ? "DEVELOPMENT" : nodeEnv === "missing" ? "UNKNOWN" : "OTHER",
    nodeEnv,
    kalshiEnvironment: kalshi === "production"
      ? "PRODUCTION"
      : kalshi === "" ? "MISSING" : "NOT_PRODUCTION",
    accountMode: mode === "exclusive" || mode === "primary_nonexclusive" ? mode : mode === "" ? "MISSING" : "OTHER",
    configuredSubaccount: /^(?:0|[1-9]\d*)$/.test(subaccount) && Number(subaccount) <= 63
      ? subaccount
      : subaccount === "" ? "MISSING" : "INVALID",
    configuredExchangeIndex: "2 (dedicated-pair constant; not selected by the browser)",
    index2: index2.present ? "PRESENT" : "MISSING",
    shared: shared.present ? "PRESENT" : "MISSING",
    sharedVersusIndex2: sameCredential(shared, index2),
    index2FingerprintVersusBoundary: "UNKNOWN",
  };
}

async function openPool(): Promise<ReadPool> {
  const loaded: unknown = await import("../lib/db/src/index.ts");
  const pool = loaded !== null && typeof loaded === "object" && "pool" in loaded
    ? (loaded as { pool?: unknown }).pool
    : null;
  if (pool === null || typeof pool !== "object" ||
      typeof (pool as { query?: unknown }).query !== "function" ||
      typeof (pool as { end?: unknown }).end !== "function") {
    throw new Error("DATABASE_CONNECTION_FAILED");
  }
  return pool as ReadPool;
}

function worseStatus(left: Status, right: Status): Status {
  if (left === "MISMATCH" || right === "MISMATCH") return "MISMATCH";
  if (left === "INCOMPLETE" || right === "INCOMPLETE") return "INCOMPLETE";
  return "VERIFIED";
}

export const COMMISSIONING_LINKAGE_FIELDS = [
  "micro_live_funding_anchor_subaccount", "micro_live_funding_anchor_exchange_index",
  "micro_live_funding_anchor_transfer_id", "micro_live_funding_anchor_transfer_at",
  "micro_live_funding_anchor_amount_cents", "micro_live_pair_cash_baseline_micros",
  "micro_live_pair_cash_baseline_run_id", "micro_live_pair_cash_baseline_at",
  "micro_live_pair_cash_baseline_evidence_digest",
  "micro_live_account_activity_checkpoint_subaccount", "micro_live_account_activity_checkpoint_exchange_index",
  "micro_live_account_activity_checkpoint_run_id", "micro_live_account_activity_checkpoint_cursor",
  "micro_live_account_activity_checkpoint_at", "micro_live_account_activity_checkpoint_evidence_digest",
  "micro_live_restricted_api_key_id", "micro_live_restricted_key_fingerprint",
] as const;

/** No inference from a historical archive or funded boundary can fill missing singleton fields. */
export function assessSingletonLinkage(row: Record<string, unknown>): Section {
  const missing = COMMISSIONING_LINKAGE_FIELDS.filter(field =>
    row[field] === null || row[field] === undefined ||
    typeof row[field] === "string" && row[field].trim() === "");
  const timestamp = (field: string) => stamp(row[field]) === "UNKNOWN" ? null : Date.parse(stamp(row[field]));
  const transferAt = timestamp("micro_live_funding_anchor_transfer_at");
  const baselineAt = timestamp("micro_live_pair_cash_baseline_at");
  const checkpointAt = timestamp("micro_live_account_activity_checkpoint_at");
  const checkpointRun = text(row.micro_live_account_activity_checkpoint_run_id);
  const wrong = [
    row.micro_live_funding_anchor_subaccount != null && integer(row.micro_live_funding_anchor_subaccount) !== 1,
    row.micro_live_funding_anchor_exchange_index != null && integer(row.micro_live_funding_anchor_exchange_index) !== 2,
    row.micro_live_account_activity_checkpoint_subaccount != null && integer(row.micro_live_account_activity_checkpoint_subaccount) !== 1,
    row.micro_live_account_activity_checkpoint_exchange_index != null && integer(row.micro_live_account_activity_checkpoint_exchange_index) !== 2,
    checkpointRun !== null && checkpointRun !== text(row.micro_live_run_id),
    ...["micro_live_pair_cash_baseline_evidence_digest", "micro_live_account_activity_checkpoint_evidence_digest"]
      .map(field => row[field] != null && !/^[0-9a-f]{64}$/.test(String(row[field]))),
    ...["micro_live_funding_anchor_transfer_at", "micro_live_pair_cash_baseline_at", "micro_live_account_activity_checkpoint_at"]
      .map(field => row[field] != null && timestamp(field) === null),
    transferAt !== null && baselineAt !== null && transferAt > baselineAt,
    baselineAt !== null && checkpointAt !== null && baselineAt > checkpointAt,
  ];
  return {
    status: wrong.some(Boolean) ? "MISMATCH" : missing.length ? "INCOMPLETE" : "VERIFIED",
    lines: [
      `Commissioning linkage fields present: ${17 - missing.length}/17`,
      `Missing commissioning fields: ${missing.length ? missing.join(", ") : "NONE"}`,
      `Checkpoint identity/digest/time ordering: ${wrong.some(Boolean) ? "MISMATCH" : missing.length ? "INCOMPLETE" : "CONSISTENT"}`,
    ],
  };
}

export function readinessExitCode(database: Status, kalshi: Status, reasons: readonly string[]): 0 | 2 {
  return database === "VERIFIED" && kalshi === "VERIFIED" && reasons.length === 0 ? 0 : 2;
}

function verifyEnvironmentBinding(env: EnvReport): Section {
  const subaccountMatches = env.configuredSubaccount === String(EXPECTED_SUBACCOUNT);
  const subaccountMissing = env.configuredSubaccount === "MISSING";
  const modeMatches = env.accountMode === "exclusive";
  const modeDefaultsToExclusive = env.accountMode === "MISSING";
  const subaccountConflict = !subaccountMatches && !subaccountMissing;
  const modeConflict = !modeMatches && !modeDefaultsToExclusive;
  const status: Status = subaccountConflict || modeConflict
    ? "MISMATCH"
    : subaccountMissing ? "INCOMPLETE" : "VERIFIED";
  if (subaccountConflict) {
    block("KALSHI_BOT_SUBACCOUNT contradicts subaccount 1 and is used by the dedicated execution binding");
  }
  if (modeConflict) {
    block("MICRO_LIVE_ACCOUNT_MODE contradicts exclusive and is used by the dedicated execution binding");
  }
  if (subaccountMissing) {
    block("KALSHI_BOT_SUBACCOUNT is missing, so the dedicated execution binding cannot be formed");
  }
  return {
    status,
    lines: [
      "KALSHI_BOT_SUBACCOUNT authority: USED_BY_DEDICATED_BINDING",
      `KALSHI_BOT_SUBACCOUNT versus commissioned subaccount 1: ${subaccountMatches ? "MATCH" : subaccountMissing ? "MISSING" : "MISMATCH"}`,
      "MICRO_LIVE_ACCOUNT_MODE authority: USED_BY_DEDICATED_BINDING",
      `MICRO_LIVE_ACCOUNT_MODE versus exclusive: ${modeMatches ? "MATCH" : modeDefaultsToExclusive ? "ABSENT_DEFAULTS_TO_EXCLUSIVE" : "MISMATCH"}`,
      "Database pair boundary remains the account identity. These environment values must agree with it before dedicated execution can bind.",
    ],
  };
}

async function verifySingleton(
  pool: ReadPool,
  installedFingerprint: string | null,
  installedKeyId: string | null,
): Promise<{
  section: Section;
  row: Record<string, unknown> | null;
  limits: string[];
}> {
  const rows = await selectRows(pool, `
    select id, micro_live_run_id, micro_live_run_phase, micro_live_run_cap_micros,
      max_live_bankroll_cents, max_single_order_risk_cents, max_scout_stake_cents,
      max_confirm_additional_stake_cents, max_cumulative_reserved_cents,
      micro_live_account_mode, micro_live_selected_subaccount,
      micro_live_selected_exchange_index, micro_live_restricted_api_key_id,
      micro_live_restricted_key_fingerprint, manual_kill_switch,
      live_execution_enabled, micro_live_production_enabled,
      micro_live_run_freeze_reason, micro_live_entry_attempted, micro_live_exit_attempted,
      micro_live_funding_anchor_subaccount, micro_live_funding_anchor_exchange_index,
      micro_live_funding_anchor_transfer_id, micro_live_funding_anchor_amount_cents,
      micro_live_funding_anchor_transfer_at, micro_live_pair_cash_baseline_at,
      micro_live_pair_cash_baseline_evidence_digest,
      micro_live_pair_cash_baseline_micros, micro_live_pair_cash_baseline_run_id,
      micro_live_account_activity_checkpoint_run_id,
      micro_live_account_activity_checkpoint_subaccount,
      micro_live_account_activity_checkpoint_exchange_index,
      micro_live_account_activity_checkpoint_cursor, micro_live_account_activity_checkpoint_at,
      micro_live_account_activity_checkpoint_evidence_digest,
      created_at, updated_at
    from micro_live_config
    where id = $1
  `, ["singleton"]);
  if (rows.length !== 1) {
    block("micro-live singleton is absent");
    return {
      section: { status: "INCOMPLETE", lines: ["Singleton: MISSING"] },
      row: null,
      limits: ["Run cap: UNKNOWN", "Max live bankroll: UNKNOWN", "Max single order risk: UNKNOWN", "Max scout stake: UNKNOWN", "Max confirm/add stake: UNKNOWN"],
    };
  }
  const row = rows[0]!;
  const linkage = assessSingletonLinkage(row);
  const fingerprintStatus = compareFingerprint(installedFingerprint, row.micro_live_restricted_key_fingerprint);
  const keyMatch: Compare = installedKeyId === null || text(row.micro_live_restricted_api_key_id) === null
    ? "UNKNOWN"
    : installedKeyId === row.micro_live_restricted_api_key_id ? "MATCH" : "MISMATCH";
  const phase = text(row.micro_live_run_phase);
  const cap = integer(row.micro_live_run_cap_micros);
  const selectedSubaccount = integer(row.micro_live_selected_subaccount);
  const selectedExchangeIndex = integer(row.micro_live_selected_exchange_index);
  const accountMode = text(row.micro_live_account_mode);
  const anchorSubaccount = integer(row.micro_live_funding_anchor_subaccount);
  const anchorExchangeIndex = integer(row.micro_live_funding_anchor_exchange_index);
  const anchorAmount = integer(row.micro_live_funding_anchor_amount_cents);
  const anchorTransferPresent = text(row.micro_live_funding_anchor_transfer_id) !== null;
  const baselineMicros = text(row.micro_live_pair_cash_baseline_micros);
  const baselineRunId = text(row.micro_live_pair_cash_baseline_run_id);
  const runId = text(row.micro_live_run_id);
  const contradictions = [
    linkage.status === "MISMATCH",
    phase !== null && phase !== "FROZEN",
    cap !== null && cap !== EXPECTED_CAP_MICROS,
    selectedSubaccount !== null && selectedSubaccount !== EXPECTED_SUBACCOUNT,
    selectedExchangeIndex !== null && selectedExchangeIndex !== EXPECTED_EXCHANGE_INDEX,
    accountMode !== null && accountMode !== "exclusive",
    fingerprintStatus === "MISMATCH",
    keyMatch === "MISMATCH",
    row.manual_kill_switch === false,
    row.live_execution_enabled === true,
    row.micro_live_production_enabled === true,
    anchorSubaccount !== null && anchorSubaccount !== EXPECTED_SUBACCOUNT,
    anchorExchangeIndex !== null && anchorExchangeIndex !== EXPECTED_EXCHANGE_INDEX,
    anchorAmount !== null && anchorAmount !== EXPECTED_FUNDING_CENTS,
    baselineMicros !== null && baselineMicros !== "25000000",
    runId !== null && baselineRunId !== null && baselineRunId !== runId,
  ];
  const unproven = [
    linkage.status === "INCOMPLETE",
    phase === null,
    cap === null,
    selectedSubaccount === null,
    selectedExchangeIndex === null,
    accountMode === null,
    fingerprintStatus !== "MATCH",
    keyMatch !== "MATCH",
    row.manual_kill_switch !== true,
    row.live_execution_enabled !== false,
    row.micro_live_production_enabled !== false,
    anchorSubaccount === null,
    anchorExchangeIndex === null,
    anchorAmount === null,
    !anchorTransferPresent,
    baselineMicros === null,
    runId === null || baselineRunId === null,
  ];
  const status: Status = contradictions.some(Boolean)
    ? "MISMATCH"
    : unproven.some(Boolean) ? "INCOMPLETE" : "VERIFIED";
  if (status === "MISMATCH") block("micro-live singleton contradicts the frozen dedicated-pair commissioning state");
  if (status === "INCOMPLETE") block("micro-live singleton commissioning evidence is incomplete");
  const lines = [
    "Singleton: PRESENT",
    ...linkage.lines,
    `Run id: ${runId ?? "NONE"}`,
    `Phase: ${phase ?? "UNKNOWN"}`,
    `Run cap: ${dollarsFromMicros(cap)}`,
    `Max live bankroll: ${dollarsFromCents(integer(row.max_live_bankroll_cents))}`,
    `Max single order risk: ${dollarsFromCents(integer(row.max_single_order_risk_cents))}`,
    `Max scout stake: ${dollarsFromCents(integer(row.max_scout_stake_cents))}`,
    `Max confirm/add stake: ${dollarsFromCents(integer(row.max_confirm_additional_stake_cents))}`,
    `Cumulative reserve ceiling: ${dollarsFromCents(integer(row.max_cumulative_reserved_cents))}`,
    `Account mode: ${accountMode ?? "NONE"}`,
    `Selected subaccount: ${selectedSubaccount ?? "NONE"}`,
    `Selected exchange index: ${selectedExchangeIndex ?? "NONE"}`,
    `Installed key versus singleton key: ${keyMatch}`,
    `Restricted-key fingerprint versus installed INDEX2: ${fingerprintStatus}`,
    `Kill switch: ${row.manual_kill_switch === true ? "ON" : row.manual_kill_switch === false ? "OFF" : "UNKNOWN"}`,
    `micro_live_config.live_execution_enabled: ${row.live_execution_enabled === true ? "true" : row.live_execution_enabled === false ? "false" : "UNKNOWN"}`,
    `micro_live_config.micro_live_production_enabled: ${row.micro_live_production_enabled === true ? "true" : row.micro_live_production_enabled === false ? "false" : "UNKNOWN"}`,
    `Freeze reason: ${row.micro_live_run_freeze_reason === null ? "NONE" : safeReason(row.micro_live_run_freeze_reason)}`,
    `Entry attempted: ${row.micro_live_entry_attempted === true ? "true" : "false"}`,
    `Exit attempted: ${row.micro_live_exit_attempted === true ? "true" : "false"}`,
    `Funding anchor pair subaccount: ${anchorSubaccount ?? "NONE"}`,
    `Funding anchor exchange index: ${anchorExchangeIndex ?? "NONE"}`,
    `Funding anchor amount: ${dollarsFromCents(anchorAmount)}`,
    `Funding anchor transfer reference: ${anchorTransferPresent ? "PRESENT" : "ABSENT"}`,
    "Funding anchor subaccount stores the funded pair subaccount, not funding source 0.",
    `Pair cash baseline: ${baselineMicros === "25000000" ? "$25.00" : baselineMicros === null ? "ABSENT" : "UNEXPECTED"}`,
    `Pair cash baseline run versus singleton run: ${runId !== null && baselineRunId === runId ? "MATCH" : baselineRunId === null || runId === null ? "UNKNOWN" : "MISMATCH"}`,
    `Activity checkpoint: ${text(row.micro_live_account_activity_checkpoint_run_id) === null ? "ABSENT" : "PRESENT"}`,
    `Created: ${stamp(row.created_at)}`,
    `Updated: ${stamp(row.updated_at)}`,
  ];
  return {
    section: { status, lines },
    row,
    limits: [
      `Run cap: ${dollarsFromMicros(integer(row.micro_live_run_cap_micros))}`,
      `Max live bankroll: ${dollarsFromCents(integer(row.max_live_bankroll_cents))}`,
      `Max single order risk: ${dollarsFromCents(integer(row.max_single_order_risk_cents))}`,
      `Max scout stake: ${dollarsFromCents(integer(row.max_scout_stake_cents))}`,
      `Max confirm/add stake: ${dollarsFromCents(integer(row.max_confirm_additional_stake_cents))}`,
    ],
  };
}

async function verifyCommissioningArchive(pool: ReadPool, runId: string | null): Promise<Section> {
  const rows = await selectRows(pool, `
    select prior_run_id, phase, cap_micros, snapshot_digest, archived_at
    from micro_live_commissioning_archive
    order by archived_at asc
  `);
  const archiveRowIsCommissioningEvidence = (row: Record<string, unknown>): boolean =>
    row.phase === "FROZEN" &&
    integer(row.cap_micros) === EXPECTED_CAP_MICROS &&
    typeof row.snapshot_digest === "string" && /^[0-9a-f]{64}$/.test(row.snapshot_digest) &&
    text(row.prior_run_id) !== null;
  if (rows.length === 0) {
    block("commissioning archive has no rows");
    return { status: "INCOMPLETE", lines: ["Rows: 0", "Current singleton run is archived here: NO"] };
  }
  if (runId === null) {
    block("singleton run id is absent, so the commissioning archive cannot be linked");
    return {
      status: "INCOMPLETE",
      lines: [
        `Rows: ${rows.length}`,
        "Current singleton run is archived here: NO_SINGLETON_RUN",
      ],
    };
  }
  const represented = rows.filter((row) => row.prior_run_id === runId);
  const otherRows = rows.filter((row) => row.prior_run_id !== runId);
  const representedRow = represented[0] ?? null;
  const representedOk = representedRow !== null && archiveRowIsCommissioningEvidence(representedRow);
  const otherContradiction = otherRows.some((row) => !archiveRowIsCommissioningEvidence(row));
  const status: Status = represented.length === 0 || otherContradiction
    ? "MISMATCH"
    : represented.length === 1 && representedOk ? "VERIFIED" : "MISMATCH";
  if (status !== "VERIFIED") {
    block(represented.length === 0
      ? "commissioning archive does not contain the historical frozen singleton run"
      : "commissioning archive evidence for the historical frozen run is inconsistent");
  }
  return {
    status,
    lines: [
      `Rows: ${rows.length}`,
      `Other historical archive rows: ${otherRows.length}`,
      `Run ids: ${rows.map((row) => text(row.prior_run_id) ?? "UNKNOWN").join(", ")}`,
      `Phases: ${[...new Set(rows.map((row) => text(row.phase) ?? "UNKNOWN"))].join(", ")}`,
      `Caps: ${[...new Set(rows.map((row) => dollarsFromMicros(integer(row.cap_micros))))].join(", ")}`,
      `Digest format: ${rows.every((row) => typeof row.snapshot_digest === "string" && /^[0-9a-f]{64}$/.test(row.snapshot_digest)) ? "CONSISTENT" : "INCONSISTENT"}`,
      `Current singleton run is archived here: ${representedOk ? "YES" : "NO"}`,
      `Represented row phase: ${representedRow === null ? "ABSENT" : text(representedRow.phase) ?? "UNKNOWN"}`,
      `Represented row cap: ${representedRow === null ? "ABSENT" : dollarsFromMicros(integer(representedRow.cap_micros))}`,
      `Archived at: ${rows.map((row) => stamp(row.archived_at)).join(", ")}`,
    ],
  };
}

async function verifyRunArchive(pool: ReadPool, runId: string | null): Promise<Section> {
  const rows = await selectRows(pool, `
    select prior_run_id, successor_run_id, phase, cap_micros, archived_at
    from micro_live_run_archive
    order by archived_at asc
  `);
  const conflict = runId !== null && rows.some((row) =>
    row.prior_run_id === runId || row.successor_run_id === runId);
  return {
    status: conflict ? "MISMATCH" : "VERIFIED",
    lines: [
      `Rows: ${rows.length}`,
      rows.length === 0
        ? "Empty. Commissioning archive is the historical source for the frozen commissioning run."
        : `Run ids: ${rows.map((row) => `${text(row.prior_run_id) ?? "UNKNOWN"} -> ${text(row.successor_run_id) ?? "UNKNOWN"}`).join("; ")}`,
      `Phases: ${rows.length === 0 ? "NONE" : [...new Set(rows.map((row) => text(row.phase) ?? "UNKNOWN"))].join(", ")}`,
      `Caps: ${rows.length === 0 ? "NONE" : [...new Set(rows.map((row) => dollarsFromMicros(integer(row.cap_micros))))].join(", ")}`,
      `Current singleton run id appears in this archive: ${conflict ? "YES" : "NO"}`,
    ],
  };
}

async function verifyPairBoundary(
  pool: ReadPool,
  installedFingerprint: string | null,
  installedKeyId: string | null,
): Promise<{ section: Section; row: Record<string, unknown> | null; stop: boolean }> {
  const rows = await selectRows(pool, `
    select subaccount_number, exchange_index, state, restricted_api_key_id,
      restricted_key_fingerprint, funding_transfer_id, funding_amount_cents,
      funding_transferred_at, post_funding_balance_micros, post_funding_snapshot_at,
      initialized_run_id, ambiguity_frozen_at, ambiguity_freeze_reason,
      activity_checkpoint_at, created_at, updated_at
    from micro_live_pair_boundary
    order by subaccount_number asc, exchange_index asc
  `);
  const matches = rows.filter((candidate) =>
    integer(candidate.subaccount_number) === EXPECTED_SUBACCOUNT &&
    integer(candidate.exchange_index) === EXPECTED_EXCHANGE_INDEX);
  if (matches.length !== 1) {
    const status: Status = matches.length > 1 ? "MISMATCH" : "INCOMPLETE";
    block(matches.length > 1
      ? "multiple pair boundary rows exist for subaccount 1 exchange index 2"
      : "pair boundary row for subaccount 1 exchange index 2 is absent");
    return {
      section: {
        status,
        lines: [
          `Boundary rows: ${rows.length}`,
          `Matching (1,2) rows: ${matches.length}`,
        ],
      },
      row: null,
      stop: true,
    };
  }
  const row = matches[0]!;
  const subaccount = integer(row.subaccount_number);
  const exchangeIndex = integer(row.exchange_index);
  const identityOk = subaccount === EXPECTED_SUBACCOUNT && exchangeIndex === EXPECTED_EXCHANGE_INDEX;
  const fingerprintStatus = compareFingerprint(installedFingerprint, row.restricted_key_fingerprint);
  const keyMatch: Compare = installedKeyId === null || text(row.restricted_api_key_id) === null
    ? "UNKNOWN"
    : installedKeyId === row.restricted_api_key_id ? "MATCH" : "MISMATCH";
  const ambiguous = row.ambiguity_frozen_at !== null && row.ambiguity_frozen_at !== undefined;
  const contradicted = !identityOk || fingerprintStatus === "MISMATCH" || keyMatch === "MISMATCH" || ambiguous;
  const fundedState = row.state === "funded" || row.state === "initialized";
  const fundingAmountOk = integer(row.funding_amount_cents) === EXPECTED_FUNDING_CENTS;
  if (!identityOk) block("database pair identity is not subaccount 1 exchange index 2");
  if (fingerprintStatus === "MISMATCH" || keyMatch === "MISMATCH") {
    block("INDEX2 fingerprint or key identity does not match the pair boundary");
  }
  if (ambiguous) block("pair boundary is ambiguity-frozen");
  const status: Status = contradicted
    ? "MISMATCH"
    : !fundedState ? "INCOMPLETE"
      : !fundingAmountOk ? "MISMATCH"
        : fingerprintStatus === "MATCH" && keyMatch === "MATCH" ? "VERIFIED" : "INCOMPLETE";
  if (status === "MISMATCH" && !contradicted) {
    block("pair boundary funding amount is not the expected $25");
  }
  if (!fundedState) block("pair boundary for (1,2) is not in a funded or initialized state");
  if (!contradicted && fundedState && fundingAmountOk && status === "INCOMPLETE") {
    block("pair boundary INDEX2 fingerprint or key identity cannot be proven");
  }
  return {
    section: {
      status,
      lines: [
        `Boundary rows: ${rows.length}`,
        `Matching (1,2) rows: ${matches.length}`,
        `Subaccount: ${subaccount ?? "UNKNOWN"}`,
        `Exchange index: ${exchangeIndex ?? "UNKNOWN"}`,
        `State: ${text(row.state) ?? "UNKNOWN"}`,
        `Installed key versus boundary key: ${keyMatch}`,
        `Fingerprint versus installed INDEX2: ${fingerprintStatus}`,
        `Funding amount: ${dollarsFromCents(integer(row.funding_amount_cents))}`,
        `Post-funding balance micros: ${text(row.post_funding_balance_micros) ?? "NONE"}`,
        `Funding transfer reference: ${text(row.funding_transfer_id) === null ? "ABSENT" : "PRESENT"}`,
        `Initialized run id: ${text(row.initialized_run_id) ?? "NONE"}`,
        `Ambiguity freeze: ${ambiguous ? safeReason(row.ambiguity_freeze_reason) : "NONE"}`,
        `Funding transferred at: ${stamp(row.funding_transferred_at)}`,
        `Updated: ${stamp(row.updated_at)}`,
      ],
    },
    row,
    stop: status !== "VERIFIED",
  };
}

async function verifyIndex2Provisioning(
  pool: ReadPool,
  installedKeyId: string | null,
): Promise<Section> {
  const rows = await selectRows(pool, `
    select state, subaccount, exchange_index, scopes, key_id,
      metadata_verified_at, confirmed_at, created_at
    from micro_live_pair_key_provisioning_attempts
    order by created_at asc nulls last, confirmed_at asc nulls last
  `);
  const creation = await selectRows(pool, `
    select state, target_exchange_index, subaccount_number, verified_at
    from micro_live_subaccount_creation_attempts
    order by verified_at asc nulls last
  `);
  const pairRows = rows.filter((row) =>
    integer(row.subaccount) === EXPECTED_SUBACCOUNT &&
    integer(row.exchange_index) === EXPECTED_EXCHANGE_INDEX);
  const confirmed = pairRows.filter((row) => row.state === "handoff_confirmed");
  const earlier = pairRows.filter((row) => row.state !== "handoff_confirmed");
  const confirmedKeyIds = new Set(confirmed.map((row) => text(row.key_id) ?? "NONE"));
  const row = confirmed.length === 1 ? confirmed[0]! : null;
  const scopeText = row === null
    ? "NONE"
    : scopesAreExactRestrictedSet(row.scopes) ? "read + write::trade" : "UNEXPECTED";
  const keyMatch: Compare = row === null || installedKeyId === null || text(row.key_id) === null
    ? "UNKNOWN"
    : installedKeyId === row.key_id ? "MATCH" : "MISMATCH";
  const conflictingConfirmed = confirmed.length > 1 && confirmedKeyIds.size > 1;
  const duplicateConfirmed = confirmed.length > 1;
  const ready = row !== null &&
    scopeText === "read + write::trade" &&
    keyMatch === "MATCH";
  const status: Status = conflictingConfirmed || duplicateConfirmed || keyMatch === "MISMATCH" || scopeText === "UNEXPECTED"
    ? "MISMATCH"
    : ready ? "VERIFIED" : "INCOMPLETE";
  if (conflictingConfirmed || duplicateConfirmed) {
    block("multiple handoff_confirmed INDEX2 provisioning records exist for subaccount 1 exchange index 2");
  }
  if (keyMatch === "MISMATCH") block("INDEX2 provisioning key does not match the installed INDEX2 credential");
  if (scopeText === "UNEXPECTED") block("INDEX2 provisioning scopes are not the restricted read and write::trade set");
  if (status === "INCOMPLETE") block("INDEX2 provisioning is not in handoff_confirmed state");
  return {
    status,
    lines: [
      `Provisioning rows: ${rows.length}`,
      `Rows for other pairs: ${rows.length - pairRows.length}`,
      `Matching (1,2) rows: ${pairRows.length}`,
      `handoff_confirmed rows: ${confirmed.length}`,
      `Earlier or non-final (1,2) attempts: ${earlier.length}`,
      `Earlier states: ${earlier.length === 0 ? "NONE" : earlier.map((item) => text(item.state) ?? "UNKNOWN").join(", ")}`,
      `Distinct confirmed key identities: ${confirmed.length === 0 ? "NONE" : String(confirmedKeyIds.size)}`,
      `State: ${row === null ? "NONE" : text(row.state) ?? "UNKNOWN"}`,
      "Subaccount: 1",
      "Exchange index: 2",
      `Scopes: ${scopeText}`,
      `Installed key versus provisioned key: ${keyMatch}`,
      `Metadata verified at: ${row === null ? "NONE" : stamp(row.metadata_verified_at)}`,
      `Confirmed at: ${row === null ? "NONE" : stamp(row.confirmed_at)}`,
      `Subaccount-creation rows: ${creation.length}`,
      `Subaccount-creation states: ${creation.length === 0 ? "NONE" : creation.map((item) => text(item.state) ?? "UNKNOWN").join(", ")}`,
    ],
  };
}

function fundingTouchesCommissionedPair(row: Record<string, unknown>): boolean {
  return integer(row.exchange_index) === EXPECTED_EXCHANGE_INDEX &&
    (integer(row.source_subaccount) === EXPECTED_SUBACCOUNT ||
      integer(row.destination_subaccount) === EXPECTED_SUBACCOUNT);
}

function fundingIsExpectedShape(row: Record<string, unknown>): boolean {
  return integer(row.source_subaccount) === 0 &&
    integer(row.destination_subaccount) === EXPECTED_SUBACCOUNT &&
    integer(row.exchange_index) === EXPECTED_EXCHANGE_INDEX &&
    integer(row.amount_cents) === EXPECTED_FUNDING_CENTS;
}

async function verifyFunding(
  pool: ReadPool,
  boundary: Record<string, unknown> | null,
): Promise<{ section: Section; transferId: string | null }> {
  const rows = await selectRows(pool, `
    select source_subaccount, destination_subaccount, exchange_index, amount_cents,
      market_ticker, state, transfer_id, attempted_at, response_received_at, reconciled_at
    from micro_live_pair_funding_attempts
    order by attempted_at asc nulls last, reconciled_at asc nulls last
  `);
  const touching = rows.filter(fundingTouchesCommissionedPair);
  const unrelated = rows.length - touching.length;
  const expected = touching.filter((row) => fundingIsExpectedShape(row) && row.state === "reconciled");
  const summary = [
    `Funding rows: ${rows.length}`,
    `Unrelated historical funding rows: ${unrelated}`,
    `Rows touching commissioned (1,2): ${touching.length}`,
    `Reconciled (0,2) -> (1,2) $25 rows: ${expected.length}`,
  ];
  if (touching.length > 1 || (touching.length === 1 && !fundingIsExpectedShape(touching[0]!))) {
    block(touching.length > 1
      ? "more than one funding attempt involves the commissioned (1,2) pair"
      : "the funding attempt involving (1,2) is not the expected (0,2) -> (1,2) $25 transfer");
    return { section: { status: "MISMATCH", lines: summary }, transferId: null };
  }
  if (expected.length !== 1) {
    block("a single reconciled $25 funding attempt for (0,2) -> (1,2) was not found");
    return {
      section: {
        status: "INCOMPLETE",
        lines: [
          ...summary,
          `States touching (1,2): ${touching.map((row) => text(row.state) ?? "UNKNOWN").join(", ") || "NONE"}`,
        ],
      },
      transferId: null,
    };
  }
  const row = expected[0]!;
  const transferMatch: Compare = boundary === null || text(boundary.funding_transfer_id) === null || text(row.transfer_id) === null
    ? "UNKNOWN"
    : boundary.funding_transfer_id === row.transfer_id ? "MATCH" : "MISMATCH";
  if (transferMatch !== "MATCH") {
    block(transferMatch === "MISMATCH"
      ? "funding transfer reference does not match the pair boundary"
      : "funding transfer reference could not be compared with the pair boundary");
  }
  const ticker = text(row.market_ticker);
  return {
    section: {
      status: transferMatch === "MATCH" ? "VERIFIED" : transferMatch === "MISMATCH" ? "MISMATCH" : "INCOMPLETE",
      lines: [
        ...summary,
        `Source subaccount: ${integer(row.source_subaccount) ?? "UNKNOWN"}`,
        `Destination subaccount: ${integer(row.destination_subaccount) ?? "UNKNOWN"}`,
        `Exchange index: ${integer(row.exchange_index) ?? "UNKNOWN"}`,
        `Amount: ${dollarsFromCents(integer(row.amount_cents))}`,
        `State: ${text(row.state) ?? "UNKNOWN"}`,
        `Transfer reference versus boundary: ${transferMatch}`,
        `Historical funding ticker: ${ticker !== null && /^KXBTC15M-[A-Za-z0-9-]+$/.test(ticker) ? ticker : "UNSAFE_TO_DISPLAY"}`,
        `Attempted: ${stamp(row.attempted_at)}`,
        `Reconciled: ${stamp(row.reconciled_at)}`,
      ],
    },
    transferId: text(row.transfer_id),
  };
}

function attachSingletonCrossChecks(
  section: Section,
  singletonRow: Record<string, unknown> | null,
  boundaryRow: Record<string, unknown> | null,
  attemptTransferId: string | null,
): { section: Section; identity: Compare } {
  if (singletonRow === null) return { section, identity: "UNKNOWN" };
  const anchorId = text(singletonRow.micro_live_funding_anchor_transfer_id);
  const boundaryId = boundaryRow === null ? null : text(boundaryRow.funding_transfer_id);
  let fundingStatus: Status = "INCOMPLETE";
  let fundingComparison: Compare = "UNKNOWN";
  if (anchorId === null) {
    block("singleton funding transfer reference is absent");
  } else if (boundaryId === null || attemptTransferId === null) {
    block("singleton funding transfer reference cannot be compared with boundary and funding evidence");
  } else if (anchorId === boundaryId && anchorId === attemptTransferId) {
    fundingStatus = "VERIFIED";
    fundingComparison = "MATCH";
  } else {
    fundingStatus = "MISMATCH";
    fundingComparison = "MISMATCH";
    block("singleton funding anchor contradicts pair-boundary or funding-attempt evidence");
  }
  const singletonFingerprint = text(singletonRow.micro_live_restricted_key_fingerprint);
  const boundaryFingerprint = boundaryRow === null ? null : text(boundaryRow.restricted_key_fingerprint);
  const singletonKey = text(singletonRow.micro_live_restricted_api_key_id);
  const boundaryKey = boundaryRow === null ? null : text(boundaryRow.restricted_api_key_id);
  const fingerprintComparison: Compare = singletonFingerprint === null || boundaryFingerprint === null
    ? "UNKNOWN"
    : singletonFingerprint === boundaryFingerprint ? "MATCH" : "MISMATCH";
  const keyComparison: Compare = singletonKey === null || boundaryKey === null
    ? "UNKNOWN"
    : singletonKey === boundaryKey ? "MATCH" : "MISMATCH";
  let identityStatus: Status = "VERIFIED";
  if (fingerprintComparison === "MISMATCH" || keyComparison === "MISMATCH") {
    identityStatus = "MISMATCH";
    block("singleton INDEX2 evidence contradicts the pair boundary");
  } else if (fingerprintComparison !== "MATCH" || keyComparison !== "MATCH") {
    identityStatus = "INCOMPLETE";
    block("singleton INDEX2 evidence cannot be related to the pair boundary");
  }
  const identity: Compare = fingerprintComparison === "MISMATCH" || keyComparison === "MISMATCH"
    ? "MISMATCH"
    : fingerprintComparison === "MATCH" && keyComparison === "MATCH" ? "MATCH" : "UNKNOWN";
  return {
    identity,
    section: {
      status: worseStatus(section.status, worseStatus(fundingStatus, identityStatus)),
      lines: [
        ...section.lines,
        `Singleton funding transfer reference: ${anchorId === null ? "ABSENT" : "PRESENT"}`,
        `Singleton funding transfer versus boundary and funding attempt: ${fundingComparison}`,
        `Singleton fingerprint versus boundary fingerprint: ${fingerprintComparison}`,
        `Singleton key versus boundary key: ${keyComparison}`,
      ],
    },
  };
}

async function verifyFeeApproval(
  pool: ReadPool,
  installedFingerprint: string | null,
  boundary: Record<string, unknown> | null,
): Promise<Section> {
  const rows = await selectRows(pool, `
    select subaccount_number, exchange_index, prior_run_id, state, all_in_cap_micros,
      restricted_key_fingerprint, funding_transfer_id, funding_evidence_digest,
      pdf_digest, approved_at, created_at
    from micro_live_pair_fee_approval
    order by created_at asc nulls last, approved_at asc nulls last
  `);
  const pairRows = rows.filter((candidate) =>
    integer(candidate.subaccount_number) === EXPECTED_SUBACCOUNT &&
    integer(candidate.exchange_index) === EXPECTED_EXCHANGE_INDEX);
  const approvedRows = pairRows.filter((candidate) => candidate.state === "approved");
  const counts = [
    `Fee approval rows: ${rows.length}`,
    `Rows for other pairs: ${rows.length - pairRows.length}`,
    `Matching (1,2) rows: ${pairRows.length}`,
    `Approved (1,2) rows: ${approvedRows.length}`,
  ];
  if (pairRows.length !== 1 || approvedRows.length !== 1) {
    const status: Status = pairRows.length > 1 || approvedRows.length > 1 ? "MISMATCH" : "INCOMPLETE";
    block(status === "MISMATCH"
      ? "multiple fee approvals exist for subaccount 1 exchange index 2"
      : "an approved fee record for subaccount 1 exchange index 2 was not found");
    return { status, lines: counts };
  }
  const row = approvedRows[0]!;
  const fingerprintStatus = compareFingerprint(installedFingerprint, row.restricted_key_fingerprint);
  const transferMatch: Compare = boundary === null || text(boundary.funding_transfer_id) === null
    ? "UNKNOWN"
    : boundary.funding_transfer_id === row.funding_transfer_id ? "MATCH" : "MISMATCH";
  const digestOk = typeof row.funding_evidence_digest === "string" &&
    /^[0-9a-f]{64}$/.test(row.funding_evidence_digest);
  const capOk = integer(row.all_in_cap_micros) === EXPECTED_CAP_MICROS;
  const approved = capOk && fingerprintStatus === "MATCH" && transferMatch === "MATCH" && digestOk;
  const status: Status = !capOk || fingerprintStatus === "MISMATCH" || transferMatch === "MISMATCH"
    ? "MISMATCH"
    : approved ? "VERIFIED" : "INCOMPLETE";
  if (status !== "VERIFIED") block("pair fee approval for (1,2) is missing or inconsistent");
  return {
    status,
    lines: [
      ...counts,
      "Authoritative pair: (1, 2)",
      `State: ${text(row.state) ?? "UNKNOWN"}`,
      `Approved cap: ${dollarsFromMicros(integer(row.all_in_cap_micros))}`,
      `Fingerprint versus installed INDEX2: ${fingerprintStatus}`,
      `Funding reference versus boundary: ${transferMatch}`,
      `Funding evidence digest format: ${digestOk ? "CONSISTENT" : "INCONSISTENT"}`,
      `PDF digest: ${typeof row.pdf_digest === "string" && /^[0-9a-f]{64}$/.test(row.pdf_digest) ? "PRESENT" : "ABSENT"}`,
      `Approved at: ${stamp(row.approved_at)}`,
      "Revocation column: NOT_IN_SCHEMA",
    ],
  };
}

type LedgerIds = {
  orderExchangeIds: Set<string>;
  orderClientIds: Set<string>;
  fillIds: Set<string>;
};

function emptyLedger(): LedgerIds {
  return {
    orderExchangeIds: new Set<string>(),
    orderClientIds: new Set<string>(),
    fillIds: new Set<string>(),
  };
}

function runAssociation(
  runId: string | null,
  relevantRunIds: Set<string>,
): "ASSOCIATED" | "OTHER" | "UNATTRIBUTED" {
  if (runId === null || relevantRunIds.size === 0) return "UNATTRIBUTED";
  return relevantRunIds.has(runId) ? "ASSOCIATED" : "OTHER";
}

async function verifyLedger(
  pool: ReadPool,
  entryAttempted: boolean,
  relevantRunIds: Set<string>,
): Promise<{
  orders: Section;
  fills: Section;
  settlements: Section;
  decisions: Section;
  unexpected: "NONE" | "FOUND" | "UNKNOWN";
  ids: LedgerIds;
}> {
  const orders = await selectRows(pool, `
    select id, status, micro_live_run_id, created_at, exchange_order_id, client_order_id,
      market_ticker, position_id, exit_position_id
    from micro_live_orders
    order by created_at asc nulls last
  `);
  const fills = await selectRows(pool, `
    select order_id, exchange_fill_id, filled_at
    from micro_live_fills
    order by filled_at asc nulls last
  `);
  const settlements = await selectRows(pool, `
    select position_id, market_ticker, settled_at
    from micro_live_settlements
    order by settled_at asc nulls last
  `);
  const decisions = await selectRows(pool, `
    select status, reason, order_id, decided_at
    from micro_live_decisions
    order by decided_at desc
  `);
  const ids = emptyLedger();
  const ordersById = new Map<string, Record<string, unknown>>();
  for (const row of orders) {
    const id = text(row.id);
    const exchangeId = text(row.exchange_order_id);
    const clientId = text(row.client_order_id);
    if (id !== null) ordersById.set(id, row);
    if (exchangeId !== null) ids.orderExchangeIds.add(exchangeId);
    if (clientId !== null) ids.orderClientIds.add(clientId);
  }
  for (const row of fills) {
    const fillId = text(row.exchange_fill_id);
    if (fillId !== null) ids.fillIds.add(fillId);
  }
  const associatedOrders = orders.filter((row) =>
    runAssociation(text(row.micro_live_run_id), relevantRunIds) === "ASSOCIATED");
  const otherOrders = orders.filter((row) =>
    runAssociation(text(row.micro_live_run_id), relevantRunIds) === "OTHER");
  const unattributedOrders = orders.filter((row) =>
    runAssociation(text(row.micro_live_run_id), relevantRunIds) === "UNATTRIBUTED");
  const associatedOrderIds = new Set(
    associatedOrders.map((row) => text(row.id)).filter((id): id is string => id !== null),
  );
  const otherOrderIds = new Set(
    otherOrders.map((row) => text(row.id)).filter((id): id is string => id !== null),
  );
  const fillClass = (row: Record<string, unknown>): "ASSOCIATED" | "OTHER" | "UNATTRIBUTED" | "ORPHAN" => {
    const parent = text(row.order_id);
    if (parent === null || !ordersById.has(parent)) return "ORPHAN";
    if (associatedOrderIds.has(parent)) return "ASSOCIATED";
    if (otherOrderIds.has(parent)) return "OTHER";
    return "UNATTRIBUTED";
  };
  const associatedFills = fills.filter((row) => fillClass(row) === "ASSOCIATED");
  const otherFills = fills.filter((row) => fillClass(row) === "OTHER");
  const unattributedFills = fills.filter((row) => fillClass(row) === "UNATTRIBUTED");
  const orphanFills = fills.filter((row) => fillClass(row) === "ORPHAN");
  const associatedTickers = new Set(
    associatedOrders.map((row) => text(row.market_ticker)).filter((id): id is string => id !== null),
  );
  const associatedPositions = new Set<string>();
  for (const row of associatedOrders) {
    const position = text(row.position_id);
    const exitPosition = text(row.exit_position_id);
    if (position !== null) associatedPositions.add(position);
    if (exitPosition !== null) associatedPositions.add(exitPosition);
  }
  const otherTickers = new Set(
    otherOrders.map((row) => text(row.market_ticker)).filter((id): id is string => id !== null),
  );
  const settlementClass = (row: Record<string, unknown>): "ASSOCIATED" | "OTHER" | "UNATTRIBUTED" => {
    const ticker = text(row.market_ticker);
    const position = text(row.position_id);
    if ((ticker !== null && associatedTickers.has(ticker)) ||
        (position !== null && associatedPositions.has(position))) {
      return "ASSOCIATED";
    }
    if (ticker !== null && otherTickers.has(ticker)) return "OTHER";
    return "UNATTRIBUTED";
  };
  const associatedSettlements = settlements.filter((row) => settlementClass(row) === "ASSOCIATED");
  const otherSettlements = settlements.filter((row) => settlementClass(row) === "OTHER");
  const unattributedSettlements = settlements.filter((row) => settlementClass(row) === "UNATTRIBUTED");
  const knownStatuses = new Set(["pending", "unknown", "partial", "rejected", "canceled", "filled", "closed"]);
  const badAssociatedStatus = associatedOrders.some((row) => !knownStatuses.has(String(row.status)));
  const badOtherStatus = orders.some((row) =>
    !associatedOrderIds.has(text(row.id) ?? "") && !knownStatuses.has(String(row.status)));
  const unexpectedAssociated = !entryAttempted &&
    (associatedOrders.length > 0 || associatedFills.length > 0 || associatedSettlements.length > 0);
  const ledgerAmbiguous = unattributedOrders.length > 0 || unattributedFills.length > 0 ||
    unattributedSettlements.length > 0 || orphanFills.length > 0 || badOtherStatus;
  const unexpected = unexpectedAssociated || badAssociatedStatus
    ? "FOUND"
    : ledgerAmbiguous ? "UNKNOWN" : "NONE";
  if (unexpected === "FOUND") block("commissioned-run ledger activity is inconsistent with commissioning evidence");
  if (unexpected === "UNKNOWN") block("local ledger rows could not be attributed to the commissioned run");
  const statusCounts = new Map<string, number>();
  for (const row of orders) {
    const status = text(row.status) ?? "UNKNOWN";
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const decisionCounts = new Map<string, number>();
  for (const row of decisions) {
    const status = text(row.status) ?? "UNKNOWN";
    decisionCounts.set(status, (decisionCounts.get(status) ?? 0) + 1);
  }
  const associatedDecisions = decisions.filter((row) => associatedOrderIds.has(text(row.order_id) ?? ""));
  const orderTimes = associatedOrders.map((row) => stamp(row.created_at)).filter((value) => value !== "UNKNOWN").sort();
  const fillTimes = associatedFills.map((row) => stamp(row.filled_at)).filter((value) => value !== "UNKNOWN").sort();
  const settlementTimes = associatedSettlements.map((row) => stamp(row.settled_at)).filter((value) => value !== "UNKNOWN").sort();
  const latestBlocked = decisions.find((row) => row.status === "BLOCK");
  const orderStatus: Status = badAssociatedStatus || unexpectedAssociated
    ? "MISMATCH"
    : unattributedOrders.length > 0 || badOtherStatus ? "INCOMPLETE" : "VERIFIED";
  const fillStatus: Status = unexpectedAssociated && associatedFills.length > 0
    ? "MISMATCH"
    : orphanFills.length > 0 || unattributedFills.length > 0 ? "INCOMPLETE" : "VERIFIED";
  const settlementStatus: Status = unexpectedAssociated && associatedSettlements.length > 0
    ? "MISMATCH"
    : unattributedSettlements.length > 0 ? "INCOMPLETE" : "VERIFIED";
  return {
    unexpected,
    ids,
    orders: {
      status: orderStatus,
      lines: [
        `Total historical rows: ${orders.length}`,
        `Rows for relevant commissioning run: ${associatedOrders.length}`,
        `Other historical rows: ${otherOrders.length}`,
        `Unattributed rows: ${unattributedOrders.length}`,
        `By status: ${statusCounts.size === 0 ? "NONE" : [...statusCounts].map(([status, count]) => `${status}=${count}`).join(", ")}`,
        `Relevant run ids: ${relevantRunIds.size === 0 ? "NONE" : [...relevantRunIds].join(", ")}`,
        `Earliest relevant: ${orderTimes[0] ?? "NONE"}`,
        `Latest relevant: ${orderTimes[orderTimes.length - 1] ?? "NONE"}`,
      ],
    },
    fills: {
      status: fillStatus,
      lines: [
        `Total historical rows: ${fills.length}`,
        `Rows for relevant commissioning run: ${associatedFills.length}`,
        `Other historical rows: ${otherFills.length}`,
        `Unattributed rows: ${unattributedFills.length}`,
        `Orphan fills: ${orphanFills.length}`,
        `Earliest relevant: ${fillTimes[0] ?? "NONE"}`,
        `Latest relevant: ${fillTimes[fillTimes.length - 1] ?? "NONE"}`,
      ],
    },
    settlements: {
      status: settlementStatus,
      lines: [
        `Total historical rows: ${settlements.length}`,
        `Rows linked to relevant commissioning run: ${associatedSettlements.length}`,
        `Other historical rows: ${otherSettlements.length}`,
        `Unattributed rows: ${unattributedSettlements.length}`,
        "Run id column: NOT_IN_SCHEMA",
        `Earliest relevant: ${settlementTimes[0] ?? "NONE"}`,
        `Latest relevant: ${settlementTimes[settlementTimes.length - 1] ?? "NONE"}`,
      ],
    },
    decisions: {
      status: "VERIFIED",
      lines: [
        `Total historical rows: ${decisions.length}`,
        `Rows linked to relevant commissioning orders: ${associatedDecisions.length}`,
        `By status: ${decisionCounts.size === 0 ? "NONE" : [...decisionCounts].map(([status, count]) => `${status}=${count}`).join(", ")}`,
        `Latest: ${decisions[0] ? stamp(decisions[0].decided_at) : "NONE"}`,
        `Latest blocked reason: ${latestBlocked ? safeReason(latestBlocked.reason) : "NONE"}`,
        "Run id column: NOT_IN_SCHEMA",
      ],
    },
  };
}

export async function verifyShadowConfig(pool: ReadPool): Promise<Section> {
  const rows = await selectRows(pool, `
    select id, mode, live_execution_enabled, manual_kill_switch
    from live_execution_config
    where id = $1
  `, ["singleton"]);
  if (rows.length !== 1) {
    return { status: "INCOMPLETE", lines: ["live_execution_config singleton: ABSENT"] };
  }
  const row = rows[0]!;
  const disabled = row.live_execution_enabled === false && row.manual_kill_switch === true;
  if (row.live_execution_enabled !== false) block("live_execution_config.live_execution_enabled is not false");
  if (row.manual_kill_switch !== true) block("live_execution_config.manual_kill_switch is not ON");
  return {
    status: disabled ? "VERIFIED" : "MISMATCH",
    lines: [
      `Mode: ${text(row.mode) ?? "UNKNOWN"}`,
      `live_execution_enabled: ${row.live_execution_enabled === false ? "false" : "NOT_FALSE"}`,
      `manual_kill_switch: ${row.manual_kill_switch === true ? "ON" : row.manual_kill_switch === false ? "OFF" : "UNKNOWN"}`,
      "This is the shadow configuration table, separate from micro_live_config.",
    ],
  };
}

function signGet(keyId: string, privateKey: string, path: string): { timestamp: string; signature: string } | null {
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "rsa-pss") return null;
    const timestamp = Date.now().toString();
    const signer = createSign("sha256");
    signer.update(`${timestamp}GET${path}`);
    signer.end();
    const signature = signer.sign({
      key,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString("base64");
    return { timestamp, signature };
  } catch {
    return null;
  }
}

function assertGetPath(path: string): void {
  const allowed = new Set([
    `${API_PREFIX}/portfolio/balance`,
    `${API_PREFIX}/portfolio/positions`,
    `${API_PREFIX}/portfolio/orders`,
    `${API_PREFIX}/portfolio/fills`,
    `${API_PREFIX}/portfolio/settlements`,
    `${API_PREFIX}/portfolio/subaccounts/transfers`,
    `${API_PREFIX}/portfolio/intra_exchange_instance_transfers`,
    `${API_PREFIX}/historical/orders`,
    `${API_PREFIX}/historical/fills`,
    `${API_PREFIX}/api_keys`,
  ]);
  if (!allowed.has(path)) throw new Error("KALSHI_PATH_REFUSED");
}

async function kalshiGet(
  creds: { keyId: string; privateKey: string },
  path: string,
  query: string,
): Promise<{ http: number; body: unknown } | { failed: "KALSHI_SIGNED_GET_FAILED"; http: number | null }> {
  assertGetPath(path);
  const signed = signGet(creds.keyId, creds.privateKey, path);
  if (!signed) return { failed: "KALSHI_SIGNED_GET_FAILED", http: null };
  const method = "GET" as const;
  try {
    const response = await fetch(`${PRODUCTION_HOST}${path}${query}`, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/json",
        "KALSHI-ACCESS-KEY": creds.keyId,
        "KALSHI-ACCESS-SIGNATURE": signed.signature,
        "KALSHI-ACCESS-TIMESTAMP": signed.timestamp,
      },
    });
    if (!response.ok) return { failed: "KALSHI_SIGNED_GET_FAILED", http: response.status };
    try {
      return { http: response.status, body: await response.json() as unknown };
    } catch {
      return { failed: "KALSHI_SIGNED_GET_FAILED", http: response.status };
    }
  } catch {
    return { failed: "KALSHI_SIGNED_GET_FAILED", http: null };
  }
}

type FeedState = "COMPLETE" | "INCOMPLETE" | "FAILED";
type Feed = { state: FeedState; items: Array<Record<string, unknown>> };
type Shard = "PAIR" | "ELSEWHERE" | "AMBIGUOUS";
type KalshiPermissions = "VERIFIED" | "DATABASE_EVIDENCE_ONLY" | "NOT_DIRECTLY_VERIFIABLE" | "UNREADABLE" | "MISMATCH" | "INCOMPLETE";
type PaginationState = "COMPLETE" | "INCOMPLETE" | "FAILED";

type KalshiReport = {
  host: Status;
  signedGet: Status;
  identity: Status;
  permissions: KalshiPermissions;
  cash: string;
  portfolio: string;
  balanceUpdated: string;
  observedAt: string;
  requestedAccount: string;
  positions: string;
  orders: string;
  fills: string;
  settlements: string;
  historicalOrders: string;
  historicalFills: string;
  subaccountTransfers: string;
  intraExchange: string;
  pagination: PaginationState;
  transfer: Status;
  activity: "NONE" | "EXPLAINED" | "UNEXPLAINED" | "UNKNOWN";
  transferCross: Compare;
  ledgerCross: Compare;
};

async function kalshiPages(
  creds: { keyId: string; privateKey: string },
  path: string,
  query: string,
  arrayKeys: string[],
): Promise<Feed> {
  const items: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const pageQuery = `${query}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const result = await kalshiGet(creds, path, pageQuery);
    if ("failed" in result) return { state: "FAILED", items };
    const root = object(result.body);
    if (!root) return { state: "FAILED", items };
    const key = arrayKeys.find((candidate) => Array.isArray(root[candidate]));
    const batch = key === undefined ? [] : (root[key] as unknown[]).map(object).filter((item): item is Record<string, unknown> => item !== null);
    items.push(...batch);
    const next = root.cursor;
    if (next === undefined || next === null || next === "") return { state: "COMPLETE", items };
    if (typeof next !== "string" || seen.has(next)) return { state: "INCOMPLETE", items };
    seen.add(next);
    cursor = next;
  }
  return { state: "INCOMPLETE", items };
}

function balanceNumbers(body: unknown): {
  cash: string;
  portfolio: string;
  echo: "ABSENT" | "MATCH" | "MISMATCH";
  updated: string;
} {
  const root = object(body);
  const nested = root === null ? null : object(root.balance) ?? root;
  if (nested === null) {
    return { cash: "UNKNOWN", portfolio: "NOT_AVAILABLE", echo: "ABSENT", updated: "UNKNOWN" };
  }
  const dollarCash = fixedPointDollars(nested.balance_dollars);
  const centCash = integerCents(nested.balance);
  const cash = dollarCash !== null && centCash !== null && dollarCash !== centsToDollars(centCash)
    ? "INCONSISTENT"
    : dollarCash ?? (centCash === null ? "UNKNOWN" : centsToDollars(centCash));
  const dollarPortfolio = fixedPointDollars(nested.portfolio_value_dollars);
  const centPortfolio = integerCents(nested.portfolio_value);
  const portfolio = dollarPortfolio !== null && centPortfolio !== null &&
      dollarPortfolio !== centsToDollars(centPortfolio)
    ? "INCONSISTENT"
    : dollarPortfolio ?? (centPortfolio === null ? "NOT_AVAILABLE" : centsToDollars(centPortfolio));
  const echoedSubaccount = integer(nested.subaccount_number ?? nested.subaccount);
  const echoedIndex = integer(nested.exchange_index);
  const echo = echoedSubaccount === null && echoedIndex === null
    ? "ABSENT"
    : (echoedSubaccount === null || echoedSubaccount === EXPECTED_SUBACCOUNT) &&
        (echoedIndex === null || echoedIndex === EXPECTED_EXCHANGE_INDEX)
      ? "MATCH"
      : "MISMATCH";
  return { cash, portfolio, echo, updated: kalshiTimestamp(nested.updated_ts) };
}

function exchangeIndexOf(row: Record<string, unknown>): number | null {
  const value = integer(row.exchange_index);
  return value !== null && value >= 0 ? value : null;
}

function classifyActivity(row: Record<string, unknown>): Shard {
  const subaccount = integer(row.subaccount_number ?? row.subaccount);
  const exchangeIndex = exchangeIndexOf(row);
  if (exchangeIndex === null) return "AMBIGUOUS";
  if (exchangeIndex !== EXPECTED_EXCHANGE_INDEX) return "ELSEWHERE";
  if (subaccount !== null && subaccount !== EXPECTED_SUBACCOUNT) return "ELSEWHERE";
  return "PAIR";
}

function classifySubaccountTransfer(row: Record<string, unknown>): Shard {
  const from = integer(row.from_subaccount);
  const to = integer(row.to_subaccount);
  const exchangeIndex = exchangeIndexOf(row);
  if (from === null || to === null || exchangeIndex === null) return "AMBIGUOUS";
  if (exchangeIndex === EXPECTED_EXCHANGE_INDEX &&
      (from === EXPECTED_SUBACCOUNT || to === EXPECTED_SUBACCOUNT)) {
    return "PAIR";
  }
  return "ELSEWHERE";
}

function classifyIntraExchangeTransfer(row: Record<string, unknown>): Shard {
  const sourceSubaccount = integer(row.source_subaccount ?? row.source);
  const destinationSubaccount = integer(row.destination_subaccount ?? row.destination);
  const sourceShard = integer(row.source_exchange_shard);
  const destinationShard = integer(row.destination_exchange_shard);
  const sourceIsPair = sourceSubaccount === EXPECTED_SUBACCOUNT && sourceShard === EXPECTED_EXCHANGE_INDEX;
  const destinationIsPair = destinationSubaccount === EXPECTED_SUBACCOUNT &&
    destinationShard === EXPECTED_EXCHANGE_INDEX;
  if (sourceIsPair || destinationIsPair) return "PAIR";
  if (sourceSubaccount !== null && destinationSubaccount !== null &&
      sourceShard !== null && sourceShard >= 0 &&
      destinationShard !== null && destinationShard >= 0) {
    return "ELSEWHERE";
  }
  return "AMBIGUOUS";
}

function shardCounts(items: Array<Record<string, unknown>>, classify: (row: Record<string, unknown>) => Shard): string {
  const counts = { PAIR: 0, ELSEWHERE: 0, AMBIGUOUS: 0 };
  for (const item of items) counts[classify(item)] += 1;
  return `pair=${counts.PAIR} elsewhere=${counts.ELSEWHERE} ambiguous=${counts.AMBIGUOUS}`;
}

function describeFeed(feed: Feed, classify: (row: Record<string, unknown>) => Shard = classifyActivity): string {
  return `${feed.state} ${shardCounts(feed.items, classify)}`;
}

function isExpectedSubaccountFunding(row: Record<string, unknown>): boolean {
  return integer(row.from_subaccount) === 0 &&
    integer(row.to_subaccount) === EXPECTED_SUBACCOUNT &&
    exchangeIndexOf(row) === EXPECTED_EXCHANGE_INDEX &&
    integerCents(row.amount_cents) === EXPECTED_FUNDING_CENTS;
}

function orderExplained(row: Record<string, unknown>, local: {
  orderExchangeIds: Set<string>;
  orderClientIds: Set<string>;
}): boolean {
  const exchangeId = text(row.order_id) ?? text(row.id);
  const clientId = text(row.client_order_id);
  return (exchangeId !== null && local.orderExchangeIds.has(exchangeId)) ||
    (clientId !== null && local.orderClientIds.has(clientId));
}

function fillExplained(row: Record<string, unknown>, local: {
  orderExchangeIds: Set<string>;
  fillIds: Set<string>;
}): boolean {
  const fillId = text(row.trade_id) ?? text(row.fill_id) ?? text(row.id);
  const parent = text(row.order_id);
  return (fillId !== null && local.fillIds.has(fillId)) ||
    (parent !== null && local.orderExchangeIds.has(parent));
}

function relatedByDurableId(
  row: Record<string, unknown>,
  orders: Array<Record<string, unknown>>,
  fills: Array<Record<string, unknown>>,
  local: { orderExchangeIds: Set<string>; orderClientIds: Set<string>; fillIds: Set<string> },
): boolean {
  const ticker = tickerOf(row);
  if (ticker === "UNKNOWN") return false;
  return orders.some((order) => tickerOf(order) === ticker && orderExplained(order, local)) ||
    fills.some((fill) => tickerOf(fill) === ticker && fillExplained(fill, local));
}

function nonzeroPosition(row: Record<string, unknown>): boolean {
  const quantity = row.position_fp ?? row.position ?? 0;
  if (typeof quantity === "number") return quantity !== 0;
  if (typeof quantity !== "string") return true;
  return !/^-?0+(?:\.0+)?$/.test(quantity.trim());
}

function tickerOf(row: Record<string, unknown>): string {
  const ticker = text(row.ticker) ?? text(row.market_ticker);
  return ticker !== null && /^[A-Za-z0-9._-]{1,128}$/.test(ticker) ? ticker : "UNKNOWN";
}

function blankKalshi(overrides: Partial<KalshiReport>): KalshiReport {
  return {
    host: "INCOMPLETE",
    signedGet: "INCOMPLETE",
    identity: "INCOMPLETE",
    permissions: "INCOMPLETE",
    cash: "UNKNOWN",
    portfolio: "NOT_AVAILABLE",
    balanceUpdated: "UNKNOWN",
    observedAt: "UNKNOWN",
    requestedAccount: "subaccount 1, exchange index 2, credential INDEX2",
    positions: "NOT_READ",
    orders: "NOT_READ",
    fills: "NOT_READ",
    settlements: "NOT_READ",
    historicalOrders: "NOT_READ",
    historicalFills: "NOT_READ",
    subaccountTransfers: "NOT_READ",
    intraExchange: "NOT_READ",
    pagination: "FAILED",
    transfer: "INCOMPLETE",
    activity: "UNKNOWN",
    transferCross: "UNKNOWN",
    ledgerCross: "UNKNOWN",
    ...overrides,
  };
}

async function verifyKalshi(
  creds: { keyId: string; privateKey: string },
  local: {
    orderExchangeIds: Set<string>;
    orderClientIds: Set<string>;
    fillIds: Set<string>;
    fundingTransferId: string | null;
  },
): Promise<KalshiReport> {
  const requestedAccount = "subaccount 1, exchange index 2, credential INDEX2";
  const balance = await kalshiGet(
    creds,
    `${API_PREFIX}/portfolio/balance`,
    `?subaccount=${EXPECTED_SUBACCOUNT}&exchange_index=${EXPECTED_EXCHANGE_INDEX}`,
  );
  if ("failed" in balance) {
    const rejected = balance.http === 401 || balance.http === 403;
    block(rejected ? "INDEX2 signed GET was rejected" : "INDEX2 signed GET failed");
    return blankKalshi({
      host: balance.http === null ? "INCOMPLETE" : "VERIFIED",
      signedGet: rejected ? "MISMATCH" : "INCOMPLETE",
      requestedAccount,
    });
  }
  const observedAt = new Date().toISOString();
  const parsed = balanceNumbers(balance.body);
  if (parsed.cash === "UNKNOWN" || parsed.cash === "INCONSISTENT" || parsed.portfolio === "INCONSISTENT") {
    block("Kalshi balance fields could not be parsed consistently as cents and dollars");
  }
  if (parsed.echo === "MISMATCH") {
    block("balance response echoed an account other than subaccount 1 exchange index 2");
    return blankKalshi({
      host: "VERIFIED",
      signedGet: "VERIFIED",
      identity: "MISMATCH",
      cash: parsed.cash,
      portfolio: parsed.portfolio,
      balanceUpdated: parsed.updated,
      observedAt,
      requestedAccount,
    });
  }

  const keys = await kalshiGet(creds, `${API_PREFIX}/api_keys`, "");
  let permissions: KalshiPermissions = "UNREADABLE";
  if (!("failed" in keys)) {
    const root = object(keys.body);
    const records = Array.isArray(root?.api_keys) ? root.api_keys.map(object).filter((item): item is Record<string, unknown> => item !== null) : [];
    const own = records.find((record) => record.api_key_id === creds.keyId);
    if (!own) {
      permissions = "NOT_DIRECTLY_VERIFIABLE";
    } else {
      const subaccount = integer(own.subaccount);
      permissions = scopesAreExactRestrictedSet(own.scopes) && subaccount === EXPECTED_SUBACCOUNT
        ? "VERIFIED"
        : "MISMATCH";
      if (permissions === "MISMATCH") block("INDEX2 API-key metadata does not match subaccount 1 read and write::trade");
    }
  }

  const scoped = `?limit=100&subaccount=${EXPECTED_SUBACCOUNT}&exchange_index=${EXPECTED_EXCHANGE_INDEX}`;
  const subaccountOnly = `?limit=100&subaccount=${EXPECTED_SUBACCOUNT}`;
  const positions = await kalshiPages(creds, `${API_PREFIX}/portfolio/positions`, scoped, ["market_positions", "positions"]);
  const orders = await kalshiPages(creds, `${API_PREFIX}/portfolio/orders`, scoped, ["orders"]);
  const fills = await kalshiPages(creds, `${API_PREFIX}/portfolio/fills`, scoped, ["fills"]);
  const settlements = await kalshiPages(creds, `${API_PREFIX}/portfolio/settlements`, subaccountOnly, ["settlements"]);
  const historicalOrders = await kalshiPages(creds, `${API_PREFIX}/historical/orders`, subaccountOnly, ["orders"]);
  const historicalFills = await kalshiPages(creds, `${API_PREFIX}/historical/fills`, subaccountOnly, ["fills"]);
  const transfers = await kalshiPages(creds, `${API_PREFIX}/portfolio/subaccounts/transfers`, "?limit=100", ["transfers"]);
  const cross = await kalshiPages(creds, `${API_PREFIX}/portfolio/intra_exchange_instance_transfers`, "?limit=100", ["transfers"]);

  const activityFeeds = [positions, orders, fills, settlements, historicalOrders, historicalFills];
  const evidenceFeeds = [...activityFeeds, transfers, cross];
  if (evidenceFeeds.some((feed) => feed.state === "FAILED")) {
    block("one or more INDEX2 account reads failed");
  } else if (evidenceFeeds.some((feed) => feed.state === "INCOMPLETE")) {
    block("one or more INDEX2 account reads were truncated");
  }
  const orderItems = [...orders.items, ...historicalOrders.items];
  const fillItems = [...fills.items, ...historicalFills.items];
  const pairOrders = orderItems.filter((row) => classifyActivity(row) === "PAIR");
  const pairFills = fillItems.filter((row) => classifyActivity(row) === "PAIR");
  const ambiguousOrders = orderItems.filter((row) => classifyActivity(row) === "AMBIGUOUS");
  const ambiguousFills = fillItems.filter((row) => classifyActivity(row) === "AMBIGUOUS");
  const pairPositions = positions.items.filter((row) => classifyActivity(row) === "PAIR" && nonzeroPosition(row));
  const pairSettlements = settlements.items.filter((row) => classifyActivity(row) === "PAIR");
  const ambiguousActivity = [
    ...positions.items.filter(nonzeroPosition),
    ...orderItems,
    ...fillItems,
    ...settlements.items,
  ].filter((row) => classifyActivity(row) === "AMBIGUOUS").length;
  const linkedToPair = (row: Record<string, unknown>) => relatedByDurableId(row, pairOrders, pairFills, local);
  const linkedOnlyToAmbiguous = (row: Record<string, unknown>) =>
    !linkedToPair(row) && relatedByDurableId(row, ambiguousOrders, ambiguousFills, local);
  const unexplained = pairOrders.some((row) => !orderExplained(row, local)) ||
    pairFills.some((row) => !fillExplained(row, local)) ||
    pairPositions.some((row) => !linkedToPair(row) && !linkedOnlyToAmbiguous(row)) ||
    pairSettlements.some((row) => !linkedToPair(row) && !linkedOnlyToAmbiguous(row));
  if (pairPositions.some(linkedOnlyToAmbiguous) || pairSettlements.some(linkedOnlyToAmbiguous)) {
    block("a (1,2) position or settlement is linked only to exchange records whose exchange index is ambiguous");
  }
  const activityFeedsClosed = activityFeeds.every((feed) => feed.state === "COMPLETE");
  const pairActivity = pairOrders.length + pairFills.length + pairPositions.length + pairSettlements.length > 0;
  const activity = unexplained
    ? "UNEXPLAINED"
    : !activityFeedsClosed || ambiguousActivity > 0
      ? "UNKNOWN"
      : pairActivity ? "EXPLAINED" : "NONE";
  if (activity === "UNEXPLAINED") block("Kalshi (1,2) activity is not explained by durable local ledger ids");
  if (activity === "UNKNOWN") block("Kalshi activity evidence is incomplete or exchange identity is ambiguous");

  const ambiguousTransfers = transfers.items.filter((row) => classifySubaccountTransfer(row) === "AMBIGUOUS").length;
  const pairTransfers = transfers.items.filter((row) => classifySubaccountTransfer(row) === "PAIR");
  const matchingTransfers = pairTransfers.filter(isExpectedSubaccountFunding);
  const ambiguousIntra = cross.items.filter((row) => classifyIntraExchangeTransfer(row) === "AMBIGUOUS").length;
  let transfer: Status = "INCOMPLETE";
  let transferCross: Compare = "UNKNOWN";
  if (matchingTransfers.length > 1 || pairTransfers.length > matchingTransfers.length) {
    transfer = "MISMATCH";
    transferCross = "MISMATCH";
    block("Kalshi subaccount transfer history shows more than the single historical $25 funding event");
  } else if (transfers.state === "COMPLETE" && ambiguousTransfers === 0 && matchingTransfers.length === 1 &&
      pairTransfers.length === 1) {
    const transferId = text(matchingTransfers[0]?.transfer_id);
    transferCross = local.fundingTransferId !== null && transferId === local.fundingTransferId
      ? "MATCH"
      : "MISMATCH";
    transfer = transferCross === "MATCH" ? "VERIFIED" : "MISMATCH";
    if (transferCross === "MISMATCH") block("Kalshi transfer reference does not match the database funding record");
  } else {
    block("the historical $25 subaccount transfer was not completely visible to the INDEX2 credential");
  }
  const pagination: PaginationState = evidenceFeeds.some((feed) => feed.state === "FAILED")
    ? "FAILED"
    : evidenceFeeds.some((feed) => feed.state === "INCOMPLETE") || ambiguousActivity > 0 ||
        ambiguousTransfers > 0 || ambiguousIntra > 0
      ? "INCOMPLETE"
      : "COMPLETE";
  const ledgerCross: Compare = activity === "UNEXPLAINED"
    ? "MISMATCH"
    : activity === "NONE" || activity === "EXPLAINED"
      ? pagination === "COMPLETE" ? "MATCH" : "UNKNOWN"
      : "UNKNOWN";
  if (pagination !== "COMPLETE" && activity !== "UNEXPLAINED" && activity !== "UNKNOWN") {
    block("supplemental Kalshi evidence is truncated, failed, or exchange identity is ambiguous");
  }

  return {
    host: "VERIFIED",
    signedGet: "VERIFIED",
    identity: permissions === "MISMATCH" ? "MISMATCH" : "VERIFIED",
    permissions,
    cash: parsed.cash,
    portfolio: parsed.portfolio,
    balanceUpdated: parsed.updated,
    observedAt,
    requestedAccount,
    positions: describeFeed(positions),
    orders: describeFeed(orders),
    fills: describeFeed(fills),
    settlements: describeFeed(settlements),
    historicalOrders: describeFeed(historicalOrders),
    historicalFills: describeFeed(historicalFills),
    subaccountTransfers: describeFeed(transfers, classifySubaccountTransfer),
    intraExchange: describeFeed(cross, classifyIntraExchangeTransfer),
    pagination,
    transfer,
    activity,
    transferCross,
    ledgerCross,
  };
}

function databaseConclusion(parts: Status[]): Status {
  if (parts.includes("MISMATCH")) return "MISMATCH";
  if (parts.includes("INCOMPLETE")) return "INCOMPLETE";
  return "VERIFIED";
}

function printReport(input: {
  env: EnvReport;
  host: Status;
  database: Status;
  frozen: Status;
  archive: Section;
  runArchive: Section;
  boundary: Section;
  provisioning: Section;
  funding: Section;
  fee: Section;
  orders: Section;
  fills: Section;
  settlements: Section;
  decisions: Section;
  singleton: Section;
  environmentBinding: Section;
  shadow: Section;
  unexpected: "NONE" | "FOUND" | "UNKNOWN";
  limits: string[];
  kalshi: Awaited<ReturnType<typeof verifyKalshi>> | null;
  kalshiFinal: Status;
  pairCross: Compare;
  index2Cross: Compare;
}): void {
  line("LIVE READINESS VERIFICATION");
  line("===========================");
  line("");
  line("Environment");
  line("");
  line(`DATABASE_URL: ${input.env.databaseUrl}`);
  line(`Database destination (fingerprint proof): ${input.env.databaseDestination}`);
  line(`Application mode inferred from NODE_ENV (not database target proof): ${input.env.runtime}`);
  line(`NODE_ENV: ${input.env.nodeEnv}`);
  line(`MICRO_LIVE_ACCOUNT_MODE: ${input.env.accountMode}`);
  line(`Dedicated execution binding: ${input.environmentBinding.status}`);
  for (const item of input.environmentBinding.lines) line(`  ${item}`);
  line(`Configured subaccount: ${input.env.configuredSubaccount}`);
  line(`Configured exchange index: ${input.env.configuredExchangeIndex}`);
  line(`Kalshi environment: ${input.env.kalshiEnvironment}`);
  line(`Kalshi production host: ${input.host}`);
  line(`INDEX2 credential: ${input.env.index2}`);
  line(`Shared credential: ${input.env.shared}`);
  line(`Shared vs INDEX2: ${input.env.sharedVersusIndex2}`);
  line("");
  line("Database");
  line("");
  line(`Authoritative commissioning evidence: ${input.database}`);
  line(`Micro-live singleton: ${input.singleton.status}`);
  for (const item of input.singleton.lines) line(`  ${item}`);
  line(`Historical FROZEN state: ${input.frozen}`);
  line(`Commissioning archive: ${input.archive.status}`);
  for (const item of input.archive.lines) line(`  ${item}`);
  line(`Run archive: ${input.runArchive.status}`);
  for (const item of input.runArchive.lines) line(`  ${item}`);
  line(`Pair boundary (1,2): ${input.boundary.status}`);
  for (const item of input.boundary.lines) line(`  ${item}`);
  line(`INDEX2 provisioning evidence: ${input.provisioning.status}`);
  for (const item of input.provisioning.lines) line(`  ${item}`);
  line(`Historical $25 funding evidence: ${input.funding.status}`);
  for (const item of input.funding.lines) line(`  ${item}`);
  line(`Pair-specific fee approval: ${input.fee.status}`);
  for (const item of input.fee.lines) line(`  ${item}`);
  line("Shadow live_execution_config:");
  line(`  ${input.shadow.status}`);
  for (const item of input.shadow.lines) line(`  ${item}`);
  line("Micro-live orders:");
  for (const item of input.orders.lines) line(`  ${item}`);
  line("Micro-live fills:");
  for (const item of input.fills.lines) line(`  ${item}`);
  line("Micro-live settlements:");
  for (const item of input.settlements.lines) line(`  ${item}`);
  line("Micro-live decisions:");
  for (const item of input.decisions.lines) line(`  ${item}`);
  line(`Unexpected database activity: ${input.unexpected}`);
  line("");
  line("Current configured limits");
  line("");
  for (const item of input.limits) line(item);
  line("");
  line("Kalshi (1,2)");
  line("");
  const kalshi = input.kalshi;
  line(`Requested account identity: ${kalshi?.requestedAccount ?? "subaccount 1, exchange index 2, credential INDEX2"}`);
  line(`INDEX2 signed GET: ${kalshi?.signedGet ?? "INCOMPLETE"}`);
  line(`Credential/account identity: ${kalshi?.identity ?? "INCOMPLETE"}`);
  line(`Permission evidence: ${kalshi?.permissions ?? "INCOMPLETE"}`);
  line(`Cash balance: ${kalshi?.cash ?? "UNKNOWN"}`);
  line(`Portfolio value: ${kalshi?.portfolio ?? "UNKNOWN"}`);
  line(`Kalshi balance updated: ${kalshi?.balanceUpdated ?? "UNKNOWN"}`);
  line(`Verifier observed: ${kalshi?.observedAt ?? "UNKNOWN"}`);
  line(`Positions: ${kalshi?.positions ?? "NOT_READ"}`);
  line(`Orders: ${kalshi?.orders ?? "NOT_READ"}`);
  line(`Fills: ${kalshi?.fills ?? "NOT_READ"}`);
  line(`Settlements: ${kalshi?.settlements ?? "NOT_READ"}`);
  line(`Historical orders: ${kalshi?.historicalOrders ?? "NOT_READ"}`);
  line(`Historical fills: ${kalshi?.historicalFills ?? "NOT_READ"}`);
  line(`Subaccount transfers: ${kalshi?.subaccountTransfers ?? "NOT_READ"}`);
  line(`Intra-exchange transfers: ${kalshi?.intraExchange ?? "NOT_READ"}`);
  line(`Pagination: ${kalshi?.pagination ?? "FAILED"}`);
  line(`Historical $25 transfer: ${kalshi?.transfer ?? "INCOMPLETE"}`);
  line(`Current account activity: ${kalshi?.activity ?? "UNKNOWN"}`);
  line("");
  line("Cross-check");
  line("");
  line(`Database pair vs Kalshi identity: ${input.pairCross}`);
  line(`Database INDEX2 vs installed INDEX2: ${input.index2Cross}`);
  line(`Database funding vs Kalshi transfer: ${kalshi?.transferCross ?? "UNKNOWN"}`);
  line(`Database ledger vs Kalshi activity: ${kalshi?.ledgerCross ?? "UNKNOWN"}`);
  line("");
  line("FINAL");
  line("");
  line(`DATABASE: ${input.database}`);
  line(`KALSHI (1,2): ${input.kalshiFinal}`);
  const safe = input.database === "VERIFIED" && input.kalshiFinal === "VERIFIED";
  line(`SAFE TO CONTINUE TO DEDICATED-PAIR COMMISSIONING REVIEW: ${safe ? "YES" : "NO"}`);
  line(`READINESS PREREQUISITES: ${safe ? "VERIFIED" : "BLOCKED"}`);
  line("EXECUTION AUTHORITY: NONE — this verifier cannot authorize live execution.");
  line("The readiness verdict is not a source-code review, executor-completion, or profitability verdict.");
  if (!safe) {
    line("Blocking reasons:");
    for (const reason of blocking) line(`- ${reason}`);
  }
  process.stdout.write(`${reportLines.join("\n")}\n`);
}

function emptySection(status: Status, textValue: string): Section {
  return { status, lines: [textValue] };
}

async function main(): Promise<void> {
  reportLines.length = 0;
  blocking.length = 0;
  const index2 = credentialMaterial("KALSHI_INDEX2_API_KEY_ID", "KALSHI_INDEX2_PRIVATE_KEY");
  const shared = credentialMaterial("KALSHI_API_KEY_ID", "KALSHI_API_PRIVATE_KEY");
  const env = checkEnvironment(index2, shared);
  const installedFingerprint = index2.present && index2.keyId && index2.privateKey
    ? fingerprint(index2.keyId, index2.privateKey)
    : null;

  let pool: ReadPool | null = null;
  let frozen: Status = "INCOMPLETE";
  let singletonSection = emptySection("INCOMPLETE", "Not read");
  let archive = emptySection("INCOMPLETE", "Not read");
  let runArchive = emptySection("INCOMPLETE", "Not read");
  let boundary = emptySection("INCOMPLETE", "Not read");
  let boundaryRow: Record<string, unknown> | null = null;
  let boundaryStop = false;
  let provisioning = emptySection("INCOMPLETE", "Not read");
  let funding = emptySection("INCOMPLETE", "Not read");
  let fee = emptySection("INCOMPLETE", "Not read");
  let orders = emptySection("INCOMPLETE", "Not read");
  let fills = emptySection("INCOMPLETE", "Not read");
  let settlements = emptySection("INCOMPLETE", "Not read");
  let decisions = emptySection("INCOMPLETE", "Not read");
  let shadow = emptySection("INCOMPLETE", "Not read");
  let unexpected: "NONE" | "FOUND" | "UNKNOWN" = "UNKNOWN";
  let ledgerIds = emptyLedger();
  let limits = [
    "Run cap: UNKNOWN",
    "Max live bankroll: UNKNOWN",
    "Max single order risk: UNKNOWN",
    "Max scout stake: UNKNOWN",
    "Max confirm/add stake: UNKNOWN",
  ];
  let singleton: Record<string, unknown> | null = null;
  let index2Cross: Compare = "UNKNOWN";

  if (env.databaseUrl === "MISSING") {
    block("DATABASE_URL is missing");
  } else {
    try {
      pool = await openPool();
      const destination = await selectRows(pool, `select md5(current_database()) as database_name_hash,
        md5(coalesce(inet_server_addr()::text, 'local') || ':' ||
          coalesce(inet_server_port()::text, '?')) as server_endpoint_hash,
        (select oid from pg_database where datname = current_database()) as database_oid`);
      const guardPath = "../lib/db/src/verified-destinations.mjs";
      const { classifyDatabaseDestination } = await import(guardPath);
      env.databaseDestination = classifyDatabaseDestination(destination[0]);
      if (env.databaseDestination === "UNKNOWN") block("database destination could not be independently identified");
      const singletonResult = await verifySingleton(pool, installedFingerprint, index2.keyId);
      singleton = singletonResult.row;
      singletonSection = singletonResult.section;
      limits = singletonResult.limits;
      index2Cross = singleton === null
        ? "UNKNOWN"
        : compareFingerprint(installedFingerprint, singleton.micro_live_restricted_key_fingerprint);
      env.index2FingerprintVersusBoundary = index2Cross;
      const runId = singleton === null ? null : text(singleton.micro_live_run_id);
      archive = await verifyCommissioningArchive(pool, runId);
      runArchive = await verifyRunArchive(pool, runId);
      const boundaryResult = await verifyPairBoundary(pool, installedFingerprint, index2.keyId);
      boundary = boundaryResult.section;
      boundaryRow = boundaryResult.row;
      boundaryStop = boundaryResult.stop;
      if (boundaryRow !== null) {
        const boundaryFingerprint = compareFingerprint(installedFingerprint, boundaryRow.restricted_key_fingerprint);
        if (boundaryFingerprint !== "UNKNOWN") index2Cross = boundaryFingerprint;
      }
      provisioning = await verifyIndex2Provisioning(pool, index2.keyId);
      const fundingResult = await verifyFunding(pool, boundaryRow);
      funding = fundingResult.section;
      const singletonCross = attachSingletonCrossChecks(
        singletonSection,
        singleton,
        boundaryRow,
        fundingResult.transferId,
      );
      singletonSection = singletonCross.section;
      if (singletonCross.identity === "MISMATCH") index2Cross = "MISMATCH";
      if (singletonCross.identity === "UNKNOWN" && index2Cross !== "MISMATCH") index2Cross = "UNKNOWN";
      fee = await verifyFeeApproval(pool, installedFingerprint, boundaryRow);
      const relevantRunIds = new Set<string>();
      const singletonRunId = text(singleton?.micro_live_run_id);
      const initializedRunId = text(boundaryRow?.initialized_run_id);
      if (singletonRunId !== null) relevantRunIds.add(singletonRunId);
      if (initializedRunId !== null) relevantRunIds.add(initializedRunId);
      const ledger = await verifyLedger(
        pool,
        singleton?.micro_live_entry_attempted === true,
        relevantRunIds,
      );
      orders = ledger.orders;
      fills = ledger.fills;
      settlements = ledger.settlements;
      decisions = ledger.decisions;
      unexpected = ledger.unexpected;
      ledgerIds = ledger.ids;
      shadow = await verifyShadowConfig(pool);
      const phase = text(singleton?.micro_live_run_phase);
      const executionOff = singleton?.live_execution_enabled === false &&
        singleton?.micro_live_production_enabled === false &&
        singleton?.manual_kill_switch === true;
      frozen = phase === "FROZEN" && executionOff && archive.status === "VERIFIED"
        ? "VERIFIED"
        : phase === null ? "INCOMPLETE" : "MISMATCH";
      if (frozen !== "VERIFIED") block("historical FROZEN singleton state is not intact");
    } catch (error) {
      const code = dbFailure(error);
      block(code);
      unexpected = "UNKNOWN";
    } finally {
      if (pool !== null) {
        try {
          await pool.end();
        } catch {
          block("DATABASE_CONNECTION_FAILED");
        }
      }
    }
  }

  const environmentBinding = verifyEnvironmentBinding(env);
  const databaseParts = [
    singletonSection.status, environmentBinding.status, archive.status, runArchive.status,
    boundary.status, provisioning.status, funding.status, fee.status, shadow.status, frozen,
    orders.status, fills.status, settlements.status,
  ];
  const database = env.databaseUrl === "MISSING" || blocking.includes("DATABASE_CONNECTION_FAILED") ||
      blocking.includes("DATABASE_RELATION_MISSING")
    ? "INCOMPLETE"
    : databaseConclusion(databaseParts);

  const kalshiAllowed = database === "VERIFIED" &&
    env.databaseDestination !== "UNKNOWN" &&
    env.kalshiEnvironment === "PRODUCTION" &&
    env.index2 === "PRESENT" &&
    index2.keyId !== null &&
    index2.privateKey !== null &&
    index2Cross === "MATCH";

  if (env.kalshiEnvironment !== "PRODUCTION") {
    block(env.kalshiEnvironment === "MISSING"
      ? "KALSHI_API_ENVIRONMENT is missing"
      : "KALSHI_API_ENVIRONMENT is not production");
  }
  if (env.index2 === "MISSING") block("INDEX2 credential is missing");
  if (index2Cross === "MISMATCH") block("installed INDEX2 fingerprint does not match database evidence");
  if (index2Cross === "UNKNOWN" && env.index2 === "PRESENT") {
    block("installed INDEX2 identity cannot be related to singleton and pair evidence");
  }

  let kalshi: Awaited<ReturnType<typeof verifyKalshi>> | null = null;
  let host: Status = env.kalshiEnvironment === "PRODUCTION" ? "INCOMPLETE" : env.kalshiEnvironment === "NOT_PRODUCTION" ? "MISMATCH" : "INCOMPLETE";
  if (kalshiAllowed && index2.keyId !== null && index2.privateKey !== null) {
    kalshi = await verifyKalshi(
      { keyId: index2.keyId, privateKey: index2.privateKey },
      {
        orderExchangeIds: ledgerIds.orderExchangeIds,
        orderClientIds: ledgerIds.orderClientIds,
        fillIds: ledgerIds.fillIds,
        fundingTransferId: text(boundaryRow?.funding_transfer_id),
      },
    );
    if (kalshi.permissions === "UNREADABLE" && provisioning.status === "VERIFIED") {
      kalshi.permissions = "DATABASE_EVIDENCE_ONLY";
    } else if (kalshi.permissions === "NOT_DIRECTLY_VERIFIABLE") {
      block("the installed INDEX2 key was not present in the API-key list");
    } else if (kalshi.permissions === "UNREADABLE") {
      block("INDEX2 API-key metadata could not be read");
    }
    host = kalshi.host;
  } else if (!kalshiAllowed) {
    block("Kalshi reads were not started because a database or environment stop condition was present");
  }

  const permissionAcceptable = kalshi !== null &&
    (kalshi.permissions === "VERIFIED" || kalshi.permissions === "DATABASE_EVIDENCE_ONLY");
  const kalshiFinal: Status = kalshi === null
    ? env.kalshiEnvironment === "NOT_PRODUCTION" || boundary.status === "MISMATCH" || index2Cross === "MISMATCH" || funding.status === "MISMATCH" || frozen === "MISMATCH"
      ? "MISMATCH"
      : "INCOMPLETE"
    : kalshi.signedGet === "MISMATCH" || kalshi.identity === "MISMATCH" || kalshi.permissions === "MISMATCH" ||
        kalshi.transfer === "MISMATCH" || kalshi.activity === "UNEXPLAINED" || kalshi.ledgerCross === "MISMATCH"
      ? "MISMATCH"
      : kalshi.signedGet === "VERIFIED" && kalshi.identity === "VERIFIED" && kalshi.transfer === "VERIFIED" &&
          (kalshi.activity === "NONE" || kalshi.activity === "EXPLAINED") &&
          permissionAcceptable && kalshi.pagination === "COMPLETE" && kalshi.ledgerCross === "MATCH" &&
          kalshi.cash.startsWith("$") && kalshi.portfolio !== "INCONSISTENT"
        ? "VERIFIED"
        : "INCOMPLETE";

  printReport({
    env,
    host,
    database,
    frozen,
    singleton: singletonSection,
    environmentBinding,
    archive,
    runArchive,
    boundary,
    provisioning,
    funding,
    fee,
    orders,
    fills,
    settlements,
    decisions,
    shadow,
    unexpected,
    limits,
    kalshi,
    kalshiFinal,
    pairCross: kalshi === null
      ? "UNKNOWN"
      : kalshi.identity === "VERIFIED" && boundary.status !== "MISMATCH" ? "MATCH" : kalshi.identity === "MISMATCH" ? "MISMATCH" : "UNKNOWN",
    index2Cross,
  });
  process.exitCode = readinessExitCode(database, kalshiFinal, blocking);
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(() => {
    process.stderr.write("LIVE_READINESS_VERIFIER_FAILED\n");
    process.exitCode = 1;
  });
}

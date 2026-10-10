import { randomUUID, createPrivateKey, createSign, constants as cryptoConstants, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

const API_PREFIX = "/trade-api/v2";
const TARGET_EXCHANGE_INDEX = 2;
const SUBACCOUNT_LIMIT = 63;
const TIMEOUT_MS = 15_000;
const API_HOST = "https://external-api.kalshi.com";
const NETTING_PATH = `${API_PREFIX}/portfolio/subaccounts/netting`;
const BALANCES_PATH = `${API_PREFIX}/portfolio/subaccounts/balances`;
const API_KEYS_PATH = `${API_PREFIX}/api_keys`;
const CREATE_PATH = `${API_PREFIX}/portfolio/subaccounts`;

export type CreationState =
  "reserved" | "attempted" | "response_received" | "verified" | "uncertain";

export type PairIdentity = Readonly<{
  subaccountNumber: number;
  exchangeIndex: number;
}>;

export type CanonicalInventory = Readonly<{
  nettingConfigs: readonly Readonly<{
    subaccountNumber: number;
    exchangeIndex: number;
    enabled: boolean;
  }>[];
  balances: readonly Readonly<{
    subaccountNumber: number;
    exchangeIndex: number;
    balanceMicros: string;
    updatedAt: number;
  }>[];
}>;

export interface CreationAttemptRecord {
  attemptId: string;
  targetExchangeIndex: number;
  prePostInventoryDigest: string;
  prePostInventory: CanonicalInventory;
  createdAt: Date;
  state: CreationState;
  attemptedAt: Date | null;
  responseReceivedAt: Date | null;
  verifiedAt: Date | null;
  subaccountNumber: number | null;
  responseStatus: number | null;
  responseMetadata: Record<string, unknown> | null;
}

export interface CreationAttemptStore {
  get(): Promise<CreationAttemptRecord | null>;
  reserve(record: CreationAttemptRecord): Promise<CreationAttemptRecord | null>;
  markAttempted(attemptId: string, at: Date): Promise<boolean>;
  markResponseReceived(
    attemptId: string, subaccountNumber: number, responseStatus: number,
    metadata: Record<string, unknown>, at: Date,
  ): Promise<boolean>;
  markUncertain(
    attemptId: string, metadata: Record<string, unknown>, responseStatus?: number,
  ): Promise<void>;
  markVerified(attemptId: string, subaccountNumber: number, at: Date): Promise<boolean>;
  getVerifiedForPair(subaccountNumber: number): Promise<CreationAttemptRecord | null>;
}

export type CreationFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type MicroLiveSubaccountCreationService = {
  submit(): Promise<Readonly<{
    state: CreationState;
    attemptId: string;
    subaccountNumber: number | null;
    reason: string;
  }>>;
  verify(): Promise<Readonly<{
    state: CreationState | null;
    attemptId: string | null;
    subaccountNumber: number | null;
    reason: string;
  }>>;
};

type DatabaseAttemptRow = {
  attemptId: string;
  targetExchangeIndex: number;
  prePostInventoryDigest: string;
  prePostInventory: unknown;
  createdAt: Date;
  state: string;
  attemptedAt: Date | null;
  responseReceivedAt: Date | null;
  verifiedAt: Date | null;
  subaccountNumber: number | null;
  responseStatus: number | null;
  responseMetadata: unknown;
};

async function databaseModules() {
  // Keep injected-store tests completely detached from DATABASE_URL and the
  // database module's eager Pool initialization.
  const schema = await import("@workspace/db");
  return {
    db: schema.db,
    attempts: schema.microLiveSubaccountCreationAttemptTable,
  };
}

function toRecord(row: DatabaseAttemptRow): CreationAttemptRecord {
  return {
    attemptId: row.attemptId,
    targetExchangeIndex: row.targetExchangeIndex,
    prePostInventoryDigest: row.prePostInventoryDigest,
    prePostInventory: row.prePostInventory as CanonicalInventory,
    createdAt: row.createdAt,
    state: row.state as CreationState,
    attemptedAt: row.attemptedAt,
    responseReceivedAt: row.responseReceivedAt,
    verifiedAt: row.verifiedAt,
    subaccountNumber: row.subaccountNumber,
    responseStatus: row.responseStatus,
    responseMetadata: row.responseMetadata as Record<string, unknown> | null,
  };
}

export const databaseCreationAttemptStore: CreationAttemptStore = {
  async get() {
    const { db, attempts } = await databaseModules();
    const [row] = await db.select().from(attempts)
      .where(eq(attempts.targetExchangeIndex, TARGET_EXCHANGE_INDEX)).limit(1);
    return row ? toRecord(row) : null;
  },
  async reserve(record) {
    const { db, attempts } = await databaseModules();
    const [row] = await db.insert(attempts).values({
      attemptId: record.attemptId,
      targetExchangeIndex: record.targetExchangeIndex,
      prePostInventoryDigest: record.prePostInventoryDigest,
      prePostInventory: record.prePostInventory,
      createdAt: record.createdAt,
      state: "reserved",
    }).onConflictDoNothing({ target: attempts.targetExchangeIndex }).returning();
    return row ? toRecord(row) : null;
  },
  async markAttempted(attemptId, at) {
    const { db, attempts } = await databaseModules();
    const [row] = await db.update(attempts).set({ state: "attempted", attemptedAt: at })
      .where(and(eq(attempts.attemptId, attemptId), eq(attempts.state, "reserved")))
      .returning({ attemptId: attempts.attemptId });
    return !!row;
  },
  async markResponseReceived(attemptId, subaccountNumber, responseStatus, metadata, at) {
    const { db, attempts } = await databaseModules();
    const [row] = await db.update(attempts).set({
      state: "response_received",
      subaccountNumber,
      responseStatus,
      responseMetadata: metadata,
      responseReceivedAt: at,
    }).where(and(eq(attempts.attemptId, attemptId), eq(attempts.state, "attempted")))
      .returning({ attemptId: attempts.attemptId });
    return !!row;
  },
  async markUncertain(attemptId, metadata, responseStatus) {
    const { db, attempts } = await databaseModules();
    await db.update(attempts).set({
      state: "uncertain",
      responseStatus: responseStatus ?? null,
      responseMetadata: metadata,
    }).where(and(eq(attempts.attemptId, attemptId), eq(attempts.state, "attempted")));
  },
  async markVerified(attemptId, subaccountNumber, at) {
    const { db, attempts } = await databaseModules();
    const [row] = await db.update(attempts).set({
      state: "verified",
      subaccountNumber,
      verifiedAt: at,
    }).where(and(
      eq(attempts.attemptId, attemptId),
      eq(attempts.state, "response_received"),
      eq(attempts.subaccountNumber, subaccountNumber),
    )).returning({ attemptId: attempts.attemptId });
    if (row) return true;
    // GET-only recovery may resolve a possibly accepted, but lost/malformed,
    // POST. It can only write N after both inventory views prove one candidate.
    const [recovered] = await db.update(attempts).set({
      state: "verified",
      subaccountNumber,
      verifiedAt: at,
    }).where(and(
      eq(attempts.attemptId, attemptId),
      eq(attempts.state, "uncertain"),
    )).returning({ attemptId: attempts.attemptId });
    if (recovered) return true;
    // A restart may occur after the committed attempted latch and before the
    // process has persisted whether the transport returned. That state is
    // also eligible for GET-only recovery, never for another POST.
    const [attempted] = await db.update(attempts).set({
      state: "verified",
      subaccountNumber,
      verifiedAt: at,
    }).where(and(
      eq(attempts.attemptId, attemptId),
      eq(attempts.state, "attempted"),
    )).returning({ attemptId: attempts.attemptId });
    return !!attempted;
  },
  async getVerifiedForPair(subaccountNumber) {
    const { db, attempts } = await databaseModules();
    const [row] = await db.select().from(attempts).where(and(
      eq(attempts.targetExchangeIndex, TARGET_EXCHANGE_INDEX),
      eq(attempts.subaccountNumber, subaccountNumber),
      eq(attempts.state, "verified"),
    )).limit(1);
    return row ? toRecord(row) : null;
  },
};

function assertReadOnlyDevelopment(): void {
  if (process.env.NODE_ENV !== "development" ||
      process.env.REPLIT_DEPLOYMENT === "1" ||
      process.env.KALSHI_API_ENVIRONMENT !== "production") {
    throw new Error("Index-2 subaccount verification is unavailable outside development.");
  }
}

function assertCreationAuthorized(): void {
  assertReadOnlyDevelopment();
  if (process.env.KALSHI_INDEX2_SUBACCOUNT_CREATION_AUTHORIZED !== "true") {
    throw new Error("Index-2 subaccount creation requires explicit authorization.");
  }
}

function signingKey(): { keyId: string; key: ReturnType<typeof createPrivateKey> } {
  const keyId = process.env.KALSHI_PROVISIONING_API_KEY_ID?.trim();
  const raw = process.env.KALSHI_PROVISIONING_PRIVATE_KEY?.trim();
  if (!keyId || !raw) throw new Error("Kalshi provisioning credential is not configured.");
  const pem = raw.replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "rsa-pss") {
    throw new Error("Kalshi provisioning credential must be an RSA key.");
  }
  return { keyId, key };
}

function signature(key: ReturnType<typeof createPrivateKey>, timestamp: string, method: string, path: string) {
  const signer = createSign("sha256");
  signer.update(`${timestamp}${method}${path}`);
  signer.end();
  return signer.sign({
    key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
  }).toString("base64");
}

function safeResponseMetadata(response: Response, data?: unknown): Record<string, unknown> {
  const metadata: Record<string, unknown> = { httpStatus: response.status };
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("kalshi-request-id");
  if (requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) metadata.requestId = requestId;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const body = data as Record<string, unknown>;
    for (const key of ["code", "status", "message"]) {
      const value = body[key];
      if ((typeof value === "string" && value.length <= 256) ||
          (typeof value === "number" && Number.isSafeInteger(value))) {
        metadata[key] = value;
      }
    }
    if (response.status === 201) {
      const identity = body.subaccount && typeof body.subaccount === "object" &&
          !Array.isArray(body.subaccount)
        ? body.subaccount as Record<string, unknown>
        : body;
      const returnedNumber = integer(identity.subaccount_number ?? identity.subaccount);
      if (returnedNumber !== null && returnedNumber >= 1 &&
          returnedNumber <= SUBACCOUNT_LIMIT) {
        metadata.subaccount_number = returnedNumber;
      }
      const responseIndex = integer(identity.exchange_index);
      if (responseIndex !== null) metadata.exchange_index = responseIndex;
    }
  }
  return metadata;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kalshi inventory response is malformed.");
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function pairIdentity(row: Record<string, unknown>): PairIdentity {
  const subaccountNumber = integer(row.subaccount_number ?? row.subaccount);
  const exchangeIndex = integer(row.exchange_index);
  if (subaccountNumber === null || subaccountNumber > SUBACCOUNT_LIMIT ||
      exchangeIndex === null || exchangeIndex > SUBACCOUNT_LIMIT) {
    throw new Error("Kalshi inventory contains an account without explicit valid pair identity.");
  }
  return { subaccountNumber, exchangeIndex };
}

function pairKey(identity: PairIdentity): string {
  return `${identity.subaccountNumber}:${identity.exchangeIndex}`;
}

function amountMicros(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const stringValue = String(value);
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(stringValue);
  if (!match) throw new Error("Kalshi inventory contains an invalid balance.");
  const micros = BigInt(match[2]!) * 1_000_000n + BigInt((match[3] ?? "").padEnd(6, "0"));
  return `${match[1] === "-" ? "-" : ""}${micros}`;
}

function extractRows(payload: Record<string, unknown>, candidates: string[]): Record<string, unknown>[] {
  if (payload.cursor) throw new Error("Kalshi inventory is paginated; complete inventory is required.");
  const key = candidates.find((candidate) => Array.isArray(payload[candidate]));
  if (!key) throw new Error("Kalshi inventory response does not contain a complete account list.");
  return (payload[key] as unknown[]).map(object);
}

function canonicalInventory(nettingPayload: unknown, balancePayload: unknown): CanonicalInventory {
  const nettingRows = extractRows(object(nettingPayload), ["netting_configs"]);
  const balanceRows = extractRows(object(balancePayload), ["subaccount_balances"]);
  const nettingConfigs = nettingRows.map((row) => {
    const identity = pairIdentity(row);
    if (typeof row.enabled !== "boolean") {
      throw new Error("Kalshi netting inventory is missing its enabled flag.");
    }
    return { ...identity, enabled: row.enabled };
  }).sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
  const balances = balanceRows.map((row) => {
    const identity = pairIdentity(row);
    const balanceMicros = amountMicros(row.balance ?? row.balance_dollars);
    const updatedAt = integer(row.updated_ts);
    if (balanceMicros === null || updatedAt === null || updatedAt === 0) {
      throw new Error("Kalshi balances inventory is missing a valid balance or timestamp.");
    }
    return { ...identity, balanceMicros, updatedAt };
  }).sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
  const ensureUnique = (rows: readonly PairIdentity[]) => {
    const keys = rows.map(pairKey);
    if (new Set(keys).size !== keys.length) throw new Error("Kalshi inventory has duplicate account identities.");
  };
  ensureUnique(nettingConfigs);
  ensureUnique(balances);
  return { nettingConfigs, balances };
}

function validateInventory(inventory: CanonicalInventory): void {
  const netting = new Map(inventory.nettingConfigs.map((row) => [pairKey(row), row]));
  const balances = new Map(inventory.balances.map((row) => [pairKey(row), row]));
  if (netting.size !== balances.size || [...netting.keys()].some((key) => !balances.has(key))) {
    throw new Error("Kalshi account and balance inventory views contradict each other.");
  }
}

function index2Keys(inventory: CanonicalInventory): Set<string> {
  return new Set(inventory.nettingConfigs
    .filter((row) => row.exchangeIndex === TARGET_EXCHANGE_INDEX)
    .map(pairKey));
}

function discoverNewPair(before: CanonicalInventory, after: CanonicalInventory): number {
  validateInventory(before);
  validateInventory(after);
  const priorAccounts = new Set(before.nettingConfigs.map(pairKey));
  const priorBalances = new Set(before.balances.map(pairKey));
  const newListed = [...index2Keys(after)].filter((key) => !priorAccounts.has(key));
  const newBalanced = [...new Set(after.balances
    .filter((row) => row.exchangeIndex === TARGET_EXCHANGE_INDEX)
    .map(pairKey))].filter((key) => !priorBalances.has(key));
  if (newListed.length !== 1 || newBalanced.length !== 1 || newListed[0] !== newBalanced[0]) {
    throw new Error("GET-only recovery could not identify exactly one new (N, 2) account.");
  }
  const baselineAmounts = new Map(before.balances.map((row) => [pairKey(row), row.balanceMicros]));
  const currentBalances = new Map(after.balances.map((row) => [pairKey(row), row.balanceMicros]));
  for (const [key, balance] of baselineAmounts) {
    if (currentBalances.get(key) !== balance) {
      throw new Error("A pre-existing account balance changed since the persisted pre-POST snapshot.");
    }
  }
  const candidateBalance = currentBalances.get(newListed[0]!);
  if (candidateBalance !== "0") {
    throw new Error("The newly identified subaccount does not have a proven zero balance.");
  }
  const [n] = newListed[0]!.split(":").map(Number);
  if (!Number.isSafeInteger(n) || n < 1 || n > SUBACCOUNT_LIMIT) {
    throw new Error("New index-2 account number is invalid.");
  }
  return n;
}

function responsePair(data: unknown): number {
  const root = object(data);
  const payload = root.subaccount && typeof root.subaccount === "object" && !Array.isArray(root.subaccount)
    ? root.subaccount as Record<string, unknown>
    : root;
  const n = integer(payload.subaccount_number ?? payload.subaccount);
  const exchangeIndex = integer(payload.exchange_index);
  if (n === null || n < 1 || n > SUBACCOUNT_LIMIT || exchangeIndex !== TARGET_EXCHANGE_INDEX) {
    throw new Error("Kalshi creation response does not definitively identify a valid (N, 2) account.");
  }
  return n;
}

function hasContradictoryExplicitIndex(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const root = data as Record<string, unknown>;
  const nested = root.subaccount && typeof root.subaccount === "object" &&
    !Array.isArray(root.subaccount)
    ? root.subaccount as Record<string, unknown> : null;
  return [root, nested].some((value) =>
    value && Object.hasOwn(value, "exchange_index") &&
    integer(value.exchange_index) !== TARGET_EXCHANGE_INDEX);
}

export function createMicroLiveSubaccountCreationService(
  options: { store: CreationAttemptStore; fetchImpl?: CreationFetch },
): MicroLiveSubaccountCreationService {
  const fetchImpl = options.fetchImpl ?? fetch;
  async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const { keyId, key } = signingKey();
    const timestamp = String(Date.now());
    const headers = new Headers({
      Accept: "application/json",
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      "KALSHI-ACCESS-SIGNATURE": signature(key, timestamp, method, path),
    });
    const init: RequestInit = {
      method,
      redirect: "manual",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(body);
    }
    return fetchImpl(`${API_HOST}${path}`, init);
  }

  async function readInventory(): Promise<CanonicalInventory> {
    const [nettingResponse, balancesResponse] = await Promise.all([
      request("GET", NETTING_PATH),
      request("GET", BALANCES_PATH),
    ]);
    if (!nettingResponse.ok || !balancesResponse.ok) {
      throw new Error("Authenticated Kalshi account inventory GET failed.");
    }
    const [netting, balances] = await Promise.all([
      nettingResponse.json() as Promise<unknown>,
      balancesResponse.json() as Promise<unknown>,
    ]);
    const inventory = canonicalInventory(netting, balances);
    validateInventory(inventory);
    return inventory;
  }

  async function verifyProvisioningKey(): Promise<void> {
    const response = await request("GET", API_KEYS_PATH);
    if (!response.ok) throw new Error("Provisioning credential metadata GET failed.");
    const payload = object(await response.json() as unknown);
    if (payload.cursor || !Array.isArray(payload.api_keys)) {
      throw new Error("Provisioning credential metadata inventory is incomplete.");
    }
    const keyId = process.env.KALSHI_PROVISIONING_API_KEY_ID?.trim();
    const matches = (payload.api_keys as unknown[]).map(object)
      .filter((record) => record.api_key_id === keyId);
    if (matches.length !== 1) {
      throw new Error("Provisioning credential must resolve to exactly one API key record.");
    }
    const record = matches[0]!;
    const scopes = record.scopes;
    if (!Array.isArray(scopes) || scopes.length !== 2 ||
        !scopes.every((scope) => scope === "read" || scope === "write") ||
        !scopes.includes("read") || !scopes.includes("write") ||
        (Object.hasOwn(record, "subaccount") && record.subaccount !== null)) {
      throw new Error("Provisioning credential is not unrestricted read + write.");
    }
  }

  async function verifyRecord(record: CreationAttemptRecord) {
    if (record.state !== "attempted" && record.state !== "uncertain" &&
        record.state !== "response_received") {
      return { state: record.state, attemptId: record.attemptId,
        subaccountNumber: record.subaccountNumber, reason: "Attempt is not eligible for GET-only verification." } as const;
    }
    if (record.responseMetadata?.contradictoryIndex2Response === true) {
      return Object.freeze({
        state: record.state,
        attemptId: record.attemptId,
        subaccountNumber: record.subaccountNumber,
        reason: "The definitive response contradicted exchange index 2; operator review required.",
      });
    }
    let current: CanonicalInventory;
    try {
      current = await readInventory();
      const discovered = discoverNewPair(record.prePostInventory, current);
      const responseNumber = integer(record.responseMetadata?.subaccount_number);
      if (responseNumber !== null && responseNumber !== discovered) {
        throw new Error("Creation response and authenticated inventory identify different subaccounts.");
      }
      if (record.subaccountNumber !== null && record.subaccountNumber !== discovered) {
        throw new Error("Creation response and authenticated inventory identify different subaccounts.");
      }
      const updated = await options.store.markVerified(record.attemptId, discovered, new Date());
      if (!updated) throw new Error("Durable attempt state changed before verification could be committed.");
      return Object.freeze({
        state: "verified" as const,
        attemptId: record.attemptId,
        subaccountNumber: discovered,
        reason: "A single new (N, 2) account is present consistently in both authenticated inventory views.",
      });
    } catch (error) {
      return Object.freeze({
        state: record.state,
        attemptId: record.attemptId,
        subaccountNumber: record.subaccountNumber,
        reason: error instanceof Error ? error.message : "GET-only verification failed.",
      });
    }
  }

  return {
    async submit() {
      assertCreationAuthorized();
      const [inventory] = await Promise.all([readInventory(), verifyProvisioningKey()]);
      let record = await options.store.get();
      if (!record && [...index2Keys(inventory)].some((key) => Number(key.split(":")[0]) > 0)) {
        throw new Error("A numbered exchange-index-2 subaccount already exists; one-shot creation is blocked.");
      }
      if (!record) {
        const reserved: CreationAttemptRecord = {
          attemptId: randomUUID(),
          targetExchangeIndex: TARGET_EXCHANGE_INDEX,
          prePostInventoryDigest: digest(inventory),
          prePostInventory: inventory,
          createdAt: new Date(),
          state: "reserved",
          attemptedAt: null,
          responseReceivedAt: null,
          verifiedAt: null,
          subaccountNumber: null,
          responseStatus: null,
          responseMetadata: null,
        };
        record = await options.store.reserve(reserved);
        if (!record) record = await options.store.get();
      }
      if (!record) throw new Error("Durable creation attempt reservation failed.");

      if (record.state !== "reserved") {
        return Object.freeze({
          state: record.state, attemptId: record.attemptId,
          subaccountNumber: record.subaccountNumber,
          reason: "An attempt already crossed or completed the durable one-shot boundary; POST is blocked.",
        });
      }
      if (record.prePostInventoryDigest !== digest(inventory)) {
        return Object.freeze({
          state: record.state, attemptId: record.attemptId,
          subaccountNumber: null,
          reason: "Authenticated inventory changed after reservation; creation is blocked pending operator review.",
        });
      }

      // This conditional DB transition commits before the only POST. A crash
      // after it leaves an attempted row that can only be inspected with GETs.
      if (!await options.store.markAttempted(record.attemptId, new Date())) {
        const latest = await options.store.get();
        return Object.freeze({
          state: latest?.state ?? "uncertain",
          attemptId: record.attemptId,
          subaccountNumber: latest?.subaccountNumber ?? null,
          reason: "Another process crossed the one-shot network boundary; POST is blocked.",
        });
      }
      try {
        const response = await request("POST", CREATE_PATH, { exchange_index: TARGET_EXCHANGE_INDEX });
        let data: unknown;
        try {
          data = await response.json() as unknown;
        } catch {
          await options.store.markUncertain(record.attemptId,
            safeResponseMetadata(response), response.status);
          return Object.freeze({
            state: "uncertain" as const, attemptId: record.attemptId,
            subaccountNumber: null, reason: "Creation response was not valid JSON; no retry is permitted.",
          });
        }
        const metadata = safeResponseMetadata(response, data);
        if (response.status !== 201) {
          await options.store.markUncertain(record.attemptId, metadata, response.status);
          return Object.freeze({
            state: "uncertain" as const, attemptId: record.attemptId,
            subaccountNumber: null, reason: `Creation returned HTTP ${response.status}; no retry is permitted.`,
          });
        }
        let subaccountNumber: number;
        try {
          subaccountNumber = responsePair(data);
        } catch (error) {
          await options.store.markUncertain(record.attemptId, {
            ...metadata,
            contradictoryIndex2Response: hasContradictoryExplicitIndex(data),
          }, response.status);
          return Object.freeze({
            state: "uncertain" as const, attemptId: record.attemptId,
            subaccountNumber: null,
            reason: error instanceof Error ? error.message : "Creation response was malformed.",
          });
        }
        if (!await options.store.markResponseReceived(
          record.attemptId, subaccountNumber, response.status, metadata, new Date(),
        )) {
          return Object.freeze({
            state: "uncertain" as const, attemptId: record.attemptId,
            subaccountNumber: null, reason: "Definitive response could not be committed; GET-only recovery required.",
          });
        }
        const responseRecord = await options.store.get();
        if (!responseRecord) throw new Error("Creation attempt disappeared after response.");
        return await verifyRecord(responseRecord);
      } catch (error) {
        await options.store.markUncertain(record.attemptId, {
          outcome: "transport_error_or_lost_response",
          error: error instanceof Error ? error.name : "UnknownError",
        });
        return Object.freeze({
          state: "uncertain" as const, attemptId: record.attemptId,
          subaccountNumber: null, reason: "POST outcome is uncertain; automatic retry is permanently blocked.",
        });
      }
    },
    async verify() {
      assertReadOnlyDevelopment();
      const record = await options.store.get();
      if (!record) {
        return Object.freeze({
          state: null, attemptId: null, subaccountNumber: null,
          reason: "No durable creation attempt exists; verification is unavailable.",
        });
      }
      return verifyRecord(record);
    },
  };
}

export const microLiveSubaccountCreation = createMicroLiveSubaccountCreationService({
  store: databaseCreationAttemptStore,
});

/**
 * Immutable provenance for the boundary service: only a durably verified
 * creation attempt for the requested arbitrary N and exchange index 2 is
 * returned. No value is inferred from a default account number.
 */
export async function getVerifiedCreationAttemptForPair(subaccountNumber: number):
Promise<Readonly<{
  attemptId: string;
  subaccountNumber: number;
  exchangeIndex: 2;
  inventoryDigest: string;
  prePostInventoryDigest: string;
  verifiedAt: Date;
}> | null> {
  if (!Number.isSafeInteger(subaccountNumber) || subaccountNumber < 1 ||
      subaccountNumber > SUBACCOUNT_LIMIT) return null;
  const row = await databaseCreationAttemptStore.getVerifiedForPair(subaccountNumber);
  if (!row?.verifiedAt || row.targetExchangeIndex !== TARGET_EXCHANGE_INDEX ||
      row.subaccountNumber !== subaccountNumber) return null;
  return Object.freeze({
    attemptId: row.attemptId,
    subaccountNumber,
    exchangeIndex: TARGET_EXCHANGE_INDEX,
    inventoryDigest: row.prePostInventoryDigest,
    prePostInventoryDigest: row.prePostInventoryDigest,
    verifiedAt: new Date(row.verifiedAt),
  });
}
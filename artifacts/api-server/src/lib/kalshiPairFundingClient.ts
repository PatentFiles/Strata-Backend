import {
  constants as cryptoConstants,
  createPrivateKey,
  createSign,
} from "node:crypto";

export type PrimaryBalanceEvidence = {
  scopedMicros: string;
  inventoryMicros: string;
  observedAt: number;
  updatedAt: number;
};

export type FundingTransferEvidence = {
  transferId: string;
  occurredAt: string;
};

const API_PREFIX = "/trade-api/v2";
const BALANCE_PATH = `${API_PREFIX}/portfolio/balance`;
const BALANCES_PATH = `${API_PREFIX}/portfolio/subaccounts/balances`;
const TRANSFERS_PATH = `${API_PREFIX}/portfolio/subaccounts/transfers`;
const TRANSFER_PATH = `${API_PREFIX}/portfolio/subaccounts/transfer`;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const MAX_TRANSFERS = PAGE_LIMIT * MAX_PAGES;

type Credentials = { keyId: string; privateKey: string };
type PairTransfer = {
  transferId: string;
  fromSubaccount: number;
  toSubaccount: number;
  exchangeIndex: number;
  amountCents: number;
  occurredAt: string;
};
type JsonObject = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("Invalid Kalshi response.");
  }
  return value as JsonObject;
}

function credentials(prefix: "VERIFIER" | "PROVISIONING"): Credentials {
  const keyId = process.env[`KALSHI_${prefix}_API_KEY_ID`]?.trim();
  const privateKey = process.env[prefix === "VERIFIER"
    ? "KALSHI_VERIFIER_API_PRIVATE_KEY"
    : "KALSHI_PROVISIONING_PRIVATE_KEY"]?.trim();
  if (!keyId || !privateKey) fail("Kalshi credentials are not configured.");
  const pem = privateKey.replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
  return { keyId, privateKey: pem };
}

function signature(creds: Credentials, timestamp: string, method: string, path: string): string {
  try {
    const key = createPrivateKey(creds.privateKey);
    if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "rsa-pss") {
      return fail("Kalshi signing credential must be an RSA key.");
    }
    const signer = createSign("sha256");
    signer.update(`${timestamp}${method}${path}`);
    signer.end();
    return signer.sign({
      key,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString("base64");
  } catch {
    return fail("Kalshi signing credential is invalid.");
  }
}

function baseUrl(): string {
  const environment = process.env.KALSHI_API_ENVIRONMENT ?? "demo";
  if (environment !== "demo" && environment !== "production") {
    return fail("Kalshi API environment is invalid.");
  }
  return environment === "production"
    ? "https://external-api.kalshi.com"
    : "https://external-api.demo.kalshi.co";
}

async function signedGet(
  path: string, query: string, creds: Credentials = credentials("VERIFIER"),
): Promise<unknown> {
  const timestamp = Date.now().toString();
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}${query}`, {
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        "KALSHI-ACCESS-KEY": creds.keyId,
        "KALSHI-ACCESS-SIGNATURE": signature(creds, timestamp, "GET", path),
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
      },
    });
  } catch {
    return fail("Kalshi GET request failed.");
  }
  if (response.status !== 200) return fail("Kalshi GET request returned a non-200 response.");
  try {
    return await response.json() as unknown;
  } catch {
    return fail("Kalshi GET response was not valid JSON.");
  }
}

function integer(value: unknown): number {
  const text = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)
      ? value
      : "";
  if (!text) return fail("Invalid Kalshi integer field.");
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return fail("Invalid Kalshi integer field.");
  return parsed;
}

function decimalMicros(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    return fail("Invalid Kalshi decimal field.");
  }
  const text = String(value);
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) return fail("Invalid Kalshi decimal field.");
  const fraction = (match[3] ?? "").padEnd(6, "0");
  const magnitude = BigInt(match[2]!) * 1_000_000n + BigInt(fraction || "0");
  return `${match[1] && magnitude !== 0n ? "-" : ""}${magnitude}`;
}

function timestampMs(value: unknown): number {
  const seconds = integer(value);
  const milliseconds = seconds < 100_000_000_000 ? seconds * 1000 : seconds;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    return fail("Invalid Kalshi balance timestamp.");
  }
  return milliseconds;
}

function subaccountIdentity(row: JsonObject): number {
  const primary = row.subaccount_number ?? row.subaccount;
  return integer(primary);
}

export async function readPrimaryIndex2Balance(
  subaccount: 0 | 1 = 0,
): Promise<PrimaryBalanceEvidence> {
  const [scopedPayload, inventoryPayload] = await Promise.all([
    signedGet(BALANCE_PATH, `?subaccount=${subaccount}&exchange_index=2`),
    signedGet(BALANCES_PATH, ""),
  ]);

  const scopedRoot = object(scopedPayload);
  const scoped = scopedRoot.balance !== null &&
      typeof scopedRoot.balance === "object" && !Array.isArray(scopedRoot.balance)
    ? object(scopedRoot.balance)
    : scopedRoot;
  if (scoped.subaccount_number !== undefined || scoped.subaccount !== undefined) {
    if (subaccountIdentity(scoped) !== subaccount) return fail("Kalshi scoped balance identity mismatch.");
  }
  if (scoped.exchange_index !== undefined && integer(scoped.exchange_index) !== 2) {
    return fail("Kalshi scoped balance identity mismatch.");
  }
  const scopedValue = scoped.balance_dollars;
  if (scopedValue === undefined || scopedValue === null) {
    return fail("Kalshi scoped balance is missing.");
  }
  const scopedMicros = decimalMicros(scopedValue);
  const updatedAt = timestampMs(scoped.updated_ts);
  const now = Date.now();
  if (updatedAt > now + 5_000) {
    return fail("Kalshi scoped balance timestamp is in the future.");
  }

  const inventoryRoot = object(inventoryPayload);
  if (!Array.isArray(inventoryRoot.subaccount_balances)) {
    return fail("Kalshi subaccount balances response is incomplete.");
  }
  const rows = inventoryRoot.subaccount_balances.map(object);
  const matches = rows.filter((row) =>
    subaccountIdentity(row) === subaccount && integer(row.exchange_index) === 2);
  if (matches.length !== 1) {
    return fail("Kalshi primary index-2 balance is missing or duplicated.");
  }
  const inventoryValue = matches[0]!.balance;
  if (inventoryValue === undefined || inventoryValue === null) {
    return fail("Kalshi primary index-2 balance is missing.");
  }

  return {
    scopedMicros,
    inventoryMicros: decimalMicros(inventoryValue),
    observedAt: Date.now(),
    updatedAt,
  };
}

function occurredAt(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return fail("Invalid Kalshi transfer timestamp.");
    return date.toISOString();
  }
  const secondsOrMilliseconds = integer(value);
  const milliseconds = secondsOrMilliseconds < 100_000_000_000
    ? secondsOrMilliseconds * 1000
    : secondsOrMilliseconds;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    return fail("Invalid Kalshi transfer timestamp.");
  }
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return fail("Invalid Kalshi transfer timestamp.");
  return date.toISOString();
}

function parseTransfer(value: unknown): PairTransfer {
  const row = object(value);
  const transferId = row.transfer_id;
  if (typeof transferId !== "string" || transferId.length === 0 ||
      transferId.trim() !== transferId) {
    return fail("Invalid Kalshi transfer identity.");
  }
  const fromSubaccount = integer(row.from_subaccount);
  const toSubaccount = integer(row.to_subaccount);
  const exchangeIndex = integer(row.exchange_index);
  const amountCents = integer(row.amount_cents);
  if (fromSubaccount > 63 || toSubaccount > 63 || exchangeIndex > 255) {
    return fail("Invalid Kalshi transfer identity.");
  }
  return {
    transferId,
    fromSubaccount,
    toSubaccount,
    exchangeIndex,
    amountCents,
    occurredAt: occurredAt(row.created_ts),
  };
}

export async function readPairTransferHistory(): Promise<readonly {
  transferId: string;
  fromSubaccount: number;
  toSubaccount: number;
  exchangeIndex: number;
  amountCents: number;
  occurredAt: string;
}[]> {
  const transfers: PairTransfer[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const query = `?limit=${PAGE_LIMIT}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const root = object(await signedGet(TRANSFERS_PATH, query));
    if (!Array.isArray(root.transfers) || root.transfers.length > PAGE_LIMIT) {
      return fail("Kalshi transfer page is incomplete.");
    }
    const page = root.transfers.map(parseTransfer);
    for (const transfer of page) {
      if (ids.has(transfer.transferId)) return fail("Duplicate Kalshi transfer identity.");
      ids.add(transfer.transferId);
      transfers.push(transfer);
    }
    if (transfers.length > MAX_TRANSFERS) return fail("Kalshi transfer history is incomplete.");

    if (root.cursor === undefined || root.cursor === null || root.cursor === "") return transfers;
    if (typeof root.cursor !== "string" ||
        root.cursor.trim() !== root.cursor || cursors.has(root.cursor)) {
      return fail("Invalid Kalshi transfer cursor.");
    }
    cursors.add(root.cursor);
    cursor = root.cursor;
  }
  return fail("Kalshi transfer history is incomplete.");
}

export async function readExactPairTransfers(): Promise<FundingTransferEvidence[]> {
  const history = await readPairTransferHistory();
  return history.filter((transfer) =>
    transfer.fromSubaccount === 0 &&
    transfer.toSubaccount === 1 &&
    transfer.exchangeIndex === 2 &&
    transfer.amountCents === 2500,
  ).map((transfer) => ({
    transferId: transfer.transferId,
    occurredAt: transfer.occurredAt,
  }));
}

export async function verifyFundingTransferCredential(): Promise<boolean> {
  const id = process.env.KALSHI_PROVISIONING_API_KEY_ID?.trim();
  if (!id) return false;
  try {
    const records: JsonObject[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const root = object(await signedGet(
        `${API_PREFIX}/api_keys`,
        cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`,
      ));
      if (!Array.isArray(root.api_keys) || root.api_keys.length > PAGE_LIMIT) return false;
      records.push(...root.api_keys.map(object));
      if (root.cursor === undefined || root.cursor === null || root.cursor === "") {
        const matches = records.filter(record => record.api_key_id === id);
        if (!(matches.length === 1 && matches[0]!.subaccount == null &&
          Array.isArray(matches[0]!.scopes) &&
          matches[0]!.scopes.length === 2 &&
          matches[0]!.scopes.includes("read") &&
          matches[0]!.scopes.includes("write"))) return false;
        // Metadata alone does not prove that the saved private key belongs to
        // this unrestricted transfer-capable ID.
        const proof = object(await signedGet(
          BALANCE_PATH, "?subaccount=0&exchange_index=2", credentials("PROVISIONING"),
        ));
        return proof.balance_dollars !== undefined &&
          decimalMicros(proof.balance_dollars) !== null;
      }
      if (typeof root.cursor !== "string" || seen.has(root.cursor)) return false;
      seen.add(root.cursor);
      cursor = root.cursor;
    }
  } catch {
    return false;
  }
  return false;
}

function assertDevelopmentProductionGuard(): void {
  if (process.env.NODE_ENV !== "development" ||
      process.env.REPLIT_DEPLOYMENT === "1" ||
      process.env.KALSHI_API_ENVIRONMENT !== "production") {
    fail("Kalshi provisioning transfer is unavailable outside development.");
  }
}

export async function postOneShotPairFunding(attemptId: string): Promise<void> {
  assertDevelopmentProductionGuard();
  if (typeof attemptId !== "string" || attemptId.length === 0 ||
      attemptId.length > 128 || attemptId.trim() !== attemptId) {
    fail("Invalid Kalshi funding attempt identifier.");
  }
  const creds = credentials("PROVISIONING");
  const timestamp = Date.now().toString();
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${TRANSFER_PATH}`, {
      method: "POST",
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "KALSHI-ACCESS-KEY": creds.keyId,
        "KALSHI-ACCESS-SIGNATURE": signature(creds, timestamp, "POST", TRANSFER_PATH),
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
      },
      body: JSON.stringify({
        client_transfer_id: attemptId,
        from_subaccount: 0,
        to_subaccount: 1,
        amount_cents: 2500,
        exchange_index: 2,
      }),
    });
  } catch {
    fail("Kalshi provisioning transfer request failed.");
  }
  if (response.status !== 200) {
    fail("Kalshi provisioning transfer returned a non-200 response.");
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    fail("Kalshi provisioning transfer response could not be read.");
  }
  if (body.trim() === "") return;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
        Object.keys(parsed).length === 0) return;
  } catch {
    // An invalid/non-empty response is rejected below.
  }
  fail("Kalshi provisioning transfer response was not empty.");
}
import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "@workspace/db";
import { ProductionLedger, identity, type Account } from "./ledger";
import { digest } from "./types";

// Method-level cases use the real final-account proof with a deterministic
// transaction. Malformed fixtures deliberately exercise the runtime guards.
// They run as part of the existing disposable production acceptance suite.
type MalformedFixture = Record<string, any>;
const projectionSql =
  "SELECT created_at,client_order_id,request,exchange_order_id,terminal,filled_hundredths FROM v13_production_intent WHERE account_id=$1";
const columns = [
  "created_at",
  "client_order_id",
  "request",
  "exchange_order_id",
  "terminal",
  "filled_hundredths",
];
const a: Account = {
  id: "account",
  policy_id: "synthetic-policy",
  subaccount: "1",
  exchange_index: "2",
  key_fingerprint: "f".repeat(64),
  cash_micros: "100",
  commissioning_digest: null,
  kill_switch: false,
  execution_enabled: true,
  commissioned: true,
  minimum_exit_micros: null,
  fee_artifact_digest: null,
  cash_precision_verified: true,
  reserved_micros: "0",
  initial_cash_micros: "100",
  blocked_reason: null,
  reconciled_at: null,
  revision: "0",
};
const now = Date.parse("2026-11-05T00:00:00Z");
const req = {
  market: "KXBTC15M-TEST",
  side: "YES",
  action: "BUY",
  contracts: 1,
  limitMicros: 500000,
  timeInForce: "IOC",
  reduceOnly: false,
  clientOrderId: "client",
};
const intent = {
  id: "intent",
  account_id: "account",
  created_at: new Date(now - 1000),
  client_order_id: "client",
  request: req,
  exchange_order_id: "order",
  terminal: true,
  filled_hundredths: "100",
  decision: { largeUnused: "synthetic" },
  capability_digest: "unread",
};
const fill = {
  id: "fill",
  orderId: "order",
  clientOrderId: "client",
  market: "KXBTC15M-TEST",
  side: "YES",
  action: "BUY",
  quantityHundredths: "100",
  priceMicros: 500000,
  grossMicros: "500000",
  feeMicros: "0",
  occurredAtMs: now - 500,
};
const settle = {
  id: "settled",
  market: "KXBTC15M-TEST",
  side: "YES",
  result: "YES",
  quantityHundredths: "100",
  payoutMicros: "1000000",
  feeMicros: "0",
  occurredAtMs: now - 100,
};
const snap = {
  identity: identity(a),
  observedAtMs: now,
  authenticated: true,
  complete: true,
  cashExact: true,
  unexplainedCashActivity: false,
  cashMicros: "100",
  historyFromMs: now - 1000,
  orders: [
    { orderId: "order", request: req, terminal: true, filledHundredths: "100" },
  ],
  fills: [fill],
  settlements: [settle],
  positions: [
    { market: "KXBTC15M-TEST", side: "YES", quantityHundredths: "100" },
  ],
};
const pos = [
    { market: "KXBTC15M-TEST", side: "YES", quantity_hundredths: "100" },
  ],
  events = { "fill:fill": digest(fill), "settlement:settled": digest(settle) };
const defaultFixture = (): MalformedFixture => ({
  account: structuredClone(a),
  snapshot: structuredClone(snap),
  intents: [structuredClone(intent)],
  positions: structuredClone(pos),
  events: { ...events },
  rejectSql: null,
});
async function run(f: MalformedFixture) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, args: unknown[]) => {
      calls.push({ sql, args });
      if (f.rejectSql && sql.includes(f.rejectSql))
        throw Error("fixture-query-failed");
      assert.equal(args[0], "account");
      if (sql.includes("FROM v13_production_intent WHERE account_id=$1")) {
        assert.equal(sql, projectionSql);
        assert.equal(/LIMIT|ORDER BY|state\s*=|terminal\s*=/.test(sql), false);
        return {
          rows: f.intents.map((row: Record<string, unknown>) =>
            Object.fromEntries(columns.map((key) => [key, row[key]])),
          ),
        };
      }
      if (sql.startsWith("SELECT digest"))
        return {
          rows:
            f.events[String(args[1])] == null
              ? []
              : [{ digest: f.events[String(args[1])] }],
        };
      if (sql.startsWith("SELECT market,side,quantity_hundredths"))
        return { rows: f.positions };
      throw Error("unexpected query");
    },
  };
  try {
    const ledger = new ProductionLedger(
      {} as ConstructorParameters<typeof ProductionLedger>[0],
      "account",
    );
    await ledger.finalAccountProof(
      tx as unknown as PoolClient,
      f.account,
      f.snapshot,
      now,
    );
    return { result: "ok", calls };
  } catch (error) {
    return { result: (error as Error).message, calls };
  }
}

// Recorded from the original method differential oracle. Besides expected
// outcomes, preserve the original query count and exact projected SQL.
const expectedCalls: Record<string, number> = {
  "complete signed account with historical order/fill/settlement/position": 4,
  "empty known history remains valid when snapshot empty": 2,
  "reject authenticated=false": 0,
  "reject complete=false": 0,
  "reject cashExact=false": 0,
  "reject unexplainedCashActivity=true": 0,
  "reject observedAtMs=1793836800001": 0,
  "reject observedAtMs=1793836784999": 0,
  "reject cashMicros=99": 0,
  "reject identity mismatch": 0,
  "history floor exact boundary": 4,
  "history floor1ms gap": 1,
  "oldest intent after2500rows not dropped": 1,
  "reject historical request": 1,
  "reject historical exchange_order_id": 1,
  "reject historical terminal": 1,
  "reject historical filled_hundredths": 1,
  "reject absent order": 1,
  "request extra field still compared": 1,
  "null request remains rejection": 1,
  "nonintegral filled remains fail closed": 1,
  "fill missing digest": 2,
  "fill changed digest": 2,
  "settlement missing digest": 3,
  "settlement changed digest": 3,
  "position mismatch": 4,
  "zero snapshot positions ignored": 4,
  "query rejection propagates": 1,
  "duplicate hypothetical client preserves first-match behavior": 4,
  "unused decision malformed and absent values irrelevant": 4,
  "unmatched old BLOCKED retained in floor": 1,
  "unmatched old TERMINAL retained in floor": 1,
  "unmatched old PREPARED retained in floor": 1,
  "unmatched old UNKNOWN retained in floor": 1,
  "unmatched old DISPATCHED retained in floor": 1,
  "reordered unique intents preserve result": 4,
  "invalid consumed Date fails existing history check": 1,
  "null consumed Date retains existing throw": 1,
  "multiple unsorted snapshot positions normalize identically": 4,
};
function check(
  name: string,
  mutate: (fixture: MalformedFixture) => void = () => {},
  expected = "ok",
) {
  test(`final account payload projection: ${name}`, async () => {
    const fixture = defaultFixture();
    mutate(fixture);
    const result = await run(fixture);
    assert.equal(result.result, expected);
    assert.equal(result.calls.length, expectedCalls[name]);
    const eventSql = "SELECT digest FROM v13_production_event WHERE account_id=$1 AND event_id=$2";
    const expectedSequence = [
      { sql: projectionSql, args: ["account"] },
      ...fixture.snapshot.fills.map((entry: { id: string }) => ({
        sql: eventSql, args: ["account", `fill:${entry.id}`],
      })),
      ...fixture.snapshot.settlements.map((entry: { id: string }) => ({
        sql: eventSql, args: ["account", `settlement:${entry.id}`],
      })),
      {
        sql: "SELECT market,side,quantity_hundredths FROM v13_production_position\n      WHERE account_id=$1 AND quantity_hundredths>0 ORDER BY market,side",
        args: ["account"],
      },
    ];
    assert.deepEqual(result.calls, expectedSequence.slice(0, expectedCalls[name]));
  });
}
check("complete signed account with historical order/fill/settlement/position");
check("empty known history remains valid when snapshot empty", (f) => {
  f.intents = [];
  f.snapshot.orders = [];
  f.snapshot.fills = [];
  f.snapshot.settlements = [];
  f.snapshot.positions = [];
  f.positions = [];
  f.snapshot.historyFromMs = now;
});
for (const [field, value] of [
  ["authenticated", false],
  ["complete", false],
  ["cashExact", false],
  ["unexplainedCashActivity", true],
  ["observedAtMs", now + 1],
  ["observedAtMs", now - 15001],
  ["cashMicros", "99"],
] as [string, unknown][])
  check(
    "reject " + field + "=" + value,
    (f) => (f.snapshot[field] = value),
    "production_final_account_changed_or_unproven",
  );
check(
  "reject identity mismatch",
  (f) => (f.snapshot.identity.keyFingerprint = "other"),
  "production_final_account_changed_or_unproven",
);
check(
  "history floor exact boundary",
  (f) => (f.snapshot.historyFromMs = now - 1000),
);
check(
  "history floor1ms gap",
  (f) => (f.snapshot.historyFromMs = now - 999),
  "production_final_history_gap",
);
check(
  "oldest intent after2500rows not dropped",
  (f) => {
    f.intents = Array.from({ length: 2501 }, (_, i) => ({
      ...intent,
      client_order_id: "extra-" + i,
      created_at: new Date(now - 1000),
    }));
    f.intents.push({ ...intent, created_at: new Date(now - 100000) });
  },
  "production_final_history_gap",
);
for (const [field, value] of [
  ["request", { ...req, contracts: 2 }],
  ["exchange_order_id", "wrong"],
  ["terminal", false],
  ["filled_hundredths", "99"],
] as [string, unknown][])
  check(
    "reject historical " + field,
    (f) => (f.intents[0][field] = value),
    "production_final_order_changed",
  );
check(
  "reject absent order",
  (f) => (f.intents[0].client_order_id = "other"),
  "production_final_order_changed",
);
check(
  "request extra field still compared",
  (f) => (f.intents[0].request = { ...req, unknown: "extra" }),
  "production_final_order_changed",
);
check(
  "null request remains rejection",
  (f) => (f.intents[0].request = null),
  "production_final_order_changed",
);
check(
  "nonintegral filled remains fail closed",
  (f) => (f.intents[0].filled_hundredths = "1.5"),
  "non_integral_money",
);
for (const kind of ["fill", "settlement"])
  for (const action of ["missing", "changed"])
    check(
      kind + " " + action + " digest",
      (f) => {
        const key = kind === "fill" ? "fill:fill" : "settlement:settled";
        if (action === "missing") delete f.events[key];
        else f.events[key] = "wrong";
      },
      kind === "fill"
        ? "production_final_unreconciled_fill"
        : "production_final_unreconciled_settlement",
    );
check(
  "position mismatch",
  (f) => (f.positions[0].quantity_hundredths = "99"),
  "production_final_position_changed",
);
check("zero snapshot positions ignored", (f) =>
  f.snapshot.positions.push({
    market: "KXBTC15M-ZERO",
    side: "NO",
    quantityHundredths: "0",
  }),
);
check(
  "query rejection propagates",
  (f) => (f.rejectSql = "FROM v13_production_intent"),
  "fixture-query-failed",
);
check("duplicate hypothetical client preserves first-match behavior", (f) =>
  f.intents.push({ ...intent, request: { ...req, contracts: 2 } }),
);
check("unused decision malformed and absent values irrelevant", (f) => {
  f.intents[0].decision = null;
  delete f.intents[0].capability_digest;
});
for (const state of [
  "BLOCKED",
  "TERMINAL",
  "PREPARED",
  "UNKNOWN",
  "DISPATCHED",
])
  check(
    "unmatched old " + state + " retained in floor",
    (f) =>
      f.intents.push({
        ...intent,
        id: "old",
        client_order_id: "old",
        state,
        created_at: new Date(now - 100000),
      }),
    "production_final_history_gap",
  );
check("reordered unique intents preserve result", (f) =>
  f.intents.unshift({
    ...intent,
    id: "other",
    client_order_id: "other",
    created_at: new Date(now - 500),
  }),
);
check(
  "invalid consumed Date fails existing history check",
  (f) => (f.intents[0].created_at = new Date("invalid")),
  "production_final_history_gap",
);
check(
  "null consumed Date retains existing throw",
  (f) => (f.intents[0].created_at = null),
  "Cannot read properties of null (reading 'getTime')",
);
check("multiple unsorted snapshot positions normalize identically", (f) => {
  f.positions = [
    { market: "KXBTC15M-A", side: "NO", quantity_hundredths: "1" },
    ...f.positions,
  ];
  f.snapshot.positions.push({
    market: "KXBTC15M-A",
    side: "NO",
    quantityHundredths: "01",
  });
});

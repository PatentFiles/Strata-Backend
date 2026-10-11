import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { getScopedKalshiJson } from "../kalshiAccountClient";
import { createDatabaseUserScopePort, type UserScopeQuery } from "./userScopeDatabase";
import { createUserExecutionRouter } from "../../routes/userExecutionRouter";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function account(owner: string | null, id: string, commissioned: boolean, cashMicros: string) {
  return {
    id,
    owner_user_id: owner,
    kalshi_connection_id: null,
    subaccount: 1,
    exchange_index: 2,
    commissioned,
    execution_enabled: false,
    kill_switch: true,
    cash_micros: cashMicros,
    reserved_micros: "0",
    minimum_exit_micros: 10000,
    reconciled_at: null,
    policy_state: "APPROVED",
    policy_version: 1,
    max_entry_stake_cents: 150,
    configured_stake_cents: owner === USER_A ? 100 : 80,
    stake_revision: 1,
  };
}

function database(ready: boolean) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const accounts = [
    account(null, "v13-production-1-2", true, "25000000"),
    account(USER_A, "acct-a", true, "25000000"),
    account(USER_B, "acct-b", true, "99000000"),
  ];
  const secrets = new Map([
    ["vault-a", JSON.stringify({ api_key_id: "key-a", private_key: "pem-a" })],
    ["vault-b", JSON.stringify({ api_key_id: "key-b", private_key: "pem-b-secret" })],
  ]);
  const connections = new Map([
    [USER_A, { vault_secret_id: "vault-a", key_fingerprint: "a".repeat(64), api_usage_tier: "advanced", bot_eligible: false, bot_eligibility_reason: "server_review_required", verified_at: "2026-10-11T00:00:00.000Z" }],
    [USER_B, { vault_secret_id: "vault-b", key_fingerprint: "b".repeat(64), api_usage_tier: "advanced", bot_eligible: true, bot_eligibility_reason: null, verified_at: "2026-10-11T00:00:00.000Z" }],
  ]);
  const presets = [{
    id: "preset-b", name: "B only", description: "", creator_user_id: USER_B, creator_display_name: null,
    capital_limit_cents: 15000, max_entry_stake_cents: 150, max_entry_all_in_cents: 200,
    max_daily_loss_cents: 500, max_total_loss_cents: 1500, max_quote_age_ms: 1000,
    max_fee_evidence_age_ms: 1000, minimum_exit_micros: 10000, revision: 1,
    created_at: "2026-10-11T00:00:00.000Z", updated_at: "2026-10-11T00:00:00.000Z",
  }];
  const drafts: unknown[][] = [];
  const stakes = new Map([["acct-a", 100], ["acct-b", 80]]);
  const db: UserScopeQuery = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (text.includes("information_schema")) return { rows: [{ ready }] };
      if (text.includes("WHERE a.owner_user_id")) {
        return { rows: accounts.filter((row) => row.owner_user_id === params[0]) };
      }
      if (text.includes("fa.user_id")) {
        const row = connections.get(String(params[0]));
        return { rows: row ? [row] : [] };
      }
      if (text.includes("decrypted_secrets")) {
        const secret = secrets.get(String(params[0]));
        return { rows: secret ? [{ decrypted_secret: secret }] : [] };
      }
      if (text.includes("UPDATE strata_configured_stake")) {
        const [cents, accountId, , owner] = params;
        const owned = accounts.find((row) => row.id === accountId && row.owner_user_id === owner);
        if (!owned || !stakes.has(String(accountId))) return { rows: [], rowCount: 0 };
        stakes.set(String(accountId), Number(cents));
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("UPDATE v13_shared_preset")) {
        const preset = presets.find((row) => row.id === params[0] && row.creator_user_id === params[1]);
        return { rows: preset ? [preset] : [], rowCount: preset ? 1 : 0 };
      }
      if (text.includes("DELETE FROM v13_shared_preset")) {
        const index = presets.findIndex((row) => row.id === params[0] && row.creator_user_id === params[1]);
        if (index < 0) return { rows: [], rowCount: 0 };
        presets.splice(index, 1);
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("FROM v13_shared_preset WHERE id")) {
        return { rows: presets.filter((row) => row.id === params[0]) };
      }
      if (text.includes("FROM v13_shared_preset")) return { rows: presets };
      if (text.includes("INSERT INTO v13_live_money_policy")) {
        drafts.push(params);
        assert.equal(text.includes("'DRAFT'"), true);
        assert.equal(text.includes("'APPROVED'"), false);
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("next_version")) return { rows: [{ next_version: 1 }] };
      if (text.includes("INSERT INTO v13_shared_preset")) {
        const row = {
          id: String(params[0]), name: String(params[1]), description: String(params[2]), creator_user_id: String(params[3]),
          creator_display_name: null, capital_limit_cents: Number(params[5]), max_entry_stake_cents: Number(params[6]),
          max_entry_all_in_cents: Number(params[7]), max_daily_loss_cents: Number(params[8]), max_total_loss_cents: Number(params[9]),
          max_quote_age_ms: Number(params[10]), max_fee_evidence_age_ms: Number(params[11]), minimum_exit_micros: Number(params[12]),
          revision: 1, created_at: "2026-10-11T00:00:00.000Z", updated_at: "2026-10-11T00:00:00.000Z",
        };
        presets.push(row);
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { db, calls, drafts, stakes, presets };
}

test("missing migration fails closed and does not read the legacy account", async () => {
  const { db, calls } = database(false);
  const port = createDatabaseUserScopePort(db, { kalshiGet: async () => { throw new Error("kalshi_called"); } });
  assert.equal(await port.migrationReady(), false);
  const view = await port.settings(USER_A);
  assert.equal(view.executionAccountExists, false);
  assert.equal(view.botCashCents, null);
  assert.equal(view.legacyUnassigned, false);
  const control = await port.control(USER_A, "START");
  assert.equal(control.reason, "user_scope_not_migrated");
  assert.equal(calls.some((call) => call.text.includes("owner_user_id IS NULL")), false);
  assert.equal(calls.some((call) => call.text.includes("v13_production_account a")), false);
});

test("user A cannot read user B credentials, balances, stakes, or presets", async () => {
  const { db, calls, drafts, stakes } = database(true);
  const seenKeys: string[] = [];
  const port = createDatabaseUserScopePort(db, {
    kalshiGet: async (creds, path) => {
      seenKeys.push(creds.keyId);
      assert.equal(creds.privateKey.includes("pem-b"), false);
      if (path.endsWith("/account/limits")) return { usage_tier: "advanced" };
      if (path.endsWith("/portfolio/balance")) return { balance: 2500, portfolio_value: 1234 };
      if (path.endsWith("/portfolio/positions")) return { market_positions: [{ ticker: "KXBTC15M" }] };
      if (path.endsWith("/portfolio/orders")) return { orders: [{ order_id: "o1" }] };
      if (path.endsWith("/portfolio/fills")) return { fills: [{ trade_id: "f1" }] };
      return { orders: [], fills: [], settlements: [], transfers: [], market_positions: [] };
    },
  });
  const wallet = await port.wallet(USER_A);
  assert.equal(wallet.primary.cashCents, 2500);
  assert.equal(wallet.primary.portfolioValueCents, 1234);
  assert.equal(wallet.credentialVerified, true);
  assert.equal(wallet.apiUsageTier, "advanced");
  assert.equal(wallet.botEligible, true);
  assert.equal(wallet.botSubaccount?.cashCents, 2500);
  assert.equal(wallet.positions.length, 1);
  assert.equal(wallet.orders.length, 1);
  assert.equal(wallet.fills.length, 1);
  assert.equal(seenKeys.length, 8);
  assert.equal(seenKeys.every((key) => key === "key-a"), true);
  assert.equal(JSON.stringify(wallet).includes("pem-b-secret"), false);
  assert.equal(JSON.stringify(wallet).includes("vault-b"), false);
  assert.equal(calls.some((call) => call.text.includes("decrypted_secrets") && call.params[0] === "vault-b"), false);
  const settings = await port.settings(USER_A);
  assert.equal(settings.botCashCents, 2500);
  assert.equal(settings.ownerUserId, USER_A);
  const stake = await port.stake(USER_A, 120, 1);
  assert.equal(stake.ok, true);
  assert.equal(stakes.get("acct-a"), 120);
  assert.equal(stakes.get("acct-b"), 80);
  const foreignStake = calls.filter((call) => call.text.includes("UPDATE strata_configured_stake"));
  assert.equal(foreignStake.every((call) => call.params[1] === "acct-a" && call.params[3] === USER_A), true);
  const updated = await port.updatePreset(USER_A, "preset-b", {
    name: "stolen", capitalLimitCents: 15000, maxEntryStakeCents: 150, maxEntryAllInCents: 200,
    maxDailyLossCents: 500, maxTotalLossCents: 1500, maxQuoteAgeMs: 1000, maxFeeEvidenceAgeMs: 1000, minimumExitMicros: 10000,
  });
  assert.equal(updated.ok, false);
  assert.equal(updated.reason, "not_preset_creator");
  const applied = await port.applyPreset(USER_A, "preset-b");
  assert.equal(applied.ok, true);
  assert.equal(applied.draft?.state, "DRAFT");
  assert.equal(applied.draft?.approved, false);
  assert.equal(drafts[0]?.[2], "acct-a");
  assert.equal(drafts[0]?.includes("acct-b"), false);
  const started = await port.control(USER_A, "START");
  const armed = await port.control(USER_A, "ARM");
  assert.equal(started.reason, "user_execution_signer_not_provisioned");
  assert.equal(armed.reason, "user_execution_signer_not_provisioned");
  const source = readFileSync("src/lib/strata/userScopeDatabase.ts", "utf8");
  assert.equal(source.includes("getLiveProductionSupervisor"), false);
  assert.equal(source.includes("KALSHI_INDEX2"), false);
});

test("wallet reads the caller's Vault connection before execution ownership exists", async () => {
  const { db, calls } = database(false);
  const port = createDatabaseUserScopePort(db, {
    kalshiGet: async (creds, path, query = "") => {
      assert.equal(creds.keyId, "key-a");
      if (query.includes("subaccount=")) throw new Error("bot_unavailable");
      if (path.endsWith("/account/limits")) return { usage_tier: "basic" };
      if (path.endsWith("/portfolio/balance")) return { balance_dollars: "25.0000", portfolio_value: 1234 };
      return {};
    },
  });
  const wallet = await port.wallet(USER_A);
  assert.equal(wallet.credentialVerified, true);
  assert.equal(wallet.primary.cashCents, 2500);
  assert.equal(wallet.primary.portfolioValueCents, 1234);
  assert.equal(wallet.botEligible, false);
  assert.equal(wallet.botEligibilityReason, "ADVANCED_API_TIER_REQUIRED");
  assert.equal(wallet.botSubaccount, null);
  assert.equal(calls.some((call) => call.text.includes("v13_production_account")), false);
  assert.equal(calls.some((call) => call.params.includes("vault-b")), false);
});

test("an uncommissioned account cannot be armed and a client owner id is ignored", async () => {
  const seen: string[] = [];
  const port = createDatabaseUserScopePort({
    query: async (text, params) => {
      if (text.includes("information_schema")) return { rows: [{ ready: true }] };
      if (text.includes("WHERE a.owner_user_id")) {
        seen.push(String(params?.[0]));
        return { rows: params?.[0] === USER_A ? [account(USER_A, "acct-a", false, "0")] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  });
  assert.equal((await port.control(USER_A, "ARM")).reason, "user_execution_account_not_commissioned");
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.strata = { subject: USER_A };
    next();
  });
  app.use("/me", createUserExecutionRouter((_req, _res, next) => next(), port));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const portNumber = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${portNumber}/me/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "START", owner_user_id: USER_B, target_user_id: USER_B, bot_eligible: true }),
    });
    const body = await response.json() as { reason?: string };
    assert.equal(response.status, 409);
    assert.equal(body.reason, "user_execution_account_not_commissioned");
    assert.equal(seen.every((id) => id === USER_A), true);
    assert.equal(seen.includes(USER_B), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("scoped Kalshi reads are signed GETs and integer cents stay cents", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let method = "";
  let body: unknown = "unset";
  const payload = await getScopedKalshiJson(
    { keyId: "key-a", privateKey: pem },
    "/trade-api/v2/portfolio/balance",
    "",
    async (_url, init) => {
      method = init?.method ?? "";
      body = init?.body ?? null;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("KALSHI-ACCESS-KEY"), "key-a");
      assert.equal(headers.get("KALSHI-ACCESS-SIGNATURE")?.includes(pem), false);
      return new Response(JSON.stringify({ balance: 2500, portfolio_value: 1234 }), { status: 200 });
    },
  );
  assert.equal(method, "GET");
  assert.equal(body, null);
  assert.deepEqual(payload, { balance: 2500, portfolio_value: 1234 });
  await assert.rejects(
    getScopedKalshiJson({ keyId: "key-a", privateKey: pem }, "/trade-api/v2/portfolio/orders/cancel", "", async () => new Response("{}", { status: 200 })),
  );
});

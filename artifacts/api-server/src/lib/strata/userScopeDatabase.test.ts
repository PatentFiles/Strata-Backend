import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { getScopedKalshiJson, KalshiApiError } from "../kalshiAccountClient";
import { sanitizePublic } from "../v13-production/sanitize";
import { productionPersonalSession } from "./personalExecutionSupervisor";
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
    max_entry_stake_cents: 500,
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
      if (text.includes("JOIN private.role_assignments ra")) {
        return { rows: params[0] === USER_A ? [{ authorized: 1 }] : [] };
      }
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
      if (text.includes("account-stake:exposure")) {
        return {
          rows: [{
            open_positions: 0,
            prepared: 0,
            dispatched: 0,
            unknown: 0,
            unresolved: 0,
            running: 0,
          }],
          rowCount: 1,
        };
      }
      if (text.includes("account-stake:upsert")) {
        const [cents, accountId, revision, owner] = params;
        const owned = accounts.find((row) => row.id === accountId && row.owner_user_id === owner);
        if (!owned) return { rows: [], rowCount: 0 };
        const current = stakes.get(String(accountId));
        if (current === undefined) {
          if (revision !== null) return { rows: [], rowCount: 0 };
          stakes.set(String(accountId), Number(cents));
          return { rows: [{ revision: 1 }], rowCount: 1 };
        }
        if (revision !== owned.stake_revision) return { rows: [], rowCount: 0 };
        const next = Number(owned.stake_revision) + 1;
        owned.stake_revision = next;
        stakes.set(String(accountId), Number(cents));
        return { rows: [{ revision: next }], rowCount: 1 };
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
  const stake = await port.stake(USER_A, 500, 1);
  assert.equal(stake.ok, true);
  assert.equal(stake.view.configuredStakeCents, 500);
  assert.equal(stake.view.stakeRevision, 2);
  assert.equal(stake.view.workerRunning, false);
  assert.equal(stakes.get("acct-a"), 500);
  assert.equal(stakes.get("acct-b"), 80);
  const foreignStake = calls.filter((call) => call.text.includes("account-stake:upsert"));
  assert.equal(foreignStake.every((call) => call.params[1] === "acct-a" && call.params[3] === USER_A), true);
  const updated = await port.updatePreset(USER_A, "preset-b", {
    name: "stolen", capitalLimitCents: 15000, maxEntryStakeCents: 150, maxEntryAllInCents: 200,
    maxDailyLossCents: 500, maxTotalLossCents: 1500, maxQuoteAgeMs: 1000, maxFeeEvidenceAgeMs: 1000, minimumExitMicros: 10000,
  });
  assert.equal(updated.ok, false);
  assert.equal(updated.reason, "not_preset_creator");
  const standard = await port.previewPreset(USER_A, {
    presetId: "strata-standard-c52c53-v1", capitalLimitCents: 500,
  });
  assert.equal(standard.ok, true);
  assert.equal(standard.limits?.maxEntryStakeCents, 30);
  assert.equal(standard.limits?.maxEntryAllInCents, 40);
  assert.equal(standard.minimumExitMicros, null);
  assert.equal(standard.approved, false);
  const missingAuthority = await port.savePreset(USER_B, {
    name: "Must not save", capitalLimitCents: 2500, maxEntryStakeCents: 150,
    maxEntryAllInCents: 200, maxDailyLossCents: 500, maxTotalLossCents: 1500,
    maxQuoteAgeMs: 5000, maxFeeEvidenceAgeMs: 15000, minimumExitMicros: 10000,
  });
  assert.equal(missingAuthority.reason, "admin_required_to_manage_shared_presets");
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
      if (query.includes("subaccount=1")) throw new Error("bot_unavailable");
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

test("wallet reads all primary exchange indexes but never treats primary deposits as bot cash", async () => {
  const { db } = database(true);
  const balanceQueries: string[] = [];
  const port = createDatabaseUserScopePort(db, {
    kalshiGet: async (_creds, path, query = "") => {
      if (path.endsWith("/portfolio/balance")) {
        balanceQueries.push(query);
        if (query === "?subaccount=0")
          return { balance_dollars: "100.00", portfolio_value_dollars: "0.00" };
        if (query === "?subaccount=1&exchange_index=2")
          return { balance_dollars: "25.00", portfolio_value_dollars: "0.00" };
        throw new Error("unexpected balance scope");
      }
      if (path.endsWith("/account/limits")) return { usage_tier: "advanced" };
      return {};
    },
  });
  const wallet = await port.wallet(USER_A);
  assert.deepEqual(balanceQueries.sort(), [
    "?subaccount=0", "?subaccount=1&exchange_index=2",
  ]);
  assert.equal(wallet.credentialVerified, true);
  assert.equal(wallet.primary.cashCents, 10_000);
  assert.equal(wallet.botSubaccount?.cashCents, 2_500);
  assert.equal(wallet.primary.portfolioValueCents, 0);
  // This wallet read is read-only. It must not rewrite production cash or
  // permit bot orders to spend an unaudited $100 primary-account deposit.
});

test("primary balance verifies the credential when limits and activity reads fail", async () => {
  const { db } = database(true);
  const port = createDatabaseUserScopePort(db, {
    kalshiGet: async (_creds, path) => {
      if (path.endsWith("/portfolio/balance")) return { balance: 2500, portfolio_value: 1234 };
      throw new KalshiApiError("HTTP_ERROR", 404);
    },
  });
  const wallet = await port.wallet(USER_A);
  assert.equal(wallet.credentialVerified, true);
  assert.equal(wallet.verificationReason, "API_TIER_UNAVAILABLE");
  assert.equal(wallet.primary.cashCents, 2500);
  assert.equal(wallet.primary.portfolioValueCents, 1234);
  assert.equal(wallet.apiUsageTier, null);
  assert.equal(wallet.botEligible, false);
  assert.equal(wallet.botEligibilityReason, "API_TIER_UNAVAILABLE");
  const published = sanitizePublic({ ...wallet, private_key: "pem-a" });
  assert.equal(published.credentialVerified, true);
  assert.equal(published.verificationReason, "API_TIER_UNAVAILABLE");
  assert.equal(published.primary.cashCents, 2500);
  assert.equal(JSON.stringify(published).includes("pem-a"), false);
});

test("primary balance HTTP 401 does not verify the credential", async () => {
  const { db } = database(true);
  const port = createDatabaseUserScopePort(db, {
    kalshiGet: async () => {
      throw new KalshiApiError("HTTP_ERROR", 401);
    },
  });
  const wallet = await port.wallet(USER_A);
  assert.equal(wallet.credentialVerified, false);
  assert.equal(wallet.verificationReason, "PRIMARY_BALANCE_HTTP_401");
  assert.equal(wallet.primary.cashCents, null);
  assert.equal(wallet.botEligible, false);
});

test("a malformed Vault secret stays unverified and is not returned", async () => {
  const port = createDatabaseUserScopePort({
    query: async (text) => {
      if (text.includes("fa.user_id")) {
        return { rows: [{ financial_account_id: "acct", vault_secret_id: "vault-a" }] };
      }
      if (text.includes("decrypted_secrets")) return { rows: [{ decrypted_secret: "not-json" }] };
      return { rows: [] };
    },
  });
  const wallet = await port.wallet(USER_A);
  assert.equal(wallet.credentialVerified, false);
  assert.equal(wallet.verificationReason, "VAULT_SECRET_FORMAT_INVALID");
  assert.equal(JSON.stringify(wallet).includes("not-json"), false);
  assert.equal(JSON.stringify(wallet).includes("private_key"), false);
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

test("stake initializes once, rejects an unsafe revision, and control never reports a running worker", async () => {
  const row = {
    id: "acct-new",
    owner_user_id: USER_A,
    kalshi_connection_id: null,
    subaccount: 1,
    exchange_index: 2,
    commissioned: true,
    execution_enabled: false,
    kill_switch: true,
    cash_micros: "30000000000",
    reserved_micros: "0",
    minimum_exit_micros: 10000,
    reconciled_at: null,
    policy_state: "APPROVED",
    policy_version: 1,
    max_entry_stake_cents: 2_500_000,
    configured_stake_cents: null as number | null,
    stake_revision: null as number | null,
  };
  let running = 0;
  const port = createDatabaseUserScopePort({
    query: async (text, params = []) => {
      if (text.includes("information_schema")) return { rows: [{ ready: true }] };
      if (text.includes("WHERE a.owner_user_id")) {
        return { rows: params[0] === USER_A ? [row] : [] };
      }
      if (text.includes("account-stake:exposure")) {
        return {
          rows: [{
            open_positions: 0,
            prepared: 0,
            dispatched: 0,
            unknown: 0,
            unresolved: 0,
            running,
          }],
          rowCount: 1,
        };
      }
      if (text.includes("account-stake:upsert")) {
        const [cents, accountId, revision, owner] = params;
        if (accountId !== row.id || owner !== USER_A) return { rows: [], rowCount: 0 };
        if (row.stake_revision === null) {
          if (revision !== null) return { rows: [], rowCount: 0 };
          row.configured_stake_cents = Number(cents);
          row.stake_revision = 1;
          return { rows: [{ revision: 1 }], rowCount: 1 };
        }
        if (revision !== row.stake_revision) return { rows: [], rowCount: 0 };
        row.configured_stake_cents = Number(cents);
        row.stake_revision += 1;
        return { rows: [{ revision: row.stake_revision }], rowCount: 1 };
      }
      if (text.includes("account-control:restricted-signer")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  });
  const first = await port.stake(USER_A, 500, null);
  assert.equal(first.ok, true);
  assert.equal(first.view.configuredStakeCents, 500);
  assert.equal(first.view.stakeRevision, 1);
  const belowMinimum = await port.stake(USER_A, 499, 1);
  assert.equal(belowMinimum.ok, false);
  assert.equal(belowMinimum.reason, "stake_below_minimum_500_cents");
  const repeated = await port.stake(USER_A, 500, 1);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.view.configuredStakeCents, 500);
  assert.equal(repeated.view.stakeRevision, 2);
  let revision = 2;
  for (const cents of [25_000, 100_000, 500_000, 2_500_000]) {
    const saved = await port.stake(USER_A, cents, revision);
    assert.equal(saved.ok, true, `stake ${cents}`);
    assert.equal(saved.view.configuredStakeCents, cents);
    revision += 1;
  }
  assert.equal(row.configured_stake_cents, 2_500_000);
  const conflict = await port.stake(USER_A, 25_000, null);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "stake_revision_conflict");
  assert.equal(row.configured_stake_cents, 2_500_000);
  const ceiling = await port.stake(USER_A, 2_500_001, row.stake_revision);
  assert.equal(ceiling.ok, false);
  assert.equal(ceiling.reason, "above_hard_stake_ceiling");
  running = 1;
  const blocked = await port.stake(USER_A, 500, row.stake_revision);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "worker_running");
  const started = await port.control(USER_A, "START");
  assert.equal(started.ok, false);
  assert.equal(started.reason, "user_execution_signer_not_provisioned");
  assert.equal(started.view.workerRunning, false);
  const source = readFileSync("src/lib/strata/userScopeDatabase.ts", "utf8");
  assert.match(source, /ON CONFLICT \(execution_account_id\) WHERE execution_account_id IS NOT NULL/);
  assert.equal(source.includes("id = 'production'"), false);
  assert.equal(source.includes("kalshiPost"), false);
  assert.equal(source.includes("live_execution_not_enabled"), true);
});

test("a verified signer still cannot start while the global kill switch is on", async () => {
  const row: Record<string, unknown> = {
    ...account(USER_A, "acct-a", true, "25000000"),
    kill_switch: false,
    reconciled_at: "2026-10-13T00:00:00.000Z",
  };
  let posts = 0;
  const port = createDatabaseUserScopePort({
    query: async (text, params = []) => {
      if (text.includes("information_schema")) return { rows: [{ ready: true }] };
      if (text.includes("WHERE a.owner_user_id")) return { rows: params[0] === USER_A ? [row] : [] };
      if (text.includes("account-control:restricted-signer")) {
        return { rows: [{ key_fingerprint: "a".repeat(64) }], rowCount: 1 };
      }
      if (text.includes("account-control:global-safety")) {
        return { rows: [{ live_execution_enabled: false, manual_kill_switch: true }], rowCount: 1 };
      }
      if (text.includes("account-control:kill")) {
        assert.equal(params[0], "acct-a");
        assert.equal(params[1], USER_A);
        row.kill_switch = true;
        row.execution_enabled = false;
        return { rows: [{ id: "acct-a" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  }, {
    kalshiGet: async () => {
      posts += 1;
      throw new Error("control_must_not_call_kalshi");
    },
  });
  const started = await port.control(USER_A, "START");
  assert.equal(started.ok, false);
  assert.equal(started.reason, "global_kill_switch");
  assert.equal(started.view.workerRunning, false);
  const armed = await port.control(USER_A, "ARM");
  assert.equal(armed.reason, "global_kill_switch");
  assert.equal(armed.view.workerRunning, false);
  const killed = await port.control(USER_A, "KILL");
  assert.equal(killed.ok, true);
  assert.equal(killed.reason, "account_killed");
  assert.equal(killed.exchangeFlatVerified, false);
  assert.equal(killed.protectiveExitState, "MANUAL_EXCHANGE_RECONCILIATION_REQUIRED");
  assert.equal(killed.view.killSwitch, true);
  assert.equal(killed.view.workerRunning, false);
  assert.equal(posts, 0);
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
    getScopedKalshiJson({ keyId: "key-a", privateKey: pem }, "/trade-api/v2/portfolio/orders/ord-1/cancel", "", async () => new Response("{}", { status: 200 })),
  );
  const order = await getScopedKalshiJson(
    { keyId: "key-a", privateKey: pem },
    "/trade-api/v2/portfolio/orders/ord-1",
    "",
    async () => new Response(JSON.stringify({ order: { order_id: "ord-1" } }), { status: 200 }),
  );
  assert.deepEqual(order, { order: { order_id: "ord-1" } });
});

test("scoped Kalshi reads sign stored Ed25519 keys", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let method = "";
  const payload = await getScopedKalshiJson(
    { keyId: "key-ed", privateKey: pem },
    "/trade-api/v2/portfolio/balance",
    "",
    async (_url, init) => {
      method = init?.method ?? "";
      const headers = new Headers(init?.headers);
      const timestamp = headers.get("KALSHI-ACCESS-TIMESTAMP") ?? "";
      const signature = Buffer.from(headers.get("KALSHI-ACCESS-SIGNATURE") ?? "", "base64");
      assert.equal(verify(null, Buffer.from(`${timestamp}GET/trade-api/v2/portfolio/balance`), publicKey, signature), true);
      assert.equal(headers.get("KALSHI-ACCESS-SIGNATURE")?.includes("PRIVATE"), false);
      return new Response(JSON.stringify({ balance: 2500, portfolio_value: 1234 }), { status: 200 });
    },
  );
  assert.equal(method, "GET");
  assert.deepEqual(payload, { balance: 2500, portfolio_value: 1234 });
});

test("START reports running only after the session schedules a worker, and production refuses submission", async () => {
  const row: Record<string, unknown> = {
    ...account(USER_A, "acct-a", true, "25000000"),
    kill_switch: false,
    execution_enabled: true,
    // The actual lease ARM flag, not eligibility, controls reported armed.
    worker_arm_requested: true,
    worker_lease_state: "released",
    reconciled_at: "2026-10-13T00:00:00.000Z",
    configured_stake_cents: 100,
    stake_revision: 4,
    max_entry_stake_cents: 2_500_000,
  };
  let posts = 0;
  const session = {
    running: false,
    isScheduled(userId: string, accountId: string) {
      return this.running && userId === USER_A && accountId === "acct-a";
    },
    async start() {
      this.running = true;
      return { ok: true, reason: "worker_scheduled", workerStarted: true };
    },
    async stopOwner() {
      this.running = false;
      return { workerStopped: true };
    },
    async stop() {
      this.running = false;
      return { workerStopped: true };
    },
  };
  const query = async (text: string, params: unknown[] = []) => {
    if (text.includes("information_schema")) return { rows: [{ ready: true }] };
    if (text.includes("WHERE a.owner_user_id")) return { rows: params[0] === USER_A ? [row] : [] };
    if (text.includes("account-control:restricted-signer")) return { rows: [{ key_fingerprint: "ab".repeat(32) }], rowCount: 1 };
    if (text.includes("account-control:global-safety")) {
      return { rows: [{ live_execution_enabled: true, manual_kill_switch: false }], rowCount: 1 };
    }
    if (text.includes("account-stake:exposure")) {
      return { rows: [{ open_positions: 0, prepared: 0, dispatched: 0, unknown: 0, unresolved: 0, running: 0 }], rowCount: 1 };
    }
    if (text.includes("account-stake:upsert")) {
      const [cents, accountId, revision, owner] = params;
      if (accountId !== "acct-a" || owner !== USER_A || revision !== row.stake_revision) return { rows: [], rowCount: 0 };
      row.configured_stake_cents = cents;
      row.stake_revision = Number(revision) + 1;
      return { rows: [{ revision: row.stake_revision }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const port = createDatabaseUserScopePort({ query }, {
    kalshiGet: async () => {
      posts += 1;
      throw new Error("control_must_not_call_kalshi");
    },
    session,
  });
  // ARM never schedules a worker or calls the exchange. Only START does.
  const armed = await port.control(USER_A, "ARM");
  assert.equal(armed.ok, true);
  assert.equal(armed.reason, "account_armed_ready_for_start");
  assert.equal(armed.view.armed, true);
  assert.equal(armed.view.workerRunning, false);
  assert.equal(session.running, false);
  const started = await port.control(USER_A, "START");
  assert.equal(started.ok, true);
  assert.equal(started.reason, "worker_scheduled");
  assert.equal(started.view.workerRunning, true);
  assert.equal((await port.settings(USER_A)).workerRunning, true);
  const duplicate = await port.control(USER_A, "START");
  assert.equal(duplicate.view.workerRunning, true);
  const stopped = await port.control(USER_A, "STOP");
  assert.equal(stopped.reason, "entries_stopped");
  assert.equal(stopped.exchangeFlatVerified, false);
  assert.equal(stopped.protectiveExitState, "EXCHANGE_RECONCILIATION_REQUIRED");
  assert.equal(stopped.view.workerRunning, false);
  const saved = await port.stake(USER_A, 500, 4);
  assert.equal(saved.ok, true);
  assert.equal(saved.view.configuredStakeCents, 500);
  assert.equal(saved.view.stakeRevision, 5);
  const production = createDatabaseUserScopePort({ query }, {
    kalshiGet: async () => {
      posts += 1;
      throw new Error("control_must_not_call_kalshi");
    },
    session: productionPersonalSession(),
  });
  const refused = await production.control(USER_A, "START");
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "personal_signer_unavailable");
  assert.equal(refused.view.workerRunning, false);
  assert.equal(posts, 0);
});

test("wallet display coalesces repeated reads per authenticated owner without sharing cash",async()=>{
 const {db}=database(true);let calls=0;
 const port=createDatabaseUserScopePort(db,{kalshiGet:async(creds,path)=>{
  calls++;
  if(path.endsWith("/account/limits"))return {usage_tier:"advanced"};
  if(path.endsWith("/portfolio/balance"))return {balance:creds.keyId==="key-a"?2500:800,portfolio_value:0};
  return {orders:[],fills:[],settlements:[],transfers:[],market_positions:[]};
 }});
 const [a,b]=await Promise.all([port.wallet(USER_A),port.wallet(USER_A)]);
 assert.equal(calls,8);assert.equal(a.primary.cashCents,2500);assert.equal(b.primary.cashCents,2500);
 a.primary.cashCents=999;
 assert.equal((await port.wallet(USER_A)).primary.cashCents,2500);assert.equal(calls,8);
 assert.equal((await port.wallet(USER_B)).primary.cashCents,800);assert.equal(calls,16);
});

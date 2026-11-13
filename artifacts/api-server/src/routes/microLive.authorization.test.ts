import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import express from "express";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db, forwardTestEngineTable, microLiveConfigTable, microLiveDecisionTable,
  microLiveOrderTable, pool,
} from "@workspace/db";
import router from "./microLive";
import { recoverAndCancelUncertainMicroLiveExit } from "../lib/microLiveRecovery";
import {
  cancelAndVerifyMicroLiveExit, observeMicroLiveWorkerLeaseForIsolatedTest,
  registerMicroLiveWorkerLeaseOwner, type MicroLiveDependencies,
} from "../lib/microLive";

if (!/^shadow_test_[a-f0-9]{24}$/.test(process.env.SHADOW_TEST_ISOLATED_SCHEMA ?? "")) {
  throw new Error("Micro-live authorization tests require a disposable isolated schema");
}

const saved = {
  nodeEnv: process.env.NODE_ENV,
  admin: process.env.PHASE4_ADMIN_USER_ID,
  productionEnabled: process.env.MICRO_LIVE_PRODUCTION_ENABLED,
  executionEnabled: process.env.LIVE_EXECUTION_ENABLED,
  accountMode: process.env.MICRO_LIVE_ACCOUNT_MODE,
  subaccount: process.env.KALSHI_BOT_SUBACCOUNT,
};

after(async () => {
  for (const [key, value] of [
    ["NODE_ENV", saved.nodeEnv],
    ["PHASE4_ADMIN_USER_ID", saved.admin],
    ["MICRO_LIVE_PRODUCTION_ENABLED", saved.productionEnabled],
    ["LIVE_EXECUTION_ENABLED", saved.executionEnabled],
    ["MICRO_LIVE_ACCOUNT_MODE", saved.accountMode],
    ["KALSHI_BOT_SUBACCOUNT", saved.subaccount],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await pool.end();
});

test("micro-live authorization only allows admin state reads and emergency stop", async () => {
  process.env.NODE_ENV = "development";
  process.env.PHASE4_ADMIN_USER_ID = "micro-live-test-admin";
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "1";
  const cancellationRunId = randomUUID();

  // This suite's older disposable runner clones the core tables, but not the
  // settlement table now read by the state endpoint.
  await db.execute(sql`CREATE TABLE micro_live_settlements
    (LIKE public.micro_live_settlements INCLUDING ALL)`);
  // Disposable schemas clone the core tables from public, which can lag
  // migrations applied to the code under test.
  await db.execute(sql`ALTER TABLE micro_live_config
    ADD COLUMN IF NOT EXISTS micro_live_run_id text,
    ADD COLUMN IF NOT EXISTS micro_live_entry_attempted boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS micro_live_reserved_micros integer NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE micro_live_orders
    ADD COLUMN IF NOT EXISTS micro_live_run_id text,
    ADD COLUMN IF NOT EXISTS reserved_entry_fee_micros integer,
    ADD COLUMN IF NOT EXISTS reserved_exit_fee_micros integer,
    ADD COLUMN IF NOT EXISTS fee_evidence_fingerprint text,
    ADD COLUMN IF NOT EXISTS fee_evidence_verified_at timestamptz,
    ADD COLUMN IF NOT EXISTS cancellation_attempted_at timestamptz`);
  await db.insert(microLiveConfigTable).values({
    id: "singleton",
    microLiveProductionEnabled: true,
    liveExecutionEnabled: true,
    manualKillSwitch: false,
    microLiveAccountMode: "exclusive",
    microLiveSelectedSubaccount: 1,
    microLiveRunId: cancellationRunId,
  });

  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    async function call(path: string, options: {
      userId?: string;
      method?: string;
      body?: unknown;
    } = {}) {
      return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
        const req = httpRequest({
          hostname: "127.0.0.1",
          port,
          path,
          method: options.method ?? "GET",
          headers: {
            ...(options.userId ? { "x-test-user-id": options.userId } : {}),
            ...(payload ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            } : {}),
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode ?? 0,
              body: text.startsWith("{") ? JSON.parse(text) : {},
            });
          });
        });
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
      });
    }

    const statePath = "/micro-live/state";
    assert.equal((await call(statePath)).status, 401, "anonymous state request must be rejected");
    assert.equal((await call(statePath, { userId: "micro-live-test-user" })).status, 403,
      "signed-in non-admin state request must be rejected");
    const state = await call(statePath, { userId: "micro-live-test-admin" });
    assert.equal(state.status, 200);
    assert.equal(state.body.killSwitch, "OFF");
    assert.equal(state.body.enabled, false, "environment gates remain off in the test");

    const stopPath = "/micro-live/emergency-stop";
    assert.equal((await call(stopPath, { method: "POST", body: { disable: true } })).status, 401,
      "anonymous emergency stop must be rejected");
    assert.equal((await call(stopPath, {
      userId: "micro-live-test-user",
      method: "POST",
      body: { disable: true },
    })).status, 403, "signed-in non-admin emergency stop must be rejected");
    const invalid = await call(stopPath, {
      userId: "micro-live-test-admin",
      method: "POST",
      body: { disable: false },
    });
    assert.equal(invalid.status, 400, "a request must explicitly request disable=true");

    const stopped = await call(stopPath, {
      userId: "micro-live-test-admin",
      method: "POST",
      body: { disable: true },
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.killSwitch, "ON");
    assert.deepEqual(stopped.body.databaseFlags, {
      microLiveProductionEnabled: false,
      liveExecutionEnabled: false,
    });
    const [persistedConfig] = await db.select().from(microLiveConfigTable);
    assert.equal(persistedConfig?.microLiveProductionEnabled, false);
    assert.equal(persistedConfig?.liveExecutionEnabled, false);
    assert.equal(persistedConfig?.manualKillSwitch, true);

    for (const [path, body] of [
      ["/micro-live/bounded-run/arm", { confirm: true }],
      ["/micro-live/bounded-run/resume-exit", { confirm: true }],
      ["/micro-live/bounded-run/prepare-next", {
        confirm: true, priorRunId: randomUUID(),
        reason: "Prepare next run after the previous bounded entry window expired unused.",
      }],
    ] as const) {
      assert.equal((await call(path, { method: "POST", body })).status, 401,
        `anonymous ${path} request must be rejected`);
      assert.equal((await call(path, {
        method: "POST", userId: "micro-live-test-user", body,
      })).status, 403, `signed-in non-admin ${path} request must be rejected`);
    }

    const recoveryPath = "/micro-live/reconcile-uncertain";
    const recoveryBody = { orderId: "00000000-0000-4000-8000-000000000001" };
    assert.equal((await call(recoveryPath, { method: "POST", body: recoveryBody })).status, 401);
    assert.equal((await call(recoveryPath, {
      method: "POST", userId: "micro-live-test-user", body: recoveryBody,
    })).status, 403);
    assert.equal((await call(recoveryPath, {
      method: "POST", userId: "micro-live-test-admin", body: { orderId: "bad" },
    })).status, 400);
    const missing = await call(recoveryPath, {
      method: "POST", userId: "micro-live-test-admin", body: recoveryBody,
    });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.reason, "uncertain_recovery_order_not_found");

    const recoverAndCancelPath = "/micro-live/recover-and-cancel-uncertain-exit";
    const nonexistentExitId = randomUUID();
    const recoverAndCancelBody = { orderId: nonexistentExitId };
    assert.equal((await call(recoverAndCancelPath, {
      method: "POST", body: recoverAndCancelBody,
    })).status, 401, "anonymous recovery-and-cancel request must be rejected");
    assert.equal((await call(recoverAndCancelPath, {
      method: "POST", userId: "micro-live-test-user", body: recoverAndCancelBody,
    })).status, 403, "signed-in non-admin recovery-and-cancel request must be rejected");
    assert.equal((await call(recoverAndCancelPath, {
      method: "POST", userId: "micro-live-test-admin", body: { orderId: "invalid" },
    })).status, 400, "invalid recovery order ID must be rejected");
    // The ID is guaranteed not to exist; the procedure returns before any
    // exchange evidence/account reader can be reached.
    const safelyMissingExit = await call(recoverAndCancelPath, {
      method: "POST", userId: "micro-live-test-admin", body: recoverAndCancelBody,
    });
    assert.equal(safelyMissingExit.status, 409);
    assert.deepEqual(safelyMissingExit.body, {
      status: "blocked",
      reason: "uncertain_recovery_order_not_found",
      orderId: nonexistentExitId,
    });

    const settlementPath = "/micro-live/reconcile-settlement";
    const settlementBody = { positionId: "position:test:one" };
    assert.equal((await call(settlementPath, {
      method: "POST", body: settlementBody,
    })).status, 401);
    assert.equal((await call(settlementPath, {
      method: "POST", userId: "micro-live-test-user", body: settlementBody,
    })).status, 403);
    assert.equal((await call(settlementPath, {
      method: "POST", userId: "micro-live-test-admin", body: { positionId: "$invalid" },
    })).status, 400);
    const noPosition = await call(settlementPath, {
      method: "POST", userId: "micro-live-test-admin", body: settlementBody,
    });
    assert.equal(noPosition.status, 409);
    assert.equal(noPosition.body.status, "blocked");

    for (const path of ["/micro-live/activate", "/micro-live/order"]) {
      assert.equal((await call(path, {
        userId: "micro-live-test-admin",
        method: "POST",
        body: {},
      })).status, 404, `${path} must not be exposed`);
    }

    // Recovery-and-cancel exercises only injected exchange readers and the
    // identified-order cancellation seam; no authenticated Kalshi calls occur.
    process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
    process.env.LIVE_EXECUTION_ENABLED = "false";
    const suffix = randomUUID().replaceAll("-", "");
    const ticker = `KXBTC15M-RECOVERY-${suffix.slice(0, 12)}`;
    const recoveryOrderIds: string[] = [];
    const createExit = async () => {
      const id = randomUUID();
      await db.insert(microLiveOrderTable).values({
        id,
        actionKey: `recovery-action-${id}`,
        clientOrderId: `recovery-client-${id}`,
        marketTicker: ticker,
        crossingKey: `recovery-crossing-${id}`,
        triggerType: "EXIT",
        action: "sell",
        intent: "exit",
        exitPositionId: `position-${id}`,
        side: "UP",
        sourceEvaluationId: `evaluation-${id}`,
        signalAt: new Date(),
        requestedLimitPrice: 0.4,
        requestedContracts: 2,
        requestedStakeCents: 80,
        reservedRiskCents: 80,
        exchangeOrderId: null,
        status: "unknown",
        remainingContracts: 2,
        filledContracts: 0,
        microLiveRunId: cancellationRunId,
        reservedEntryFeeMicros: 0,
        reservedExitFeeMicros: 0,
        feeEvidenceFingerprint: `isolated-route-fee-${id}`,
        feeEvidenceVerifiedAt: new Date(),
      });
      recoveryOrderIds.push(id);
      return id;
    };
    const evidenceFor = (id: string, exchangeId = `exchange-${id}`) => ({
      orders: [{
        id: exchangeId,
        clientOrderId: `recovery-client-${id}`,
        ticker,
        side: "yes",
        action: "sell",
        type: "limit",
        status: "resting",
        priceDollars: "0.4",
        initialCount: "2",
        filledCount: "0",
        remainingCount: "2",
      }],
      fills: [],
      historicalFills: [],
      historicalFillsAvailable: true,
      truncated: false,
    });
    const accountFor = (exchangeId: string) => ({
      balance: { availableCashDollars: "100", portfolioValueDollars: "100" },
      openOrders: [{
        id: exchangeId, ticker, side: "yes", action: "sell",
        priceDollars: "0.4", remainingCount: "2", status: "resting",
        createdAt: new Date().toISOString(),
      }],
      positions: [],
      fills: [],
      truncated: { openOrders: false, positions: false, fills: false },
    });
    const noCancel = async () => ({ ready: false as const, reason: "must_not_cancel" });

    const successId = await createExit();
    let cancelCount = 0;
    const validEvidence = evidenceFor(successId);
    const success = await recoverAndCancelUncertainMicroLiveExit(successId, "micro-live-test-admin", {
      readEvidence: async () => validEvidence,
      readAccount: async () => accountFor(validEvidence.orders[0]!.id),
      cancelExit: async (localId) => {
        cancelCount++;
        const [linked] = await db.select().from(microLiveOrderTable)
          .where(eq(microLiveOrderTable.id, localId)).limit(1);
        assert.equal(linked?.exchangeOrderId, validEvidence.orders[0]!.id,
          "exchange identity must be transactionally linked before cancellation");
        return { ready: false, reason: "exit_canceled_requires_manual_review" };
      },
    });
    assert.equal(success.status, "linked_and_cancel_checked");
    assert.equal(cancelCount, 1);
    const [linkedExit] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, successId)).limit(1);
    assert.equal(linkedExit?.status, "unknown");
    assert.equal(linkedExit?.reservedRiskCents, 80);

    const ownershipBlockedId = await createExit();
    const ownershipEvidence = evidenceFor(ownershipBlockedId);
    const ownershipBlocked = await recoverAndCancelUncertainMicroLiveExit(
      ownershipBlockedId, "micro-live-test-admin", {
        readEvidence: async () => ownershipEvidence,
        readAccount: async () => accountFor(ownershipEvidence.orders[0]!.id),
        cancelExit: async () => ({
          ready: false, reason: "micro_live_account_exclusive_control_unverified",
        }),
      },
    );
    assert.equal(ownershipBlocked.status, "blocked",
      "a proved identity is not proof that cancellation was permitted");
    const [ownershipFrozen] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, ownershipBlockedId)).limit(1);
    assert.equal(ownershipFrozen?.exchangeOrderId, ownershipEvidence.orders[0]!.id);
    assert.equal(ownershipFrozen?.status, "unknown");
    assert.equal(ownershipFrozen?.reservedRiskCents, 80);

    const blockedId = await createExit();
    const blockedCases = [
      { evidence: { ...evidenceFor(blockedId), orders: [] }, reason: "no candidate" },
      {
        evidence: {
          ...evidenceFor(blockedId),
          orders: [...evidenceFor(blockedId).orders, {
            ...evidenceFor(blockedId).orders[0]!, id: `duplicate-${blockedId}`,
          }],
        },
        reason: "duplicate candidate",
      },
      {
        evidence: {
          ...evidenceFor(blockedId),
          orders: [{ ...evidenceFor(blockedId).orders[0]!, action: "buy" }],
        },
        reason: "conflicting action",
      },
      {
        evidence: {
          ...evidenceFor(blockedId),
          orders: [{ ...evidenceFor(blockedId).orders[0]!, id: `wrong-id-${blockedId}` }],
        },
        reason: "exchange order ID does not match the account open order",
      },
      {
        evidence: {
          ...evidenceFor(blockedId),
          orders: [{ ...evidenceFor(blockedId).orders[0]!, priceDollars: "0.41" }],
        },
        reason: "conflicting price",
      },
      {
        evidence: { ...evidenceFor(blockedId), truncated: true },
        reason: "truncated history",
      },
      {
        evidence: { ...evidenceFor(blockedId), historicalFillsAvailable: false },
        reason: "unavailable historical fills",
      },
    ];
    for (const item of blockedCases) {
      const result = await recoverAndCancelUncertainMicroLiveExit(blockedId, "micro-live-test-admin", {
        readEvidence: async () => item.evidence,
        readAccount: async () => accountFor(`exchange-${blockedId}`),
        cancelExit: noCancel,
      });
      assert.equal(result.status, "blocked", item.reason);
    }
    const [unresolved] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, blockedId)).limit(1);
    assert.equal(unresolved?.status, "unknown");
    assert.equal(unresolved?.exchangeOrderId, null);
    assert.equal(unresolved?.reservedRiskCents, 80);

    const concurrentId = await createExit();
    const concurrentCandidate = evidenceFor(concurrentId);
    let readyReads = 0;
    let releaseReads!: () => void;
    const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
    let concurrentCancels = 0;
    const concurrentDependencies = {
      readEvidence: async () => concurrentCandidate,
      readAccount: async () => accountFor(concurrentCandidate.orders[0]!.id),
      afterEvidenceRead: async () => {
        readyReads++;
        if (readyReads === 2) releaseReads();
        await bothRead;
      },
      cancelExit: async () => {
        concurrentCancels++;
        return { ready: false as const, reason: "exit_canceled_requires_manual_review" };
      },
    };
    const concurrent = await Promise.all([
      recoverAndCancelUncertainMicroLiveExit(concurrentId, "micro-live-test-admin", concurrentDependencies),
      recoverAndCancelUncertainMicroLiveExit(concurrentId, "micro-live-test-admin", concurrentDependencies),
    ]);
    assert.deepEqual(concurrent.map((result) => result.status).sort(),
      ["blocked", "linked_and_cancel_checked"]);
    assert.equal(concurrentCancels, 1, "only the transaction winner may invoke cancellation");

    // Simulated process restart: the already-linked order must be freshly
    // verified; it is not re-linked, and cancellation is not blind.
    const [beforeRetry] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, concurrentId)).limit(1);
    const alreadyLinkedEvidence = evidenceFor(
      concurrentId, concurrentCandidate.orders[0]!.id,
    );
    const retry = await recoverAndCancelUncertainMicroLiveExit(
      concurrentId, "micro-live-test-admin", {
        readEvidence: async () => alreadyLinkedEvidence,
        readAccount: async () => accountFor(alreadyLinkedEvidence.orders[0]!.id),
        cancelExit: async () => {
          concurrentCancels++;
          return { ready: false as const, reason: "exit_canceled_requires_manual_review" };
        },
      });
    assert.equal(retry.status, "linked_and_cancel_checked");
    const [afterRetry] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, concurrentId)).limit(1);
    assert.equal(afterRetry?.exchangeOrderId, beforeRetry?.exchangeOrderId);
    assert.equal(afterRetry?.updatedAt.getTime(), beforeRetry?.updatedAt.getTime(),
      "already-linked recovery must not write the link again");
    assert.equal(concurrentCancels, 2);
    const wrongLinkRetry = await recoverAndCancelUncertainMicroLiveExit(
      concurrentId, "micro-live-test-admin", {
        readEvidence: async () => evidenceFor(concurrentId, `different-${concurrentId}`),
        readAccount: async () => accountFor(`different-${concurrentId}`),
        cancelExit: async () => {
          concurrentCancels++;
          return { ready: false as const, reason: "must_not_cancel" };
        },
      });
    assert.equal(wrongLinkRetry.status, "blocked");
    assert.equal(wrongLinkRetry.reason, "uncertain_exit_recovery_linked_order_id_conflict");
    assert.equal(concurrentCancels, 2, "a newly different exchange ID must never be canceled");

    const recoveryAudits = await db.select().from(microLiveDecisionTable)
      .where(eq(microLiveDecisionTable.orderId, blockedId));
    assert.ok(recoveryAudits.length >= blockedCases.length,
      "unresolved attempts are audited");

    // Remove the earlier recovery fixtures (including intentionally idless
    // rows) so the account-wide exclusive proof for this isolated cancellation
    // test has one precisely identified local order.
    await db.delete(microLiveDecisionTable)
      .where(inArray(microLiveDecisionTable.orderId, recoveryOrderIds));
    await db.delete(microLiveOrderTable)
      .where(inArray(microLiveOrderTable.id, recoveryOrderIds));
    process.env.KALSHI_BOT_SUBACCOUNT = "1";
    const leaseOwner = `authorization-test-${randomUUID()}`;
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    await db.insert(forwardTestEngineTable).values({
      id: "v1.3-paper",
      strategyVersion: "V1.3",
      enabled: true,
      leaseOwner,
      leaseExpiresAt,
    }).onConflictDoUpdate({
      target: forwardTestEngineTable.id,
      set: {
        strategyVersion: "V1.3",
        enabled: true,
        leaseOwner,
        leaseExpiresAt,
      },
    });
    const claimId = await createExit();
    const claimExchangeId = `claim-exchange-${claimId}`;
    await db.update(microLiveOrderTable).set({
      exchangeOrderId: claimExchangeId,
    }).where(eq(microLiveOrderTable.id, claimId));
    const [claimRow] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, claimId)).limit(1);
    assert.ok(claimRow);
    const account = {
      balance: { availableCashDollars: "100", portfolioValueDollars: "100" },
      openOrders: [{
        id: claimExchangeId, ticker: claimRow.marketTicker, side: "yes",
        action: "sell", priceDollars: "0.4", remainingCount: "2",
        status: "resting", createdAt: claimRow.createdAt.toISOString(),
      }],
      positions: [],
      fills: [],
      truncated: { openOrders: false, positions: false, fills: false },
    };
    const accountActivity = {
      orders: [{
        id: claimExchangeId,
        clientOrderId: claimRow.clientOrderId,
        ticker: claimRow.marketTicker,
        side: "yes",
        action: "sell",
        type: "limit",
        status: "resting",
        priceDollars: "0.4",
        initialCount: "2",
        filledCount: "0",
        remainingCount: "2",
        createdAt: claimRow.createdAt.toISOString(),
      }],
      fills: [],
      available: true,
      truncated: false,
      keyRestrictionVerified: true,
      selectedSubaccount: 1,
      scanStartedAt: new Date().toISOString(),
      scanFinishedAt: new Date().toISOString(),
      exclusiveControlVerified: true,
    };
    let statusReads = 0;
    let releaseStatusReads!: () => void;
    const bothStatusReads = new Promise<void>((resolve) => { releaseStatusReads = resolve; });
    let deleteAttempts = 0;
    const cancellationDependencies = {
      readAccount: async () => account,
      readAccountActivity: async () => accountActivity,
      readOrderStatus: async (id: string) => {
        assert.equal(id, claimExchangeId);
        statusReads++;
        if (statusReads === 2) releaseStatusReads();
        await bothStatusReads;
        return {
          orderId: claimExchangeId,
          clientOrderId: claimRow.clientOrderId,
          ticker: claimRow.marketTicker,
          side: "yes" as const,
          action: "sell" as const,
          type: "limit" as const,
          status: "resting",
          remainingCount: "2",
          filledCount: "0",
        };
      },
      cancelOrder: async (...[exchangeId, _context, capability]:
        Parameters<NonNullable<MicroLiveDependencies["cancelOrder"]>>) => {
        deleteAttempts++;
        assert.equal(exchangeId, claimExchangeId);
        assert.ok(capability, "DELETE must receive its single-use authorization capability");
        throw new Error("mock unknown DELETE response");
      },
    };
    registerMicroLiveWorkerLeaseOwner(leaseOwner);
    await observeMicroLiveWorkerLeaseForIsolatedTest();
    const attempts = await Promise.all([
      cancelAndVerifyMicroLiveExit(claimId, cancellationDependencies),
      cancelAndVerifyMicroLiveExit(claimId, cancellationDependencies),
    ]);
    assert.equal(statusReads, 3, "each caller GETs once, and the winner re-reads after claiming");
    assert.equal(deleteAttempts, 1, "the atomic durable claim permits at most one DELETE");
    assert.ok(attempts.some((result) =>
      result.reason === "exit_cancellation_or_verification_failed"));
    assert.ok(attempts.some((result) =>
      result.reason === "exit_cancellation_already_attempted"));
    const [claimed] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, claimId)).limit(1);
    assert.ok(claimed?.cancellationAttemptedAt, "failed DELETE keeps durable claim");
    assert.equal(claimed?.status, "unknown");
    assert.equal(claimed?.reservedRiskCents, 80);

    // Restart/retry may attempt authenticated GET-only recovery, but an
    // unavailable account snapshot cannot clear the claim or authorize DELETE.
    let retryAccountReads = 0;
    const restarted = await cancelAndVerifyMicroLiveExit(claimId, {
      readAccount: async () => {
        retryAccountReads++;
        throw new Error("mock account snapshot unavailable");
      },
      readAccountActivity: async () => { throw new Error("account snapshot must be read first"); },
      readOrderStatus: async () => {
        statusReads++;
        throw new Error("account snapshot must be read first");
      },
      cancelOrder: async () => {
        deleteAttempts++;
        throw new Error("must not DELETE after claimed attempt");
      },
    });
    assert.equal(restarted.reason, "startup_exchange_reconciliation_failed");
    assert.equal(retryAccountReads, 1);
    assert.equal(statusReads, 3);
    assert.equal(deleteAttempts, 1);
    const [stillFrozen] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, claimId)).limit(1);
    assert.equal(stillFrozen?.status, "unknown");
    assert.equal(stillFrozen?.reservedRiskCents, 80);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("accounting resolution endpoint requires admin authentication and an explicit reason", async () => {
  process.env.NODE_ENV = "development";
  process.env.PHASE4_ADMIN_USER_ID = "micro-live-test-admin";
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const body = {
      expectedUnresolvedReason: "startup_exchange_reconciliation_failed",
      resolutionReason: "Reviewed complete primary history; stale exchange startup read failed.",
    };
    const call = async (userId?: string, override: unknown = body) =>
      new Promise<number>((resolve, reject) => {
        const payload = JSON.stringify(override);
        const req = httpRequest({
          hostname: "127.0.0.1", port, path: "/micro-live/resolve-stale-accounting",
          method: "POST",
          headers: {
            ...(userId ? { "x-test-user-id": userId } : {}),
            "content-type": "application/json", "content-length": Buffer.byteLength(payload),
          },
        }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.end(payload);
      });
    assert.equal(await call(), 401);
    assert.equal(await call("other-user"), 403);
    assert.equal(await call("micro-live-test-admin", { ...body, resolutionReason: " " }), 400);
    assert.equal(await call("micro-live-test-admin", {
      ...body, expectedUnresolvedReason: "another_error",
    }), 400);
    // Even a valid admin request cannot reach exchange reads unless the
    // specifically recorded stale state and frozen primary binding exist.
    assert.equal(await call("micro-live-test-admin"), 409);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("isolated uncertain exit recovery link regression", async () => {
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "1";
  await db.update(microLiveConfigTable).set({
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
    manualKillSwitch: true,
    microLiveAccountMode: "exclusive",
    microLiveSelectedSubaccount: 1,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const id = randomUUID();
  const ticker = `KXBTC15M-RECOVERY-${id.slice(0, 12)}`;
  const exchangeId = `exchange-${id}`;
  await db.insert(microLiveOrderTable).values({
    id, actionKey: `recovery-action-${id}`, clientOrderId: `recovery-client-${id}`,
    marketTicker: ticker, crossingKey: `recovery-crossing-${id}`,
    triggerType: "EXIT", action: "sell", intent: "exit", exitPositionId: `position-${id}`,
    side: "UP", sourceEvaluationId: `evaluation-${id}`, signalAt: new Date(),
    requestedLimitPrice: 0.4, requestedContracts: 2, requestedStakeCents: 80,
    reservedRiskCents: 80, exchangeOrderId: null, status: "unknown",
    remainingContracts: 2, filledContracts: 0,
  });
  let cancellationCalls = 0;
  const result = await recoverAndCancelUncertainMicroLiveExit(id, "micro-live-test-admin", {
    readEvidence: async () => ({
      orders: [{
        id: exchangeId, clientOrderId: `recovery-client-${id}`, ticker,
        side: "yes", action: "sell", type: "limit", status: "resting",
        priceDollars: "0.4", initialCount: "2", filledCount: "0", remainingCount: "2",
      }],
      fills: [], historicalFills: [], historicalFillsAvailable: true, truncated: false,
    }),
    readAccount: async () => ({
      balance: { availableCashDollars: "100", portfolioValueDollars: "100" },
      openOrders: [{
        id: exchangeId, ticker, side: "yes", action: "sell",
        priceDollars: "0.4", remainingCount: "2", status: "resting",
        createdAt: new Date().toISOString(),
      }],
      positions: [], fills: [],
      truncated: { openOrders: false, positions: false, fills: false },
    }),
    cancelExit: async () => {
      cancellationCalls++;
      return { ready: false, reason: "exit_canceled_requires_manual_review" };
    },
  });
  assert.equal(result.status, "linked_and_cancel_checked", `actual result: ${JSON.stringify(result)}`);
  assert.equal(cancellationCalls, 1);
});
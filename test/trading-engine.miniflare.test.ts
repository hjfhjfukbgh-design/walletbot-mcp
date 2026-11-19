import { applyAdverseSlippage, applyEntrySlippage } from "../src/trading/positions";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";

const P = 100_000_000n;
const U = 1_000_000n;
const userId = "123456789";
type EngineStub = any;

describe("TradingEngine SQLite integration (Miniflare)", () => {
  let source = "";
  let root = "";
  let mf: Miniflare | undefined;
  let objectName = "engine-test-0";
  let testSequence = 0;

  beforeAll(async () => {
    root = ".mf-engine-test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const bundle = await build({ entryPoints: ["src/trading/engine.ts"], bundle: true, platform: "browser", format: "esm", write: false });
    source = bundle.outputFiles[0].text + "\nexport default { fetch() { return new Response('ok'); } };";
  });

  afterAll(async () => {
    await mf?.dispose();
  });

  beforeEach(async () => { await mf?.dispose(); mf = undefined; objectName = "engine-test-" + (++testSequence); });

  async function boot() {
    mf = new Miniflare({
      workers: [{
        config: {
          name: "engine-test",
          compatibilityDate: "2025-06-01",
          env: {
            ENGINE: { type: "durable-object", worker: "engine-test", exportName: "TradingEngine" },
            ENGINE_MAX_QUOTE_AGE_MS: { type: "text", value: "10000" },
            ENGINE_DISABLE_SOCKET: { type: "text", value: "true" },
          },
          exports: {
            TradingEngine: { type: "durable-object", storage: "sqlite" },
          },
          manifest: {
            mainModule: "engine.mjs",
            modules: {
              "engine.mjs": { type: "esm", contents: source },
            },
          },
        },
      }],
      resourcePersistencePath: root,
    });
    const ns = await mf.getDurableObjectNamespace("ENGINE");
    return ns.get(ns.idFromName(objectName));
  }

  async function post(stub: EngineStub, path: string, body: Record<string, unknown>) {
    const response = await stub.fetch("https://engine.test" + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  async function quote(stub: EngineStub, price: bigint) {
    return post(stub, "/quote", { symbol: "BTC", price: price.toString(), observedAt: Date.now() });
  }

  async function open(stub: EngineStub, marginMicro: bigint, limits = { maxOrderBps: "10000", maxTotalExposureBps: "10000", maxDailyLossBps: "500" }, forUser = userId) {
    return post(stub, "/open", {
      userId: forUser, mode: "demo", symbol: "BTC", side: "long",
      marginMicro: marginMicro.toString(), leverage: "2",
      takeProfitPrice: (52_000n * P).toString(), stopLossPrice: (49_000n * P).toString(),
      feePpm: "350", slippagePpm: "1000", ...limits,
    });
  }

  async function openWithoutStops(stub: EngineStub, marginMicro: bigint) {
    return post(stub, "/open", {
      userId, mode: "demo", symbol: "BTC", side: "long",
      marginMicro: marginMicro.toString(), leverage: "2",
      feePpm: "350", slippagePpm: "1000",
      maxOrderBps: "10000", maxTotalExposureBps: "10000", maxDailyLossBps: "500",
    });
  }

  it("keeps AI paper funds separate and transfers virtual DEMO balance atomically", async () => {
    const stub = await boot();
    const funded = await post(stub, "/ai/paper/fund", {
      userId, amountMicro: (100n * U).toString(), idempotencyKey: "fund-ai-001",
    });
    expect(funded.status).toBe(200);
    expect(funded.body).toMatchObject({
      ok: true, duplicate: false,
      demoBalanceMicro: (900n * U).toString(),
      aiBalanceMicro: (100n * U).toString(),
      status: "stopped", openPositions: 0,
    });
    const manual = await stub.fetch("https://engine.test/account?userId=" + userId);
    expect(await manual.json()).toMatchObject({ balanceMicro: (900n * U).toString(), positions: [] });
    const ai = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userId);
    expect(await ai.json()).toMatchObject({
      demoBalanceMicro: (900n * U).toString(), aiBalanceMicro: (100n * U).toString(),
    });
  });

  it("makes AI paper funding idempotent and rejects key reuse with a different amount", async () => {
    const stub = await boot();
    const first = await post(stub, "/ai/paper/fund", {
      userId, amountMicro: (100n * U).toString(), idempotencyKey: "fund-ai-repeat",
    });
    const duplicate = await post(stub, "/ai/paper/fund", {
      userId, amountMicro: (100n * U).toString(), idempotencyKey: "fund-ai-repeat",
    });
    expect(first.body.duplicate).toBe(false);
    expect(duplicate.body.duplicate).toBe(true);
    expect(duplicate.body.demoBalanceMicro).toBe((900n * U).toString());
    expect(duplicate.body.aiBalanceMicro).toBe((100n * U).toString());
    const conflict = await post(stub, "/ai/paper/fund", {
      userId, amountMicro: (200n * U).toString(), idempotencyKey: "fund-ai-repeat",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.ok).toBe(false);
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userId);
    expect(await status.json()).toMatchObject({
      demoBalanceMicro: (900n * U).toString(), aiBalanceMicro: (100n * U).toString(),
    });
  });

  it("rejects insufficient virtual funding without creating an AI balance", async () => {
    const stub = await boot();
    const result = await post(stub, "/ai/paper/fund", {
      userId, amountMicro: (1_001n * U).toString(), idempotencyKey: "fund-ai-too-much",
    });
    expect(result.status).toBe(409);
    expect(result.body.ok).toBe(false);
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userId);
    expect(await status.json()).toMatchObject({
      demoBalanceMicro: (1_000n * U).toString(), aiBalanceMicro: "0",
    });
  });

  it("serializes concurrent AI funding and isolates users", async () => {
    const stub = await boot();
    const concurrent = await Promise.all([
      post(stub, "/ai/paper/fund", { userId, amountMicro: (600n * U).toString(), idempotencyKey: "fund-ai-concurrent-a" }),
      post(stub, "/ai/paper/fund", { userId, amountMicro: (600n * U).toString(), idempotencyKey: "fund-ai-concurrent-b" }),
    ]);
    expect(concurrent.filter(x => x.body.ok === true)).toHaveLength(1);
    expect(concurrent.filter(x => x.status === 409)).toHaveLength(1);
    const other = await post(stub, "/ai/paper/fund", {
      userId: "987654321", amountMicro: (200n * U).toString(), idempotencyKey: "fund-ai-other-user",
    });
    expect(other.body.ok).toBe(true);
    const firstStatus = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userId);
    const secondStatus = await stub.fetch("https://engine.test/ai/paper/status?userId=987654321");
    expect(await firstStatus.json()).toMatchObject({ demoBalanceMicro: (400n * U).toString(), aiBalanceMicro: (600n * U).toString() });
    expect(await secondStatus.json()).toMatchObject({ demoBalanceMicro: (800n * U).toString(), aiBalanceMicro: (200n * U).toString() });
  });

  it("returns AI paper funds to DEMO atomically and idempotently with signed ledger retries", async () => {
    const stub = await boot();
    const funded = await post(stub, "/ai/paper/fund", {
      userId, amountMicro: (100n * U).toString(), idempotencyKey: "fund-for-withdraw",
    });
    expect(funded.status).toBe(200);
    const withdrawn = await post(stub, "/ai/paper/withdraw", {
      userId, amountMicro: (40n * U).toString(), idempotencyKey: "withdraw-ai-001",
    });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body).toMatchObject({
      ok: true, duplicate: false,
      demoBalanceMicro: (940n * U).toString(),
      aiBalanceMicro: (60n * U).toString(),
    });
    const duplicate = await post(stub, "/ai/paper/withdraw", {
      userId, amountMicro: (40n * U).toString(), idempotencyKey: "withdraw-ai-001",
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);
    expect(duplicate.body.demoBalanceMicro).toBe((940n * U).toString());
    expect(duplicate.body.aiBalanceMicro).toBe((60n * U).toString());
    const conflict = await post(stub, "/ai/paper/withdraw", {
      userId, amountMicro: (50n * U).toString(), idempotencyKey: "withdraw-ai-001",
    });
    expect(conflict.status).toBe(409);
  });

  it("rejects AI withdrawal beyond available AI paper balance", async () => {
    const stub = await boot();
    await post(stub, "/ai/paper/fund", {
      userId, amountMicro: (25n * U).toString(), idempotencyKey: "fund-small-ai",
    });
    const withdrawn = await post(stub, "/ai/paper/withdraw", {
      userId, amountMicro: (26n * U).toString(), idempotencyKey: "withdraw-too-much",
    });
    expect(withdrawn.status).toBe(409);
    expect(withdrawn.body.ok).toBe(false);
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userId);
    expect(await status.json()).toMatchObject({
      demoBalanceMicro: (975n * U).toString(), aiBalanceMicro: (25n * U).toString(),
    });
  });

  it("does not allow a funding idempotency key to be replayed as a withdrawal", async () => {
    const stub = await boot();
    await post(stub, "/ai/paper/fund", {
      userId, amountMicro: (100n * U).toString(), idempotencyKey: "same-ai-operation-key",
    });
    const withdrawn = await post(stub, "/ai/paper/withdraw", {
      userId, amountMicro: (100n * U).toString(), idempotencyKey: "same-ai-operation-key",
    });
    expect(withdrawn.status).toBe(409);
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userId);
    expect(await status.json()).toMatchObject({
      demoBalanceMicro: (900n * U).toString(), aiBalanceMicro: (100n * U).toString(),
    });
  });

  it("rejects stale quotes for both market updates and trade entry", async () => {
    const stub = await boot();
    const stale = await post(stub, "/quote", { symbol: "BTC", price: (50_000n * P).toString(), observedAt: Date.now() - 20_000 });
    expect(stale.body.ok).toBe(false);
    const opened = await open(stub, 100n * U);
    expect(opened.body.ok).toBe(false);
  });

  it("serializes Promise.all opens against one balance and prevents overspending", async () => {
    const stub = await boot();
    await quote(stub, 50_000n * P);
    const results = await Promise.all([open(stub, 700n * U), open(stub, 700n * U)]);
    expect(results.filter((r) => r.status === 200 && r.body.ok === true)).toHaveLength(1);
    expect(results.filter((r) => r.body.ok === false)).toHaveLength(1);
  });

  it("enforces total exposure atomically under concurrent opens and isolates users", async () => {
    const stub = await boot();
    await quote(stub, 50_000n * P);
    const limits = { maxOrderBps: "10000", maxTotalExposureBps: "500", maxDailyLossBps: "500" };
    const sameUser = await Promise.all([open(stub, 40n * U, limits), open(stub, 40n * U, limits)]);
    expect(sameUser.filter((r) => r.body.ok === true)).toHaveLength(1);
    expect(sameUser.filter((r) => r.body.ok === false)).toHaveLength(1);

    // A different Telegram user has an independent balance and exposure budget.
    const otherUser = await open(stub, 40n * U, limits, "987654321");
    expect(otherUser.body.ok).toBe(true);

    // Account isolation includes ownership of position IDs, not just balances.
    const firstUserAccount = await stub.fetch("https://engine.test/account?userId=" + userId);
    const firstUserState = await firstUserAccount.json() as { positions: Array<{ id: string }> };
    expect(firstUserState.positions).toHaveLength(1);
    const foreignPositionId = firstUserState.positions[0].id;
    const foreignClose = await post(stub, "/close", { userId: "987654321", positionId: foreignPositionId, manual: true });
    expect(foreignClose.body.ok).toBe(false);
    expect(String(foreignClose.body.error)).toContain("не найдена");
    const secondUserAccount = await stub.fetch("https://engine.test/account?userId=987654321");
    const secondUserState = await secondUserAccount.json() as { positions: Array<{ id: string }> };
    expect(secondUserState.positions).toHaveLength(1);
    expect(secondUserState.positions[0].id).not.toBe(foreignPositionId);
    const secondUserHistory = await stub.fetch("https://engine.test/history?userId=987654321");
    const secondUserHistoryBody = await secondUserHistory.json() as { trades: unknown[] };
    expect(secondUserHistoryBody.trades).toHaveLength(1);
  });

  it("isolates idempotency key between different users for POST /ai/paper/fund", async () => {
    const stub = await boot();
    const sharedKey = "shared-idempotency-key-001";
    const userA = "111111111";
    const userB = "222222222";

    // User A funds AI paper with sharedKey
    const fundA1 = await post(stub, "/ai/paper/fund", {
      userId: userA, amountMicro: (100n * U).toString(), idempotencyKey: sharedKey,
    });
    expect(fundA1.status).toBe(200);
    expect(fundA1.body.ok).toBe(true);
    expect(fundA1.body.duplicate).toBe(false);

    // User B funds AI paper with the same sharedKey (should succeed independently)
    const fundB1 = await post(stub, "/ai/paper/fund", {
      userId: userB, amountMicro: (200n * U).toString(), idempotencyKey: sharedKey,
    });
    expect(fundB1.status).toBe(200);
    expect(fundB1.body.ok).toBe(true);
    expect(fundB1.body.duplicate).toBe(false);

    // User A retries with the same sharedKey (should be a duplicate, no double funding)
    const fundA2 = await post(stub, "/ai/paper/fund", {
      userId: userA, amountMicro: (100n * U).toString(), idempotencyKey: sharedKey,
    });
    expect(fundA2.status).toBe(200);
    expect(fundA2.body.duplicate).toBe(true);

    // Verify both tenants retain independent balances and A was not funded twice.
    const statusA = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userA);
    expect(await statusA.json()).toMatchObject({
      demoBalanceMicro: (900n * U).toString(),
      aiBalanceMicro: (100n * U).toString(),
    });
    const statusB = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userB);
    expect(await statusB.json()).toMatchObject({
      demoBalanceMicro: (800n * U).toString(),
      aiBalanceMicro: (200n * U).toString(),
    });
  });

  it("scopes AI paper withdrawal idempotency keys to each Telegram user", async () => {
    const stub = await boot();
    const userA = "111111111";
    const userB = "222222222";
    const sharedFundKey = "cross-tenant-fund-001";
    const sharedWithdrawKey = "cross-tenant-withdraw-001";

    const fundA = await post(stub, "/ai/paper/fund", {
      userId: userA, amountMicro: (100n * U).toString(), idempotencyKey: sharedFundKey,
    });
    const fundB = await post(stub, "/ai/paper/fund", {
      userId: userB, amountMicro: (200n * U).toString(), idempotencyKey: sharedFundKey,
    });
    expect(fundA.status).toBe(200);
    expect(fundB.status).toBe(200);
    expect(fundA.body.duplicate).toBe(false);
    expect(fundB.body.duplicate).toBe(false);

    const withdrawA = await post(stub, "/ai/paper/withdraw", {
      userId: userA, amountMicro: (40n * U).toString(), idempotencyKey: sharedWithdrawKey,
    });
    const withdrawB = await post(stub, "/ai/paper/withdraw", {
      userId: userB, amountMicro: (80n * U).toString(), idempotencyKey: sharedWithdrawKey,
    });
    expect(withdrawA.status).toBe(200);
    expect(withdrawB.status).toBe(200);
    expect(withdrawA.body.duplicate).toBe(false);
    expect(withdrawB.body.duplicate).toBe(false);

    const retryA = await post(stub, "/ai/paper/withdraw", {
      userId: userA, amountMicro: (40n * U).toString(), idempotencyKey: sharedWithdrawKey,
    });
    const retryB = await post(stub, "/ai/paper/withdraw", {
      userId: userB, amountMicro: (80n * U).toString(), idempotencyKey: sharedWithdrawKey,
    });
    expect(retryA.body.duplicate).toBe(true);
    expect(retryB.body.duplicate).toBe(true);

    const statusA = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userA);
    const statusB = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userB);
    expect(await statusA.json()).toMatchObject({
      demoBalanceMicro: (940n * U).toString(), aiBalanceMicro: (60n * U).toString(),
    });
    expect(await statusB.json()).toMatchObject({
      demoBalanceMicro: (880n * U).toString(), aiBalanceMicro: (120n * U).toString(),
    });
  });

  it("rejects missing or invalid server-side risk limits", async () => {
    const stub = await boot();
    await quote(stub, 50_000n * P);
    const missing = await post(stub, "/open", {
      userId, mode: "demo", symbol: "BTC", side: "long",
      marginMicro: (40n * U).toString(), leverage: "2", feePpm: "350", slippagePpm: "1000",
    });
    expect(missing.body.ok).toBe(false);
    const invalid = await open(stub, 40n * U, { maxOrderBps: "10001", maxTotalExposureBps: "500", maxDailyLossBps: "500" });
    expect(invalid.body.ok).toBe(false);
  });

  it("blocks new and concurrent opens when today's open-position loss breaches the UTC daily stop", async () => {
    const stub = await boot();
    await quote(stub, 50_000n * P);
    const opened = await post(stub, "/open", {
      userId, mode: "demo", symbol: "BTC", side: "long",
      marginMicro: (300n * U).toString(), leverage: "2",
      feePpm: "350", slippagePpm: "1000",
      maxOrderBps: "10000", maxTotalExposureBps: "10000", maxDailyLossBps: "500",
    });
    expect(opened.body.ok).toBe(true);
    await quote(stub, 44_000n * P); // no TP/SL: loss remains unrealized and must still count
    const results = await Promise.all([openWithoutStops(stub, 10n * U), openWithoutStops(stub, 10n * U)]);
    expect(results.every((r) => r.body.ok === false)).toBe(true);
    expect(results.every((r) => String(r.body.error).includes("дневной лимит убытка"))).toBe(true);
    const account = await stub.fetch("https://engine.test/account?userId=" + userId);
    const state = await account.json() as { positions: Array<{ status: string }> };
    expect(state.positions).toHaveLength(1);
  });

  it("counts realized net losses closed during the current UTC day", async () => {
    const stub = await boot();
    await quote(stub, 50_000n * P);
    const opened = await post(stub, "/open", {
      userId, mode: "demo", symbol: "BTC", side: "long",
      marginMicro: (300n * U).toString(), leverage: "2",
      takeProfitPrice: null, stopLossPrice: null,
      feePpm: "350", slippagePpm: "1000",
      maxOrderBps: "10000", maxTotalExposureBps: "10000", maxDailyLossBps: "500",
    });
    expect(opened.body.ok).toBe(true);
    const id = opened.body.position.id as string;
    await quote(stub, 44_000n * P);
    const closed = await post(stub, "/close", { userId, positionId: id, manual: true });
    expect(closed.body.ok).toBe(true);
    const blocked = await openWithoutStops(stub, 10n * U);
    expect(blocked.body.ok).toBe(false);
    expect(String(blocked.body.error)).toContain("дневной лимит убытка");
  });

  it("automatically closes LONG and SHORT positions when take-profit targets are crossed", async () => {
    const stub = await boot();
    const openWithTargets = (side: "long" | "short", takeProfit: bigint, stopLoss: bigint) => post(stub, "/open", {
      userId, mode: "demo", symbol: "BTC", side,
      marginMicro: (100n * U).toString(), leverage: "2",
      takeProfitPrice: (takeProfit * P).toString(), stopLossPrice: (stopLoss * P).toString(),
      feePpm: "350", slippagePpm: "1000",
      maxOrderBps: "10000", maxTotalExposureBps: "10000", maxDailyLossBps: "500",
    });
    await quote(stub, 50_000n * P);
    const long = await openWithTargets("long", 52_000n, 49_000n);
    expect(long.body.ok).toBe(true);
    await quote(stub, 51_000n * P);
    let account = await stub.fetch("https://engine.test/account?userId=" + userId);
    expect((await account.json() as { positions: unknown[] }).positions).toHaveLength(1);
    await quote(stub, 52_000n * P);
    account = await stub.fetch("https://engine.test/account?userId=" + userId);
    expect((await account.json() as { positions: unknown[] }).positions).toHaveLength(0);

    await quote(stub, 50_000n * P);
    const short = await openWithTargets("short", 48_000n, 51_000n);
    expect(short.body.ok).toBe(true);
    await quote(stub, 48_000n * P);
    account = await stub.fetch("https://engine.test/account?userId=" + userId);
    expect((await account.json() as { positions: unknown[] }).positions).toHaveLength(0);
  });

  it("automatically closes SHORT positions when stop-loss is crossed", async () => {
    const stub = await boot();
    await quote(stub, 50_000n * P);
    const opened = await post(stub, "/open", {
      userId, mode: "demo", symbol: "BTC", side: "short",
      marginMicro: (100n * U).toString(), leverage: "2",
      takeProfitPrice: (48_000n * P).toString(), stopLossPrice: (51_000n * P).toString(),
      feePpm: "350", slippagePpm: "1000",
      maxOrderBps: "10000", maxTotalExposureBps: "10000", maxDailyLossBps: "500",
    });
    expect(opened.body.ok).toBe(true);
    await quote(stub, 51_000n * P);
    const account = await stub.fetch("https://engine.test/account?userId=" + userId);
    expect((await account.json() as { positions: unknown[] }).positions).toHaveLength(0);
  });

  it("allows a manual close before TP or SL is reached", async () => {
    const stub = await boot();
    await quote(stub, 50_000n * P);
    const opened = await post(stub, "/open", {
      userId, mode: "demo", symbol: "BTC", side: "long",
      marginMicro: (100n * U).toString(), leverage: "2",
      feePpm: "350", slippagePpm: "1000",
      maxOrderBps: "10000", maxTotalExposureBps: "10000", maxDailyLossBps: "500",
    });
    expect(opened.body.ok).toBe(true);
    const id = opened.body.position.id as string;
    const closed = await post(stub, "/close", { userId, positionId: id, manual: true });
    expect(closed.body.ok).toBe(true);
    expect(closed.body.closed).toBe(true);
    expect(closed.body.result.reason).toBe("manual");
  });

  it("closes once under Promise.all and duplicate ticks do not duplicate ledger credits", async () => {
    const stub = await boot();
    await quote(stub, 50_000n * P);
    const opened = await open(stub, 100n * U);
    const id = opened.body.position.id as string;
    const closes = await Promise.all([
      post(stub, "/close", { userId, positionId: id, manual: true }),
      post(stub, "/close", { userId, positionId: id, manual: true }),
    ]);
    expect(closes.every((r) => r.body.ok === true)).toBe(true);

    await quote(stub, 50_000n * P);
    await open(stub, 100n * U);
    await quote(stub, 48_000n * P); // SL crossed; fill uses this current gap quote
    await quote(stub, 48_000n * P); // duplicate tick must not credit again
    const audit = await post(stub, "/reconcile", {});
    expect(audit.body.openPositions).toBe(0);
    expect(audit.body.ledgerRows).toBe(5); // seed + 2 opens + 2 closes
  });

  it("rebuilds open positions from SQLite after Engine eviction/restart", async () => {
    let stub = await boot();
    await quote(stub, 50_000n * P);
    const opened = await open(stub, 100n * U);
    const id = opened.body.position.id as string;
    await mf?.dispose();
    mf = undefined;

    stub = await boot(); // new Miniflare isolate, same persisted DO SQLite
    const account = await stub.fetch("https://engine.test/account?userId=" + userId);
    const state = await account.json() as { positions: Array<{ id: string }> };
    expect(state.positions.map((p) => p.id)).toContain(id);
    const blocked = await post(stub, "/close", { userId, positionId: id, manual: true });
    expect(blocked.body.ok).toBe(false); // quote cache was lost with the old isolate
    await quote(stub, 48_000n * P);
    const after = await post(stub, "/reconcile", {});
    expect(after.body.openPositions).toBe(0);
  });

  it("atomically claims each LIVE handle once and persists final status", async () => {
    const stub = await boot();
    const handle = "a".repeat(32);
    const now = Date.now();
    const claimBody = {
      userId, handle, contractId: 0, symbol: "BTC", side: "long",
      leverage: 20, marginUsd: 25, notionalUsd: 500,
      previewAt: now, expiresAt: now + 120_000,
    };
    const claims = await Promise.all([
      post(stub, "/live/claim", claimBody),
      post(stub, "/live/claim", claimBody),
    ]);
    expect(claims.filter((r) => r.status === 200 && r.body.claimed === true)).toHaveLength(1);
    expect(claims.filter((r) => r.status === 409 && r.body.claimed === false)).toHaveLength(1);

    const finished = await post(stub, "/live/finish", {
      userId, handle, status: "completed", result: { orderId: "mock-order-1" },
    });
    expect(finished.body).toMatchObject({ ok: true, status: "completed" });

    const duplicate = await post(stub, "/live/claim", claimBody);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.status).toBe("completed");

    const status = await stub.fetch("https://engine.test/live/status?userId=" + userId + "&handle=" + handle);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      ok: true,
      operation: { handle, status: "completed", result: { orderId: "mock-order-1" } },
    });
  });

  it("isolates LIVE operation handles by user and rejects expired claims", async () => {
    const stub = await boot();
    const handle = "b".repeat(32);
    const now = Date.now();
    const body = {
      userId, handle, contractId: 7, symbol: "BTC", side: "short",
      leverage: 10, marginUsd: 10, notionalUsd: 100,
      previewAt: now, expiresAt: now + 120_000,
    };
    const claim = await post(stub, "/live/claim", body);
    expect(claim.body).toMatchObject({ ok: true, claimed: true });

    const otherUser = await stub.fetch("https://engine.test/live/status?userId=987654321&handle=" + handle);
    expect(otherUser.status).toBe(404);

    const expired = await post(stub, "/live/claim", {
      ...body, handle: "c".repeat(32), expiresAt: Date.now() - 1,
    });
    expect(expired.status).toBe(400);
  });


});


describe("DEMO execution price modelling", () => {
  const mid = 50_000n * P;
  const slip = 1_000n; // 0.1%

  it("applies adverse entry slippage in the direction of the opening order", () => {
    expect(applyEntrySlippage(mid, "long", slip)).toBe(50_050n * P);
    expect(applyEntrySlippage(mid, "short", slip)).toBe(49_950n * P);
  });

  it("applies adverse exit slippage in the direction of the closing order", () => {
    expect(applyAdverseSlippage(mid, "long", slip)).toBe(49_950n * P);
    expect(applyAdverseSlippage(mid, "short", slip)).toBe(50_050n * P);
  });

});

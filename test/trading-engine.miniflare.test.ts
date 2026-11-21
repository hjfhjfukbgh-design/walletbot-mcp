import { applyAdverseSlippage, applyEntrySlippage } from "../src/trading/positions";
import { ensureAiPaperDecisionColumns, parseFreshAiPaperMark } from "../src/trading/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";

const P = 100_000_000n;
const U = 1_000_000n;
const userId = "123456789";
type EngineStub = any;


describe("AI PAPER decision schema migration", () => {
  it("adds only columns missing from a legacy decisions table", () => {
    const statements: string[] = [];
    const sql = {
      exec(query: string) {
        statements.push(query);
        return { toArray: () => [{ name: "id" }, { name: "user_id" }, { name: "created_at" }] };
      },
    };
    ensureAiPaperDecisionColumns(sql);
    expect(statements).toEqual([
      "PRAGMA table_info(ai_paper_decisions)",
      "ALTER TABLE ai_paper_decisions ADD COLUMN snapshot_retrieved_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE ai_paper_decisions ADD COLUMN risk_evaluated INTEGER NOT NULL DEFAULT 0",
    ]);
  });

  it("does not alter a schema that already has both columns", () => {
    const statements: string[] = [];
    const sql = {
      exec(query: string) {
        statements.push(query);
        return { toArray: () => [{ name: "snapshot_retrieved_at" }, { name: "risk_evaluated" }] };
      },
    };
    ensureAiPaperDecisionColumns(sql);
    expect(statements).toEqual(["PRAGMA table_info(ai_paper_decisions)"]);
  });

  it("does not swallow schema inspection errors", () => {
    const sql = { exec() { throw new Error("sqlite unavailable"); } };
    expect(() => ensureAiPaperDecisionColumns(sql)).toThrow("sqlite unavailable");
  });
});

describe("TradingEngine SQLite integration (Miniflare)", () => {
  let source = "";
  let root = "";
  let mf: Miniflare | undefined;
  let objectName = "engine-test-0";
  let testSequence = 0;

  beforeAll(async () => {
    root = ".mf-engine-test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const bundle = await build({ entryPoints: ["src/trading/engine.ts"], bundle: true, platform: "browser", format: "esm", write: false });
    source = bundle.outputFiles[0].text + `
export class LegacySchemaTradingEngine extends TradingEngine {
  constructor(ctx, env) {
    ctx.storage.sql.exec("CREATE TABLE ai_paper_decisions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tick_id TEXT NOT NULL, strategy_id TEXT NOT NULL, strategy_version TEXT NOT NULL, market_snapshot_hash TEXT NOT NULL, symbol TEXT NOT NULL, signal TEXT NOT NULL, rationale TEXT NOT NULL, confidence REAL, observed_price TEXT NOT NULL, risk_pass INTEGER NOT NULL, rejection_reason TEXT, position_id TEXT, created_at INTEGER NOT NULL, UNIQUE(user_id, tick_id, symbol))");
    ctx.storage.sql.exec(
      "INSERT INTO ai_paper_decisions (id,user_id,tick_id,strategy_id,strategy_version,market_snapshot_hash,symbol,signal,rationale,confidence,observed_price,risk_pass,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "legacy-decision", "123456789", "legacy-tick", "ma-crossover", "1", "c".repeat(64),
      "BTC", "hold", "legacy row", 0.5, "50000", 1, 1234567890
    );
    super(ctx, env);
  }
}
export default { fetch() { return new Response('ok'); } };`;";
  });

  afterAll(async () => {
    await mf?.dispose();
  });

  beforeEach(async () => { await mf?.dispose(); mf = undefined; objectName = "engine-test-" + (++testSequence); });

  async function boot(envOverrides: Record<string, string> = {}, legacySchema = false) {
    mf = new Miniflare({
      workers: [{
        config: {
          name: "engine-test",
          compatibilityDate: "2025-06-01",
          env: {
            ENGINE: { type: "durable-object", worker: "engine-test", exportName: legacySchema ? "LegacySchemaTradingEngine" : "TradingEngine" },
            ENGINE_MAX_QUOTE_AGE_MS: { type: "text", value: "10000" },
            ENGINE_DISABLE_SOCKET: { type: "text", value: "true" },
            MAX_ORDER_PCT: { type: "text", value: "100" },
            MAX_TOTAL_EXPOSURE_PCT: { type: "text", value: "100" },
            MAX_DAILY_LOSS_PCT: { type: "text", value: "5" },
            STOP_LOSS_PCT: { type: "text", value: "5" },
            ALLOWED_MARKETS: { type: "text", value: "*" },
            ...Object.fromEntries(Object.entries(envOverrides).map(([key, value]) => [key, { type: "text", value }])),
          },
          exports: {
            [legacySchema ? "LegacySchemaTradingEngine" : "TradingEngine"]: { type: "durable-object", storage: "sqlite" },
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
    const requestBody = { ...body };
    if (requestBody.strategyId === "gemini-paper" && requestBody.snapshotPayload &&
        requestBody.skipSnapshotHash !== true) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(requestBody.snapshotPayload)));
      requestBody.marketSnapshotHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    delete requestBody.skipSnapshotHash;
    const response = await stub.fetch("https://engine.test" + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  async function claimGeminiDecision(stub: EngineStub, user: string, tickId: string) {
    const claim = await post(stub, "/ai/paper/decision/claim", { userId: user, tickId });
    expect(claim.status).toBe(200);
    const fencingToken = Number(claim.body.fencingToken);
    const started = await post(stub, "/ai/paper/decision/external-started", { userId: user, tickId, fencingToken });
    expect(started.status).toBe(200);
    return fencingToken;
  }

  async function startAiPaper(stub: EngineStub, user: string) {
    const started = await post(stub, "/ai/paper/session/start", { userId: user });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ ok: true, status: "active" });
  }

  async function quote(stub: EngineStub, price: bigint) {
    return post(stub, "/quote", { symbol: "BTC", price: price.toString(), observedAt: Date.now() });
  }

  async function paperDecision(stub: EngineStub, owner: string, symbol: string, signal: "buy" | "sell" | "hold", price: string, tick: string) {
    return post(stub, "/ai/paper/decision", {
      userId: owner, tickId: tick, strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "b".repeat(64), symbol, signal, rationale: "Validated server snapshot.",
      confidence: 0.8, observedPrice: price, riskPass: true,
    });
  }

  async function paperOpen(stub: EngineStub, owner: string, decisionId: string, symbol: string, side: "long" | "short", qty: string, entry: string, margin: bigint, key: string, fee = 0n, slip = 0n) {
    return post(stub, "/ai/paper/position/open", {
      userId: owner, decisionId, idempotencyKey: key, symbol, side,
      qtyUnits: qty, entryPrice: entry, marginMicro: margin.toString(),
      leverage: "2", feeMicro: fee.toString(), slippageMicro: slip.toString(),
    });
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

  it("stores AI paper decisions per tenant and makes same-tick retries idempotent", async () => {
    const stub = await boot();
    const base = {
      tickId: "tick-btc-0001",
      strategyId: "ma-crossover",
      strategyVersion: "1",
      marketSnapshotHash: "a".repeat(64),
      symbol: "BTC",
      signal: "buy",
      rationale: "Fast average crossed above slow average.",
      confidence: 0.82,
      observedPrice: "50000.00000000",
      riskPass: true,
    };
    const userA = "111111111";
    const userB = "222222222";
    const firstA = await post(stub, "/ai/paper/decision", { ...base, userId: userA });
    expect(firstA.status).toBe(201);
    expect(firstA.body).toMatchObject({ ok: true, duplicate: false });
    const retryA = await post(stub, "/ai/paper/decision", { ...base, userId: userA });
    expect(retryA.status).toBe(200);
    expect(retryA.body).toMatchObject({ ok: true, duplicate: true, id: firstA.body.id });
    const conflictA = await post(stub, "/ai/paper/decision", { ...base, userId: userA, signal: "hold" });
    expect(conflictA.status).toBe(409);

    const firstB = await post(stub, "/ai/paper/decision", { ...base, userId: userB });
    expect(firstB.status).toBe(201);
    expect(firstB.body).toMatchObject({ ok: true, duplicate: false });
    expect(firstB.body.id).not.toBe(firstA.body.id);

    const historyA = await stub.fetch("https://engine.test/ai/paper/decisions?userId=" + userA);
    const historyB = await stub.fetch("https://engine.test/ai/paper/decisions?userId=" + userB);
    const bodyA = await historyA.json() as { decisions: Array<{ id: string; userId?: string; tickId: string }> };
    const bodyB = await historyB.json() as { decisions: Array<{ id: string; tickId: string }> };
    expect(bodyA.decisions).toHaveLength(1);
    expect(bodyB.decisions).toHaveLength(1);
    expect(bodyA.decisions[0]).toMatchObject({ id: firstA.body.id, tickId: base.tickId });
    expect(bodyB.decisions[0]).toMatchObject({ id: firstB.body.id, tickId: base.tickId });
    expect(bodyA.decisions[0].id).not.toBe(bodyB.decisions[0].id);
  });

  it("rejects malformed AI paper decisions without inserting rows", async () => {
    const stub = await boot();
    const valid = {
      userId: "111111111", tickId: "tick-btc-0002", strategyId: "ma-crossover",
      strategyVersion: "1", marketSnapshotHash: "b".repeat(64), symbol: "BTC",
      signal: "buy", rationale: "Valid rationale", confidence: 0.5,
      observedPrice: "50000", riskPass: true,
    };
    const cases = [
      { ...valid, userId: "not-a-user" },
      { ...valid, signal: "short" },
      { ...valid, rationale: " " },
      { ...valid, confidence: 1.5 },
      { ...valid, observedPrice: "0" },
      { ...valid, riskPass: false, rejectionReason: "" },
    ];
    for (const input of cases) {
      const result = await post(stub, "/ai/paper/decision", input);
      expect(result.status).toBe(400);
      expect(result.body.ok).toBe(false);
    }
    const history = await stub.fetch("https://engine.test/ai/paper/decisions?userId=111111111");
    expect((await history.json() as { decisions: unknown[] }).decisions).toHaveLength(0);
  });

  it("claims AI paper runs once per tenant/tick and replays the completed ledger row", async () => {
    const stub = await boot();
    const userA = "777777771";
    const userB = "888888881";
    const tickId = "stable-tick-claim-001";
    const sameUserClaims = await Promise.all([
      post(stub, "/ai/paper/decision/claim", { userId: userA, tickId }),
      post(stub, "/ai/paper/decision/claim", { userId: userA, tickId }),
    ]);
    expect(sameUserClaims.map((result) => result.status).sort()).toEqual([200, 409]);
    const claimA = sameUserClaims.find((result) => result.status === 200)!;
    const concurrentRetry = sameUserClaims.find((result) => result.status === 409)!;
    expect(claimA.body).toMatchObject({ ok: true, state: "claimed" });
    expect(concurrentRetry.body.state).toBe("in_progress");

    const sameTickOtherUser = await post(stub, "/ai/paper/decision/claim", { userId: userB, tickId });
    expect(sameTickOtherUser.status).toBe(200);
    expect(sameTickOtherUser.body.state).toBe("claimed");

    const tokenA = Number(claimA.body.fencingToken);
    await post(stub, "/ai/paper/decision/external-started", { userId: userA, tickId, fencingToken: tokenA });
    const recordedAt = Date.now();
    const recorded = await post(stub, "/ai/paper/decision", {
      userId: userA, tickId, fencingToken: tokenA, strategyId: "gemini-paper", strategyVersion: "1",
      marketSnapshotHash: "d".repeat(64), symbol: "BTC", signal: "buy",
      rationale: "Stable request replay test.", confidence: 0.8, observedPrice: "50000", riskPass: false, riskEvaluated: false,
      snapshotRetrievedAt: recordedAt, snapshotPayload: { source: "hyperliquid-public", retrievedAt: recordedAt, markets: [{ symbol: "BTC", price: "50000", volume24hUsd: 50_000_000 }] },
    });
    expect(recorded.status).toBe(201);

    const lookup = await stub.fetch("https://engine.test/ai/paper/decision?userId=" + userA + "&tickId=" + tickId);
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({
      ok: true, state: "completed",
      decision: { tickId, symbol: "BTC", signal: "buy", rationale: "Stable request replay test." },
    });

    const replay = await post(stub, "/ai/paper/decision/claim", { userId: userA, tickId });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      ok: true, state: "completed",
      decision: {
        id: recorded.body.id, tickId,
        snapshotPayload: { source: "hyperliquid-public", markets: [{ symbol: "BTC", price: "50000", volume24hUsd: 50_000_000 }] },
      },
    });

    const tokenB = Number(sameTickOtherUser.body.fencingToken);
    await post(stub, "/ai/paper/decision/release", { userId: userB, tickId, fencingToken: tokenB });
    const retryOtherUser = await post(stub, "/ai/paper/decision/claim", { userId: userB, tickId });
    expect(retryOtherUser.status).toBe(200);
    expect(retryOtherUser.body.state).toBe("claimed");
    expect(Number(retryOtherUser.body.fencingToken)).toBeGreaterThan(tokenB);

    const userC = "999999991";
    const unknownTick = "provider-unknown-001";
    const claimC = await post(stub, "/ai/paper/decision/claim", { userId: userC, tickId: unknownTick });
    const tokenC = Number(claimC.body.fencingToken);
    await post(stub, "/ai/paper/decision/external-started", { userId: userC, tickId: unknownTick, fencingToken: tokenC });
    await post(stub, "/ai/paper/decision/unknown", { userId: userC, tickId: unknownTick, fencingToken: tokenC });
    const userD = "666666661";
    const fencingTick = "fencing-token-test-01";
    const firstClaim = await post(stub, "/ai/paper/decision/claim", { userId: userD, tickId: fencingTick });
    const firstToken = Number(firstClaim.body.fencingToken);
    await post(stub, "/ai/paper/decision/external-started", { userId: userD, tickId: fencingTick, fencingToken: firstToken });
    await post(stub, "/ai/paper/decision/release", { userId: userD, tickId: fencingTick, fencingToken: firstToken, safeToRetry: true });
    const secondClaim = await post(stub, "/ai/paper/decision/claim", { userId: userD, tickId: fencingTick });
    const secondToken = Number(secondClaim.body.fencingToken);
    expect(secondToken).toBeGreaterThan(firstToken);
    await post(stub, "/ai/paper/decision/external-started", { userId: userD, tickId: fencingTick, fencingToken: secondToken });
    const decisionAt = Date.now();
    const decisionBase = {
      userId: userD, tickId: fencingTick, strategyId: "gemini-paper", strategyVersion: "1",
      marketSnapshotHash: "e".repeat(64), symbol: "BTC", signal: "hold",
      rationale: "Fencing token test.", confidence: 0.5, observedPrice: "50000", riskPass: false, riskEvaluated: false,
      snapshotRetrievedAt: decisionAt, snapshotPayload: { source: "hyperliquid-public", retrievedAt: decisionAt, markets: [{ symbol: "BTC", price: "50000", volume24hUsd: 50_000_000 }] },
    };
    const staleFinalize = await post(stub, "/ai/paper/decision", { ...decisionBase, fencingToken: firstToken });
    expect(staleFinalize.status).toBe(409);
    const currentFinalize = await post(stub, "/ai/paper/decision", { ...decisionBase, fencingToken: secondToken });
    expect(currentFinalize.status).toBe(201);

    const unknownLookup = await stub.fetch("https://engine.test/ai/paper/decision?userId=" + userC + "&tickId=" + unknownTick);
    expect(unknownLookup.status).toBe(409);
    expect(await unknownLookup.json()).toMatchObject({ state: "external_outcome_unknown" });
    const unknownRetry = await post(stub, "/ai/paper/decision/claim", { userId: userC, tickId: unknownTick });
    expect(unknownRetry.status).toBe(409);
    expect(unknownRetry.body.state).toBe("external_outcome_unknown");
  });

  it("records only fresh non-future server observation timestamps for AI paper decisions", async () => {
    const stub = await boot();
    const owner = "777777771";
    const base = {
      userId: owner, strategyId: "gemini-paper", strategyVersion: "1",
      marketSnapshotHash: "c".repeat(64), symbol: "BTC", signal: "buy",
      rationale: "Server snapshot validated.", confidence: 0.8, observedPrice: "50000", riskPass: false, riskEvaluated: false,
    };
    const badHashTick = "tick-server-mark-bad-hash";
    const badHashToken = await claimGeminiDecision(stub, owner, badHashTick);
    const badHashPayload = { source: "hyperliquid-public", retrievedAt: Date.now(), markets: [{ symbol: "BTC", price: "50000", volume24hUsd: 50_000_000 }] };
    const badHash = await post(stub, "/ai/paper/decision", {
      ...base, tickId: badHashTick, fencingToken: badHashToken, marketSnapshotHash: "0".repeat(64),
      snapshotRetrievedAt: badHashPayload.retrievedAt, snapshotPayload: badHashPayload, skipSnapshotHash: true,
    });
    expect(badHash.status).toBe(400);
    await post(stub, "/ai/paper/decision/unknown", { userId: owner, tickId: badHashTick, fencingToken: badHashToken });

    const noClaimAt = Date.now();
    const noClaim = await post(stub, "/ai/paper/decision", {
      ...base, tickId: "tick-server-mark-no-claim", snapshotRetrievedAt: noClaimAt, snapshotPayload: { source: "hyperliquid-public", retrievedAt: noClaimAt, markets: [{ symbol: "BTC", price: "50000", volume24hUsd: 50_000_000 }] },
    });
    expect(noClaim.status).toBe(400);

    const staleTick = "tick-server-mark-stale";
    const staleToken = await claimGeminiDecision(stub, owner, staleTick);
    const staleAt = Date.now() - 10 * 60_000 - 1;
    const stale = await post(stub, "/ai/paper/decision", {
      ...base, tickId: staleTick, fencingToken: staleToken, snapshotRetrievedAt: staleAt, snapshotPayload: { source: "hyperliquid-public", retrievedAt: staleAt, markets: [{ symbol: "BTC", price: "50000", volume24hUsd: 50_000_000 }] },
    });
    expect(stale.status).toBe(400);
    await post(stub, "/ai/paper/decision/unknown", { userId: owner, tickId: staleTick, fencingToken: staleToken });

    const futureTick = "tick-server-mark-future";
    const futureToken = await claimGeminiDecision(stub, owner, futureTick);
    const futureAt = Date.now() + 5_000;
    const future = await post(stub, "/ai/paper/decision", {
      ...base, tickId: futureTick, fencingToken: futureToken, snapshotRetrievedAt: futureAt, snapshotPayload: { source: "hyperliquid-public", retrievedAt: futureAt, markets: [{ symbol: "BTC", price: "50000", volume24hUsd: 50_000_000 }] },
    });
    expect(future.status).toBe(400);
    await post(stub, "/ai/paper/decision/unknown", { userId: owner, tickId: futureTick, fencingToken: futureToken });

    const freshAt = Date.now();
    const freshTick = "tick-server-mark-fresh";
    const freshToken = await claimGeminiDecision(stub, owner, freshTick);
    const fresh = await post(stub, "/ai/paper/decision", {
      ...base, tickId: freshTick, fencingToken: freshToken, snapshotRetrievedAt: freshAt, snapshotPayload: { source: "hyperliquid-public", retrievedAt: freshAt, markets: [{ symbol: "BTC", price: "50000", volume24hUsd: 50_000_000 }] },
    });
    expect(fresh.status).toBe(201);
    const decisions = await stub.fetch("https://engine.test/ai/paper/decisions?userId=" + owner);
    const body = await decisions.json() as { decisions: Array<{ createdAt: number; snapshotRetrievedAt: number | null; riskPass: boolean; riskEvaluated: boolean; snapshotPayload: unknown }> };
    expect(body.decisions[0].snapshotRetrievedAt).toBe(freshAt);
    expect(body.decisions[0].riskPass).toBe(false);
    expect(body.decisions[0].riskEvaluated).toBe(false);
    expect(body.decisions[0].snapshotPayload).toEqual({ source: "hyperliquid-public", retrievedAt: freshAt, markets: [{ symbol: "BTC", price: "50000", volume24hUsd: 50_000_000 }] });
    expect(body.decisions[0].createdAt).toBeGreaterThanOrEqual(freshAt);
    const savedSnapshot = { source: "hyperliquid-public", retrievedAt: freshAt, markets: [{ symbol: "BTC", price: "50000", volume24hUsd: 50_000_000 }] };
    const retry = await post(stub, "/ai/paper/decision", {
      ...base, tickId: freshTick, fencingToken: freshToken, snapshotRetrievedAt: freshAt, snapshotPayload: savedSnapshot,
    });
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    const replay = await stub.fetch("https://engine.test/ai/paper/decision?userId=" + owner + "&tickId=" + freshTick);
    const replayBody = await replay.json() as { state: string; decision: { snapshotPayload: unknown } };
    expect(replayBody.state).toBe("completed");
    expect(replayBody.decision.snapshotPayload).toEqual(savedSnapshot);
    const alteredReplay = await post(stub, "/ai/paper/decision", {
      ...base, tickId: freshTick, fencingToken: freshToken, snapshotRetrievedAt: freshAt,
      snapshotPayload: { ...savedSnapshot, markets: [{ symbol: "BTC", price: "50000", volume24hUsd: 50_000_001 }] },
    });
    expect(alteredReplay.status).toBe(409);
  });

  it("bounds AI paper decision history queries", async () => {
    const stub = await boot();
    const response = await stub.fetch("https://engine.test/ai/paper/decisions?userId=111111111&limit=1000");
    expect(response.status).toBe(400);
  });

  it("opens AI paper positions atomically per tenant and links approved decisions", async () => {
    const stub = await boot({ MAX_DAILY_LOSS_PCT: "10" });
    const userA = "111111111";
    const userB = "222222222";
    const sharedKey = "ai-paper-open-shared-001";
    await post(stub, "/ai/paper/fund", { userId: userA, amountMicro: (100n * U).toString(), idempotencyKey: "fund-position-user-a" });
    await post(stub, "/ai/paper/fund", { userId: userB, amountMicro: (100n * U).toString(), idempotencyKey: "fund-position-user-b" });
    const decisionBase = {
      tickId: "tick-position-0001", strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "c".repeat(64), symbol: "BTC", signal: "buy",
      rationale: "Fast average crossed above slow average.", confidence: 0.8,
      observedPrice: "50000", riskPass: true,
    };
    await startAiPaper(stub, userA);
    await startAiPaper(stub, userB);
    const decisionA = await post(stub, "/ai/paper/decision", { ...decisionBase, userId: userA });
    const decisionB = await post(stub, "/ai/paper/decision", { ...decisionBase, userId: userB });
    const positionBase = {
      decisionId: decisionA.body.id, idempotencyKey: sharedKey, symbol: "BTC", side: "long",
      qtyUnits: "0.01", entryPrice: "50000", marginMicro: (25n * U).toString(),
      leverage: "2", feeMicro: U.toString(), slippageMicro: U.toString(),
    };
    const openedA = await post(stub, "/ai/paper/position/open", { ...positionBase, userId: userA });
    expect(openedA.status).toBe(201);
    expect(openedA.body).toMatchObject({ ok: true, duplicate: false, balanceMicro: (73n * U).toString() });
    const retryA = await post(stub, "/ai/paper/position/open", { ...positionBase, userId: userA });
    expect(retryA.status).toBe(200);
    expect(retryA.body).toMatchObject({ ok: true, duplicate: true, positionId: openedA.body.positionId });
    const alternateDecision = await post(stub, "/ai/paper/decision", {
      ...decisionBase, userId: userA, tickId: "tick-btc-alternate-02",
    });
    const keyConflict = await post(stub, "/ai/paper/position/open", {
      ...positionBase, userId: userA, decisionId: alternateDecision.body.id,
    });
    expect(keyConflict.status).toBe(409);

    const openedB = await post(stub, "/ai/paper/position/open", {
      ...positionBase, userId: userB, decisionId: decisionB.body.id,
      marginMicro: (40n * U).toString(), feeMicro: (2n * U).toString(),
    });
    expect(openedB.status).toBe(201);
    expect(openedB.body).toMatchObject({ ok: true, duplicate: false, balanceMicro: (57n * U).toString() });
    expect(openedB.body.positionId).not.toBe(openedA.body.positionId);

    const historyA = await stub.fetch("https://engine.test/ai/paper/positions?userId=" + userA);
    const historyB = await stub.fetch("https://engine.test/ai/paper/positions?userId=" + userB);
    const rowsA = await historyA.json() as { positions: Array<{ id: string; user_id: string; status: string }> };
    const rowsB = await historyB.json() as { positions: Array<{ id: string; status: string }> };
    expect(rowsA.positions).toHaveLength(1);
    expect(rowsB.positions).toHaveLength(1);
    expect(rowsA.positions[0]).toMatchObject({ id: openedA.body.positionId, status: "open" });
    expect(rowsA.positions[0]).not.toHaveProperty("user_id");
    expect(rowsB.positions[0].id).toBe(openedB.body.positionId);
    const statusA = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userA);
    const statusB = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userB);
    expect(await statusA.json()).toMatchObject({ aiBalanceMicro: (73n * U).toString(), openPositions: 1 });
    expect(await statusB.json()).toMatchObject({ aiBalanceMicro: (57n * U).toString(), openPositions: 1 });
  });

  it("rejects foreign or risk-rejected AI paper decisions and insufficient position reserves", async () => {
    const stub = await boot();
    const userA = "111111111";
    const userB = "222222222";
    await post(stub, "/ai/paper/fund", { userId: userA, amountMicro: (10n * U).toString(), idempotencyKey: "fund-position-small" });
    await startAiPaper(stub, userA);
    const decision = await post(stub, "/ai/paper/decision", {
      userId: userA, tickId: "tick-position-0002", strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "d".repeat(64), symbol: "ETH", signal: "buy", rationale: "Signal approved.",
      confidence: 0.7, observedPrice: "3000", riskPass: true,
    });
    const foreign = await post(stub, "/ai/paper/position/open", {
      userId: userB, decisionId: decision.body.id, idempotencyKey: "foreign-open-key",
      symbol: "ETH", side: "long", qtyUnits: "0.1", entryPrice: "3000",
      marginMicro: U.toString(), leverage: "2", feeMicro: "0", slippageMicro: "0",
    });
    expect(foreign.status).toBe(409);

    const insufficient = await post(stub, "/ai/paper/position/open", {
      userId: userA, decisionId: decision.body.id, idempotencyKey: "insufficient-open-key",
      symbol: "ETH", side: "long", qtyUnits: "0.1", entryPrice: "3000",
      marginMicro: (20n * U).toString(), leverage: "2", feeMicro: "0", slippageMicro: "0",
    });
    expect(insufficient.status).toBe(409);
    const positions = await stub.fetch("https://engine.test/ai/paper/positions?userId=" + userA);
    expect((await positions.json() as { positions: unknown[] }).positions).toHaveLength(0);
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userA);
    expect(await status.json()).toMatchObject({ aiBalanceMicro: (10n * U).toString(), openPositions: 0 });
  });

  it("enforces server-owned AI paper max-order reserve as a percentage of equity", async () => {
    const stub = await boot({ MAX_ORDER_PCT: "5" });
    const owner = "333333333";
    await post(stub, "/ai/paper/fund", { userId: owner, amountMicro: (100n * U).toString(), idempotencyKey: "fund-max-order-cap" });
    await startAiPaper(stub, owner);
    const decision = await post(stub, "/ai/paper/decision", {
      userId: owner, tickId: "tick-max-order-cap", strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "c".repeat(64), symbol: "BTC", signal: "buy", rationale: "Approved.",
      confidence: 0.8, observedPrice: "50000", riskPass: true,
    });
    const rejected = await post(stub, "/ai/paper/position/open", {
      userId: owner, decisionId: decision.body.id, idempotencyKey: "open-over-max-order",
      symbol: "BTC", side: "long", qtyUnits: "0.01", entryPrice: "50000",
      marginMicro: (6n * U).toString(), leverage: "2", feeMicro: "0", slippageMicro: "0",
    });
    expect(rejected.status).toBe(409);
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + owner);
    expect(await status.json()).toMatchObject({ aiBalanceMicro: (100n * U).toString(), openPositions: 0 });
    const positions = await stub.fetch("https://engine.test/ai/paper/positions?userId=" + owner);
    expect((await positions.json() as { positions: unknown[] }).positions).toHaveLength(0);

    const withinDecision = await post(stub, "/ai/paper/decision", {
      userId: owner, tickId: "tick-max-order-at-cap", strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "f".repeat(64), symbol: "BTC", signal: "buy", rationale: "At configured cap.",
      confidence: 0.8, observedPrice: "50000", riskPass: true,
    });
    const within = await post(stub, "/ai/paper/position/open", {
      userId: owner, decisionId: withinDecision.body.id, idempotencyKey: "open-at-max-order-cap",
      symbol: "BTC", side: "long", qtyUnits: "0.01", entryPrice: "50000",
      marginMicro: (5n * U).toString(), leverage: "2", feeMicro: "0", slippageMicro: "0",
    });
    expect(within.status).toBe(201);
  });

  it("atomically enforces aggregate AI paper exposure under concurrent opens", async () => {
    const stub = await boot({ MAX_TOTAL_EXPOSURE_PCT: "50" });
    const owner = "444444444";
    await post(stub, "/ai/paper/fund", { userId: owner, amountMicro: (100n * U).toString(), idempotencyKey: "fund-total-exposure-cap" });
    await startAiPaper(stub, owner);

    const btcDecision = await post(stub, "/ai/paper/decision", {
      userId: owner, tickId: "tick-total-exposure-btc", strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "d".repeat(64), symbol: "BTC", signal: "buy", rationale: "Approved.",
      confidence: 0.8, observedPrice: "50000", riskPass: true,
    });
    const ethDecision = await post(stub, "/ai/paper/decision", {
      userId: owner, tickId: "tick-total-exposure-eth", strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "e".repeat(64), symbol: "ETH", signal: "buy", rationale: "Approved.",
      confidence: 0.8, observedPrice: "2500", riskPass: true,
    });
    const results = await Promise.all([
      post(stub, "/ai/paper/position/open", {
        userId: owner, decisionId: btcDecision.body.id, idempotencyKey: "open-total-exposure-btc",
        symbol: "BTC", side: "long", qtyUnits: "0.01", entryPrice: "50000",
        marginMicro: (30n * U).toString(), leverage: "2", feeMicro: "0", slippageMicro: "0",
      }),
      post(stub, "/ai/paper/position/open", {
        userId: owner, decisionId: ethDecision.body.id, idempotencyKey: "open-total-exposure-eth",
        symbol: "ETH", side: "long", qtyUnits: "0.1", entryPrice: "2500",
        marginMicro: (30n * U).toString(), leverage: "2", feeMicro: "0", slippageMicro: "0",
      }),
    ]);
    expect(results.filter(result => result.status === 201)).toHaveLength(1);
    expect(results.filter(result => result.status === 409)).toHaveLength(1);
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + owner);
    expect(await status.json()).toMatchObject({ aiBalanceMicro: (70n * U).toString(), openPositions: 1 });
  });

  it("blocks new AI paper opens after UTC-day realized net loss breaches the server limit", async () => {
    const stub = await boot();
    const owner = "666666661";
    await post(stub, "/ai/paper/fund", { userId: owner, amountMicro: (100n * U).toString(), idempotencyKey: "fund-daily-realized-loss" });
    await startAiPaper(stub, owner);
    const btc = await paperDecision(stub, owner, "BTC", "buy", "50000", "tick-daily-realized-btc");
    const opened = await paperOpen(stub, owner, btc.body.id, "BTC", "long", "0.01", "50000", 25n * U, "open-daily-realized-btc", U, U);
    expect(opened.status).toBe(201);
    const closed = await post(stub, "/ai/paper/position/close", {
      userId: owner, positionId: opened.body.positionId, idempotencyKey: "close-daily-realized-btc",
      exitPrice: "40000", closeFeeMicro: "0", closeSlippageMicro: "0", fundingMicro: "0",
    });
    expect(closed.status).toBe(201);
    expect(BigInt(closed.body.close.netPnlMicro)).toBeLessThan(-5n * U);

    const eth = await paperDecision(stub, owner, "ETH", "buy", "2500", "tick-daily-realized-eth");
    const sol = await paperDecision(stub, owner, "SOL", "buy", "150", "tick-daily-realized-sol");
    const results = await Promise.all([
      paperOpen(stub, owner, eth.body.id, "ETH", "long", "0.1", "2500", U, "open-daily-realized-eth"),
      paperOpen(stub, owner, sol.body.id, "SOL", "long", "1", "150", U, "open-daily-realized-sol"),
    ]);
    expect(results.every(result => result.status === 409)).toBe(true);
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + owner);
    expect(await status.json()).toMatchObject({ aiBalanceMicro: (73n * U).toString(), openPositions: 0 });
  });

  it("includes fee-aware unrealized loss from every open symbol in the daily stop", async () => {
    const stub = await boot();
    const owner = "666666662";
    await post(stub, "/ai/paper/fund", { userId: owner, amountMicro: (100n * U).toString(), idempotencyKey: "fund-daily-unrealized-loss" });
    await startAiPaper(stub, owner);
    const btc = await paperDecision(stub, owner, "BTC", "buy", "50000", "tick-daily-unrealized-btc");
    const opened = await paperOpen(stub, owner, btc.body.id, "BTC", "long", "0.01", "50000", 25n * U, "open-daily-unrealized-btc", U, U);
    expect(opened.status).toBe(201);
    await new Promise(resolve => setTimeout(resolve, 5));
    const mark = await paperDecision(stub, owner, "BTC", "hold", "49700", "tick-daily-unrealized-btc-mark");
    expect(mark.status).toBe(201);
    const eth = await paperDecision(stub, owner, "ETH", "buy", "2500", "tick-daily-unrealized-eth");
    const rejected = await paperOpen(stub, owner, eth.body.id, "ETH", "long", "0.1", "2500", U, "open-daily-unrealized-eth");
    expect(rejected.status).toBe(409);
    expect(String(rejected.body.error)).toContain("дневной лимит");
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + owner);
    expect(await status.json()).toMatchObject({ openPositions: 1 });
  });

  it.each([
    ["missing", () => undefined, (now: number) => now],
    ["malformed", () => "not-a-price", (now: number) => now],
    ["stale", () => "50000", (now: number) => now - 10 * 60_000 - 1],
    ["future", () => "50000", (now: number) => now + 2_000],
    ["zero", () => "0", (now: number) => now],
  ])("rejects %s AI paper marks", (_kind: string, price: () => unknown, timestamp: (now: number) => number) => {
    const now = Date.now();
    expect(parseFreshAiPaperMark(price(), timestamp(now), now)).toBeNull();
  });

  it("accepts a fresh positive AI paper decision mark using fixed-point arithmetic", () => {
    const now = Date.now();
    expect(parseFreshAiPaperMark("50000.125", now, now)).toBe(5_000_012_500_000n);
    expect(parseFreshAiPaperMark("50000", now - 10 * 60_000, now)).toBe(5_000_000_000_000n);
    expect(parseFreshAiPaperMark("50000", now + 1, now)).toBeNull();
  });

  it("allows AI paper leverage up to 10 and rejects higher leverage without mutating the virtual account", async () => {
    const stub = await boot();
    const owner = "111111111";
    await post(stub, "/ai/paper/fund", { userId: owner, amountMicro: (100n * U).toString(), idempotencyKey: "fund-max-leverage-01" });
    await startAiPaper(stub, owner);
    const decision = await post(stub, "/ai/paper/decision", {
      userId: owner, tickId: "tick-max-leverage-01", strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "a".repeat(64), symbol: "BTC", signal: "buy", rationale: "Approved.",
      confidence: 0.8, observedPrice: "50000", riskPass: true,
    });
    const rejected = await post(stub, "/ai/paper/position/open", {
      userId: owner, decisionId: decision.body.id, idempotencyKey: "open-max-leverage-01",
      symbol: "BTC", side: "long", qtyUnits: "0.01", entryPrice: "50000",
      marginMicro: (10n * U).toString(), leverage: "11", feeMicro: "0", slippageMicro: "0",
    });
    expect(rejected.status).toBe(400);
    const statusAfterReject = await stub.fetch("https://engine.test/ai/paper/status?userId=" + owner);
    expect(await statusAfterReject.json()).toMatchObject({ aiBalanceMicro: (100n * U).toString(), openPositions: 0 });
    const positionsAfterReject = await stub.fetch("https://engine.test/ai/paper/positions?userId=" + owner);
    expect((await positionsAfterReject.json() as { positions: unknown[] }).positions).toHaveLength(0);

    const maxDecision = await post(stub, "/ai/paper/decision", {
      userId: owner, tickId: "tick-max-leverage-10", strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "b".repeat(64), symbol: "BTC", signal: "buy", rationale: "Approved at max leverage.",
      confidence: 0.8, observedPrice: "50000", riskPass: true,
    });
    const accepted = await post(stub, "/ai/paper/position/open", {
      userId: owner, decisionId: maxDecision.body.id, idempotencyKey: "open-max-leverage-10",
      symbol: "BTC", side: "long", qtyUnits: "0.02", entryPrice: "50000",
      marginMicro: (10n * U).toString(), leverage: "10", feeMicro: "0", slippageMicro: "0",
    });
    expect(accepted.status).toBe(201);
    const statusAtMax = await stub.fetch("https://engine.test/ai/paper/status?userId=" + owner);
    expect(await statusAtMax.json()).toMatchObject({ aiBalanceMicro: (90n * U).toString(), openPositions: 1 });
  });

  it("atomically caps AI paper accounts at three open positions under concurrent requests", async () => {
    const stub = await boot();
    const owner = "222222222";
    await post(stub, "/ai/paper/fund", { userId: owner, amountMicro: (100n * U).toString(), idempotencyKey: "fund-three-position-cap" });
    await startAiPaper(stub, owner);
    const symbols = ["BTC", "ETH", "SOL", "XRP"];
    const results = await Promise.all(symbols.map(async (symbol, index) => {
      const decision = await post(stub, "/ai/paper/decision", {
        userId: owner, tickId: "tick-three-cap-" + index, strategyId: "ma-crossover", strategyVersion: "1",
        marketSnapshotHash: String(index + 1).repeat(64), symbol, signal: "buy", rationale: "Approved.",
        confidence: 0.8, observedPrice: "100", riskPass: true,
      });
      return post(stub, "/ai/paper/position/open", {
        userId: owner, decisionId: decision.body.id, idempotencyKey: "open-three-cap-" + index,
        symbol, side: "long", qtyUnits: "1", entryPrice: "100",
        marginMicro: (10n * U).toString(), leverage: "2", feeMicro: "0", slippageMicro: "0",
      });
    }));
    expect(results.filter(result => result.status === 201)).toHaveLength(3);
    expect(results.filter(result => result.status === 409)).toHaveLength(1);
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + owner);
    expect(await status.json()).toMatchObject({ aiBalanceMicro: (70n * U).toString(), openPositions: 3 });
    const positions = await stub.fetch("https://engine.test/ai/paper/positions?userId=" + owner);
    expect((await positions.json() as { positions: unknown[] }).positions).toHaveLength(3);
  });

  it("prevents a second open AI paper position for the same tenant and symbol", async () => {
    const stub = await boot();
    const userId = "111111111";
    await post(stub, "/ai/paper/fund", { userId, amountMicro: (100n * U).toString(), idempotencyKey: "fund-one-position" });
    const makeDecision = (tickId: string) => post(stub, "/ai/paper/decision", {
      userId, tickId, strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "e".repeat(64), symbol: "SOL", signal: "buy",
      rationale: "Signal approved.", confidence: 0.7, observedPrice: "150", riskPass: true,
    });
    await startAiPaper(stub, userId);
    const d1 = await makeDecision("tick-position-sol-01");
    const d2 = await makeDecision("tick-position-sol-02");
    const base = {
      userId, symbol: "SOL", side: "long", qtyUnits: "1", entryPrice: "150",
      marginMicro: (20n * U).toString(), leverage: "2", feeMicro: "0", slippageMicro: "0",
    };
    const first = await post(stub, "/ai/paper/position/open", { ...base, decisionId: d1.body.id, idempotencyKey: "sol-open-first" });
    expect(first.status).toBe(201);
    const second = await post(stub, "/ai/paper/position/open", { ...base, decisionId: d2.body.id, idempotencyKey: "sol-open-second" });
    expect(second.status).toBe(409);
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userId);
    expect(await status.json()).toMatchObject({ aiBalanceMicro: (80n * U).toString(), openPositions: 1 });
  });

  it("settles profitable AI paper LONG positions with fees, slippage and funding exactly once", async () => {
    const stub = await boot();
    const userId = "111111111";
    await post(stub, "/ai/paper/fund", { userId, amountMicro: (100n * U).toString(), idempotencyKey: "fund-close-long-01" });
    await startAiPaper(stub, userId);
    const decision = await post(stub, "/ai/paper/decision", {
      userId, tickId: "tick-close-long-01", strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "f".repeat(64), symbol: "BTC", signal: "buy", rationale: "Approved long.",
      confidence: 0.9, observedPrice: "50000", riskPass: true,
    });
    const opened = await post(stub, "/ai/paper/position/open", {
      userId, decisionId: decision.body.id, idempotencyKey: "open-close-long-01",
      symbol: "BTC", side: "long", qtyUnits: "0.01", entryPrice: "50000",
      marginMicro: (25n * U).toString(), leverage: "2", feeMicro: U.toString(), slippageMicro: U.toString(),
    });
    const closeInput = {
      userId, positionId: opened.body.positionId, idempotencyKey: "close-long-01",
      exitPrice: "51000", closeFeeMicro: "500000", closeSlippageMicro: "250000", fundingMicro: "100000",
    };
    const closed = await post(stub, "/ai/paper/position/close", closeInput);
    expect(closed.status).toBe(201);
    expect(closed.body.close).toMatchObject({
      grossPnlMicro: (10n * U).toString(), payoutMicro: (34_150_000n).toString(),
      netPnlMicro: (7_150_000n).toString(), closeFeeMicro: "500000",
      closeSlippageMicro: "250000", fundingMicro: "100000",
    });
    const retry = await post(stub, "/ai/paper/position/close", closeInput);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ duplicate: true, close: closed.body.close });
    const conflict = await post(stub, "/ai/paper/position/close", { ...closeInput, exitPrice: "52000" });
    expect(conflict.status).toBe(409);
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userId);
    expect(await status.json()).toMatchObject({ aiBalanceMicro: (107_150_000n).toString(), openPositions: 0 });
    const positions = await stub.fetch("https://engine.test/ai/paper/positions?userId=" + userId + "&status=closed");
    expect((await positions.json() as { positions: Array<{ status: string; close_json: string }> }).positions[0].status).toBe("closed");
  });

  it("settles losing AI paper SHORT positions and caps payout at zero", async () => {
    const stub = await boot({ MAX_DAILY_LOSS_PCT: "10" });
    const userId = "222222222";
    await post(stub, "/ai/paper/fund", { userId, amountMicro: (50n * U).toString(), idempotencyKey: "fund-close-short-01" });
    await startAiPaper(stub, userId);
    const decision = await post(stub, "/ai/paper/decision", {
      userId, tickId: "tick-close-short-01", strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "1".repeat(64), symbol: "ETH", signal: "sell", rationale: "Approved short.",
      confidence: 0.75, observedPrice: "3000", riskPass: true,
    });
    const opened = await post(stub, "/ai/paper/position/open", {
      userId, decisionId: decision.body.id, idempotencyKey: "open-close-short-01",
      symbol: "ETH", side: "short", qtyUnits: "0.1", entryPrice: "3000",
      marginMicro: (10n * U).toString(), leverage: "2", feeMicro: U.toString(), slippageMicro: U.toString(),
    });
    const closed = await post(stub, "/ai/paper/position/close", {
      userId, positionId: opened.body.positionId, idempotencyKey: "close-short-01",
      exitPrice: "4000", closeFeeMicro: "0", closeSlippageMicro: "0", fundingMicro: "0",
    });
    expect(closed.status).toBe(201);
    expect(closed.body.close).toMatchObject({
      grossPnlMicro: (-100n * U).toString(), payoutMicro: "0",
      netPnlMicro: (-12n * U).toString(),
    });
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userId);
    expect(await status.json()).toMatchObject({ aiBalanceMicro: (38n * U).toString(), openPositions: 0 });
  });

  it("prevents foreign users from closing AI paper positions and rejects second close keys", async () => {
    const stub = await boot();
    const owner = "333333333";
    const stranger = "444444444";
    await post(stub, "/ai/paper/fund", { userId: owner, amountMicro: (20n * U).toString(), idempotencyKey: "fund-close-owner" });
    await startAiPaper(stub, owner);
    const decision = await post(stub, "/ai/paper/decision", {
      userId: owner, tickId: "tick-close-owner-01", strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "2".repeat(64), symbol: "SOL", signal: "buy", rationale: "Approved long.",
      confidence: 0.7, observedPrice: "150", riskPass: true,
    });
    const opened = await post(stub, "/ai/paper/position/open", {
      userId: owner, decisionId: decision.body.id, idempotencyKey: "open-close-owner",
      symbol: "SOL", side: "long", qtyUnits: "1", entryPrice: "150",
      marginMicro: (10n * U).toString(), leverage: "2", feeMicro: "0", slippageMicro: "0",
    });
    const foreign = await post(stub, "/ai/paper/position/close", {
      userId: stranger, positionId: opened.body.positionId, idempotencyKey: "foreign-close-key",
      exitPrice: "160", closeFeeMicro: "0", closeSlippageMicro: "0", fundingMicro: "0",
    });
    expect(foreign.status).toBe(404);
    const firstClose = await post(stub, "/ai/paper/position/close", {
      userId: owner, positionId: opened.body.positionId, idempotencyKey: "owner-close-first",
      exitPrice: "160", closeFeeMicro: "0", closeSlippageMicro: "0", fundingMicro: "0",
    });
    expect(firstClose.status).toBe(201);
    const secondClose = await post(stub, "/ai/paper/position/close", {
      userId: owner, positionId: opened.body.positionId, idempotencyKey: "owner-close-second",
      exitPrice: "160", closeFeeMicro: "0", closeSlippageMicro: "0", fundingMicro: "0",
    });
    expect(secondClose.status).toBe(409);
  });

  it("requires explicit AI paper session start and stops new opens without auto-closing", async () => {
    const stub = await boot();
    const userId = "555555555";
    const otherUser = "666666666";
    const zeroUser = "777777777";
    const missing = await post(stub, "/ai/paper/session/start", { userId });
    expect(missing.status).toBe(404);
    await post(stub, "/ai/paper/fund", { userId: zeroUser, amountMicro: (10n * U).toString(), idempotencyKey: "fund-zero-session-01" });
    await post(stub, "/ai/paper/withdraw", { userId: zeroUser, amountMicro: (10n * U).toString(), idempotencyKey: "withdraw-zero-session-01" });
    expect((await post(stub, "/ai/paper/session/start", { userId: zeroUser })).status).toBe(409);
    await post(stub, "/ai/paper/fund", { userId, amountMicro: (50n * U).toString(), idempotencyKey: "fund-session-start-01" });
    await post(stub, "/ai/paper/fund", { userId: otherUser, amountMicro: (20n * U).toString(), idempotencyKey: "fund-session-other-01" });
    await startAiPaper(stub, otherUser);
    const stopped = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userId);
    expect(await stopped.json()).toMatchObject({ status: "stopped", aiBalanceMicro: (50n * U).toString() });

    const decision = await post(stub, "/ai/paper/decision", {
      userId, tickId: "tick-session-open-01", strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "3".repeat(64), symbol: "BTC", signal: "buy",
      rationale: "Approved long.", confidence: 0.8, observedPrice: "50000", riskPass: true,
    });
    const openInput = {
      userId, decisionId: decision.body.id, idempotencyKey: "open-session-01",
      symbol: "BTC", side: "long", qtyUnits: "0.01", entryPrice: "50000",
      marginMicro: (10n * U).toString(), leverage: "2", feeMicro: "0", slippageMicro: "0",
    };
    expect((await post(stub, "/ai/paper/position/open", openInput)).status).toBe(409);
    await startAiPaper(stub, userId);
    const opened = await post(stub, "/ai/paper/position/open", openInput);
    expect(opened.status).toBe(201);

    const stoppedSession = await post(stub, "/ai/paper/session/stop", { userId });
    expect(stoppedSession.body).toMatchObject({ ok: true, status: "stopped", openPositions: 1 });
    const status = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userId);
    expect(await status.json()).toMatchObject({ status: "stopped", openPositions: 1 });
    const otherStatus = await stub.fetch("https://engine.test/ai/paper/status?userId=" + otherUser);
    expect(await otherStatus.json()).toMatchObject({ status: "active", aiBalanceMicro: (20n * U).toString() });

    const anotherDecision = await post(stub, "/ai/paper/decision", {
      userId, tickId: "tick-session-open-02", strategyId: "ma-crossover", strategyVersion: "1",
      marketSnapshotHash: "4".repeat(64), symbol: "ETH", signal: "buy",
      rationale: "Another approved long.", confidence: 0.8, observedPrice: "3000", riskPass: true,
    });
    const blockedOpen = await post(stub, "/ai/paper/position/open", {
      ...openInput, decisionId: anotherDecision.body.id, idempotencyKey: "open-session-02", symbol: "ETH", entryPrice: "3000",
    });
    expect(blockedOpen.status).toBe(409);

    const closed = await post(stub, "/ai/paper/position/close", {
      userId, positionId: opened.body.positionId, idempotencyKey: "close-while-stopped-01",
      exitPrice: "51000", closeFeeMicro: "0", closeSlippageMicro: "0", fundingMicro: "0",
    });
    expect(closed.status).toBe(201);
    const finalStatus = await stub.fetch("https://engine.test/ai/paper/status?userId=" + userId);
    expect(await finalStatus.json()).toMatchObject({ status: "stopped", openPositions: 0 });
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

  it("upgrades a persisted legacy AI PAPER decisions table and preserves its rows", async () => {
    // A test-only Durable Object subclass seeds the old schema before the
    // TradingEngine constructor runs its normal production migration.
    const stub = await boot({}, true);
    const response = await stub.fetch("https://engine.test/account?userId=" + userId);
    expect(response.status).toBe(200);

    const history = await stub.fetch("https://engine.test/ai/paper/decisions?userId=" + userId);
    expect(history.status).toBe(200);
    const body = await history.json() as { decisions: Array<{
      id: string; tickId: string; snapshotRetrievedAt: number | null; riskEvaluated: boolean;
      signal: string; rationale: string;
    }> };
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0]).toMatchObject({
      id: "legacy-decision",
      tickId: "legacy-tick",
      snapshotRetrievedAt: 0,
      riskEvaluated: false,
      signal: "hold",
      rationale: "legacy row",
    });
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

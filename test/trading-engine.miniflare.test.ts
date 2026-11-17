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

  async function open(stub: EngineStub, marginMicro: bigint, limits = { maxOrderBps: "10000", maxTotalExposureBps: "10000" }, forUser = userId) {
    return post(stub, "/open", {
      userId: forUser, mode: "demo", symbol: "BTC", side: "long",
      marginMicro: marginMicro.toString(), leverage: "2",
      takeProfitPrice: (52_000n * P).toString(), stopLossPrice: (49_000n * P).toString(),
      feePpm: "350", slippagePpm: "1000", ...limits,
    });
  }

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
    const limits = { maxOrderBps: "10000", maxTotalExposureBps: "500" };
    const sameUser = await Promise.all([open(stub, 40n * U, limits), open(stub, 40n * U, limits)]);
    expect(sameUser.filter((r) => r.body.ok === true)).toHaveLength(1);
    expect(sameUser.filter((r) => r.body.ok === false)).toHaveLength(1);

    // A different Telegram user has an independent balance and exposure budget.
    const otherUser = await open(stub, 40n * U, limits, "987654321");
    expect(otherUser.body.ok).toBe(true);
  });

  it("rejects missing or invalid server-side risk limits", async () => {
    const stub = await boot();
    await quote(stub, 50_000n * P);
    const missing = await post(stub, "/open", {
      userId, mode: "demo", symbol: "BTC", side: "long",
      marginMicro: (40n * U).toString(), leverage: "2", feePpm: "350", slippagePpm: "1000",
    });
    expect(missing.body.ok).toBe(false);
    const invalid = await open(stub, 40n * U, { maxOrderBps: "10001", maxTotalExposureBps: "500" });
    expect(invalid.body.ok).toBe(false);
  });

  it("allows a manual close before TP or SL is reached", async () => {
    const stub = await boot();
    await quote(stub, 50_000n * P);
    const opened = await post(stub, "/open", {
      userId, mode: "demo", symbol: "BTC", side: "long",
      marginMicro: (100n * U).toString(), leverage: "2",
      feePpm: "350", slippagePpm: "1000",
      maxOrderBps: "10000", maxTotalExposureBps: "10000",
    });
    expect(opened.body.ok).toBe(true);
    const id = opened.body.position.id as string;
    const closed = await post(stub, "/close", { userId, positionId: id, manual: true });
    expect(closed.body.ok).toBe(true);
    expect(closed.body.closed).toBe(true);
    expect(closed.body.result.reason).toBe("manual");
  });

  it("persists closed LONG and SHORT results in per-user history across Engine restart", async () => {
    let stub = await boot();
    const initialAccountResponse = await stub.fetch("https://engine.test/account?userId=" + userId);
    const initialBalance = (await initialAccountResponse.json() as { balanceMicro: string }).balanceMicro;
    await quote(stub, 50_000n * P);
    const long = await open(stub, 100n * U);
    expect(long.body.ok).toBe(true);
    const short = await post(stub, "/open", {
      userId, mode: "demo", symbol: "BTC", side: "short",
      marginMicro: (100n * U).toString(), leverage: "2",
      feePpm: "350", slippagePpm: "1000",
      maxOrderBps: "10000", maxTotalExposureBps: "10000",
    });
    expect(short.body.ok).toBe(true);
    const openAccountResponse = await stub.fetch("https://engine.test/account?userId=" + userId);
    const openAccount = await openAccountResponse.json() as { balanceMicro: string; positions: Array<{ id: string }> };
    expect(openAccount.positions).toHaveLength(2);
    expect(BigInt(openAccount.balanceMicro)).toBeLessThan(BigInt(initialBalance));
    await quote(stub, 51_000n * P);
    const longClose = await post(stub, "/close", { userId, positionId: long.body.position.id, manual: true });
    const shortClose = await post(stub, "/close", { userId, positionId: short.body.position.id, manual: true });
    expect(BigInt(longClose.body.result.netPnlMicro)).toBeGreaterThan(0n);
    expect(BigInt(shortClose.body.result.netPnlMicro)).toBeLessThan(0n);
    expect(BigInt(longClose.body.result.totalNetPnlMicro)).toBe(
      BigInt(longClose.body.result.netPnlMicro) - BigInt(long.body.position.entryFeeMicro),
    );
    expect(BigInt(shortClose.body.result.totalNetPnlMicro)).toBe(
      BigInt(shortClose.body.result.netPnlMicro) - BigInt(short.body.position.entryFeeMicro),
    );

    const first = await stub.fetch("https://engine.test/history?userId=" + userId);
    const history = await first.json() as { trades: Array<{ event: string; side: string; pnl?: number }>; equity: Array<[number, number]> };
    expect(history.trades).toHaveLength(4);
    expect(history.trades.filter((item) => item.event === "open")).toHaveLength(2);
    expect(history.trades.filter((item) => item.event === "close")).toHaveLength(2);
    expect(history.trades.filter((item) => item.event === "close").map((item) => item.side).sort()).toEqual(["long", "short"]);
    expect(history.equity.length).toBeGreaterThanOrEqual(5);
    expect(history.equity.every(([at, balance]) => Number.isFinite(at) && Number.isFinite(balance))).toBe(true);
    expect(history.equity[0][1]).toBe(1000);
    expect(history.equity[history.equity.length - 1][1]).toBe(Number(BigInt(balanceBeforeRestart)) / 1_000_000);
    const balance = await stub.fetch("https://engine.test/account?userId=" + userId);
    const closedAccount = await balance.json() as { balanceMicro: string; positions: Array<{ id: string }> };
    const balanceBeforeRestart = closedAccount.balanceMicro;
    expect(closedAccount.positions).toHaveLength(0);
    const expectedBalance = BigInt(initialBalance)
      + BigInt(longClose.body.result.totalNetPnlMicro)
      + BigInt(shortClose.body.result.totalNetPnlMicro);
    expect(BigInt(balanceBeforeRestart)).toBe(expectedBalance);
    const reconciliation = await post(stub, "/reconcile", {});
    expect(reconciliation.body.ok).toBe(true);
    expect(balanceBeforeRestart).not.toBe(initialBalance);

    await mf?.dispose();
    mf = undefined;
    stub = await boot();
    const afterRestart = await stub.fetch("https://engine.test/history?userId=" + userId);
    const restored = await afterRestart.json() as { trades: Array<{ event: string }> };
    expect(restored.trades).toHaveLength(4);
    const accountAfterRestart = await stub.fetch("https://engine.test/account?userId=" + userId);
    expect((await accountAfterRestart.json() as { balanceMicro: string }).balanceMicro).toBe(balanceBeforeRestart);
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

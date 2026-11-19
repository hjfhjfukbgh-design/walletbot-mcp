import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../miniapp/web/kripto-guru-api.js", import.meta.url), "utf8");

function loadApi(fetchMock, initData = "signed-telegram-init-data") {
  const window = { Telegram: { WebApp: { initData } } };
  runInNewContext(source, { window, fetch: fetchMock, Response, AbortController, setTimeout, clearTimeout });
  return window.KriptoGuruAPI;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

describe("window.KriptoGuruAPI contract", () => {
  it("exposes a DOM-independent API and normalizes the DEMO wallet account", async () => {
    const fetchMock = vi.fn(async (input, init) => {
      expect(String(input)).toBe("/api/demo");
      expect(init.headers).toMatchObject({ Authorization: "tma signed-telegram-init-data" });
      return json({ ok: true, balanceMicro: "1255500000", positions: [{
        id: "p1", symbol: "BTC", side: "long", status: "open", leverage: "3",
        marginMicro: "100000000", entryNotionalMicro: "300000000",
        entryPrice: "5000000000000", qtyUnits: "600000", entryFeeMicro: "105000",
        liquidationPrice: "3400000000000", takeProfitPrice: null, stopLossPrice: null,
        markPriceUsd: 51000, unrealizedGrossPnlMicro: "6000000", estimatedExitFeeMicro: "107100", estimatedNetPnlMicro: "5787900", markObservedAt: 123456,
      }] });
    });
    const api = loadApi(fetchMock);
    const account = await api.wallet.get();
    expect(api.version).toBe("1.0.0");
    expect(account).toMatchObject({ mode: "demo", balanceUsd: 1255.5, balanceMicro: "1255500000" });
    expect(account.positions[0]).toMatchObject({
      id: "p1", side: "long", marginUsd: 100, notionalUsd: 300,
      entryPriceUsd: 50000, entryFeeUsd: 0.105, liquidationPriceUsd: 34000,
      markPriceUsd: 51000, unrealizedGrossPnlUsd: 6, estimatedExitFeeUsd: 0.1071,
      estimatedNetPnlUsd: 5.7879, markObservedAt: 123456,
    });
  });

  it("keeps LIVE unavailable when Walt readiness is incomplete while preserving unsupported markets", async () => {
    const fetchMock = vi.fn(async (input) => {
      expect(String(input)).toBe("/api/live/status");
      return json({ ok: true, connected: false, readiness: { available: false, ok: false }, contracts: { available: false, count: 0 }, balance: { available: false, usd: null }, issues: [{ code: "not_connected", description: "Walt не подключён." }] });
    });
    const api = loadApi(fetchMock);
    const stocks = await api.markets.list({ category: "stocks" });
    const capabilities = await api.capabilities.get();
    expect(stocks).toMatchObject({ available: false, markets: [] });
    expect(capabilities.live).toMatchObject({ available: false, reason: "Walt не подключён.", balanceUsd: null });
    expect(capabilities.stocks.available).toBe(false);
    expect(capabilities.funds.available).toBe(false);
    expect(capabilities.ipo.available).toBe(false);
    expect(capabilities.bonuses.available).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });


  it("normalizes live market metadata into the Russian UI contract and caps demo leverage", async () => {
    const contract = {
      market: "BTC", name: "BTC-USDC", price: 50000, change24hPct: 2.5,
      volume24hUsd: 5000000, fundingRateHourly: 0.0001, takerFeePct: 0.00035,
      maxLeverage: 50, minSizeQuote: 10, allowed: true, liquid: true,
    };
    const fetchMock = vi.fn(async (input) => {
      if (String(input) === "/api/contracts") return json({ ok: true, contracts: [contract] });
      if (String(input).startsWith("/api/price?market=BTC")) {
        return json({ ok: true, price: 50000, maxDemoLeverage: 3, minMargin: 10 });
      }
      throw new Error("Unexpected request: " + String(input));
    });
    const api = loadApi(fetchMock);
    const list = await api.markets.list({ category: "futures" });
    expect(list.markets[0]).toMatchObject({
      symbol: "BTC", priceUsd: 50000, fundingRateHourlyPct: 0.01,
      takerFeePct: 0.035, tradeable: true,
    });
    const detail = await api.market.get("BTC");
    expect(detail).toMatchObject({
      symbol: "BTC", priceUsd: 50000, productType: "Фьючерс",
      maxLeverage: 3, minMarginUsd: 10, takerFeePct: 0.035,
      fundingRateHourlyPct: 0.01, tradeable: true,
    });
  });

  it("uses server preview for max margin and estimated fees", async () => {
    const fetchMock = vi.fn(async (_input, init) => {
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({
        symbol: "BTC", side: "short", leverage: 5, marginMicro: "25000000",
      });
      return json({
        ok: true, symbol: "BTC", side: "short", priceUsd: 50000, leverage: 5,
        marginUsd: 25, maxMarginUsd: 80, volumeUsd: 125, entryFeeUsd: 0.04375,
        estimatedExitFeeUsd: 0.04375, liquidationPriceUsd: 59900, tradeable: true,
      });
    });
    const api = loadApi(fetchMock);
    const preview = await api.trade.preview({ symbol: "BTC", side: "short", marginUsd: 25, leverage: 5 });
    expect(preview).toMatchObject({ maxMarginUsd: 80, volumeUsd: 125, entryFeeUsd: 0.04375, tradeable: true });
  });

  it("marks an otherwise successful preview unavailable when server risk limits reject its size", async () => {
    const fetchMock = vi.fn(async () => json({
      ok: true, symbol: "BTC", side: "long", priceUsd: 50000, leverage: 3,
      marginUsd: 1, maxMarginUsd: 0, volumeUsd: 3, entryFeeUsd: 0.00105,
      estimatedExitFeeUsd: 0.00105, liquidationPriceUsd: 33500,
      tradeable: false, reason: "Лимит демо-счёта не позволяет открыть позицию минимального размера.",
    }));
    const api = loadApi(fetchMock);
    const preview = await api.trade.preview({ symbol: "BTC", side: "long", marginUsd: 1, leverage: 3 });
    expect(preview).toMatchObject({
      valid: false, available: false, tradeable: false,
      reason: "Лимит демо-счёта не позволяет открыть позицию минимального размера.",
    });
  });

  it("opens and closes only through authenticated DEMO endpoints", async () => {
    const fetchMock = vi.fn(async (input, init) => {
      if (String(input) === "/api/demo/open") {
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toMatchObject({
          symbol: "ETH", side: "long", marginMicro: "12500000", leverage: 2,
          takeProfitPrice: "27000000000", stopLossPrice: null,
        });
        return json({ ok: true, balanceMicro: "987500000", position: {
          id: "p2", symbol: "ETH", side: "long", status: "open", leverage: "2",
          marginMicro: "12500000", entryNotionalMicro: "25000000",
          entryPrice: "25000000000", qtyUnits: "1000", entryFeeMicro: "8750",
          liquidationPrice: "12500000000", takeProfitPrice: "27000000000", stopLossPrice: null,
        } });
      }
      expect(String(input)).toBe("/api/demo/close");
      expect(JSON.parse(String(init.body))).toEqual({ positionId: "p2", manual: true });
      return json({ ok: true, closed: true, result: { totalNetPnlMicro: "125000" } });
    });
    const api = loadApi(fetchMock);
    const opened = await api.trade.open({ symbol: "ETH", side: "long", marginUsd: 12.5, leverage: 2, takeProfitUsd: 270 });
    expect(opened.position).toMatchObject({ id: "p2", marginUsd: 12.5, entryPriceUsd: 250 });
    const closed = await api.trade.close("p2");
    expect(closed).toMatchObject({ closed: true, result: { totalNetPnlMicro: "125000" } });
  });

  it("exposes LIVE status, position, preview and operation routes with encoded query values", async () => {
    const calls = [];
    const fetchMock = vi.fn(async (input, init = {}) => {
      calls.push({ url: String(input), method: init.method || "GET", body: init.body ? JSON.parse(String(init.body)) : null });
      if (String(input) === "/api/live/status") return json({ ok: true, connected: true, readiness: { available: true, ok: true }, contracts: { available: true, count: 12 }, balance: { available: true, usd: 250 }, issues: [] });
      if (String(input) === "/api/live/position?symbol=BTC%2FUSDT") return json({ ok: true, position: null });
      if (String(input) === "/api/live/preview") return json({ ok: true, handle: "live-handle-1", risk: { liquidationPriceUsd: 42000 }, warnings: [] });
      if (String(input) === "/api/live/operation?handle=live%2Fhandle%3F1") return json({ ok: true, status: "pending" });
      throw new Error("Unexpected request: " + String(input));
    });
    const api = loadApi(fetchMock);
    const status = await api.live.status();
    const position = await api.live.position("btc/usdt");
    const preview = await api.live.preview({ symbol: "btc/usdt", side: "long", marginUsd: 25, leverage: 4 });
    const operation = await api.live.operation("live/handle?1");
    expect(status.connected).toBe(true);
    expect(position.position).toBe(null);
    expect(preview.handle).toBe("live-handle-1");
    expect(operation.status).toBe("pending");
    expect(calls).toEqual([
      { url: "/api/live/status", method: "GET", body: null },
      { url: "/api/live/position?symbol=BTC%2FUSDT", method: "GET", body: null },
      { url: "/api/live/preview", method: "POST", body: { symbol: "BTC/USDT", side: "long", marginUsd: 25, leverage: 4 } },
      { url: "/api/live/operation?handle=live%2Fhandle%3F1", method: "GET", body: null },
    ]);
  });

  it("exposes virtual AI paper funding and withdrawal with idempotency keys", async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, balanceMicro: "150000000", demoBalanceMicro: "850000000" }));
    const api = loadApi(fetchMock);
    await api.aiPaper.fund({ amountUsd: "25.50", idempotencyKey: "fund-test-key-0001" });
    await api.aiPaper.withdraw({ amountUsd: "10", idempotencyKey: "withdraw-test-key-01" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/ai/paper/fund", expect.objectContaining({
      method: "POST", body: JSON.stringify({ amountUsd: "25.50", idempotencyKey: "fund-test-key-0001" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/ai/paper/withdraw", expect.objectContaining({
      method: "POST", body: JSON.stringify({ amountUsd: "10", idempotencyKey: "withdraw-test-key-01" }),
    }));
  });
  it("requires explicit confirmation before a LIVE execute request", async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, status: "completed" }));
    const api = loadApi(fetchMock);
    await expect(api.live.execute({ handle: "live-handle-1", confirm: false })).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED", status: 400, retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await api.live.execute({ handle: "live-handle-1", confirm: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/live/execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ handle: "live-handle-1", confirm: true });
  });

  it("enables LIVE capability only when every readiness component is available", async () => {
    const fetchMock = vi.fn(async () => json({
      ok: true, connected: true, readiness: { available: true, ok: true },
      contracts: { available: true, count: 12 }, balance: { available: true, usd: 250 }, issues: [],
    }));
    const api = loadApi(fetchMock);
    const capabilities = await api.capabilities.get();
    expect(capabilities.live).toMatchObject({ available: true, balanceUsd: 250, issues: [] });
  });

  it("normalizes history close events and keeps exact raw payloads", async () => {
    const fetchMock = vi.fn(async () => json({
      ok: true,
      trades: [{ id: "p1:close", event: "close", at: 1234, market: "BTC", side: "short", price: 49000, pnl: 12.3456, reason: "manual", mode: "paper" }],
      equity: [[1000, 1000], [1234, 1012.3456]],
    }));
    const api = loadApi(fetchMock);
    const result = await api.history.list();
    expect(result.events[0]).toMatchObject({
      event: "close", timestamp: "01.01.1970, 00:00:01", symbol: "BTC", side: "short", netPnlUsd: 12.3456, mode: "demo",
    });
    expect(result.equity).toEqual([{ timestamp: 1000, balanceUsd: 1000 }, { timestamp: 1234, balanceUsd: 1012.3456 }]);
  });

  it("returns one normalized error shape for missing Telegram auth and server errors", async () => {
    const noAuth = loadApi(vi.fn(), "");
    await expect(noAuth.wallet.get()).rejects.toMatchObject({
      name: "KriptoGuruApiError", code: "TELEGRAM_AUTH_REQUIRED", status: 401, retryable: false,
    });
    const failed = loadApi(vi.fn(async () => json({ ok: false, error: "Котировка недоступна." }, 503)));
    await expect(failed.wallet.get()).rejects.toMatchObject({
      name: "KriptoGuruApiError", code: "API_ERROR", status: 503, retryable: true,
    });
  });
});

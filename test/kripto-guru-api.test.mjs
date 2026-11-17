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
    expect(account).toMatchObject({ mode: "demo", balanceUsd: 1255.5, balanceMicro: "1255000000" });
    expect(account.positions[0]).toMatchObject({
      id: "p1", side: "long", marginUsd: 100, notionalUsd: 300,
      entryPriceUsd: 50000, entryFeeUsd: 0.105, liquidationPriceUsd: 34000,
      markPriceUsd: 51000, unrealizedGrossPnlUsd: 6, estimatedExitFeeUsd: 0.1071,
      estimatedNetPnlUsd: 5.7879, markObservedAt: 123456,
    });
  });

  it("returns explicit unavailable states instead of inventing stocks, funds or bonuses", async () => {
    const fetchMock = vi.fn();
    const api = loadApi(fetchMock);
    const stocks = await api.markets.list({ category: "stocks" });
    const capabilities = await api.capabilities.get();
    expect(stocks).toMatchObject({ available: false, markets: [] });
    expect(capabilities.live.available).toBe(false);
    expect(capabilities.stocks.available).toBe(false);
    expect(capabilities.funds.available).toBe(false);
    expect(capabilities.ipo.available).toBe(false);
    expect(capabilities.bonuses.available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("normalizes history close events and keeps exact raw payloads", async () => {
    const fetchMock = vi.fn(async () => json({
      ok: true,
      trades: [{ id: "p1:close", event: "close", at: 1234, market: "BTC", side: "short", price: 49000, pnl: 12.3456, reason: "manual", mode: "paper" }],
      equity: [[1000, 1000], [1234, 1012.3456]],
    }));
    const api = loadApi(fetchMock);
    const result = await api.history.list();
    expect(result.events[0]).toMatchObject({
      event: "close", timestamp: 1234, symbol: "BTC", side: "short", netPnlUsd: 12.3456, mode: "demo",
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

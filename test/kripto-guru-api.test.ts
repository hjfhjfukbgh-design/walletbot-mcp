import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync("miniapp/web/kripto-guru-api.js", "utf8");

function boot(fetchMock: ReturnType<typeof vi.fn>) {
  const events: string[] = [];
  const window = {
    Telegram: { WebApp: { initData: "signed-telegram-init-data" } },
    dispatchEvent: (event: { type: string }) => events.push(event.type),
  };
  runInNewContext(source, {
    window,
    fetch: fetchMock,
    URLSearchParams,
    Event: class { type: string; constructor(type: string) { this.type = type; } },
    BigInt, Date, Number, Math, Map, Promise, Error, Object, String, Array, Set,
  });
  return { api: (window as unknown as { KriptoGuruAPI: any }).KriptoGuruAPI, events };
}

const contract = {
  market: "BTC",
  name: "BTC-USDC",
  price: 100,
  change24hPct: 2.5,
  volume24hUsd: 5_000_000,
  fundingRateHourly: 0.00001,
  takerFeePct: 0.00035,
  maxLeverage: 10,
  minSizeQuote: 10,
  maxSizeQuote: 1_000_000,
  allowed: true,
  liquid: true,
};

function response(data: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => data };
}

describe("Kripto Guru browser DEMO API bridge", () => {
  it("loads market list and chart using signed Telegram initData", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/contracts") return response({ ok: true, contracts: [contract] });
      if (url.startsWith("/api/chart?")) return response({ ok: true, source: "hyperliquid", candles: [[1, 99, 101, 98, 100]] });
      throw new Error("Unexpected request: " + url);
    });
    const { api, events } = boot(fetchMock);
    const markets = await api.markets.list({ category: "crypto" });
    const chart = await api.market.candles("BTC", "15m");
    expect(markets.markets[0]).toMatchObject({ symbol: "BTC", priceUsd: 100, tradeable: true });
    expect(chart.candles).toHaveLength(1);
    expect(events).toContain("kripto-guru-api-ready");
    expect(fetchMock.mock.calls.every((call) => (call[1] as RequestInit).headers && ((call[1] as RequestInit).headers as Record<string,string>).Authorization === "tma signed-telegram-init-data")).toBe(true);
  });

  it("previews and opens only a server-validated DEMO order with fixed-point margin", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/contracts") return response({ ok: true, contracts: [contract] });
      if (url.startsWith("/api/price?")) return response({ ok: true, market: "BTC", price: 100, maxDemoLeverage: 3, minMargin: 3.34 });
      if (url === "/api/demo") return response({ ok: true, balanceMicro: "1000000000", positions: [] });
      if (url === "/api/demo/open" && init?.method === "POST") return response({ ok: true, position: { id: "p1" } });
      throw new Error("Unexpected request: " + url);
    });
    const { api } = boot(fetchMock);
    const preview = await api.trade.preview({ symbol: "BTC", side: "short", marginUsd: 50, leverage: 2 });
    expect(preview).toMatchObject({ valid: true, side: "short", volumeUsd: 100, entryFeeUsd: 0.035 });
    await api.trade.open({ symbol: "BTC", side: "short", marginUsd: 50, leverage: 2, previewId: preview.previewId });
    const openCall = fetchMock.mock.calls.find((call) => call[0] === "/api/demo/open");
    expect(JSON.parse(String((openCall?.[1] as RequestInit).body))).toEqual({
      symbol: "BTC", side: "short", marginMicro: "50000000", leverage: 2
    });
  });

  it("closes a DEMO position by its position id and keeps LIVE capabilities disabled", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/demo/close") return response({ ok: true, closed: true });
      throw new Error("Unexpected request: " + url);
    });
    const { api } = boot(fetchMock);
    await api.trade.close("position-7");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ positionId: "position-7" });
    expect((await api.capabilities.get()).live.available).toBe(false);
  });
});

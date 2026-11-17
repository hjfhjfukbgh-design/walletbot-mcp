import { afterEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api";
import type { RiskLimits } from "../src/env";
import { MAX_PRICES, pushEquity, pushPrice } from "../src/history";
import { marketAllowed } from "../src/risk";
import { defaultState, saveState } from "../src/state";
import { minMargin } from "../src/strategy/grid";
import { env } from "./helpers";
import { tenantEnv } from "../src/tenants";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
async function signedInitData(botToken: string, userId: string): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: Number(userId), first_name: "Test" }),
  });
  const encoder = new TextEncoder();
  const hmac = async (keyBytes: Uint8Array, value: string) => {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  };
  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const hash = [...await hmac(secret, checkString)].map((value) => value.toString(16).padStart(2, "0")).join("");
  params.set("hash", hash);
  return params.toString();
}
const call = async (e: ReturnType<typeof env>, path: string, key?: string, init: RequestInit = {}, userId = "12345") => {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (key === "chave-teste" && userId) headers.Authorization = `tma ${await signedInitData(e.TELEGRAM_BOT_TOKEN, userId)}`;
  else if (key && key !== "chave-teste") headers.Authorization = `tma ${key}`;
  return handleApi(new Request(`https://w.dev/api/${path}`, { ...init, headers }), e, ctx);
};

describe("API da Mini App", () => {
  it("exige initData do Telegram assinada corretamente", async () => {
    const e = env();
    expect((await call(e, "state")).status).toBe(401);
    expect((await call(e, "state", "errada")).status).toBe(401);
    expect((await call(e, "state", "chave-teste")).status).toBe(200);
    expect((await call(e, "state", "chave-teste", {}, "")).status).toBe(401);
  });

  it("reports an unconnected Walt account without exposing another tenant", async () => {
    const response = await call(env(), "walt/account", "chave-teste");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining("Walt не подключён") });
  });

  it("reads the connected user's Walt balance through MCP without executing trades", async () => {
    const e = env();
    await e.STATE.put("tenant:12345:oauth:tokens", JSON.stringify({ access_token: "test-access-token" }));
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || "{}")) as { id?: number; method?: string; params?: { name?: string } };
      if (payload.method) methods.push(payload.method);
      if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (payload.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } } });
      }
      if (payload.method === "tools/call" && payload.params?.name === "balance_get") {
        return Response.json({ jsonrpc: "2.0", id: payload.id, result: { structuredContent: { balances: [{ asset: "USDC", available: "42.5" }] } } });
      }
      throw new Error("Unexpected Walt MCP request: " + JSON.stringify(payload));
    });
    const response = await call(e, "walt/account", "chave-teste");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, connected: true, balanceUsd: 42.5, currency: "USDC",
      source: "walt-mcp", permission: "read-only",
    });
    expect(methods).toContain("initialize");
    expect(methods).toContain("tools/call");
    expect(methods).not.toContain("perps_execute_operation");
  });

  it("reads only the requested Walt market position through MCP", async () => {
    const e = env();
    await e.STATE.put("tenant:12345:oauth:tokens", JSON.stringify({ access_token: "test-access-token" }));
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || "{}")) as { id?: number; method?: string; params?: { name?: string; arguments?: { contractId?: number } } };
      if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (payload.method === "initialize") return Response.json({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } } });
      if (payload.method === "tools/call") {
        const name = payload.params?.name || "";
        calls.push(name);
        if (name === "perps_list_contracts") {
          return Response.json({ jsonrpc: "2.0", id: payload.id, result: { structuredContent: { contracts: [{
            contract_id: 7, contract_name: "BTC-USDC", price_decimals: 2, min_size_base: 0.001,
            min_size_quote: 10, max_size_quote: 1000000, max_leverage: 20,
            taker_fee_pct: 0.0005, price_slippage: 0.001, volume_24h_usd: 5000000,
          }] } } });
        }
        if (name === "perps_list_positions") {
          expect(payload.params?.arguments).toEqual({ contractId: 7 });
          return Response.json({ jsonrpc: "2.0", id: payload.id, result: { structuredContent: { positions: [{
            contract_id: 7, status: "open", value_base: 0.02, avg_entry_price: 50000,
            margin_quote: 100, liquidation_price: 35000,
          }] } } });
        }
      }
      throw new Error("Unexpected Walt MCP request: " + JSON.stringify(payload));
    });
    const response = await call(e, "walt/position?market=BTC", "chave-teste");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, market: "BTC", source: "walt-mcp", permission: "read-only",
      position: { contractId: 7, avgEntryPrice: 50000, valueBase: 0.02, marginQuote: 100, liquidationPrice: 35000 },
    });
    expect(calls).toEqual(["perps_list_contracts", "perps_list_positions"]);
  });

  it("routes demo history through the authenticated user-scoped Engine", async () => {
    const e = env();
    let requestedUrl = "";
    e.ENGINE = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          requestedUrl = request.url;
          return Response.json({ ok: true, trades: [] });
        },
      }),
    } as unknown as DurableObjectNamespace;
    const response = await call(e, "demo/history", "chave-teste");
    expect(response.status).toBe(200);
    expect(requestedUrl).toContain("/history?userId=12345");
    expect(await response.json()).toMatchObject({ ok: true, trades: [] });
  });

  it("keeps authenticated DEMO API requests alive when tenant KV registration fails", async () => {
    const e = env();
    vi.spyOn(e.STATE, "put").mockRejectedValue(new Error("KV temporarily unavailable"));
    e.ENGINE = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ ok: true, trades: [], equity: [] }),
      }),
    } as unknown as DurableObjectNamespace;
    const response = await call(e, "demo/history", "chave-teste");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, trades: [], equity: [] });
    expect(e.STATE.put).toHaveBeenCalledWith(
      "tenant:user:12345",
      expect.stringContaining('"chatId":"12345"'),
    );
  });

  it("recusa tudo se o token do bot não estiver configurado", async () => {
    const e = { ...env(), TELEGRAM_BOT_TOKEN: "" };
    expect((await call(e, "state", "chave-teste")).status).toBe(401);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it("requests real candle snapshots for every supported timeframe", async () => {
    const e = env();
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      requested.push(payload.req.interval);
      return Response.json([{ t: Date.now(), o: "100", h: "105", l: "99", c: "103" }]);
    });
    for (const interval of ["1m", "5m", "15m", "1h", "4h", "1d"]) {
      const response = await call(e, "chart?market=BTC&interval=" + interval, "chave-teste");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ interval, source: "hyperliquid" });
    }
    expect(requested).toEqual(["1m", "5m", "15m", "1h", "4h", "1d"]);
  });

  it("returns an explicit error instead of relabeling sparse ticks as timeframe candles", async () => {
    const e = env();
    vi.stubGlobal("fetch", async () => Response.json([]));
    const response = await call(e, "chart?market=BTC&interval=1m", "chave-teste");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("devolve estado, histórico e 404 para rota desconhecida", async () => {
    const e = env();
    const s = defaultState();
    pushEquity(s, 1000);
    await saveState(tenantEnv(e, "12345"), s);
    const st = (await (await call(e, "state", "chave-teste")).json()) as { mode: string; grid: unknown };
    expect(st.mode).toBe("paper");
    expect(st.grid).toBeNull();
    const tr = (await (await call(e, "trades", "chave-teste")).json()) as { trades: unknown[]; equity: unknown[] };
    expect(tr.trades).toEqual([]);
    expect(tr.equity).toHaveLength(1);
    expect((await call(e, "nada", "chave-teste")).status).toBe(404);
  });

  it("isola estado entre usuários Telegram", async () => {
    const e = env();
    const alice = defaultState();
    alice.mode = "live";
    await saveState(tenantEnv(e, "111"), alice);
    const a = (await (await call(e, "state", "chave-teste", {}, "111")).json()) as { mode: string };
    const b = (await (await call(e, "state", "chave-teste", {}, "222")).json()) as { mode: string };
    expect(a.mode).toBe("live");
    expect(b.mode).toBe("paper");
  });

  it("validates the DEMO preview direction and margin before market lookup", async () => {
    const invalidSide = await call(env(), "demo/preview", "chave-teste", {
      method: "POST", body: JSON.stringify({ symbol: "BTC", side: "buy", leverage: 2 }),
    });
    expect(invalidSide.status).toBe(400);
    expect(await invalidSide.json()).toMatchObject({ ok: false, error: "Направление должно быть LONG или SHORT." });

    const invalidMargin = await call(env(), "demo/preview", "chave-teste", {
      method: "POST", body: JSON.stringify({ symbol: "BTC", side: "long", leverage: 2, marginMicro: "not-a-number" }),
    });
    expect(invalidMargin.status).toBe(400);
    expect(await invalidMargin.json()).toMatchObject({ ok: false });
  });

  it("enforces the DEMO leverage cap before contacting the Engine", async () => {
    const res = await call(env(), "demo/open", "chave-teste", {
      method: "POST",
      body: JSON.stringify({ symbol: "BTC", side: "long", marginMicro: "1000000", leverage: 999 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Максимальное плечо демо-счёта");
  });

  it("valida campos do grid", async () => {
    const res = await call(env(), "grid", "chave-teste", { method: "POST", body: JSON.stringify({ market: "BTC" }) });
    expect(res.status).toBe(400);
  });
});

describe("histórico", () => {
  it("limita os preços a 24 h e zera ao trocar de par", () => {
    const s = defaultState();
    for (let i = 0; i < MAX_PRICES + 10; i++) pushPrice(s, "BTC", 100 + i, i);
    expect(s.prices!.points).toHaveLength(MAX_PRICES);
    expect(s.prices!.points[0][1]).toBe(110);
    pushPrice(s, "ETH", 3000, 999);
    expect(s.prices).toEqual({ market: "ETH", points: [[999, 3000]] });
  });

  it("grava patrimônio no máximo uma vez por hora, salvo forçado", () => {
    const s = defaultState();
    pushEquity(s, 1000, false, 0);
    pushEquity(s, 1001, false, 60_000);
    pushEquity(s, 1002, true, 120_000);
    pushEquity(s, 1003, false, 3_800_000);
    expect(s.equity!.map((p) => p[1])).toEqual([1000, 1002, 1003]);
  });
});

describe("pares", () => {
  const limits = { allowedMarkets: ["*"] } as RiskLimits;
  it("'*' libera qualquer mercado; lista explícita restringe", () => {
    expect(marketAllowed(limits, "doge")).toBe(true);
    expect(marketAllowed({ allowedMarkets: ["BTC"] } as RiskLimits, "ETH")).toBe(false);
  });

  it("calcula a margem mínima como o Walt", () => {
    const btc = { contractId: 1, name: "BTC-USDC", priceDecimals: 1, minSizeBase: 0.00007, minSizeQuote: 1, maxSizeQuote: 25000, maxLeverage: 50, takerFeePct: 0.0009, priceSlippage: 0.01 };
    expect(minMargin(btc, 84276.5, 3)).toBeCloseTo(1.99, 2);
    expect(minMargin({ ...btc, minSizeBase: 0.000001 }, 84276.5, 3)).toBe(1); // piso de min_size_quote
  });
});

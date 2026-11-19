import { afterEach, describe, expect, it, vi } from "vitest";
import { handleApi, livePositionTimestampMatches, normalizeLivePosition } from "../src/api";
import type { RiskLimits } from "../src/env";
import { MAX_PRICES, pushEquity, pushPrice } from "../src/history";
import { marketAllowed } from "../src/risk";
import { defaultState, saveState } from "../src/state";
import { minMargin } from "../src/strategy/grid";
import { env } from "./helpers";
import { tenantEnv } from "../src/tenants";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
async function signedInitData(botToken: string, userId: string): Promise<string> {
  if (!botToken) return "";
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: Number(userId), first_name: "Test" }),
  });
  const encoder = new TextEncoder();
  const hmac = async (keyBytes: Uint8Array, value: string) => {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  };
  // Telegram Web Apps test signature: HMAC-SHA256(key="WebAppData", message=botToken).
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

describe("LIVE reconciliation timestamp correlation", () => {
  const previewAt = 1_800_000_000_000;
  const operationUpdatedAt = previewAt + 30_000;

  it("prefers stable opened/created time over a later mutable updated_at", () => {
    expect(livePositionTimestampMatches({
      created_at: previewAt + 10_000,
      updated_at: previewAt + 3_600_000,
    }, previewAt, operationUpdatedAt)).toBe(true);
  });

  it("rejects positions created after the operation became unknown", () => {
    expect(livePositionTimestampMatches({ created_at: operationUpdatedAt + 60_000 }, previewAt, operationUpdatedAt)).toBe(false);
  });

  it("does not auto-reconcile when only mutable updated_at is available", () => {
    expect(livePositionTimestampMatches({ updated_at: previewAt + 10_000 }, previewAt, operationUpdatedAt)).toBe(false);
  });

  it("rejects positions opened before the preview window", () => {
    expect(livePositionTimestampMatches({ opened_at: previewAt - 10_000 }, previewAt, operationUpdatedAt)).toBe(false);
  });
});

describe("LIVE position normalization", () => {
  it("returns null for no open position", () => {
    expect(normalizeLivePosition({ contractId: 7, name: "BTC-USDC" }, null)).toBeNull();
  });

  it("returns only safe normalized fields and never leaks raw Walt payload", () => {
    const position = normalizeLivePosition(
      { contractId: 7, name: "BTC-USDC" },
      {
        contractId: 7,
        valueBase: 0.25,
        avgEntryPrice: 64000,
        marginQuote: 125,
        liquidationPrice: 59000,
        raw: { side: "LONG", accessToken: "must-not-leak", internal: { account: "private" } },
      },
    );
    expect(position).toEqual({
      contractId: 7,
      symbol: "BTC-USDC",
      side: "long",
      valueBase: 0.25,
      avgEntryPrice: 64000,
      marginQuote: 125,
      liquidationPrice: 59000,
    });
    expect(position).not.toHaveProperty("raw");
    expect(JSON.stringify(position)).not.toContain("must-not-leak");
  });
});

describe("API da Mini App", () => {
  it("exige initData do Telegram assinada corretamente", async () => {
    const e = env();
    expect((await call(e, "state")).status).toBe(401);
    expect((await call(e, "state", "errada")).status).toBe(401);
    expect((await call(e, "state", "chave-teste")).status).toBe(200);
    expect((await call(e, "state", "chave-teste", {}, "")).status).toBe(401);
  });



  it("persists AI product mode per Telegram user without changing execution mode", async () => {
    const e = env();
    const saved = await call(e, "product-mode", "chave-teste", {
      method: "POST", body: JSON.stringify({ productMode: "ai" }),
    }, "111");
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ ok: true, productMode: "ai", executionMode: "paper" });
    const alice = await call(e, "state", "chave-teste", {}, "111");
    const bob = await call(e, "state", "chave-teste", {}, "222");
    expect(await alice.json()).toMatchObject({ productMode: "ai", mode: "paper" });
    expect(await bob.json()).toMatchObject({ productMode: "demo", mode: "paper" });
  });

  it("refuses LIVE product mode until full LIVE capability is available", async () => {
    const e = env();
    const response = await call(e, "product-mode", "chave-teste", {
      method: "POST", body: JSON.stringify({ productMode: "live" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining("LIVE пока заблокирован") });
    expect(await (await call(e, "state", "chave-teste")).json()).toMatchObject({ productMode: "demo", mode: "paper" });
  });

  it("rejects unknown product modes instead of silently accepting them", async () => {
    const response = await call(env(), "product-mode", "chave-teste", {
      method: "POST", body: JSON.stringify({ productMode: "autotrade" }),
    });
    expect(response.status).toBe(400);
  });

  it("requires AI product mode and derives AI funding userId from Telegram initData", async () => {
    const e = env();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const stub = {
      fetch: async (request: Request) => {
        const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
        calls.push({ url: request.url, body });
        return Response.json({ ok: true, funded: true });
      },
    };
    e.ENGINE = { idFromName: (name: string) => name, get: () => stub } as unknown as typeof e.ENGINE;

    const locked = await call(e, "ai/paper/fund", "chave-teste", {
      method: "POST", body: JSON.stringify({ amountUsd: "50.00", idempotencyKey: "api-ai-fund-001", userId: "999" }),
    }, "111");
    expect(locked.status).toBe(409);
    expect(calls).toHaveLength(0);
    const lockedWithdrawal = await call(e, "ai/paper/withdraw", "chave-teste", {
      method: "POST", body: JSON.stringify({ amountUsd: "20.00", idempotencyKey: "api-ai-withdraw-01", userId: "999" }),
    }, "111");
    expect(lockedWithdrawal.status).toBe(409);
    expect(calls).toHaveLength(0);

    const mode = await call(e, "product-mode", "chave-teste", {
      method: "POST", body: JSON.stringify({ productMode: "ai" }),
    }, "111");
    expect(mode.status).toBe(200);

    const funded = await call(e, "ai/paper/fund", "chave-teste", {
      method: "POST", body: JSON.stringify({ amountUsd: "50.00", idempotencyKey: "api-ai-fund-001", userId: "999" }),
    }, "111");
    expect(funded.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/ai/paper/fund");
    expect(calls[0].body).toMatchObject({ userId: "111", amountMicro: "50000000", idempotencyKey: "api-ai-fund-001" });
    const withdrawn = await call(e, "ai/paper/withdraw", "chave-teste", {
      method: "POST", body: JSON.stringify({ amountUsd: "20.00", idempotencyKey: "api-ai-withdraw-01", userId: "999" }),
    }, "111");
    expect(withdrawn.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("/ai/paper/withdraw");
    expect(calls[1].body).toMatchObject({ userId: "111", amountMicro: "20000000", idempotencyKey: "api-ai-withdraw-01" });
  });

  it("returns a safe disconnected LIVE status without contacting Walt", async () => {
    const e = env();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await call(e, "live/status", "chave-teste");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      connected: false,
      readiness: { available: false, ok: false },
      contracts: { available: false, count: null },
      balance: { available: false, usd: null },
      issues: [expect.objectContaining({ code: "not_connected" })],
    });
    expect(JSON.stringify(body)).not.toContain("TEST_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires explicit LIVE execute confirmation before any Walt call", async () => {
    const e = env();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await call(e, "live/execute", "chave-teste", {
      method: "POST",
      body: JSON.stringify({ handle: "a".repeat(32) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("отдельное явное подтверждение"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes AI paper session controls and read APIs using only signed Telegram identity", async () => {
    const e = env();
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    e.ENGINE = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
          calls.push({ url: request.url, method: request.method, body });
          return Response.json({ ok: true, status: "active", positions: [], decisions: [] });
        },
      }),
    } as unknown as DurableObjectNamespace;
    await call(e, "product-mode", "chave-teste", { method: "POST", body: JSON.stringify({ productMode: "ai" }) }, "111");

    const started = await call(e, "ai/paper/session/start", "chave-teste", {
      method: "POST", body: JSON.stringify({ userId: "999" }),
    }, "111");
    expect(started.status).toBe(200);
    expect(calls[0]).toMatchObject({ method: "POST", url: expect.stringContaining("/ai/paper/session/start"), body: { userId: "111" } });

    const stopped = await call(e, "ai/paper/session/stop", "chave-teste", {
      method: "POST", body: JSON.stringify({ userId: "999" }),
    }, "111");
    expect(stopped.status).toBe(200);
    expect(calls[1]).toMatchObject({ method: "POST", url: expect.stringContaining("/ai/paper/session/stop"), body: { userId: "111" } });

    const positions = await call(e, "ai/paper/positions?status=closed&limit=10", "chave-teste", {}, "111");
    expect(positions.status).toBe(200);
    expect(calls[2]).toMatchObject({ method: "GET", url: expect.stringContaining("/ai/paper/positions?userId=111&status=closed&limit=10") });

    const decisions = await call(e, "ai/paper/decisions?limit=25", "chave-teste", {}, "111");
    expect(decisions.status).toBe(200);
    expect(calls[3]).toMatchObject({ method: "GET", url: expect.stringContaining("/ai/paper/decisions?userId=111&limit=25") });

    const spoofed = await call(e, "ai/paper/positions?userId=999", "chave-teste", {}, "111");
    expect(spoofed.status).toBe(400);
    expect(calls).toHaveLength(4);
  });

  it("routes AI paper status through the authenticated user-scoped Engine", async () => {
    const e = env();
    let requestedUrl = "";
    let requestedMethod = "";
    e.ENGINE = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          requestedUrl = request.url;
          requestedMethod = request.method;
          return Response.json({
            ok: true, demoBalanceMicro: "900000000", aiBalanceMicro: "100000000",
            status: "stopped", openPositions: 2,
          });
        },
      }),
    } as unknown as DurableObjectNamespace;
    const response = await call(e, "ai/paper/status", "chave-teste");
    expect(response.status).toBe(200);
    expect(requestedMethod).toBe("GET");
    expect(requestedUrl).toContain("/ai/paper/status?userId=12345");
    expect(await response.json()).toMatchObject({
      ok: true, demoBalanceMicro: "900000000", aiBalanceMicro: "100000000",
      status: "stopped", openPositions: 2,
    });
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


  it("rejects unauthenticated POST requests before parsing their body", async () => {
    const e = env();
    const request = new Request("https://w.dev/api/demo/open", { method: "POST" });
    const parseBody = vi.fn(async () => ({ symbol: "BTC", side: "long" }));
    Object.defineProperty(request, "json", { value: parseBody });
    const response = await handleApi(request, e, ctx);
    expect(response.status).toBe(401);
    expect(parseBody).not.toHaveBeenCalled();
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
    expect(body.error).toContain("Для этого актива доступно плечо не выше 40×");
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

import { describe, expect, it } from "vitest";
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

  it("recusa tudo se o token do bot não estiver configurado", async () => {
    const e = { ...env(), TELEGRAM_BOT_TOKEN: "" };
    expect((await call(e, "state", "chave-teste")).status).toBe(401);
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

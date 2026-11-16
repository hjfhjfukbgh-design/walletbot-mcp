// API JSON para a Mini App (via endpoints do Telegram Serverless) e para o encaminhamento de updates.
// Autenticação: header X-Api-Key igual ao secret API_SECRET.
import { closeAll, connectWalt, paperEquity, positionPnl } from "./bot";
import { publicContracts, publicMid } from "./prices";
import { handleUpdate } from "./commands";
import { riskLimits, type Env } from "./env";
import { loadTrades } from "./history";

import { getAccessToken } from "./oauth";
import { marketAllowed } from "./risk";
import { configureGrid, resumeGrid, runGrid, setMode, stopGrid, walt } from "./service";
import { cachedContracts, loadState } from "./state";
import { buyPrice, minMargin, notional, step, stopLossPrice } from "./strategy/grid";
import { timingSafeEqual, type TgUpdate } from "./telegram";
import { findContract } from "./walt";
import { tenantEnv } from "./tenants";

type Json = Record<string, unknown>;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (error: string, status = 400) => json({ ok: false, error }, status);

export async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const key = req.headers.get("X-Api-Key") ?? "";
  const url = new URL(req.url);
  const route = `${req.method} ${url.pathname.replace(/^\/api\//, "")}`;
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Json) : {};
  let telegramUserId = "";

  if (route === "POST telegram") {
    if (!env.API_SECRET || !timingSafeEqual(key, env.API_SECRET)) return fail("unauthorized", 401);
  } else {
    const authorization = req.headers.get("Authorization") ?? "";
    if (authorization.startsWith("tma ")) {
      telegramUserId = (await validateTelegramInitData(authorization.slice(4), env.TELEGRAM_BOT_TOKEN)) ?? "";
    } else if (env.API_SECRET && timingSafeEqual(key, env.API_SECRET)) {
      telegramUserId = req.headers.get("X-Telegram-User-Id") ?? "";
    }
    if (!/^\d{1,20}$/.test(telegramUserId)) return fail("Требуется открыть приложение через Telegram.", 401);
  }
  const scopedEnv = telegramUserId ? tenantEnv(env, telegramUserId) : env;
  if (telegramUserId) {
    await env.STATE.put("tenant:user:" + telegramUserId, JSON.stringify({ chatId: telegramUserId, createdAt: new Date().toISOString() }));
  }
  try {
    switch (route) {
      case "GET state":
        return json({ ok: true, ...(await stateView(scopedEnv)) });
      case "GET contracts":
        return json({ ok: true, contracts: await contractsView(scopedEnv) });
      case "GET price":
        return json({ ok: true, ...(await priceView(scopedEnv, url.searchParams.get("market") ?? "", Number(url.searchParams.get("leverage") ?? 3))) });
      case "GET chart":
        return json({ ok: true, ...(await chartView(scopedEnv, url.searchParams.get("market") ?? "")) });
      case "GET trades": {
        const s = await loadState(scopedEnv);
        return json({ ok: true, trades: (await loadTrades(scopedEnv)).slice().reverse(), equity: s.equity ?? [] });
      }
      case "POST grid": {
        const args = [body.market, body.low, body.high, body.levels, body.marginUsd, body.leverage].map((v) => String(v ?? ""));
        if (args.slice(0, 5).some((a) => a === "")) return fail("campos obrigatórios: market, low, high, levels, marginUsd");
        return json({ ok: true, message: await configureGrid(scopedEnv, args) });
      }
      case "POST control":
        return json({ ok: true, message: await control(scopedEnv, body) });
      case "POST telegram":
        // update encaminhado pelo handler do tgcloud; responde já e processa em segundo plano
        ctx.waitUntil(handleUpdate(env, body as unknown as TgUpdate));
        return json({ ok: true });
      default:
        return fail(`rota desconhecida: ${route}`, 404);
    }
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}

async function control(env: Env, body: Json): Promise<string> {
  switch (body.action) {
    case "run":
      return runGrid(env);
    case "stop":
      return stopGrid(env);
    case "resume":
      return resumeGrid(env);
    case "closeall":
      return closeAll(env);
    case "mode":
      return setMode(env, [String(body.mode ?? ""), body.confirm === true ? "CONFIRMO" : ""]);
    default:
      throw new Error("action deve ser run, stop, resume, closeall ou mode");
  }
}

async function stateView(env: Env) {
  const s = await loadState(env);
  const limits = riskLimits(env);
  const connected = !!(await getAccessToken(env).catch(() => null));
  const grid = s.grid
    ? {
        ...s.grid.cfg,
        contract: undefined,
        contractId: s.grid.cfg.contract.contractId,
        step: step(s.grid.cfg),
        notional: notional(s.grid.cfg),
        stopLoss: stopLossPrice(s.grid.cfg, limits.stopLossPct),
        levelPrices: Array.from({ length: s.grid.cfg.levels + 1 }, (_, i) => buyPrice(s.grid!.cfg, i)),
      }
    : null;
  const pos = s.grid?.position;
  let live: Json | null = null;
  if (s.mode === "live" && s.grid && connected) {
    const w = await connectWalt(env);
    const p = await w?.openPosition(s.grid.cfg.contract.contractId).catch(() => null);
    if (p) live = { ...p.raw };
  }
  return {
    mode: s.mode,
    running: s.running,
    paused: s.paused ?? null,
    connected,
    lastPrice: s.lastPrice ?? null,
    lastTick: s.lastTick ?? null,
    lastError: s.lastError ?? null,
    lastBlock: s.lastBlock ?? null,
    lastRecenter: s.lastRecenter ?? null,
    stats: s.stats,
    grid,
    position: pos
      ? {
          ...pos,
          unrealizedPnl: s.lastPrice && s.grid ? positionPnl(pos, s.lastPrice, s.grid.cfg.contract.takerFeePct) : null,
        }
      : null,
    livePosition: live,
    paper: s.mode === "paper" ? { ...s.paper, equity: s.lastPrice ? paperEquity(s, s.lastPrice) : s.paper.cash } : null,
    limits,
  };
}

async function contractsView(env: Env) {
  const limits = riskLimits(env);
  const state = await loadState(env);
  const list = state.mode === "live"
    ? await cachedContracts(env, async () => (await walt(env)).contracts())
    : await publicContracts();
  return list
    .map((c) => {
      const market = c.name.replace(/-USDC?$/i, "");
      return {
        market,
        ...c,
        source: state.mode === "live" ? "walt" : "hyperliquid",
        liquid: (c.volume24hUsd ?? 0) >= limits.minVolume24hUsd,
        allowed: marketAllowed(limits, market) && (c.volume24hUsd ?? 0) >= limits.minVolume24hUsd,
      };
    })
    .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
}

async function priceView(env: Env, market: string, leverage: number) {
  const state = await loadState(env);
  const contract = state.mode === "live"
    ? findContract(await cachedContracts(env, async () => (await walt(env)).contracts()), market)
    : findContract(await publicContracts(), market);
  if (!contract) throw new Error(`рынок ${market} не найден`);
  const price = state.mode === "live" ? await (await walt(env)).rate(contract) : await publicMid(market);
  const lev = Math.max(1, Math.min(Math.trunc(leverage) || 1, contract.maxLeverage, riskLimits(env).maxLeverage));
  return {
    market: market.toUpperCase(),
    price,
    leverage: lev,
    minMargin: Number(minMargin(contract, price * 1.02, lev).toFixed(2)),
    suggestion: { low: Number((price * 0.94).toFixed(contract.priceDecimals)), high: Number((price * 1.02).toFixed(contract.priceDecimals)) },
  };
}

/** Velas de 15 min da Hyperliquid (dados públicos) quando o par existe lá; senão, os preços gravados pelo tick. */
async function chartView(env: Env, market: string) {
  const m = market.toUpperCase();
  const end = Date.now();
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: m, interval: "15m", startTime: end - 2 * 86_400_000, endTime: end } }),
    });
    if (res.ok) {
      const rows = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string }>;
      if (Array.isArray(rows) && rows.length)
        return { source: "hyperliquid", candles: rows.map((r) => [r.t, +r.o, +r.h, +r.l, +r.c]) };
    }
  } catch {
    // cai para os ticks gravados
  }
  const s = await loadState(env);
  const points = s.prices?.market === m ? s.prices.points : [];
  return { source: "ticks", candles: points.map(([t, p]) => [t, p, p, p, p]) };
}

/** Validate Telegram Mini App initData and return the signed Telegram user ID. */
async function validateTelegramInitData(initData: string, botToken: string): Promise<string | null> {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash") ?? "";
    const authDate = Number(params.get("auth_date") ?? 0);
    const now = Math.floor(Date.now() / 1000);
    if (!/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(authDate) || authDate < now - 86_400 || authDate > now + 60) return null;
    params.delete("hash");
    const checkString = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
    const encoder = new TextEncoder();
    const hmac = async (keyBytes: Uint8Array, data: string) => {
      const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
    };
    const secret = await hmac(encoder.encode(botToken), "WebAppData");
    const actual = [...await hmac(secret, checkString)].map((v) => v.toString(16).padStart(2, "0")).join("");
    if (actual.length !== hash.length) return null;
    let mismatch = 0;
    for (let i = 0; i < actual.length; i++) mismatch |= actual.charCodeAt(i) ^ hash.toLowerCase().charCodeAt(i);
    if (mismatch !== 0) return null;
    const user = JSON.parse(params.get("user") ?? "{}") as { id?: number | string };
    return user.id && /^\d{1,20}$/.test(String(user.id)) ? String(user.id) : null;
  } catch { return null; }
}
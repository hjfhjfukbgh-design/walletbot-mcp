// API JSON para a Mini App (via endpoints do Telegram Serverless) e para o encaminhamento de updates.
// Autenticação: header X-Api-Key igual ao secret API_SECRET.
import { closeAll, connectWalt, positionPnl } from "./bot";
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
import { MONEY_SCALE, parseFixed, PRICE_SCALE, pnlMicro } from "./trading/money";
import { closeManualTrade, manualPositionsView, openManualTrade } from "./manual";

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
    }
    if (!/^\d{1,20}$/.test(telegramUserId)) return fail("Требуется открыть приложение через Telegram.", 401);
  }
  const scopedEnv = telegramUserId ? tenantEnv(env, telegramUserId) : env;
  if (telegramUserId) {
    await env.STATE.put("tenant:user:" + telegramUserId, JSON.stringify({ chatId: telegramUserId, createdAt: new Date().toISOString() }));
  }
  try {
    switch (route) {
      case "GET demo":
        return engineRequest(env, "/account?userId=" + encodeURIComponent(telegramUserId));
      case "GET demo/history":
        return engineRequest(env, "/history?userId=" + encodeURIComponent(telegramUserId));
      case "POST demo/preview":
        return previewDemoTrade(env, telegramUserId, body);
      case "POST demo/open":
        return openDemoTrade(env, telegramUserId, body);
      case "POST demo/close":
        return engineRequest(env, "/close", { ...body, userId: telegramUserId, manual: true });
      case "GET state":
        // Read-only polling must not run the legacy KV position monitor:
        // scheduled processing is the single monitor for that compatibility path.
        return json({ ok: true, ...(await stateView(scopedEnv)) });
      case "GET contracts":
        return json({ ok: true, contracts: await contractsView(scopedEnv) });
      case "GET price":
        return json({ ok: true, ...(await priceView(scopedEnv, url.searchParams.get("market") ?? "", Number(url.searchParams.get("leverage") ?? 3))) });
      case "GET chart":
        return json({ ok: true, ...(await chartView(scopedEnv, url.searchParams.get("market") ?? "", url.searchParams.get("interval") ?? "15m")) });
      case "POST manual": {
        if (body.action === "open") {
          const side = String(body.side ?? "") as "long" | "short";
          const result = await openManualTrade(scopedEnv, { market: String(body.market ?? ""), side, marginUsd: Number(body.marginUsd), leverage: Number(body.leverage), takeProfit: body.takeProfit == null ? null : Number(body.takeProfit), stopLoss: body.stopLoss == null ? null : Number(body.stopLoss) });
          return json({ ok: true, ...result });
        }
        if (body.action === "close") return json({ ok: true, message: await closeManualTrade(scopedEnv, String(body.id ?? "")) });
        return fail("Действие должно быть open или close");
      }
      case "GET trades": {
        const s = await loadState(scopedEnv);
        return json({ ok: true, trades: (await loadTrades(scopedEnv)).slice().reverse(), equity: s.equity ?? [] });
      }
      case "POST grid": {
        const args = [body.market, body.low, body.high, body.levels, body.marginUsd, body.leverage].map((v) => String(v ?? ""));
        if (args.slice(0, 5).some((a) => a === "")) return fail("Обязательные поля: market, low, high, levels, marginUsd");
        return json({ ok: true, message: await configureGrid(scopedEnv, args) });
      }
      case "POST control":
        return json({ ok: true, message: await control(scopedEnv, body) });
      case "POST telegram":
        // update encaminhado pelo handler do tgcloud; responde já e processa em segundo plano
        ctx.waitUntil(handleUpdate(env, body as unknown as TgUpdate));
        return json({ ok: true });
      default:
        return fail(`Неизвестный маршрут: ${route}`, 404);
    }
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}

 
/**
 * Enforce all DEMO order limits on the trusted server. Never accept fees,
 * slippage, leverage limits, market eligibility, or account sizing from the client.
 */
/**
 * Read-only DEMO preview. All limits, current marks and fees are calculated
 * from server-owned risk settings and public contract metadata.
 */
async function previewDemoTrade(env: Env, userId: string, body: Json): Promise<Response> {
  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  const side = String(body.side ?? "");
  const leverage = Number(body.leverage);
  const limits = riskLimits(env);
  if (!/^[A-Z0-9:_-]{2,32}$/.test(symbol)) return fail("Некорректный торговый актив.");
  if (side !== "long" && side !== "short") return fail("Направление должно быть LONG или SHORT.");
  if (!Number.isSafeInteger(leverage) || leverage < 1 || leverage > limits.maxLeverage)
    return fail(`Максимальное плечо демо-счёта: ${limits.maxLeverage}×.`);

  const contracts = await publicContracts();
  const contract = contracts.find((item) => item.name.replace(/-USDC?$/i, "").toUpperCase() === symbol);
  if (!contract) return fail("Этот актив сейчас недоступен для демо-торговли.");
  if (!marketAllowed(limits, symbol)) return fail("Этот рынок не входит в список разрешённых.", 403);
  if ((contract.volume24hUsd ?? 0) < limits.minVolume24hUsd) return fail("Недостаточная ликвидность рынка для демо-сделки.");
  const allowedLeverage = Math.min(limits.maxLeverage, contract.maxLeverage);
  if (leverage > allowedLeverage) return fail(`Для этого актива доступно плечо не выше ${allowedLeverage}×.`);

  const mid = await publicMid(symbol);
  if (!Number.isFinite(mid) || mid <= 0) return fail("Не удалось получить свежую цену актива.", 503);
  const accountResponse = await engineRequest(env, "/account?userId=" + encodeURIComponent(userId));
  if (!accountResponse.ok) return accountResponse;
  const account = await accountResponse.json() as {
    balanceMicro: string;
    positions: Array<{ symbol: string; side: "long" | "short"; marginMicro: string; qtyUnits: string; entryPrice: string }>;
  };
  const balanceMicro = BigInt(account.balanceMicro);
  let openMarginMicro = 0n;
  let unrealizedMicro = 0n;
  const marks = new Map<string, number>();
  for (const position of account.positions ?? []) {
    openMarginMicro += BigInt(position.marginMicro);
    let mark = marks.get(position.symbol);
    if (mark === undefined) {
      mark = await publicMid(position.symbol);
      marks.set(position.symbol, mark);
    }
    const markUnits = parseFixed(mark.toFixed(8), PRICE_SCALE, 8);
    unrealizedMicro += pnlMicro(position.side, BigInt(position.qtyUnits), BigInt(position.entryPrice), markUnits);
  }
  const equityMicro = balanceMicro + openMarginMicro + unrealizedMicro;
  if (equityMicro <= 0n) return fail("Демо-капитал исчерпан. Новые позиции заблокированы.");
  const orderLimitBps = BigInt(Math.max(0, Math.round(limits.maxOrderPct * 100)));
  const exposureLimitBps = BigInt(Math.max(0, Math.round(limits.maxTotalExposurePct * 100)));
  const orderCap = equityMicro * orderLimitBps / 10_000n;
  const exposureCap = (equityMicro * exposureLimitBps / 10_000n) - openMarginMicro;
  const cashCap = balanceMicro;
  const feePpm = BigInt(Math.max(0, Math.round(contract.takerFeePct * 1_000_000)));
  const feeFactor = 1_000_000n + BigInt(leverage) * feePpm;
  const feeAdjustedCashCap = cashCap * 1_000_000n / feeFactor;
  const maxNotional = BigInt(Math.floor(contract.maxSizeQuote * Number(MONEY_SCALE)));
  const minNotional = BigInt(Math.ceil(contract.minSizeQuote * Number(MONEY_SCALE)));
  const maxMarginMicro = [orderCap, exposureCap, feeAdjustedCashCap, maxNotional / BigInt(leverage)]
    .reduce((min, value) => value < min ? value : min);
  const minMarginMicro = (minNotional + BigInt(leverage) - 1n) / BigInt(leverage);
  const maxMarginUsd = Number(maxMarginMicro > 0n ? maxMarginMicro : 0n) / Number(MONEY_SCALE);
  const minMarginUsd = Number(minMarginMicro) / Number(MONEY_SCALE);
  const requestedMargin = body.marginMicro == null ? minMarginMicro : BigInt(String(body.marginMicro));
  if (requestedMargin < 0n || (body.marginMicro != null && !/^\d{1,18}$/.test(String(body.marginMicro))))
    return fail("Некорректная сумма маржи.");
  const notionalMicro = requestedMargin * BigInt(leverage);
  const entryFeeMicro = notionalMicro * feePpm / 1_000_000n;
  const exitFeeMicro = entryFeeMicro;
  const tradeable = maxMarginMicro >= minMarginMicro && maxMarginMicro > 0n;
  const liquidation = side === "long"
    ? mid * (1 - 1 / leverage + 0.005) / (1 - 0.005)
    : mid * (1 + 1 / leverage - 0.005) / (1 + 0.005);
  return json({
    ok: true, symbol, side, priceUsd: mid, leverage,
    marginUsd: Number(requestedMargin) / Number(MONEY_SCALE),
    maxMarginUsd, minMarginUsd,
    volumeUsd: Number(notionalMicro) / Number(MONEY_SCALE),
    entryFeeUsd: Number(entryFeeMicro) / Number(MONEY_SCALE),
    estimatedExitFeeUsd: Number(exitFeeMicro) / Number(MONEY_SCALE),
    liquidationPriceUsd: liquidation, tradeable,
    reason: tradeable ? null : "Лимит демо-счёта не позволяет открыть позицию минимального размера.",
    source: "hyperliquid",
  });
}

async function openDemoTrade(env: Env, userId: string, body: Json): Promise<Response> {
  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  const side = String(body.side ?? "");
  const leverage = Number(body.leverage);
  const limits = riskLimits(env);
  if (!/^[A-Z0-9:_-]{2,32}$/.test(symbol)) return fail("Некорректный торговый актив.");
  if (side !== "long" && side !== "short") return fail("Направление должно быть LONG или SHORT.");
  if (!Number.isSafeInteger(leverage) || leverage < 1 || leverage > limits.maxLeverage)
    return fail(`Максимальное плечо демо-счёта: ${limits.maxLeverage}×.`);

  const rawMargin = String(body.marginMicro ?? "");
  if (!/^\d{1,18}$/.test(rawMargin)) return fail("Некорректная сумма маржи.");
  const marginMicro = BigInt(rawMargin);
  if (marginMicro <= 0n) return fail("Маржа должна быть положительной.");

  const contracts = await publicContracts();
  const contract = contracts.find((item) => item.name.replace(/-USDC?$/i, "").toUpperCase() === symbol);
  if (!contract) return fail("Этот актив сейчас недоступен для демо-торговли.");
  if (!marketAllowed(limits, symbol)) return fail("Этот рынок не входит в список разрешённых.", 403);
  if ((contract.volume24hUsd ?? 0) < limits.minVolume24hUsd)
    return fail("Недостаточная ликвидность рынка для демо-сделки.");
  const allowedLeverage = Math.min(limits.maxLeverage, contract.maxLeverage);
  if (leverage > allowedLeverage) return fail(`Для этого актива доступно плечо не выше ${allowedLeverage}×.`);

  const notionalMicro = marginMicro * BigInt(leverage);
  const minNotional = BigInt(Math.ceil(contract.minSizeQuote * Number(MONEY_SCALE)));
  const maxNotional = BigInt(Math.floor(contract.maxSizeQuote * Number(MONEY_SCALE)));
  if (notionalMicro < minNotional || notionalMicro > maxNotional)
    return fail(`Объём позиции должен быть от ${contract.minSizeQuote} до ${contract.maxSizeQuote} USDC.`);

  const accountResponse = await engineRequest(env, "/account?userId=" + encodeURIComponent(userId));
  if (!accountResponse.ok) return accountResponse;
  const account = await accountResponse.json() as {
    balanceMicro: string;
    positions: Array<{ symbol: string; side: "long" | "short"; marginMicro: string; qtyUnits: string; entryPrice: string }>;
  };
  const balanceMicro = BigInt(account.balanceMicro);
  let openMarginMicro = 0n;
  let unrealizedMicro = 0n;
  const marks = new Map<string, number>();
  for (const position of account.positions ?? []) {
    openMarginMicro += BigInt(position.marginMicro);
    let mark = marks.get(position.symbol);
    if (mark === undefined) {
      mark = await publicMid(position.symbol);
      marks.set(position.symbol, mark);
    }
    const markUnits = parseFixed(mark.toFixed(8), PRICE_SCALE, 8);
    unrealizedMicro += pnlMicro(position.side, BigInt(position.qtyUnits), BigInt(position.entryPrice), markUnits);
  }
  const equityMicro = balanceMicro + openMarginMicro + unrealizedMicro;
  if (equityMicro <= 0n) return fail("Демо-капитал исчерпан. Новые позиции заблокированы.");
  const orderLimitBps = BigInt(Math.max(0, Math.round(limits.maxOrderPct * 100)));
  const exposureLimitBps = BigInt(Math.max(0, Math.round(limits.maxTotalExposurePct * 100)));
  if (marginMicro * 10_000n > equityMicro * orderLimitBps)
    return fail(`Маржа превышает лимит одной сделки (${limits.maxOrderPct}% капитала).`);
  if ((openMarginMicro + marginMicro) * 10_000n > equityMicro * exposureLimitBps)
    return fail(`Общая маржа превысит лимит ${limits.maxTotalExposurePct}% капитала.`);

  const mid = await publicMid(symbol);
  if (!Number.isFinite(mid) || mid <= 0) return fail("Не удалось получить свежую цену актива.", 503);
  const price = parseFixed(mid.toFixed(8), PRICE_SCALE, 8);
  const quote = await engineRequest(env, "/quote", { symbol, price: price.toString(), observedAt: Date.now() });
  if (!quote.ok) return quote;

  const optionalPrice = (value: unknown, label: string): string | null | Response => {
    if (value == null || value === "") return null;
    const raw = String(value);
    if (!/^\d{1,30}$/.test(raw) || BigInt(raw) <= 0n) return fail(`Некорректное значение ${label}.`);
    return raw;
  };
  const takeProfitPrice = optionalPrice(body.takeProfitPrice, "TP");
  if (takeProfitPrice instanceof Response) return takeProfitPrice;
  const stopLossPrice = optionalPrice(body.stopLossPrice, "SL");
  if (stopLossPrice instanceof Response) return stopLossPrice;

  // Contract parameters are server-derived. Client-supplied feePpm/slippagePpm are ignored.
  const feePpm = String(Math.max(0, Math.round(contract.takerFeePct * 1_000_000)));
  const slippagePpm = String(Math.max(0, Math.round(contract.priceSlippage * 1_000_000)));
  return engineRequest(env, "/open", {
    symbol, side, marginMicro: marginMicro.toString(), leverage: String(leverage),
    takeProfitPrice, stopLossPrice, feePpm, slippagePpm,
    maxOrderBps: String(Math.round(limits.maxOrderPct * 100)),
    maxTotalExposureBps: String(Math.round(limits.maxTotalExposurePct * 100)),
    userId, mode: "demo",
  });
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
      throw new Error("Действие должно быть run, stop, resume, closeall или mode");
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
    paper: s.mode === "paper" ? { ...s.paper, equity: await paperEquityWithManual(env, s) } : null,
    manualPositions: s.mode === "paper" ? await manualPositionsView(env) : [],
    limits,
  };
}

async function paperEquityWithManual(env: Env, s: Awaited<ReturnType<typeof loadState>>) {
  const manual = await manualPositionsView(env);
  const gridPnl = s.lastPrice ? (s.grid?.position && s.grid ? positionPnl(s.grid.position, s.lastPrice, s.grid.cfg.contract.takerFeePct) : 0) : 0;
  return Number((s.paper.cash + gridPnl + manual.reduce((sum, p) => sum + p.estimatedEquity, 0)).toFixed(4));
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
        allowed: (state.mode === "paper" || marketAllowed(limits, market)) && (c.volume24hUsd ?? 0) >= limits.minVolume24hUsd,
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
    maxDemoLeverage: riskLimits(env).maxLeverage,
    minMargin: Number(minMargin(contract, price * 1.02, lev).toFixed(2)),
    suggestion: { low: Number((price * 0.94).toFixed(contract.priceDecimals)), high: Number((price * 1.02).toFixed(contract.priceDecimals)) },
  };
}

/** Public candles from Hyperliquid, with selectable interval. */
async function chartView(_env: Env, market: string, requestedInterval: string) {
  const m = market.trim().toUpperCase();
  if (!/^[A-Z0-9:_-]{2,32}$/.test(m)) throw new Error("Некорректный торговый актив для графика.");
  const allowedIntervals = ["1m", "5m", "15m", "1h", "4h", "1d"];
  const interval = allowedIntervals.includes(requestedInterval) ? requestedInterval : "15m";
  const durations: Record<string, number> = { "1m": 6 * 60 * 60_000, "5m": 24 * 60 * 60_000, "15m": 2 * 86_400_000, "1h": 14 * 86_400_000, "4h": 60 * 86_400_000, "1d": 365 * 86_400_000 };
  const end = Date.now();
  let response: Response;
  try {
    response = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: m, interval, startTime: end - durations[interval], endTime: end } }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new Error(`Свечи ${m} (${interval}) временно недоступны: ${error instanceof Error ? error.message : "ошибка сети"}`);
  }
  if (!response.ok) throw new Error(`Поставщик свечей вернул HTTP ${response.status} для ${m} (${interval}).`);
  let rows: Array<{ t: number; o: string; h: string; l: string; c: string }>;
  try { rows = await response.json() as Array<{ t: number; o: string; h: string; l: string; c: string }>; }
  catch { throw new Error("Поставщик свечей вернул некорректный JSON."); }
  const candles = Array.isArray(rows) ? rows
    .filter((row) => Number.isFinite(row.t) && [row.o, row.h, row.l, row.c].every((value) => Number.isFinite(Number(value)) && Number(value) > 0))
    .map((row) => [row.t, Number(row.o), Number(row.h), Number(row.l), Number(row.c)]) : [];
  if (!candles.length) throw new Error(`Для ${m} нет свечных данных на таймфрейме ${interval}.`);
  return { source: "hyperliquid", interval, candles };
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
    const pairs: Array<[string, string]> = [];
    params.forEach((value, key) => pairs.push([key, value]));
    const checkString = pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
    const encoder = new TextEncoder();
    const hmac = async (keyBytes: Uint8Array, data: string) => {
      const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
    };
    const secret = await hmac(encoder.encode("WebAppData"), botToken);
    const actual = [...await hmac(secret, checkString)].map((v) => v.toString(16).padStart(2, "0")).join("");
    if (actual.length !== hash.length) return null;
    let mismatch = 0;
    for (let i = 0; i < actual.length; i++) mismatch |= actual.charCodeAt(i) ^ hash.toLowerCase().charCodeAt(i);
    if (mismatch !== 0) return null;
    const user = JSON.parse(params.get("user") ?? "{}") as { id?: number | string };
    return user.id && /^\d{1,20}$/.test(String(user.id)) ? String(user.id) : null;
  } catch { return null; }
}

/** All user-scoped Engine calls use the Telegram ID verified from signed initData above. */
async function engineRequest(env: Env, path: string, body?: Json): Promise<Response> {
  const id = env.ENGINE.idFromName("global-engine");
  const stub = env.ENGINE.get(id);
  const request = body === undefined
    ? new Request("https://engine.internal" + path)
    : new Request("https://engine.internal" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return stub.fetch(request);
}

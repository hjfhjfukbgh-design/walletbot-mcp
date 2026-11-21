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
import { cachedContracts, loadState, normalizeProductMode, saveState } from "./state";
import { buyPrice, minMargin, notional, step, stopLossPrice } from "./strategy/grid";
import { timingSafeEqual, type TgUpdate } from "./telegram";
import { findContract } from "./walt";
import { tenantEnv } from "./tenants";
import { feeMicro, MONEY_SCALE, notionalMicro, parseFixed, PRICE_SCALE, pnlMicro } from "./trading/money";
import { closeManualTrade, manualPositionsView, openManualTrade } from "./manual";

type Json = Record<string, unknown>;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (error: string, status = 400) => json({ ok: false, error }, status);

export async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const key = req.headers.get("X-Api-Key") ?? "";
  const url = new URL(req.url);
  const route = `${req.method} ${url.pathname.replace(/^\/api\//, "")}`;
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
  // Do not consume or parse an unauthenticated request body.
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Json) : {};
  const scopedEnv = telegramUserId ? tenantEnv(env, telegramUserId) : env;
  try {
    if (telegramUserId) {
      // Tenant discovery is auxiliary: a transient KV outage must not take down
      // authenticated wallet, market, history, or DEMO trading API requests.
      try {
        await env.STATE.put("tenant:user:" + telegramUserId, JSON.stringify({ chatId: telegramUserId, createdAt: new Date().toISOString() }));
      } catch (error) {
        console.error("[miniapp-api] tenant registry write failed; continuing request", error);
      }
    }
    switch (route) {
      case "GET ai/paper/status":
        return engineRequest(env, "/ai/paper/status?userId=" + encodeURIComponent(telegramUserId));
      case "GET ai/paper/positions": {
        if (url.searchParams.has("userId")) return fail("ID пользователя берётся только из Telegram initData.", 400);
        const status = url.searchParams.get("status") ?? "open";
        const limit = Number(url.searchParams.get("limit") ?? "50");
        if (!["open", "closed", "all"].includes(status) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          return fail("Некорректные параметры истории AI paper позиций.", 400);
        return engineRequest(env, "/ai/paper/positions?userId=" + encodeURIComponent(telegramUserId) + "&status=" + encodeURIComponent(status) + "&limit=" + limit);
      }
      case "GET ai/paper/decisions": {
        if (url.searchParams.has("userId")) return fail("ID пользователя берётся только из Telegram initData.", 400);
        const limit = Number(url.searchParams.get("limit") ?? "50");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          return fail("Некорректный лимит истории AI paper решений.", 400);
        return engineRequest(env, "/ai/paper/decisions?userId=" + encodeURIComponent(telegramUserId) + "&limit=" + limit);
      }
      case "GET demo":
        return demoAccountView(env, telegramUserId);
      case "GET demo/history":
        return engineRequest(env, "/history?userId=" + encodeURIComponent(telegramUserId));
      case "POST live/preview":
        return previewLiveTrade(scopedEnv, telegramUserId, body);
      case "POST live/execute":
        return executeLiveTrade(env, scopedEnv, telegramUserId, body);
      case "GET live/operation":
        return liveOperationView(env, scopedEnv, telegramUserId, url.searchParams.get("handle") ?? "");
      case "POST demo/preview":
        return previewDemoTrade(env, telegramUserId, body);
      case "POST demo/open":
        return openDemoTrade(env, telegramUserId, body);
      case "POST demo/close":
        return engineRequest(env, "/close", { ...body, userId: telegramUserId, manual: true });
      case "GET live/status":
        return liveStatusView(scopedEnv);
      case "GET live/position":
        return livePositionView(scopedEnv, url.searchParams.get("symbol") ?? "");
      case "POST product-mode":
        return updateProductMode(scopedEnv, telegramUserId, body);
      case "POST ai/paper/session/start":
        return startAiPaperSession(scopedEnv, telegramUserId);
      case "POST ai/paper/session/stop":
        return engineRequest(env, "/ai/paper/session/stop", { userId: telegramUserId });
      case "POST ai/paper/fund":
        return fundAiPaper(scopedEnv, telegramUserId, body);
      case "POST ai/paper/withdraw":
        return withdrawAiPaper(scopedEnv, telegramUserId, body);
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
 * Read-only LIVE connection status. This route never prepares or executes orders.
 * Each Walt read is isolated so a partial outage is represented explicitly.
 */
export function normalizeLivePosition(
  contract: { contractId: number; name: string },
  position: { contractId: number; valueBase?: number; avgEntryPrice?: number; marginQuote?: number; liquidationPrice?: number; raw: Json } | null,
): Json | null {
  if (!position) return null;
  const rawSide = position.raw && typeof position.raw === "object" ? position.raw.side : null;
  const side = typeof rawSide === "string" && ["long", "short"].includes(rawSide.toLowerCase())
    ? rawSide.toLowerCase()
    : null;
  return {
    contractId: contract.contractId,
    symbol: contract.name,
    side,
    valueBase: typeof position.valueBase === "number" && Number.isFinite(position.valueBase) ? position.valueBase : null,
    avgEntryPrice: typeof position.avgEntryPrice === "number" && Number.isFinite(position.avgEntryPrice) ? position.avgEntryPrice : null,
    marginQuote: typeof position.marginQuote === "number" && Number.isFinite(position.marginQuote) ? position.marginQuote : null,
    liquidationPrice: typeof position.liquidationPrice === "number" && Number.isFinite(position.liquidationPrice) ? position.liquidationPrice : null,
  };
}

async function livePositionView(scopedEnv: Env, requestedSymbol: string): Promise<Response> {
  const symbol = String(requestedSymbol || "").trim().toUpperCase().replace(/[\/-](?:USDC|USDT|USD)$/, "");
  if (!/^[A-Z0-9_]{1,32}$/.test(symbol)) return fail("Укажите корректный торговый символ.");
  const client = await connectWalt(scopedEnv).catch(() => null);
  if (!client) return fail("Walt недоступен для чтения позиции.", 503);
  let contracts;
  try {
    contracts = await client.contracts();
  } catch {
    return fail("Не удалось получить список контрактов Walt.", 503);
  }
  const contract = findContract(contracts, symbol);
  if (!contract) return fail("Контракт не найден.", 404);
  let position;
  try {
    position = await client.openPosition(contract.contractId);
  } catch {
    return fail("Не удалось получить LIVE-позицию из Walt.", 503);
  }
  return json({ ok: true, position: normalizeLivePosition(contract, position), observedAt: Date.now() });
}

async function liveStatusView(env: Env): Promise<Response> {
  const observedAt = Date.now();
  const client = await connectWalt(env).catch(() => null);
  if (!client) {
    return json({
      ok: true,
      connected: false,
      readiness: { available: false, ok: false },
      contracts: { available: false, count: null },
      balance: { available: false, usd: null },
      issues: [{ code: "not_connected", description: "Подключение к Walt не настроено." }],
      observedAt,
    });
  }

  const issues: Array<{ code: string; description: string }> = [];
  let readiness: { available: boolean; ok: boolean } = { available: false, ok: false };
  let contracts: { available: boolean; count: number | null } = { available: false, count: null };
  let balance: { available: boolean; usd: number | null } = { available: false, usd: null };

  try {
    const result = await client.readiness();
    readiness = { available: true, ok: result.ok };
    for (const issue of result.issues) {
      issues.push({ code: String(issue.code || "readiness_issue"), description: String(issue.description || "Проверка готовности не пройдена.") });
    }
  } catch {
    issues.push({ code: "readiness_unavailable", description: "Не удалось проверить готовность Walt." });
  }

  if (readiness.available && readiness.ok) {
    try {
      const list = await client.contracts();
      contracts = { available: true, count: list.length };
    } catch {
      issues.push({ code: "contracts_unavailable", description: "Не удалось получить список контрактов." });
    }
    try {
      const usd = await client.balanceUsd();
      if (Number.isFinite(usd) && usd >= 0) balance = { available: true, usd };
      else issues.push({ code: "balance_invalid", description: "Walt вернул некорректное значение баланса." });
    } catch {
      issues.push({ code: "balance_unavailable", description: "Не удалось получить баланс." });
    }
  }

  return json({ ok: true, connected: true, readiness, contracts, balance, issues, observedAt });
}

/**
 * Enforce all DEMO order limits on the trusted server. Never accept fees,
 * slippage, leverage limits, market eligibility, or account sizing from the client.
 */
/**
 * Enrich open DEMO positions with a server-observed mark and fee-aware PnL.
 * A missing quote is represented as unavailable; it never becomes a made-up zero.
 */
async function demoAccountView(env: Env, userId: string): Promise<Response> {
  const response = await engineRequest(env, "/account?userId=" + encodeURIComponent(userId));
  if (!response.ok) return response;
  const account = await response.json() as {
    balanceMicro: string;
    positions: Array<{
      id: string; symbol: string; side: "long" | "short"; qtyUnits: string;
      entryPrice: string; entryFeeMicro: string; feePpm: string;
    }>;
  };
  const positions = await Promise.all((account.positions ?? []).map(async (position) => {
    try {
      const mark = await publicMid(position.symbol);
      if (!Number.isFinite(mark) || mark <= 0) throw new Error("Нет свежей котировки.");
      const markUnits = parseFixed(mark.toFixed(8), PRICE_SCALE, 8);
      const grossPnl = pnlMicro(position.side, BigInt(position.qtyUnits), BigInt(position.entryPrice), markUnits);
      const exitNotional = notionalMicro(BigInt(position.qtyUnits), markUnits);
      const exitFee = feeMicro(exitNotional, BigInt(position.feePpm || "0"));
      const estimatedNet = grossPnl - BigInt(position.entryFeeMicro || "0") - exitFee;
      return {
        ...position, markPriceUsd: mark,
        unrealizedGrossPnlMicro: grossPnl.toString(),
        estimatedExitFeeMicro: exitFee.toString(),
        estimatedNetPnlMicro: estimatedNet.toString(),
        markObservedAt: Date.now(),
      };
    } catch {
      return { ...position, markPriceUsd: null, unrealizedGrossPnlMicro: null, estimatedExitFeeMicro: null, estimatedNetPnlMicro: null, markObservedAt: null };
    }
  }));
  return json({ ok: true, balanceMicro: account.balanceMicro, positions });
}

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
  if (!Number.isSafeInteger(leverage) || leverage < 1)
    return fail("Плечо должно быть целым числом не меньше 1.");
  if (body.marginMicro != null && !/^\d{1,18}$/.test(String(body.marginMicro))) return fail("Некорректная сумма маржи.");

  const dailyRisk = await engineRequest(env, "/risk?userId=" + encodeURIComponent(userId)
    + "&maxDailyLossBps=" + Math.round(limits.maxDailyLossPct * 100));
  if (!dailyRisk.ok) return dailyRisk;
  const dailyRiskState = await dailyRisk.json() as { blocked?: boolean };
  if (dailyRiskState.blocked) return fail("Достигнут дневной лимит убытка демо-счёта. Новые сделки заблокированы до 00:00 UTC.", 403);

  const contracts = await publicContracts();
  const contract = contracts.find((item) => item.name.replace(/-USDC?$/i, "").toUpperCase() === symbol);
  if (!contract) return fail("Этот актив сейчас недоступен для демо-торговли.");
  if (!Number.isFinite(contract.maxLeverage) || contract.maxLeverage < 1) return fail("Для этого контракта не получен допустимый лимит плеча.", 503);
  if (!marketAllowed(limits, symbol)) return fail("Этот рынок не входит в список разрешённых.", 403);
  if ((contract.volume24hUsd ?? 0) < limits.minVolume24hUsd) return fail("Недостаточная ликвидность рынка для демо-сделки.");
  const allowedLeverage = contract.maxLeverage;
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
  if (requestedMargin <= 0n) return fail("Маржа должна быть положительной.");
  const notionalMicro = requestedMargin * BigInt(leverage);
  const entryFeeMicro = notionalMicro * feePpm / 1_000_000n;
  const exitFeeMicro = entryFeeMicro;
  const tradeable = maxMarginMicro >= minMarginMicro && maxMarginMicro > 0n
    && requestedMargin >= minMarginMicro && requestedMargin <= maxMarginMicro;
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

/**
 * Server-side LIVE preview via Walt. Prepares order placement and checks leverage,
 * margin, balance, and contract limits without executing.
 */
async function previewLiveTrade(env: Env, userId: string, body: Json): Promise<Response> {
  if (env.LIVE_TRADING_ENABLED !== "true") return fail("LIVE отключён серверным feature gate.", 409);
  const symbol = String(body.market ?? body.symbol ?? "").trim().toUpperCase();
  const side = String(body.side ?? "").toLowerCase();
  const leverage = Number(body.leverage);
  const limits = riskLimits(env);

  if (!/^[A-Z0-9:_-]{2,32}$/.test(symbol)) return fail("Некорректный торговый актив.");
  if (side !== "long" && side !== "short") return fail("Направление должно быть LONG или SHORT.");
  if (!Number.isSafeInteger(leverage) || leverage < 1) return fail("Некорректное целое плечо.");
  if (body.marginUsd == null || !Number.isFinite(Number(body.marginUsd)) || Number(body.marginUsd) <= 0) {
    return fail("Маржа должна быть положительным числом.");
  }
  const marginUsd = Number(body.marginUsd);

  const client = await connectWalt(env).catch(() => null);
  if (!client) return fail("Подключение к Walt не настроено.", 503);

  let contractList;
  try {
    contractList = await client.contracts();
  } catch {
    return fail("Не удалось получить список контрактов от Walt.", 503);
  }
  const contract = contractList.find(
    (item) => item.name.replace(/-USDC?$/i, "").toUpperCase() === symbol
  );
  if (!contract) return fail("Этот актив недоступен в Walt.");
  if (!marketAllowed(limits, symbol)) return fail("Рынок не входит в список разрешённых для LIVE.");
  if (!Number.isSafeInteger(contract.contractId) || contract.contractId < 0 ||
      !Number.isSafeInteger(contract.priceDecimals) || contract.priceDecimals < 0 || contract.priceDecimals > 18 ||
      !Number.isFinite(contract.maxLeverage) || contract.maxLeverage < 1 ||
      !Number.isFinite(contract.minSizeQuote) || contract.minSizeQuote <= 0 ||
      !Number.isFinite(contract.maxSizeQuote) || contract.maxSizeQuote < contract.minSizeQuote) {
    return fail("Walt не вернул корректные лимиты выбранного контракта.", 503);
  }

  const maxAllowedLeverage = contract.maxLeverage;
  if (!Number.isFinite(maxAllowedLeverage) || maxAllowedLeverage < 1) return fail("Не удалось определить допустимое плечо для LIVE.", 503);
  if (leverage > maxAllowedLeverage) {
    return fail(`Плечо превышает допустимый лимит (${maxAllowedLeverage}×).`);
  }

  let existingPosition;
  try {
    existingPosition = await client.openPosition(contract.contractId);
  } catch {
    return fail("Не удалось проверить открытые позиции в Walt.", 503);
  }
  if (existingPosition) return fail("По этому контракту уже есть открытая позиция. Для безопасной сверки сначала закройте её вручную.", 409);

  let currentPriceVal;
  try {
    currentPriceVal = await client.rate(contract);
  } catch {
    return fail("Не удалось получить текущую цену от Walt.", 503);
  }
  if (!Number.isFinite(currentPriceVal) || currentPriceVal <= 0) {
    return fail("Walt вернул некорректную цену.", 502);
  }

  let balanceUsdVal;
  try {
    balanceUsdVal = await client.balanceUsd();
  } catch {
    return fail("Не удалось получить баланс Walt.", 503);
  }
  if (!Number.isFinite(balanceUsdVal) || balanceUsdVal < 0) {
    return fail("Walt вернул некорректный баланс.", 502);
  }

  if (marginUsd > balanceUsdVal) {
    return fail("Маржа превышает доступный баланс Walt.");
  }

  const notionalUsd = marginUsd * leverage;
  if (notionalUsd < contract.minSizeQuote || notionalUsd > contract.maxSizeQuote) {
    return fail(`Объём позиции (${notionalUsd.toFixed(2)} USDC) вне допустимых лимитов контракта (${contract.minSizeQuote} – ${contract.maxSizeQuote}).`);
  }

  const args = {
    contractId: contract.contractId,
    side,
    type: "market",
    leverage,
    amount: marginUsd.toFixed(2),
    price: currentPriceVal.toFixed(contract.priceDecimals),
  };

  let previewResult;
  try {
    previewResult = await client.preview("perps_prepare_order_place", args);
  } catch (e) {
    return fail(`Подготовка ордера в Walt отклонена: ${(e as Error).message}`);
  }

  if (!previewResult.ok || !previewResult.confirmationToken) {
    return fail("Walt отклонил предварительную проверку ордера: " + JSON.stringify(previewResult.risk ?? {}).slice(0, 240), 409);
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const opaqueHandle = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const previewAt = Date.now();
  const expiresAt = previewAt + 120_000;
  await env.STATE.put(
    `live:preview:${userId}:${opaqueHandle}`,
    JSON.stringify({ confirmationToken: previewResult.confirmationToken, expiresAt, previewAt, contractId: contract.contractId, symbol, side, leverage, marginUsd, notionalUsd, priceUsd: currentPriceVal }),
    { expirationTtl: 120 }
  );

  return json({
    ok: true,
    market: symbol,
    side,
    leverage,
    marginUsd,
    notionalUsd,
    priceUsd: currentPriceVal,
    risk: previewResult.risk ?? null,
    warnings: previewResult.warnings ?? [],
    expiresInSeconds: 120,
    handle: opaqueHandle,
  });
}

type LivePreviewRecord = {
  confirmationToken: string;
  expiresAt: number;
  previewAt: number;
  contractId: number;
  symbol: string;
  side: "long" | "short";
  leverage: number;
  marginUsd: number;
  notionalUsd: number;
  priceUsd: number;
};

export function livePositionTimestampMatches(
  raw: Record<string, unknown>,
  previewAt: number,
  operationUpdatedAt: number,
): boolean {
  // Position open-time is stable; updated_at may change after the position is created.
  const rawTime = raw.opened_at ?? raw.created_at ?? raw.openedAt ?? raw.createdAt;
  if (rawTime === undefined || rawTime === null) return false;
  let positionAt = typeof rawTime === "string" && !/^[0-9]+([.][0-9]+)?$/.test(rawTime)
    ? Date.parse(rawTime)
    : Number(rawTime);
  if (Number.isFinite(positionAt) && positionAt < 1_000_000_000_000) positionAt *= 1_000;
  const start = Number(previewAt) - 5_000;
  const end = Number(operationUpdatedAt) + 5_000;
  return Number.isFinite(positionAt) && Number.isFinite(start) && Number.isFinite(end) &&
    positionAt >= start && positionAt <= end;
}

function safeLiveResult(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { message: typeof value === "string" ? value.slice(0, 240) : "Walt подтвердил вызов." };
  }
  const source = value as Record<string, unknown>;
  const result: Json = {};
  for (const key of ["status", "orderId", "order_id", "id", "message", "filledAmount", "filled_amount", "averagePrice", "avgPrice", "avg_price"]) {
    const item = source[key];
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean")
      result[key] = typeof item === "string" ? item.slice(0, 240) : item;
  }
  return result;
}

async function executeLiveTrade(env: Env, scopedEnv: Env, userId: string, body: Json): Promise<Response> {
  if (body.confirm !== true) return fail("Требуется отдельное явное подтверждение LIVE-ордера.", 400);
  if (scopedEnv.LIVE_TRADING_ENABLED !== "true") return fail("LIVE отключён серверным feature gate.", 409);
  const handle = String(body.handle ?? "").trim();
  if (!/^[a-f0-9]{32}$/.test(handle)) return fail("Некорректный идентификатор подготовки ордера.");

  const key = "live:preview:" + userId + ":" + handle;
  const preview = await scopedEnv.STATE.get<LivePreviewRecord>(key, "json");
  if (!preview) {
    const prior = await engineRequest(env, "/live/status?userId=" + encodeURIComponent(userId) + "&handle=" + encodeURIComponent(handle));
    if (prior.ok) {
      const data = await prior.json() as { operation?: Json };
      const priorOperation = data.operation ?? {};
      return json({
        ok: true, alreadyProcessed: true,
        operation: {
          handle: priorOperation.handle, market: priorOperation.symbol, side: priorOperation.side,
          leverage: priorOperation.leverage, marginUsd: priorOperation.marginUsd,
          status: priorOperation.status, result: priorOperation.result ?? null,
        },
      });
    }
    return fail("Подготовка ордера не найдена или срок подтверждения истёк.", 410);
  }
  if (!preview.confirmationToken || !Number.isSafeInteger(preview.contractId) ||
      !Number.isFinite(preview.expiresAt) || preview.expiresAt <= Date.now()) {
    await scopedEnv.STATE.delete(key);
    return fail("Подготовка ордера истекла или повреждена. Создайте новый preview.", 410);
  }

  const client = await connectWalt(scopedEnv).catch(() => null);
  if (!client) return fail("Walt не подключён. Подготовка остаётся доступной до истечения TTL.", 503);

  const claim = await engineRequest(env, "/live/claim", {
    userId, handle, contractId: preview.contractId, symbol: preview.symbol,
    side: preview.side, leverage: preview.leverage, marginUsd: preview.marginUsd,
    notionalUsd: preview.notionalUsd, previewAt: preview.previewAt, expiresAt: preview.expiresAt,
  });
  const claimBody = await claim.json().catch(() => ({})) as Json;
  if (!claim.ok || claimBody.claimed !== true) {
    return json({ ok: false, status: String(claimBody.status ?? "already_processed"), error: "Эта LIVE-подготовка уже использована. Повторное исполнение запрещено." }, 409);
  }

  // Durable Object claim is the atomic replay guard; KV deletion is cleanup only.
  try { await scopedEnv.STATE.delete(key); } catch (error) { console.error("[live] preview token cleanup failed", error); }

  // Re-check immediately before the only LIVE write. A manual/external position
  // may have appeared after preview; never stack a second position on the contract.
  try {
    const existingPosition = await client.openPosition(preview.contractId);
    if (existingPosition) {
      const message = "После подготовки по этому контракту появилась открытая позиция. Новый ордер не отправлен; требуется ручная сверка.";
      const finished = await engineRequest(env, "/live/finish", {
        userId, handle, status: "unknown",
        result: { message, reason: "position_exists_before_execute" },
      });
      if (!finished.ok) console.error("[live] pre-execute position guard status persistence failed", await finished.text());
      return json({ ok: false, status: "unknown", error: message }, 202);
    }
  } catch (error) {
    const message = "Не удалось повторно проверить открытые позиции Walt. Ордер не отправлен; требуется ручная сверка.";
    const finished = await engineRequest(env, "/live/finish", {
      userId, handle, status: "unknown",
      result: { message, reason: "position_check_failed", detail: String((error as Error)?.message ?? "unknown").slice(0, 200) },
    });
    if (!finished.ok) console.error("[live] pre-execute position check status persistence failed", await finished.text());
    return json({ ok: false, status: "unknown", error: message }, 202);
  }

  try {
    const result = await client.call("perps_execute_operation", { confirmationToken: preview.confirmationToken });
    if (result && typeof result === "object" && !Array.isArray(result) && (result as Record<string, unknown>).ok === false)
      throw new Error("Walt вернул отказ при исполнении операции.");
    const summary = safeLiveResult(result);
    const finished = await engineRequest(env, "/live/finish", { userId, handle, status: "completed", result: summary });
    if (!finished.ok) console.error("[live] execution completed but status persistence failed", await finished.text());
    return json({ ok: true, status: "completed", result: summary });
  } catch (error) {
    const message = "Walt не подтвердил результат. Операция помечена UNKNOWN; не отправляйте этот ордер повторно.";
    const summary = { message, detail: String((error as Error)?.message ?? "неизвестная ошибка").slice(0, 240) };
    const finished = await engineRequest(env, "/live/finish", { userId, handle, status: "unknown", result: summary });
    if (!finished.ok) console.error("[live] unknown execution status persistence failed", await finished.text());
    return json({ ok: false, status: "unknown", error: message }, 202);
  }
}

async function liveOperationView(env: Env, scopedEnv: Env, userId: string, handle: string): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(handle)) return fail("Некорректный идентификатор LIVE-операции.");
  const response = await engineRequest(env, "/live/status?userId=" + encodeURIComponent(userId) + "&handle=" + encodeURIComponent(handle));
  if (!response.ok) return fail("LIVE-операция не найдена.", response.status);
  const data = await response.json() as { operation?: Json };
  const operation = data.operation;
  if (!operation) return fail("LIVE-операция не найдена.", 404);

  let status = String(operation.status ?? "unknown");
  let reconciliation: Json | null = null;
  const staleExecuting = status === "executing" && Date.now() - Number(operation.updatedAt ?? Date.now()) > 60_000;
  if (staleExecuting) {
    await engineRequest(env, "/live/finish", { userId, handle, status: "unknown", result: { message: "Execution response timed out; read-only reconciliation required." } });
    status = "unknown";
  }
  if (status === "unknown") {
    const priorResult = operation.result && typeof operation.result === "object"
      ? operation.result as Json
      : {};
    const priorReason = String(priorResult.reason ?? "");
    if (priorReason === "position_exists_before_execute" || priorReason === "position_check_failed") {
      // The order was deliberately NOT sent. A position observed in this state
      // cannot be attributed to our handle, even if its timestamp looks recent.
      reconciliation = {
        positionDetected: priorReason === "position_exists_before_execute",
        message: priorReason === "position_exists_before_execute"
          ? "До отправки ордера уже обнаружена позиция. Она не относится к этой операции автоматически; требуется ручная проверка."
          : "Не удалось проверить позицию до отправки. Ордер не отправлялся; требуется ручная проверка.",
      };
    } else {
    const client = await connectWalt(scopedEnv).catch(() => null);
    if (!client) {
      reconciliation = { positionDetected: false, message: "Walt недоступен для read-only сверки. Не повторяйте ордер." };
    } else {
      try {
        const position = await client.openPosition(Number(operation.contractId));
        if (!position) {
          reconciliation = { positionDetected: false, message: "Открытая позиция не обнаружена. Результат остаётся UNKNOWN; повторно не исполняйте ордер." };
        } else {
          const raw = position.raw ?? {};
          const rawSide = String(raw.side ?? raw.position_side ?? raw.direction ?? "").toLowerCase();
          const expectedSide = String(operation.side ?? "");
          const sideMatches = rawSide === expectedSide || (expectedSide === "long" && rawSide === "buy") || (expectedSide === "short" && rawSide === "sell");
          const timeMatches = livePositionTimestampMatches(
            raw,
            Number(operation.previewAt ?? 0),
            Number(operation.updatedAt ?? Date.now()),
          );
          const summary = {
            positionDetected: true, sideMatches, timeMatches,
            contractId: position.contractId, avgEntryPrice: position.avgEntryPrice ?? null,
            valueBase: position.valueBase ?? null, marginQuote: position.marginQuote ?? null,
            liquidationPrice: position.liquidationPrice ?? null,
          };
          if (sideMatches && timeMatches) {
            const finished = await engineRequest(env, "/live/finish", { userId, handle, status: "reconciled", result: summary });
            if (finished.ok) status = "reconciled";
          }
          reconciliation = {
            ...summary,
            message: sideMatches && timeMatches
              ? "Позиция совпала по контракту, стороне и времени после preview."
              : "Позиция обнаружена, но её нельзя однозначно связать с этой операцией. Требуется ручная проверка; повторное исполнение запрещено.",
          };
        }
      } catch {
        reconciliation = { positionDetected: false, message: "Не удалось сверить позицию через Walt. Статус остаётся UNKNOWN; не повторяйте ордер." };
      }
    }
    }
  }

  return json({
    ok: true,
    operation: {
      handle, market: operation.symbol, side: operation.side, leverage: operation.leverage,
      marginUsd: operation.marginUsd, notionalUsd: operation.notionalUsd,
      status, createdAt: operation.createdAt, updatedAt: operation.updatedAt, result: operation.result ?? null,
    },
    reconciliation,
  });
}

async function openDemoTrade(env: Env, userId: string, body: Json): Promise<Response> {
  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  const side = String(body.side ?? "");
  const leverage = Number(body.leverage);
  const limits = riskLimits(env);
  if (!/^[A-Z0-9:_-]{2,32}$/.test(symbol)) return fail("Некорректный торговый актив.");
  if (side !== "long" && side !== "short") return fail("Направление должно быть LONG или SHORT.");
  if (!Number.isSafeInteger(leverage) || leverage < 1)
    return fail("Плечо должно быть целым числом не меньше 1.");

  const rawMargin = String(body.marginMicro ?? "");
  if (!/^\d{1,18}$/.test(rawMargin)) return fail("Некорректная сумма маржи.");
  const marginMicro = BigInt(rawMargin);
  if (marginMicro <= 0n) return fail("Маржа должна быть положительной.");

  const contracts = await publicContracts();
  const contract = contracts.find((item) => item.name.replace(/-USDC?$/i, "").toUpperCase() === symbol);
  if (!contract) return fail("Этот актив сейчас недоступен для демо-торговли.");
  if (!Number.isFinite(contract.maxLeverage) || contract.maxLeverage < 1) return fail("Для этого контракта не получен допустимый лимит плеча.", 503);
  if (!marketAllowed(limits, symbol)) return fail("Этот рынок не входит в список разрешённых.", 403);
  if ((contract.volume24hUsd ?? 0) < limits.minVolume24hUsd)
    return fail("Недостаточная ликвидность рынка для демо-сделки.");
  const allowedLeverage = contract.maxLeverage;
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
    maxDailyLossBps: String(Math.round(limits.maxDailyLossPct * 100)),
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

async function updateProductMode(env: Env, userId: string, body: Json): Promise<Response> {
  const requested = body.productMode;
  if (requested !== "demo" && requested !== "ai" && requested !== "live")
    return fail("Режим должен быть demo, ai или live.");
  if (requested === "live")
    return fail("LIVE пока заблокирован до подтверждения полного торгового и close-контракта.", 409);
  const state = await loadState(env);
  const nextMode = normalizeProductMode(requested);
  if (normalizeProductMode(state.productMode) === "ai" && nextMode !== "ai") {
    try {
      const stopped = await engineRequest(env, "/ai/paper/session/stop", { userId });
      if (!stopped.ok && stopped.status !== 404)
        return fail("Не удалось подтвердить остановку AI paper сессии. Повторите переключение режима.", 503);
    } catch {
      return fail("Не удалось связаться с AI paper счётом для безопасной остановки сессии.", 503);
    }
  }
  state.marketMode = "demo";
  state.tradingMethod = nextMode === "ai" ? "ai_piper" : "manual";
  state.productMode = nextMode === "ai" ? "ai" : "demo";
  await saveState(env, state);
  return json({
    ok: true,
    marketMode: state.marketMode,
    tradingMethod: state.tradingMethod,
    productMode: state.productMode,
    executionMode: state.mode,
  });
}

async function startAiPaperSession(env: Env, userId: string): Promise<Response> {
  const state = await loadState(env);
  if (normalizeProductMode(state.productMode) !== "ai")
    return fail("Выберите режим AI Trading перед запуском AI paper сессии.", 409);
  return engineRequest(env, "/ai/paper/session/start", { userId });
}

async function fundAiPaper(env: Env, userId: string, body: Json): Promise<Response> {
  const state = await loadState(env);
  if (normalizeProductMode(state.productMode) !== "ai")
    return fail("Выберите режим AI Trading перед виртуальным пополнением.", 409);
  const amountText = String(body.amountUsd ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(amountText))
    return fail("Сумма должна быть положительным числом с точностью до двух знаков.");
  let amountMicro: bigint;
  try { amountMicro = parseFixed(amountText, MONEY_SCALE, 6); }
  catch { return fail("Некорректная сумма виртуального пополнения."); }
  if (amountMicro <= 0n) return fail("Сумма пополнения должна быть больше нуля.");
  const idempotencyKey = String(body.idempotencyKey ?? "");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
    return fail("Не задан корректный ключ идемпотентности.");
  return engineRequest(env, "/ai/paper/fund", {
    userId,
    amountMicro: amountMicro.toString(),
    idempotencyKey,
  });
}

async function withdrawAiPaper(env: Env, userId: string, body: Json): Promise<Response> {
  const state = await loadState(env);
  if (normalizeProductMode(state.productMode) !== "ai")
    return fail("Выберите режим AI Trading перед возвратом виртуальных средств.", 409);
  const amountText = String(body.amountUsd ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(amountText))
    return fail("Сумма должна быть положительным числом с точностью до двух знаков.");
  let amountMicro: bigint;
  try { amountMicro = parseFixed(amountText, MONEY_SCALE, 6); }
  catch { return fail("Некорректная сумма возврата."); }
  if (amountMicro <= 0n) return fail("Сумма возврата должна быть больше нуля.");
  const idempotencyKey = String(body.idempotencyKey ?? "");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
    return fail("Не задан корректный ключ идемпотентности.");
  return engineRequest(env, "/ai/paper/withdraw", {
    userId,
    amountMicro: amountMicro.toString(),
    idempotencyKey,
  });
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
    marketMode: s.marketMode ?? "demo",
    tradingMethod: s.tradingMethod ?? "manual",
    productMode: normalizeProductMode(s.productMode),
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
  // Kripto Guru Mini App is DEMO-only. Its public market catalogue must not
  // depend on the legacy Telegram bot's global LIVE/PAPER mode or Walt OAuth.
  const list = await publicContracts();
  return list
    .map((c) => {
      const market = c.name.replace(/-USDC?$/i, "");
      const liquid = (c.volume24hUsd ?? 0) >= limits.minVolume24hUsd;
      return {
        market,
        ...c,
        source: "hyperliquid",
        liquid,
        // Display public quotes even when a market is below the trading
        // liquidity threshold; the order preview enforces eligibility.
        allowed: liquid && marketAllowed(limits, market),
      };
    })
    .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
}

async function priceView(env: Env, market: string, leverage: number) {
  // The Mini App always displays the same verified public DEMO quote source.
  const contract = findContract(await publicContracts(), market);
  if (!contract) throw new Error(`рынок ${market} не найден`);
  if (!Number.isFinite(contract.maxLeverage) || contract.maxLeverage < 1) throw new Error("Для контракта не получен допустимый лимит плеча.");
  const price = await publicMid(market);
  const lev = Math.max(1, Math.min(Math.trunc(leverage) || 1, contract.maxLeverage));
  return {
    market: market.toUpperCase(),
    price,
    leverage: lev,
    maxDemoLeverage: contract.maxLeverage,
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
    // Telegram Web Apps HMAC: HMAC-SHA256(key="WebAppData", message=botToken).
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

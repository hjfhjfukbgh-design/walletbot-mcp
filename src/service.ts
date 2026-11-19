// Operações do bot usadas pelos comandos do Telegram e pela API da Mini App.
import { riskLimits, type Env } from "./env";
import { connectWalt, currentPrice } from "./bot";
import { publicContracts, publicMid } from "./prices";
import { cachedContracts, loadState, saveState } from "./state";
import { marketAllowed } from "./risk";
import { notional, sizeError, step, stopLossPrice, validateConfig, type GridConfig } from "./strategy/grid";
import { findContract, type Walt } from "./walt";
import { loadManualPositions } from "./manual";

export async function walt(env: Env): Promise<Walt> {
  const w = await connectWalt(env);
  if (!w) throw new Error("Walt не подключён — используйте /connect");
  return w;
}

export async function stopGrid(env: Env): Promise<string> {
  const s = await loadState(env);
  s.running = false;
  await saveState(env, s);
  return "Сетка остановлена. Открытая позиция (если есть) остаётся с TP/SL на стороне Walt. Для закрытия используйте /closeall.";
}

export async function resumeGrid(env: Env): Promise<string> {
  const s = await loadState(env);
  s.paused = undefined;
  s.day = undefined; // recomeça a contagem de perda diária
  await saveState(env, s);
  return "Пауза снята. Следующая проверка сетки выполнится по расписанию.";
}

export async function configureGrid(env: Env, args: string[]): Promise<string> {
  const limits = riskLimits(env);
  const market = (args[0] ?? "BTC").toUpperCase();
  const state = await loadState(env);
  if (state.mode === "live" && !marketAllowed(limits, market)) return `Рынок не входит в список разрешённых: ${limits.allowedMarkets.join(", ")}`;
  const contract = state.mode === "live"
    ? findContract(await cachedContracts(env, async () => (await walt(env)).contracts()), market)
    : findContract(await publicContracts(), market);
  if (!contract) return `Рынок ${market} не найден в публичном списке или в Walt.`;
  if ((contract.volume24hUsd ?? 0) < limits.minVolume24hUsd)
    return `Объём торгов ${market} за 24 часа — ${Math.round(contract.volume24hUsd ?? 0).toLocaleString("ru-RU")}, это ниже минимального порога ${limits.minVolume24hUsd.toLocaleString("ru-RU")} (недостаточная ликвидность).`;
  if (args.length < 5) {
    // sugestão pronta para copiar: faixa de −6% a +2% do preço atual
    const price = state.mode === "live" ? await (await walt(env)).rate(contract) : await publicMid(market);
    const d = contract.priceDecimals;
    const lo = (price * 0.94).toFixed(d);
    const hi = (price * 1.02).toFixed(d);
    return [
      `Текущая цена ${market}: ${price}`,
      "",
      "Использование: /grid <рынок> <нижняя граница> <верхняя граница> <уровни> <маржа в USD на сделку> [плечо]",
      "Рекомендация (диапазон −6% / +2%, 8 уровней, маржа $5, плечо 3x) — скопируйте и отправьте:",
      `/grid ${market} ${lo} ${hi} 8 5 3`,
    ].join("\n");
  }
  const cfg: GridConfig = {
    market,
    contract,
    low: Number(args[1]),
    high: Number(args[2]),
    levels: Number(args[3]),
    marginUsd: Number(args[4]),
    leverage: Math.trunc(Number(args[5] ?? 1)),
  };
  const err = validateConfig(cfg);
  if (err) return `Некорректные настройки: ${err}`;
  const s = await loadState(env);
  if (s.grid?.position) return "В текущей сетке есть открытая позиция. Перед изменением настроек используйте /closeall.";
  const price = state.mode === "live" ? await (await walt(env)).rate(contract) : await publicMid(market);
  const sizeErr = sizeError(cfg, Math.min(price, cfg.high));
  if (sizeErr) return `Некорректные настройки: ${sizeErr}`;
  s.grid = { cfg };
  s.running = false;
  await saveState(env, s);
  return [
    `Сетка ${market} (контракт №${contract.contractId}) настроена:`,
    `• ${cfg.levels} уровней с шагом ${step(cfg).toFixed(contract.priceDecimals)} в диапазоне ${cfg.low}–${cfg.high} (текущая цена ${price})`,
    `• Каждая сделка: маржа ${cfg.marginUsd}, плечо ${cfg.leverage}x, объём ≈ ${notional(cfg).toFixed(2)}, тейк-профит на следующем уровне`,
    `• Стоп-лосс: ${stopLossPrice(cfg, limits.stopLossPct).toFixed(contract.priceDecimals)} (остановит сетку)`,
    `Для запуска используйте /run (режим ${s.mode}).`,
  ].join("\n");
}

export async function runGrid(env: Env): Promise<string> {
  const s = await loadState(env);
  if (!s.grid) return "Сначала настройте сетку командой /grid.";
  if (s.mode === "paper" && (await loadManualPositions(env)).length) return "Сначала закройте все ручные демо-позиции, затем запускайте сетку.";
  const price = await currentPrice(s.grid.cfg, s.mode === "live" ? await connectWalt(env) : null);
  const { low, high } = s.grid.cfg;
  const warn =
    price > high || price < low ? `\n⚠️ Цена вне диапазона ${low}–${high}: вход произойдёт, только когда цена вернётся в диапазон.` : "";
  s.running = true;
  s.paused = undefined;
  s.lastPrice = price;
  await saveState(env, s);
  return `▶️ Сетка ${s.grid.cfg.market} запущена в режиме ${(s.mode === 'paper' ? 'ДЕМО' : 'LIVE')} (цена ${price}). Проверка каждые 5 минут.${warn}`;
}

export async function setMode(env: Env, args: string[]): Promise<string> {
  const s = await loadState(env);
  const target = args[0]?.toLowerCase();
  if (target !== "paper" && target !== "live") return `Modo atual: ${s.mode === "paper" ? "ДЕМО" : "LIVE"}. Используйте /demo или /live CONFIRMO.`;
  if (s.grid?.position) return "Перед сменой режима закройте позицию командой /closeall.";
  if (target === "live") {
    return "LIVE пока закрыт: сначала подключаем подтверждение каждой сделки, сверку открытых позиций и жёсткие лимиты риска. ДЕМО работает полностью без кошелька.";
  }
  s.mode = target;
  s.grid = undefined; // DEMO and LIVE use different contract identifiers
  s.running = false;
  s.day = undefined;
  await saveState(env, s);
  return `Режим ${target === "paper" ? "ДЕМО" : "LIVE"} включён. Сетка остановлена — запустите её командой /run.`;
}

export type PaperSignal = {
  signal: "long" | "short" | "hold";
  shortAverage: number | null;
  longAverage: number | null;
  reason: string;
};

/** Pure moving-average baseline for DEMO/paper research; never executes trades. */
export function buildPaperSignal(
  prices: number[],
  shortWindow = 5,
  longWindow = 20,
): PaperSignal {
  const hold = (reason: string): PaperSignal => ({
    signal: "hold", shortAverage: null, longAverage: null, reason,
  });
  if (!Array.isArray(prices) || !prices.every(price => Number.isFinite(price) && price > 0))
    return hold("Недостаточно корректных положительных цен для анализа.");
  if (!Number.isSafeInteger(shortWindow) || !Number.isSafeInteger(longWindow) ||
      shortWindow < 1 || longWindow < 2 || shortWindow >= longWindow)
    return hold("Окна скользящих средних заданы некорректно.");
  if (prices.length < longWindow)
    return hold("Недостаточно истории для расчёта длинной скользящей средней.");

  const shortPrices = prices.slice(-shortWindow);
  const longPrices = prices.slice(-longWindow);
  const shortAverage = shortPrices.reduce((sum, price) => sum + price, 0) / shortWindow;
  const longAverage = longPrices.reduce((sum, price) => sum + price, 0) / longWindow;
  if (shortAverage > longAverage)
    return { signal: "long", shortAverage, longAverage, reason: "Короткая средняя выше длинной." };
  if (shortAverage < longAverage)
    return { signal: "short", shortAverage, longAverage, reason: "Короткая средняя ниже длинной." };
  return { signal: "hold", shortAverage, longAverage, reason: "Скользящие средние совпадают." };
}


export type AiPaperDecision = {
  signal: "buy" | "sell" | "hold";
  symbol: string;
  rationale: string;
  confidence: number;
};

/**
 * Parse the model's strict JSON decision. Prices, risk approval, tenant IDs and
 * position IDs are deliberately excluded: those values must come from the
 * server-side market snapshot and risk engine, never from Gemini.
 */
export function parseAiPaperDecision(
  raw: string,
  allowedSymbols: readonly string[],
): { ok: true; decision: AiPaperDecision } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_000)
    return { ok: false, reason: "Ответ модели пустой или превышает допустимый размер." };
  if (!Array.isArray(allowedSymbols) || allowedSymbols.length === 0)
    return { ok: false, reason: "Нет подтверждённого списка разрешённых рынков." };
  const allowed = new Set(allowedSymbols.map(symbol => String(symbol).trim().toUpperCase()).filter(Boolean));
  if (allowed.size === 0)
    return { ok: false, reason: "Нет подтверждённого списка разрешённых рынков." };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "Ответ модели не является строгим JSON." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, reason: "Решение модели должно быть JSON-объектом." };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 4 || keys.join(",") !== "confidence,rationale,signal,symbol")
    return { ok: false, reason: "JSON решения содержит отсутствующие или лишние поля." };
  const signal = record.signal;
  const symbol = typeof record.symbol === "string" ? record.symbol.trim().toUpperCase() : "";
  const rationale = typeof record.rationale === "string" ? record.rationale.trim() : "";
  const confidence = record.confidence;
  if (signal !== "buy" && signal !== "sell" && signal !== "hold")
    return { ok: false, reason: "Недопустимый сигнал модели." };
  if (!/^[A-Z0-9]{2,20}$/.test(symbol) || !allowed.has(symbol))
    return { ok: false, reason: "Модель выбрала рынок вне серверного allowlist." };
  if (!rationale || rationale.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(rationale))
    return { ok: false, reason: "Обоснование модели пустое или некорректное." };
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    return { ok: false, reason: "Уверенность модели должна быть числом от 0 до 1." };
  return { ok: true, decision: { signal, symbol, rationale, confidence } };
}

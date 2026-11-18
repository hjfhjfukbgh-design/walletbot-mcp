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

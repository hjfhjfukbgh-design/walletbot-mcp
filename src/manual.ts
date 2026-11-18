import { riskLimits, type Env } from "./env";
import { publicContracts, publicMid } from "./prices";
import { loadState, saveState } from "./state";
import { recordTrade } from "./history";
import { findContract } from "./walt";

export type TradeSide = "long" | "short";
export interface ManualPosition {
  id: string;
  market: string;
  side: TradeSide;
  entryPrice: number;
  qty: number;
  marginUsd: number;
  notionalUsd: number;
  leverage: number;
  takeProfit: number | null;
  stopLoss: number | null;
  liquidationPrice: number;
  takerFeePct: number;
  entryFeeUsd: number;
  openedAt: string;
}
const KEY = "paper:manual:positions:v1";
const MAINTENANCE_MARGIN_RATE = 0.005;

export function directionalPnl(position: Pick<ManualPosition, "side" | "entryPrice" | "qty" | "takerFeePct">, mark: number): number {
  const direction = position.side === "long" ? 1 : -1;
  return direction * position.qty * (mark - position.entryPrice) - position.qty * mark * position.takerFeePct;
}
export function estimateLiquidationPrice(entry: number, qty: number, margin: number, feeRate: number, side: TradeSide): number {
  const notional = entry * qty;
  const availableLoss = margin - notional * MAINTENANCE_MARGIN_RATE - notional * feeRate;
  if (!(availableLoss > 0) || !(qty > 0)) throw new Error("Маржи недостаточно для расчёта ликвидации. Уменьшите плечо или увеличьте маржу.");
  const distance = availableLoss / qty;
  return Number((side === "long" ? Math.max(0, entry - distance) : entry + distance).toPrecision(12));
}
export function liquidationHit(position: ManualPosition, price: number): boolean {
  return position.side === "long" ? price <= position.liquidationPrice : price >= position.liquidationPrice;
}
export function exitReason(position: ManualPosition, price: number): "tp" | "sl" | "liquidation" | null {
  if (liquidationHit(position, price)) return "liquidation";
  if (position.takeProfit !== null && (position.side === "long" ? price >= position.takeProfit : price <= position.takeProfit)) return "tp";
  if (position.stopLoss !== null && (position.side === "long" ? price <= position.stopLoss : price >= position.stopLoss)) return "sl";
  return null;
}
export async function loadManualPositions(env: Env): Promise<ManualPosition[]> {
  return (await env.STATE.get<ManualPosition[]>(KEY, "json")) ?? [];
}
async function saveManualPositions(env: Env, positions: ManualPosition[]): Promise<void> {
  await env.STATE.put(KEY, JSON.stringify(positions));
}
export async function openManualTrade(
  env: Env,
  input: { market: string; side: TradeSide; marginUsd: number; leverage: number; takeProfit?: number | null; stopLoss?: number | null },
): Promise<{ message: string; position: ManualPosition }> {
  const state = await loadState(env);
  if (state.mode !== "paper") throw new Error("Ручные сделки доступны только в режиме ДЕМО. LIVE заблокирован.");
  if (state.running || state.grid?.position) throw new Error("Сначала остановите сетку и закройте её позицию. Ручные сделки и сетка используют общий демо-баланс.");
  const market = input.market.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(market)) throw new Error("Некорректный торговый актив.");
  if (input.side !== "long" && input.side !== "short") throw new Error("Направление должно быть LONG или SHORT.");
  const contracts = await publicContracts();
  const contract = findContract(contracts, market);
  if (!contract) throw new Error(`Рынок ${market} не найден в публичном списке.`);
  if ((contract.volume24hUsd ?? 0) < riskLimits(env).minVolume24hUsd) throw new Error("Недостаточная ликвидность рынка для демо-сделки.");
  const price = await publicMid(market);
  const leverage = Math.trunc(input.leverage);
  const marginUsd = Number(input.marginUsd);
  const limits = riskLimits(env);
  if (!Number.isFinite(marginUsd) || marginUsd < 1) throw new Error("Маржа должна быть не меньше $1.");
  if (!Number.isFinite(contract.maxLeverage) || contract.maxLeverage < 1) throw new Error("Для контракта не получен допустимый лимит плеча.");
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > contract.maxLeverage) throw new Error(`Плечо должно быть от 1x до ${contract.maxLeverage}x.`);
  const notionalUsd = marginUsd * leverage;
  if (notionalUsd < contract.minSizeQuote || notionalUsd > contract.maxSizeQuote) throw new Error(`Объём позиции должен быть от ${contract.minSizeQuote} до ${contract.maxSizeQuote} USDC.`);
  const qty = notionalUsd / price;
  const fee = notionalUsd * contract.takerFeePct;
  const takeProfit = input.takeProfit == null || input.takeProfit === 0 ? null : Number(input.takeProfit);
  const stopLoss = input.stopLoss == null || input.stopLoss === 0 ? null : Number(input.stopLoss);
  if (takeProfit !== null && (!Number.isFinite(takeProfit) || (input.side === "long" ? takeProfit <= price : takeProfit >= price))) throw new Error(input.side === "long" ? "Для LONG тейк-профит должен быть выше текущей цены." : "Для SHORT тейк-профит должен быть ниже текущей цены.");
  if (stopLoss !== null && (!Number.isFinite(stopLoss) || (input.side === "long" ? stopLoss >= price : stopLoss <= price) || stopLoss <= 0)) throw new Error(input.side === "long" ? "Для LONG стоп-лосс должен быть ниже текущей цены." : "Для SHORT стоп-лосс должен быть выше текущей цены.");
  const positions = await loadManualPositions(env);
  if (positions.some((p) => p.market === market)) throw new Error(`По ${market} уже есть открытая ручная позиция. Сначала закройте её.`);
  const gridMargin = state.grid?.position?.marginUsd ?? 0;
  const openMargin = positions.reduce((sum, p) => sum + p.marginUsd, 0) + gridMargin;
  const equity = state.paper.cash + positions.reduce((sum, p) => sum + p.marginUsd + directionalPnl(p, price), 0);
  if (marginUsd > equity * limits.maxOrderPct / 100) throw new Error(`Маржа превышает лимит одной сделки (${limits.maxOrderPct}% капитала).`);
  if (openMargin + marginUsd > equity * limits.maxTotalExposurePct / 100) throw new Error(`Общая маржа превысит лимит ${limits.maxTotalExposurePct}% капитала.`);
  if (state.paper.cash < marginUsd + fee) throw new Error(`Недостаточно свободных средств. Нужно ${(marginUsd + fee).toFixed(2)} USDC с учётом комиссии входа.`);
  const liquidationPrice = estimateLiquidationPrice(price, qty, marginUsd, contract.takerFeePct, input.side);
  if (input.side === "long" && stopLoss !== null && stopLoss <= liquidationPrice) throw new Error("Стоп-лосс LONG должен быть выше расчётной цены ликвидации.");
  if (input.side === "short" && stopLoss !== null && stopLoss >= liquidationPrice) throw new Error("Стоп-лосс SHORT должен быть ниже расчётной цены ликвидации.");
  const position: ManualPosition = {
    id: crypto.randomUUID(), market, side: input.side, entryPrice: price, qty, marginUsd, notionalUsd, leverage,
    takeProfit, stopLoss, liquidationPrice, takerFeePct: contract.takerFeePct, entryFeeUsd: fee, openedAt: new Date().toISOString(),
  };
  state.paper.cash -= marginUsd + fee;
  await saveState(env, state);
  positions.push(position);
  await saveManualPositions(env, positions);
  await recordTrade(env, { at: position.openedAt, market, event: "open", price, marginUsd, leverage, mode: "paper", side: input.side, qty, reason: "manual" });
  return { position, message: `${input.side === "long" ? "LONG" : "SHORT"} ${market} открыта по ${price}. Объём ${notionalUsd.toFixed(2)} USDC, маржа ${marginUsd.toFixed(2)} USDC, плечо ${leverage}x.` };
}
export async function closeManualTrade(env: Env, id: string): Promise<string> {
  const positions = await loadManualPositions(env);
  const position = positions.find((p) => p.id === id);
  if (!position) throw new Error("Открытая демо-позиция не найдена.");
  const price = await publicMid(position.market);
  const grossPnl = directionalPnl(position, price);
  const pnl = grossPnl - position.entryFeeUsd;
  const state = await loadState(env);
  state.paper.cash += position.marginUsd + grossPnl;
  state.stats.trades++;
  state.stats.realizedPnl += pnl;
  if (pnl >= 0) state.stats.wins++; else state.stats.losses++;
  await saveState(env, state);
  await saveManualPositions(env, positions.filter((p) => p.id !== id));
  await recordTrade(env, { at: new Date().toISOString(), market: position.market, event: "close", price, marginUsd: position.marginUsd, leverage: position.leverage, pnl, reason: "manual", mode: "paper", side: position.side, qty: position.qty });
  return `${position.side.toUpperCase()} ${position.market} закрыта по ${price}. Результат с комиссией выхода: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDC.`;
}
export async function monitorManualTrades(env: Env): Promise<string[]> {
  const state = await loadState(env);
  if (state.mode !== "paper") return [];
  const positions = await loadManualPositions(env);
  if (!positions.length) return [];
  const messages: string[] = [];
  const remaining: ManualPosition[] = [];
  for (const position of positions) {
    let price: number;
    try { price = await publicMid(position.market); } catch { remaining.push(position); continue; }
    const reason = exitReason(position, price);
    if (!reason) { remaining.push(position); continue; }
    const grossPnl = reason === "liquidation" ? -position.marginUsd : directionalPnl(position, price);
    const pnl = grossPnl - position.entryFeeUsd;
    const exit = reason === "liquidation" ? position.liquidationPrice : price;
    state.paper.cash += position.marginUsd + grossPnl;
    state.stats.trades++;
    state.stats.realizedPnl += pnl;
    if (pnl >= 0) state.stats.wins++; else state.stats.losses++;
    await recordTrade(env, { at: new Date().toISOString(), market: position.market, event: "close", price: exit, marginUsd: position.marginUsd, leverage: position.leverage, pnl, reason: reason === "liquidation" ? "sl" : reason, mode: "paper", side: position.side, qty: position.qty });
    messages.push(reason === "liquidation"
      ? `⚠️ Демо-позиция ${position.side.toUpperCase()} ${position.market} достигла расчётной ликвидации. Списана маржа ${position.marginUsd.toFixed(2)} USDC.`
      : `Демо-позиция ${position.side.toUpperCase()} ${position.market} закрыта по ${reason === "tp" ? "TP" : "SL"}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDC.`);
  }
  if (remaining.length !== positions.length) {
    await saveManualPositions(env, remaining);
    await saveState(env, state);
  }
  return messages;
}
export async function manualPositionsView(env: Env) {
  const positions = await loadManualPositions(env);
  return Promise.all(positions.map(async (p) => {
    let markPrice = p.entryPrice;
    try { markPrice = await publicMid(p.market); } catch {}
    const grossUnrealizedPnl = directionalPnl(p, markPrice);
    const unrealizedPnl = grossUnrealizedPnl - p.entryFeeUsd;
    return { ...p, markPrice, unrealizedPnl, estimatedEquity: p.marginUsd + grossUnrealizedPnl };
  }));
}

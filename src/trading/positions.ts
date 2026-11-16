import { feeMicro, notionalMicro, pnlMicro, quantityUnits, divRound, PPM_SCALE } from "./money";

export type Side = "long" | "short";
export type ExitReason = "liquidation" | "stop_loss" | "take_profit" | "manual";
export interface PositionInput {
  id: string;
  userId: string;
  symbol: string;
  side: Side;
  marginMicro: bigint;
  leverage: bigint;
  entryPrice: bigint;
  takeProfitPrice?: bigint | null;
  stopLossPrice?: bigint | null;
  liquidationPrice: bigint;
  feePpm: bigint;
  slippagePpm: bigint;
}
export interface Position extends PositionInput {
  qtyUnits: bigint;
  entryNotionalMicro: bigint;
  entryFeeMicro: bigint;
  status: "open" | "closed";
}
export interface OpenResult {
  position: Position;
  balanceAfterMicro: bigint;
  balanceDeltaMicro: bigint;
}
export interface Trigger {
  reason: ExitReason;
  quotePrice: bigint;
  executionPrice: bigint;
}
export interface CloseResult {
  position: Position;
  reason: ExitReason;
  quotePrice: bigint;
  executionPrice: bigint;
  grossPnlMicro: bigint;
  exitFeeMicro: bigint;
  netPnlMicro: bigint;
  releasedMarginMicro: bigint;
  balanceDeltaMicro: bigint;
}

function applySlippage(price: bigint, side: Side, slippagePpm: bigint): bigint {
  if (price <= 0n || slippagePpm < 0n || slippagePpm >= PPM_SCALE) throw new Error("Некорректная цена или проскальзывание.");
  const factor = side === "long" ? PPM_SCALE - slippagePpm : PPM_SCALE + slippagePpm;
  return divRound(price * factor, PPM_SCALE, side === "long" ? "floor" : "ceil");
}

/** Pure open calculation. Caller atomically persists result and reserves margin + entry fee. */
export function openPosition(input: PositionInput, availableBalanceMicro: bigint): OpenResult {
  if (!input.id || !input.userId || !input.symbol) throw new Error("Не заполнены идентификаторы позиции.");
  if (input.marginMicro <= 0n || input.leverage <= 0n || input.entryPrice <= 0n) throw new Error("Маржа, плечо и цена должны быть положительными.");
  if (input.feePpm < 0n || input.slippagePpm < 0n || input.slippagePpm >= PPM_SCALE) throw new Error("Некорректные параметры комиссии/проскальзывания.");
  if (input.takeProfitPrice != null && input.takeProfitPrice <= 0n) throw new Error("Некорректный TP.");
  if (input.stopLossPrice != null && input.stopLossPrice <= 0n) throw new Error("Некорректный SL.");
  if (input.liquidationPrice <= 0n) throw new Error("Некорректная оценочная цена ликвидации.");
  if (input.side === "long" && ((input.takeProfitPrice != null && input.takeProfitPrice <= input.entryPrice) || (input.stopLossPrice != null && input.stopLossPrice >= input.entryPrice))) throw new Error("У LONG TP должен быть выше входа, а SL ниже.");
  if (input.side === "short" && ((input.takeProfitPrice != null && input.takeProfitPrice >= input.entryPrice) || (input.stopLossPrice != null && input.stopLossPrice <= input.entryPrice))) throw new Error("У SHORT TP должен быть ниже входа, а SL выше.");
  const qtyUnits = quantityUnits(input.marginMicro, input.leverage, input.entryPrice);
  if (qtyUnits <= 0n) throw new Error("Размер позиции слишком мал.");
  const entryNotionalMicro = notionalMicro(qtyUnits, input.entryPrice);
  const entryFeeMicro = feeMicro(entryNotionalMicro, input.feePpm);
  const reserved = input.marginMicro + entryFeeMicro;
  if (availableBalanceMicro < reserved) throw new Error("Недостаточно демо-баланса для маржи и комиссии.");
  return {
    position: { ...input, qtyUnits, entryNotionalMicro, entryFeeMicro, status: "open" },
    balanceAfterMicro: availableBalanceMicro - reserved,
    balanceDeltaMicro: -reserved,
  };
}

/** Pure unrealized P&L at a quote price, before exit fee and slippage. */
export function unrealizedPnl(position: Position, quotePrice: bigint): bigint {
  if (position.status !== "open") return 0n;
  if (quotePrice <= 0n) throw new Error("Цена котировки должна быть положительной.");
  return pnlMicro(position.side, position.qtyUnits, position.entryPrice, quotePrice);
}

/**
 * Trigger priority is liquidation > SL > TP.
 * Execution is adverse to the trader: long exits sell lower, short exits buy higher.
 */
export function checkTrigger(position: Position, quotePrice: bigint): Trigger | null {
  if (position.status !== "open" || quotePrice <= 0n) return null;
  let reason: ExitReason | null = null;
  if (position.side === "long") {
    if (quotePrice <= position.liquidationPrice) reason = "liquidation";
    else if (position.stopLossPrice != null && quotePrice <= position.stopLossPrice) reason = "stop_loss";
    else if (position.takeProfitPrice != null && quotePrice >= position.takeProfitPrice) reason = "take_profit";
  } else {
    if (quotePrice >= position.liquidationPrice) reason = "liquidation";
    else if (position.stopLossPrice != null && quotePrice >= position.stopLossPrice) reason = "stop_loss";
    else if (position.takeProfitPrice != null && quotePrice <= position.takeProfitPrice) reason = "take_profit";
  }
  if (!reason) return null;
  return { reason, quotePrice, executionPrice: applySlippage(quotePrice, position.side, position.slippagePpm) };
}

/** Pure close calculation. Net loss is capped at isolated margin; caller persists exactly once. */
export function closePosition(position: Position, trigger: Trigger): CloseResult {
  if (position.status !== "open") throw new Error("Позиция уже закрыта.");
  if (trigger.executionPrice <= 0n || trigger.quotePrice <= 0n) throw new Error("Некорректная цена закрытия.");
  const grossPnlMicro = pnlMicro(position.side, position.qtyUnits, position.entryPrice, trigger.executionPrice);
  const exitNotionalMicro = notionalMicro(position.qtyUnits, trigger.executionPrice);
  const exitFeeMicro = feeMicro(exitNotionalMicro, position.feePpm);
  const rawNet = grossPnlMicro - exitFeeMicro;
  const netPnlMicro = rawNet < -position.marginMicro ? -position.marginMicro : rawNet;
  const releasedMarginMicro = position.marginMicro + netPnlMicro;
  const closed: Position = { ...position, status: "closed" };
  return {
    position: closed,
    reason: trigger.reason,
    quotePrice: trigger.quotePrice,
    executionPrice: trigger.executionPrice,
    grossPnlMicro,
    exitFeeMicro,
    netPnlMicro,
    releasedMarginMicro,
    balanceDeltaMicro: releasedMarginMicro,
  };
}

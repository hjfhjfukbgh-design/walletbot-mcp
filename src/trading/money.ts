/**
 * Fixed-point arithmetic for the trading core.
 * Money: 1 USDT = 1_000_000 micro-USDT.
 * Price and quantity: 1 unit = 100_000_000 integer units.
 * No floating-point arithmetic is allowed in financial calculations.
 */
export const MONEY_SCALE = 1_000_000n;
export const PRICE_SCALE = 100_000_000n;
export const QTY_SCALE = 100_000_000n;
export const PRODUCT_DENOMINATOR = PRICE_SCALE * QTY_SCALE;
export const PPM_SCALE = 1_000_000n;

export type Rounding = "floor" | "ceil" | "half-up";

/** Mathematical floor/ceil; half-up rounds ties away from zero. */
export function divRound(numerator: bigint, denominator: bigint, mode: Rounding): bigint {
  if (denominator <= 0n) throw new Error("Знаменатель должен быть положительным.");
  const q = numerator / denominator; // BigInt truncates toward zero
  const r = numerator % denominator;
  if (r === 0n) return q;
  if (mode === "floor") return numerator < 0n ? q - 1n : q;
  if (mode === "ceil") return numerator > 0n ? q + 1n : q;
  const absR = r < 0n ? -r : r;
  return absR * 2n >= denominator ? q + (numerator < 0n ? -1n : 1n) : q;
}

/** Strict decimal parser. Scientific notation is rejected; excess precision is half-up rounded. */
export function parseFixed(value: string, scale: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Некорректная точность.");
  if (scale !== 10n ** BigInt(decimals)) throw new Error("Масштаб не соответствует точности.");
  const text = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error("Некорректное десятичное значение.");
  const fraction = match[3] ?? "";
  const kept = fraction.slice(0, decimals).padEnd(decimals, "0");
  const base = BigInt(match[2]) * scale + BigInt(kept || "0");
  const next = fraction.length > decimals ? Number(fraction[decimals]) : 0;
  const rounded = base + (next >= 5 ? 1n : 0n);
  return match[1] === "-" ? -rounded : rounded;
}

export function formatFixed(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Некорректная точность.");
  const scale = 10n ** BigInt(decimals);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}${decimals ? "." + fraction : ""}`;
}

/** USDT micro-value of qty * price; half-up to the nearest micro-USDT. */
export function notionalMicro(qtyUnits: bigint, priceUnits: bigint): bigint {
  if (qtyUnits < 0n || priceUnits < 0n) throw new Error("Количество и цена не могут быть отрицательными.");
  return divRound(qtyUnits * priceUnits * MONEY_SCALE, PRODUCT_DENOMINATOR, "half-up");
}

/** Signed gross P&L in micro-USDT; half-up, ties away from zero. */
export function pnlMicro(side: "long" | "short", qtyUnits: bigint, entryPrice: bigint, exitPrice: bigint): bigint {
  if (qtyUnits < 0n || entryPrice <= 0n || exitPrice <= 0n) throw new Error("Некорректные параметры P&L.");
  const delta = side === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return divRound(qtyUnits * delta * MONEY_SCALE, PRODUCT_DENOMINATOR, "half-up");
}

/** Fee in micro-USDT. Positive fees always round up so the system never under-collects. */
export function feeMicro(notional: bigint, feePpm: bigint): bigint {
  if (notional < 0n || feePpm < 0n) throw new Error("Номинал и комиссия не могут быть отрицательными.");
  return divRound(notional * feePpm, PPM_SCALE, "ceil");
}

/** Quantity in 1e-8 coin units, rounded down to avoid exceeding requested margin. */
export function quantityUnits(marginMicro: bigint, leverage: bigint, entryPrice: bigint): bigint {
  if (marginMicro <= 0n || leverage <= 0n || entryPrice <= 0n) throw new Error("Маржа, плечо и цена должны быть положительными.");
  return marginMicro * leverage * PRODUCT_DENOMINATOR / (MONEY_SCALE * entryPrice);
}

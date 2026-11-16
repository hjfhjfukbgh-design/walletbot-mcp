/**
 * Единственные правила фиксированной арифметики торгового ядра.
 * Деньги: 1 USDT = 1_000_000 микро-USDT.
 * Цена: 1 USDT = 100_000_000 price-units.
 * Количество: 1 coin = 100_000_000 qty-units.
 * В финансовых функциях запрещён number/float.
 */
export const MONEY_SCALE = 1_000_000n;
export const PRICE_SCALE = 100_000_000n;
export const QTY_SCALE = 100_000_000n;
export const PRODUCT_DENOMINATOR = PRICE_SCALE * QTY_SCALE;
export const PPM_SCALE = 1_000_000n;

export type Rounding = "floor" | "ceil" | "half-up";

/** Деление целых чисел с единым, явно заданным правилом округления. */
export function divRound(numerator: bigint, denominator: bigint, mode: Rounding): bigint {
  if (denominator <= 0n) throw new Error("Знаменатель должен быть положительным.");
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  let q = n / denominator;
  const r = n % denominator;
  if (mode === "ceil" && r !== 0n) q += 1n;
  if (mode === "half-up" && r * 2n >= denominator) q += 1n;
  return negative ? -q : q;
}

/** Строгий парсер десятичной строки; экспоненциальная запись запрещена. */
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
  const scale = 10n ** BigInt(decimals);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}${decimals ? "." + fraction : ""}`;
}

/** USDT micro-value of qty * price. Rounds half-up. */
export function notionalMicro(qtyUnits: bigint, priceUnits: bigint): bigint {
  return divRound(qtyUnits * priceUnits * MONEY_SCALE, PRODUCT_DENOMINATOR, "half-up");
}

/** Signed gross P&L in micro-USDT. */
export function pnlMicro(side: "long" | "short", qtyUnits: bigint, entryPrice: bigint, exitPrice: bigint): bigint {
  const delta = side === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return divRound(qtyUnits * delta * MONEY_SCALE, PRODUCT_DENOMINATOR, "half-up");
}

/** Fee in micro-USDT; feePpm is parts per million (350 = 0.035%). */
export function feeMicro(notional: bigint, feePpm: bigint): bigint {
  if (notional < 0n || feePpm < 0n) throw new Error("Номинал и комиссия не могут быть отрицательными.");
  return divRound(notional * feePpm, PPM_SCALE, "ceil");
}

/** Quantity in 1e-8 coin units. Rounds down to avoid exceeding requested margin. */
export function quantityUnits(marginMicro: bigint, leverage: bigint, entryPrice: bigint): bigint {
  if (marginMicro <= 0n || leverage <= 0n || entryPrice <= 0n) throw new Error("Маржа, плечо и цена должны быть положительными.");
  return marginMicro * leverage * PRODUCT_DENOMINATOR / (MONEY_SCALE * entryPrice);
}

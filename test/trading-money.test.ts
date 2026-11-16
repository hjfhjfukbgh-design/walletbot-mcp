import { describe, expect, it } from "vitest";
import {
  divRound, feeMicro, formatFixed, notionalMicro, parseFixed, pnlMicro, quantityUnits,
  MONEY_SCALE, PRICE_SCALE,
} from "../src/trading/money";

describe("fixed-point trading money", () => {
  it("parses and formats exact decimal values without floats", () => {
    expect(parseFixed("12.345678", MONEY_SCALE, 6)).toBe(12_345_678n);
    expect(formatFixed(-12_345_678n, 6)).toBe("-12.345678");
    expect(() => parseFixed("1e-6", MONEY_SCALE, 6)).toThrow();
  });

  it("uses centralized rounding rules", () => {
    expect(divRound(5n, 2n, "half-up")).toBe(3n);
    expect(divRound(-5n, 2n, "half-up")).toBe(-3n);
    expect(divRound(5n, 2n, "floor")).toBe(2n);
    expect(divRound(5n, 2n, "ceil")).toBe(3n);
    expect(divRound(-5n, 2n, "floor")).toBe(-3n);
    expect(divRound(-5n, 2n, "ceil")).toBe(-2n);
    expect(feeMicro(1n, 1n)).toBe(1n);
  });

  it("calculates notional, quantity, fees and LONG/SHORT P&L in integer units", () => {
    const margin = 100n * MONEY_SCALE;
    const entry = 50_000n * PRICE_SCALE;
    const qty = quantityUnits(margin, 2n, entry);
    expect(qty).toBe(400_000n); // 0.004 coin
    expect(notionalMicro(qty, entry)).toBe(200n * MONEY_SCALE);
    expect(feeMicro(200n * MONEY_SCALE, 350n)).toBe(70_000n);
    expect(pnlMicro("long", qty, entry, 51_000n * PRICE_SCALE)).toBe(4n * MONEY_SCALE);
    expect(pnlMicro("short", qty, entry, 51_000n * PRICE_SCALE)).toBe(-4n * MONEY_SCALE);
    expect(pnlMicro("short", qty, entry, 49_000n * PRICE_SCALE)).toBe(4n * MONEY_SCALE);
  });

  it("rejects invalid financial inputs", () => {
    expect(() => quantityUnits(0n, 1n, PRICE_SCALE)).toThrow();
    expect(() => feeMicro(-1n, 1n)).toThrow();
    expect(() => divRound(1n, 0n, "half-up")).toThrow();
  });
});

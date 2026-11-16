import { describe, expect, it } from "vitest";
import { directionalPnl, estimateLiquidationPrice, exitReason, liquidationHit, type ManualPosition } from "../src/manual";

const base: ManualPosition = {
  id: "demo-1",
  market: "BTC",
  side: "long",
  entryPrice: 100,
  qty: 1,
  marginUsd: 50,
  notionalUsd: 100,
  leverage: 2,
  takeProfit: 110,
  stopLoss: 90,
  liquidationPrice: 49.5,
  takerFeePct: 0.001,
  openedAt: new Date(0).toISOString(),
};

describe("manual demo positions", () => {
  it("calculates positive LONG and negative SHORT PnL with exit fee", () => {
    expect(directionalPnl(base, 110)).toBeCloseTo(9.89, 8);
    expect(directionalPnl({ ...base, side: "short" }, 110)).toBeCloseTo(-10.11, 8);
  });

  it("mirrors liquidation estimate for LONG and SHORT", () => {
    const long = estimateLiquidationPrice(100, 1, 50, 0.001, "long");
    const short = estimateLiquidationPrice(100, 1, 50, 0.001, "short");
    expect(long).toBeCloseTo(49.4, 6);
    expect(short).toBeCloseTo(150.6, 6);
  });

  it("detects directional TP and SL", () => {
    expect(exitReason(base, 110)).toBe("tp");
    expect(exitReason(base, 90)).toBe("sl");
    expect(exitReason({ ...base, side: "short", takeProfit: 90, stopLoss: 110, liquidationPrice: 150 }, 90)).toBe("tp");
    expect(exitReason({ ...base, side: "short", takeProfit: 90, stopLoss: 110, liquidationPrice: 150 }, 110)).toBe("sl");
  });

  it("prioritizes liquidation if price crosses liquidation threshold", () => {
    expect(liquidationHit(base, 49)).toBe(true);
    expect(exitReason(base, 49)).toBe("liquidation");
    expect(liquidationHit({ ...base, side: "short", liquidationPrice: 150 }, 151)).toBe(true);
  });
});

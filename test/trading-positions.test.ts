import { describe, expect, it } from "vitest";
import { MONEY_SCALE, PRICE_SCALE } from "../src/trading/money";
import { checkTrigger, closePosition, openPosition, unrealizedPnl, type PositionInput } from "../src/trading/positions";

const U = MONEY_SCALE;
const P = PRICE_SCALE;
const base: PositionInput = {
  id: "p1", userId: "u1", symbol: "BTC", side: "long",
  marginMicro: 100n * U, leverage: 2n, entryPrice: 50_000n * P,
  takeProfitPrice: 52_000n * P, stopLossPrice: 49_000n * P,
  liquidationPrice: 25_500n * P, feePpm: 350n, slippagePpm: 1_000n,
};
function opened(overrides: Partial<PositionInput> = {}) {
  return openPosition({ ...base, ...overrides }, 1_000n * U).position;
}

describe("pure position calculations (integer fixed point)", () => {
  it("opens LONG and reserves isolated margin plus entry fee", () => {
    const result = openPosition(base, 1_000n * U);
    expect(result.position.status).toBe("open");
    expect(result.position.qtyUnits).toBe(400_000n);
    expect(result.balanceDeltaMicro).toBe(-(100n * U + result.position.entryFeeMicro));
  });

  it("opens SHORT with direction-specific TP and SL", () => {
    const p = opened({ side: "short", takeProfitPrice: 48_000n * P, stopLossPrice: 51_000n * P, liquidationPrice: 74_500n * P });
    expect(p.side).toBe("short");
    expect(unrealizedPnl(p, 49_000n * P)).toBe(4n * U);
  });

  it("calculates profitable and losing LONG/SHORT unrealized P&L", () => {
    const long = opened();
    const short = opened({ side: "short", takeProfitPrice: 48_000n * P, stopLossPrice: 51_000n * P, liquidationPrice: 74_500n * P });
    expect(unrealizedPnl(long, 51_000n * P)).toBe(4n * U);
    expect(unrealizedPnl(long, 49_000n * P)).toBe(-4n * U);
    expect(unrealizedPnl(short, 49_000n * P)).toBe(4n * U);
    expect(unrealizedPnl(short, 51_000n * P)).toBe(-4n * U);
  });

  it("triggers LONG take profit and stop loss", () => {
    expect(checkTrigger(opened(), 52_000n * P)?.reason).toBe("take_profit");
    expect(checkTrigger(opened(), 49_000n * P)?.reason).toBe("stop_loss");
  });

  it("triggers SHORT take profit and stop loss", () => {
    const p = opened({ side: "short", takeProfitPrice: 48_000n * P, stopLossPrice: 51_000n * P, liquidationPrice: 74_500n * P });
    expect(checkTrigger(p, 48_000n * P)?.reason).toBe("take_profit");
    expect(checkTrigger(p, 51_000n * P)?.reason).toBe("stop_loss");
  });

  it("liquidates before SL/TP when a gap crosses multiple levels", () => {
    const p = opened({ stopLossPrice: 28_000n * P, takeProfitPrice: 52_000n * P, liquidationPrice: 27_000n * P });
    expect(checkTrigger(p, 25_000n * P)?.reason).toBe("liquidation");
    expect(checkTrigger(p, 25_000n * P)?.quotePrice).toBe(25_000n * P);
  });

  it("uses adverse slippage for a gap and never returns a better fill than quote", () => {
    const long = checkTrigger(opened(), 48_000n * P)!;
    expect(long.executionPrice).toBeLessThan(long.quotePrice);
    const short = checkTrigger(opened({ side: "short", takeProfitPrice: 48_000n * P, stopLossPrice: 51_000n * P, liquidationPrice: 74_500n * P }), 52_000n * P)!;
    expect(short.executionPrice).toBeGreaterThan(short.quotePrice);
  });

  it("uses liquidation > SL > TP when conditions coincide", () => {
    const p = opened({ stopLossPrice: 26_000n * P, takeProfitPrice: 52_000n * P, liquidationPrice: 27_000n * P });
    expect(checkTrigger(p, 25_000n * P)?.reason).toBe("liquidation");
  });

  it("closes once in the pure model, includes exit fee, and caps loss at margin", () => {
    const p = opened({ marginMicro: 1n * U, leverage: 50n, liquidationPrice: 49_500n * P, stopLossPrice: 49_900n * P, takeProfitPrice: 52_000n * P });
    const trigger = checkTrigger(p, 1n * P)!;
    const closed = closePosition(p, trigger);
    expect(closed.position.status).toBe("closed");
    expect(closed.netPnlMicro).toBe(-p.marginMicro);
    expect(closed.releasedMarginMicro).toBe(0n);
    expect(() => closePosition(closed.position, trigger)).toThrow("Позиция уже закрыта.");
  });

  it("rejects insufficient balance and invalid directional levels", () => {
    expect(() => openPosition(base, 1n)).toThrow("Недостаточно");
    expect(() => openPosition({ ...base, stopLossPrice: base.liquidationPrice }, 1_000n * U)).toThrow("строго между");
    expect(() => openPosition({ ...base, takeProfitPrice: 49_000n * P }, 1_000n * U)).toThrow("LONG TP");
  });
});

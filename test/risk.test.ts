import { describe, expect, it } from "vitest";
import type { RiskLimits } from "../src/env";
import { checkOpen, dailyLossExceeded, evaluateLiveRisk } from "../src/risk";

const limits: RiskLimits = {
  maxOrderPct: 5,
  maxTotalExposurePct: 50,
  maxDailyLossPct: 5,
  stopLossPct: 5,
  allowedMarkets: ["BTC", "ETH"],
  minVolume24hUsd: 1_000_000,
  autoRecenter: true,
  recenterDownPct: 6,
  recenterUpPct: 2,
};
const ctx = { equityUsd: 100, openMarginUsd: 0, dayStartEquityUsd: 100 };

const liveInput = () => ({
  equityUsd: 1_000,
  availableBalanceUsd: 100,
  aggregateOpenNotionalUsd: 100,
  dayStartEquityUsd: 1_000,
  dailyLossUsd: 10,
  proposedMarginUsd: 40,
  proposedNotionalUsd: 100,
  estimatedTakerFeeUsd: 1,
  market: "BTC",
  observedAtMs: 1_000,
  nowMs: 2_000,
  maxDataAgeMs: 60_000,
  accountBindingVerified: true,
  feeRateVerified: true,
  dailyPnlIncludesFees: true,
  dailyPnlIncludesFunding: true,
});

describe("risk", () => {
  it("aceita margem até 5% do patrimônio", () => {
    expect(checkOpen("BTC", 5, 3, ctx, limits)).toEqual({ ok: true });
    expect(checkOpen("BTC", 6, 3, ctx, limits).ok).toBe(false);
  });

  it("bloqueia whitelist, alavancagem e saldo zero", () => {
    expect(checkOpen("DOGE", 1, 1, ctx, limits).ok).toBe(false);
    expect(checkOpen("BTC", 1, 5, ctx, limits, 4).ok).toBe(false);
    expect(checkOpen("BTC", 1, 5, ctx, limits, 6).ok).toBe(true);
    expect(checkOpen("BTC", 1, 1, { ...ctx, equityUsd: 0 }, limits).ok).toBe(false);
  });

  it("detecta perda diária", () => {
    expect(dailyLossExceeded({ ...ctx, equityUsd: 95.1 }, limits)).toBe(false);
    expect(dailyLossExceeded({ ...ctx, equityUsd: 95 }, limits)).toBe(true);
  });
});

describe("evaluateLiveRisk", () => {
  it("accepts a complete, fresh and affordable account-bound preview", () => {
    expect(evaluateLiveRisk(liveInput(), limits)).toEqual({ ok: true });
  });

  it("rejects every missing provenance assertion", () => {
    for (const key of ["accountBindingVerified", "feeRateVerified", "dailyPnlIncludesFees", "dailyPnlIncludesFunding"] as const) {
      expect(evaluateLiveRisk({ ...liveInput(), [key]: false }, limits)).toEqual({
        ok: false, reason: "UNVERIFIED_ACCOUNTING_OR_PROVENANCE",
      });
    }
  });

  it("rejects missing, non-finite, negative and zero-required values", () => {
    expect(evaluateLiveRisk({ ...liveInput(), equityUsd: Number.NaN }, limits).ok).toBe(false);
    expect(evaluateLiveRisk({ ...liveInput(), proposedMarginUsd: 0 }, limits).ok).toBe(false);
    expect(evaluateLiveRisk({ ...liveInput(), proposedNotionalUsd: -1 }, limits).ok).toBe(false);
    expect(evaluateLiveRisk({ ...liveInput(), estimatedTakerFeeUsd: Number.POSITIVE_INFINITY }, limits).ok).toBe(false);
    expect(evaluateLiveRisk({ ...liveInput(), dailyLossUsd: -1 }, limits).ok).toBe(false);
    const missingEquity = { ...liveInput() } as Record<string, unknown>;
    delete missingEquity.equityUsd;
    expect(evaluateLiveRisk(missingEquity as never, limits).reason).toBe("INVALID_INPUTS");
  });

  it("rejects missing or invalid limits and an empty market allowlist", () => {
    expect(evaluateLiveRisk(liveInput(), { ...limits, maxOrderPct: Number.NaN }).reason).toBe("INVALID_LIMITS");
    expect(evaluateLiveRisk(liveInput(), { ...limits, maxDailyLossPct: 101 }).reason).toBe("INVALID_LIMITS");
    expect(evaluateLiveRisk(liveInput(), { ...limits, maxTotalExposurePct: 150 }).reason).toBe("INVALID_LIMITS");
    expect(evaluateLiveRisk(liveInput(), { ...limits, allowedMarkets: [] }).reason).toBe("INVALID_LIMITS");
  });

  it("rejects stale, future and invalid-age observations", () => {
    expect(evaluateLiveRisk({ ...liveInput(), observedAtMs: 0, nowMs: 100_000, maxDataAgeMs: 60_000 }, limits).reason).toBe("STALE_DATA");
    expect(evaluateLiveRisk({ ...liveInput(), observedAtMs: 3_000 }, limits).reason).toBe("INVALID_TIMESTAMP");
    expect(evaluateLiveRisk({ ...liveInput(), maxDataAgeMs: 0 }, limits).reason).toBe("INVALID_TIMESTAMP");
  });

  it("enforces allowlist and order-margin cap including equality boundary", () => {
    expect(evaluateLiveRisk({ ...liveInput(), market: "DOGE" }, limits).reason).toBe("MARKET_NOT_ALLOWED");
    expect(evaluateLiveRisk({ ...liveInput(), proposedMarginUsd: 50 }, limits)).toEqual({ ok: true });
    expect(evaluateLiveRisk({ ...liveInput(), proposedMarginUsd: 50.01 }, limits).reason).toBe("ORDER_TOO_LARGE");
  });

  it("enforces aggregate notional exposure across all contracts", () => {
    expect(evaluateLiveRisk({ ...liveInput(), aggregateOpenNotionalUsd: 400 }, limits)).toEqual({ ok: true });
    expect(evaluateLiveRisk({ ...liveInput(), aggregateOpenNotionalUsd: 400.01 }, limits).reason).toBe("EXPOSURE_LIMIT_EXCEEDED");
  });

  it("blocks at the daily-loss threshold and includes fees/funding provenance", () => {
    expect(evaluateLiveRisk({ ...liveInput(), dailyLossUsd: 49.99 }, limits)).toEqual({ ok: true });
    expect(evaluateLiveRisk({ ...liveInput(), dailyLossUsd: 50 }, limits).reason).toBe("DAILY_LOSS_LIMIT_REACHED");
    expect(evaluateLiveRisk({ ...liveInput(), dailyPnlIncludesFees: false }, limits).ok).toBe(false);
    expect(evaluateLiveRisk({ ...liveInput(), dailyPnlIncludesFunding: false }, limits).ok).toBe(false);
  });

  it("checks fee affordability against available balance", () => {
    expect(evaluateLiveRisk({ ...liveInput(), availableBalanceUsd: 41 }, limits)).toEqual({ ok: true });
    expect(evaluateLiveRisk({ ...liveInput(), availableBalanceUsd: 40.99 }, limits).reason).toBe("INSUFFICIENT_BALANCE_FOR_MARGIN_AND_FEES");
  });
});

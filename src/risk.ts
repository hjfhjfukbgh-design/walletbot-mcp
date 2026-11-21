import type { RiskLimits } from "./env";

export interface RiskContext {
  equityUsd: number;
  openMarginUsd: number;
  dayStartEquityUsd: number;
}

export type RiskDecision = { ok: true } | { ok: false; reason: string };

export interface LiveRiskInput {
  /** Verified account equity in USD at observedAtMs. */
  equityUsd: number;
  /** Verified currently available balance in USD at observedAtMs. */
  availableBalanceUsd: number;
  /** Sum of absolute notional exposure across every open contract in this account. */
  aggregateOpenNotionalUsd: number;
  /** Day-start equity for the same account and accounting day. */
  dayStartEquityUsd: number;
  /** Net daily loss in USD, including trading fees and funding. */
  dailyLossUsd: number;
  /** Proposed initial margin in USD. */
  proposedMarginUsd: number;
  /** Proposed order notional in USD. */
  proposedNotionalUsd: number;
  /** Conservative estimated fee for the proposed order, in USD. */
  estimatedTakerFeeUsd: number;
  market: string;
  observedAtMs: number;
  nowMs: number;
  maxDataAgeMs: number;
  /** Set only after the caller has bound every read to the authenticated Walt account. */
  accountBindingVerified: boolean;
  /** Set only when fee estimate is sourced from current authoritative fee data. */
  feeRateVerified: boolean;
  /** Explicitly asserts dailyLossUsd includes all trading fees. */
  dailyPnlIncludesFees: boolean;
  /** Explicitly asserts dailyLossUsd includes funding payments/credits. */
  dailyPnlIncludesFunding: boolean;
}

function reject(reason: string): RiskDecision {
  return { ok: false, reason };
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Deterministic fail-closed gate for a MANUAL LIVE opening preview.
 * It does not fetch provider data and cannot verify provenance itself; callers
 * must set the provenance flags only after checking the authenticated account.
 */
export function evaluateLiveRisk(
  input: LiveRiskInput,
  limits: RiskLimits,
): RiskDecision {
  if (
    !input ||
    typeof input.market !== "string" ||
    !input.market.trim() ||
    ![
      input.equityUsd,
      input.availableBalanceUsd,
      input.aggregateOpenNotionalUsd,
      input.dayStartEquityUsd,
      input.dailyLossUsd,
      input.proposedMarginUsd,
      input.proposedNotionalUsd,
      input.estimatedTakerFeeUsd,
      input.observedAtMs,
      input.nowMs,
      input.maxDataAgeMs,
    ].every(finiteNonNegative)
  ) return reject("INVALID_INPUTS");

  if (
    !limits ||
    ![
      limits.maxOrderPct,
      limits.maxTotalExposurePct,
      limits.maxDailyLossPct,
    ].every((v) => Number.isFinite(v) && v > 0 && v <= 100) ||
    !Array.isArray(limits.allowedMarkets) ||
    limits.allowedMarkets.length === 0
  ) return reject("INVALID_LIMITS");

  if (
    input.accountBindingVerified !== true ||
    input.feeRateVerified !== true ||
    input.dailyPnlIncludesFees !== true ||
    input.dailyPnlIncludesFunding !== true
  ) return reject("UNVERIFIED_ACCOUNTING_OR_PROVENANCE");

  if (input.equityUsd <= 0 || input.dayStartEquityUsd <= 0 || input.proposedMarginUsd <= 0 || input.proposedNotionalUsd <= 0) {
    return reject("INVALID_INPUTS");
  }
  if (input.maxDataAgeMs <= 0 || input.observedAtMs > input.nowMs) return reject("INVALID_TIMESTAMP");
  if (input.nowMs - input.observedAtMs > input.maxDataAgeMs) return reject("STALE_DATA");

  const market = input.market.trim().toUpperCase();
  if (!marketAllowed(limits, market)) return reject("MARKET_NOT_ALLOWED");

  if (input.dailyLossUsd / input.dayStartEquityUsd * 100 >= limits.maxDailyLossPct) {
    return reject("DAILY_LOSS_LIMIT_REACHED");
  }

  const maxMarginUsd = input.equityUsd * limits.maxOrderPct / 100;
  if (input.proposedMarginUsd > maxMarginUsd) return reject("ORDER_TOO_LARGE");

  const projectedNotionalUsd = input.aggregateOpenNotionalUsd + input.proposedNotionalUsd;
  if (!Number.isFinite(projectedNotionalUsd)) return reject("INVALID_INPUTS");
  if (projectedNotionalUsd / input.equityUsd * 100 > limits.maxTotalExposurePct) {
    return reject("EXPOSURE_LIMIT_EXCEEDED");
  }

  const requiredAvailableUsd = input.proposedMarginUsd + input.estimatedTakerFeeUsd;
  if (!Number.isFinite(requiredAvailableUsd) || requiredAvailableUsd > input.availableBalanceUsd) {
    return reject("INSUFFICIENT_BALANCE_FOR_MARGIN_AND_FEES");
  }

  return { ok: true };
}

export function marketAllowed(limits: RiskLimits, market: string): boolean {
  return limits.allowedMarkets.includes("*") || limits.allowedMarkets.includes(market.toUpperCase());
}

export function dailyLossExceeded(ctx: RiskContext, limits: RiskLimits): boolean {
  if (!(ctx.dayStartEquityUsd > 0)) return false;
  const lossPct = ((ctx.dayStartEquityUsd - ctx.equityUsd) / ctx.dayStartEquityUsd) * 100;
  return lossPct >= limits.maxDailyLossPct;
}

/** Valida uma abertura. Fechamentos nunca são bloqueados. */
export function checkOpen(
  market: string,
  marginUsd: number,
  leverage: number,
  ctx: RiskContext,
  limits: RiskLimits,
  contractMaxLeverage = Number.POSITIVE_INFINITY,
): RiskDecision {
  if (!marketAllowed(limits, market))
    return { ok: false, reason: `рынок ${market} не входит в список разрешённых (${limits.allowedMarkets.join(", ")})` };
  if (Number.isFinite(contractMaxLeverage) && leverage > contractMaxLeverage) return { ok: false, reason: `плечо ${leverage}x превышает максимум контракта ${contractMaxLeverage}x` };
  if (!(ctx.equityUsd > 0)) return { ok: false, reason: "капитал равен нулю или неизвестен (пополните счёт агента в USDC)" };
  if (dailyLossExceeded(ctx, limits)) return { ok: false, reason: `достигнут лимит дневного убытка ${limits.maxDailyLossPct}%` };
  const maxMargin = (ctx.equityUsd * limits.maxOrderPct) / 100;
  if (marginUsd > maxMargin)
    return {
      ok: false,
      reason: `маржа ${marginUsd.toFixed(2)} превышает ${limits.maxOrderPct}% капитала (${maxMargin.toFixed(2)})`,
    };
  if (ctx.openMarginUsd + marginUsd > (ctx.equityUsd * limits.maxTotalExposurePct) / 100)
    return { ok: false, reason: `общая экспозиция превысит ${limits.maxTotalExposurePct}% капитала` };
  return { ok: true };
}

import type { RiskLimits } from "./env";

export interface RiskContext {
  equityUsd: number;
  openMarginUsd: number;
  dayStartEquityUsd: number;
}

export type RiskDecision = { ok: true } | { ok: false; reason: string };

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

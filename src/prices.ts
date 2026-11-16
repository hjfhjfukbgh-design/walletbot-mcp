// Preço de referência público (Hyperliquid) — usado no modo paper quando o Walt
// ainda não está conectado ou não há tool de preço mapeada.
export async function publicMid(market: string): Promise<number> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  if (!res.ok) throw new Error(`preço público indisponível (HTTP ${res.status})`);
  const mids = (await res.json()) as Record<string, string>;
  const price = Number(mids[market.toUpperCase()]);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`mercado ${market} sem preço público`);
  return price;
}


import type { ContractInfo } from "./strategy/grid";

/** Mercados públicos Hyperliquid: independentes de Walt e de qualquer carteira. */
export async function publicContracts(): Promise<ContractInfo[]> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  if (!res.ok) throw new Error(`lista pública de mercados indisponível (HTTP ${res.status})`);
  const payload = (await res.json()) as [
    { universe?: Array<{ name: string; szDecimals?: number; maxLeverage?: number }> },
    Array<{ dayNtlVlm?: string; funding?: string; markPx?: string; midPx?: string; prevDayPx?: string }>
  ];
  const universe = payload?.[0]?.universe ?? [];
  const contexts = payload?.[1] ?? [];
  return universe.map((asset, i) => {
    const ctx = contexts[i] ?? {};
    const market = String(asset.name).toUpperCase();
    const price = Number(ctx.midPx ?? ctx.markPx ?? 0);
    const priceDecimals = price > 0 ? Math.max(0, Math.min(8, 5 - Math.floor(Math.log10(price)))) : 2;
    const szDecimals = Math.max(0, Math.min(8, Number(asset.szDecimals ?? 3)));
    return {
      contractId: i,
      name: `${market}-USDC`,
      priceDecimals,
      minSizeBase: 10 ** -szDecimals,
      minSizeQuote: 10,
      maxSizeQuote: 10_000_000,
      maxLeverage: Math.max(1, Number(asset.maxLeverage ?? 3)),
      takerFeePct: 0.00035,
      priceSlippage: 0.001,
      volume24hUsd: Number(ctx.dayNtlVlm ?? 0),
      fundingRateHourly: Number(ctx.funding ?? 0) / 8,
      price,
      change24hPct: Number(ctx.prevDayPx) > 0 && price > 0 ? ((price / Number(ctx.prevDayPx)) - 1) * 100 : undefined,
    } satisfies ContractInfo;
  }).filter((c) => c.volume24hUsd !== undefined);
}

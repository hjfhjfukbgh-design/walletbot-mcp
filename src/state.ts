import type { Env } from "./env";
import type { ContractInfo, GridConfig, GridPosition } from "./strategy/grid";

/** Legacy field retained temporarily for older Mini App clients. */
export type ProductMode = "demo" | "live" | "ai";
export type MarketMode = "demo" | "live";
export type TradingMethod = "manual" | "ai_piper";

export interface BotState {
  mode: "paper" | "live";
  running: boolean;
  paused?: string;
  grid?: { cfg: GridConfig; position?: GridPosition };
  day?: { date: string; startEquity: number };
  paper: { cash: number; startCash: number };
  stats: { trades: number; wins: number; losses: number; realizedPnl: number };
  lastPrice?: number;
  lastTick?: string;
  lastError?: string;
  lastBlock?: string;
  lastRecenter?: { at: string; low: number; high: number; price: number };
  prices?: { market: string; points: Array<[number, number]> };
  equity?: Array<[number, number]>;
  /** Top-level market mode. New persisted state uses only DEMO or LIVE here. */
  marketMode?: MarketMode;
  /** Trading method nested inside marketMode; AI is never a third market mode. */
  tradingMethod?: TradingMethod;
  /** @deprecated Compatibility field for existing clients and AI PAPER internals. */
  productMode?: ProductMode;
}

export function normalizeProductMode(value: unknown): ProductMode {
  return value === "demo" || value === "live" || value === "ai" ? value : "demo";
}

export function normalizeMarketMode(value: unknown): MarketMode {
  return value === "live" ? "live" : "demo";
}

export function normalizeTradingMethod(value: unknown): TradingMethod {
  return value === "ai_piper" ? "ai_piper" : "manual";
}

/**
 * Deterministic, safe migration:
 * - legacy "ai" becomes DEMO + AI Piper;
 * - legacy "demo" becomes DEMO + Manual;
 * - legacy "live" is deliberately downgraded to DEMO + Manual;
 * - only an explicitly persisted new marketMode may represent LIVE.
 */
export function normalizeMarketSelection(state: Partial<BotState>): Pick<BotState, "marketMode" | "tradingMethod" | "productMode"> {
  const hasNewContract = state.marketMode === "demo" || state.marketMode === "live";
  const marketMode: MarketMode = hasNewContract ? normalizeMarketMode(state.marketMode) : "demo";
  const tradingMethod: TradingMethod = state.tradingMethod === "manual" || state.tradingMethod === "ai_piper"
    ? normalizeTradingMethod(state.tradingMethod)
    : normalizeProductMode(state.productMode) === "ai" ? "ai_piper" : "manual";

  // Legacy productMode mirrors the method solely for compatibility with old
  // AI PAPER routes; it must never be interpreted as a top-level market mode.
  return {
    marketMode,
    tradingMethod,
    productMode: tradingMethod === "ai_piper" ? "ai" : "demo",
  };
}

export function withProductMode(state: BotState, value: unknown): BotState {
  const productMode = normalizeProductMode(value);
  const selection = normalizeMarketSelection({
    ...state,
    marketMode: "demo",
    tradingMethod: productMode === "ai" ? "ai_piper" : "manual",
    productMode,
  });
  return { ...state, ...selection };
}

const K_STATE = "bot:state";
const K_TOOLS = "walt:tools";
const K_CONTRACTS = "walt:contracts:v2";

export function defaultState(): BotState {
  return {
    mode: "paper",
    marketMode: "demo",
    tradingMethod: "manual",
    productMode: "demo",
    running: false,
    paper: { cash: 1000, startCash: 1000 },
    stats: { trades: 0, wins: 0, losses: 0, realizedPnl: 0 },
  };
}

export async function loadState(env: Env): Promise<BotState> {
  const saved = (await env.STATE.get<BotState>(K_STATE, "json")) ?? {};
  // Normalize the persisted record before defaults are merged. Otherwise the
  // new default marketMode/tradingMethod fields mask legacy productMode values.
  const selection = normalizeMarketSelection(saved);
  const s = { ...defaultState(), ...saved, ...selection };
  s.stats = { ...defaultState().stats, ...s.stats };
  if (s.grid && !(s.grid.cfg as Partial<GridConfig>).contract) s.grid = undefined;
  return s;
}

export async function saveState(env: Env, s: BotState): Promise<void> {
  await env.STATE.put(K_STATE, JSON.stringify({ ...s, ...normalizeMarketSelection(s) }));
}

/** Guarda o tools/list completo (descrições + schemas) para inspeção em /tools.json. */
export async function saveTools(env: Env, tools: unknown[]): Promise<void> {
  await env.STATE.put(K_TOOLS, JSON.stringify(tools));
}

export async function loadTools(env: Env): Promise<unknown[] | null> {
  return env.STATE.get<unknown[]>(K_TOOLS, "json");
}

export async function cachedContracts(env: Env, fetcher: () => Promise<ContractInfo[]>): Promise<ContractInfo[]> {
  const hit = await env.STATE.get<ContractInfo[]>(K_CONTRACTS, "json");
  if (hit?.length) return hit;
  const fresh = await fetcher();
  await env.STATE.put(K_CONTRACTS, JSON.stringify(fresh), { expirationTtl: 3600 });
  return fresh;
}

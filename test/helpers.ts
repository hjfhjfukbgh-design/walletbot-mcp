import type { Env } from "../src/env";

export function memoryKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string, type?: string) => {
      const v = m.get(k);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  } as unknown as KVNamespace;
}

export function memoryQuota(seed: Record<string, number> = {}): DurableObjectNamespace {
  const counters = new Map<string, { count: number; expiresAt: number }>();
  for (const [key, count] of Object.entries(seed)) counters.set(key, { count, expiresAt: Date.now() + 48 * 60 * 60 * 1000 });
  const stub = { fetch: async (request: Request) => {
    const body = await request.json() as { quotas: Array<{ key: string; limit: number; windowSeconds: number }> };
    const now = Date.now();
    for (const quota of body.quotas) {
      const current = counters.get(quota.key);
      if (current && current.expiresAt > now && current.count >= quota.limit)
        return Response.json({ ok: false, exhausted: { key: quota.key } }, { status: 429 });
    }
    for (const quota of body.quotas) {
      const current = counters.get(quota.key);
      counters.set(quota.key, current && current.expiresAt > now
        ? { count: current.count + 1, expiresAt: current.expiresAt }
        : { count: 1, expiresAt: now + quota.windowSeconds * 1000 });
    }
    return Response.json({ ok: true, allowed: true });
  } };
  return { idFromName: (name: string) => name, get: () => stub } as unknown as DurableObjectNamespace;
}

export const env = (): Env => ({
  ENGINE: {} as DurableObjectNamespace,
  COMPANION_QUOTA: memoryQuota(),
  STATE: memoryKV(),
  TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN",
  TELEGRAM_WEBHOOK_SECRET: "",
  OWNER_CHAT_ID: "",
  WALT_MCP_URL: "",
  WALT_AUTH_ISSUER: "",
  MAX_ORDER_PCT: "5",
  MAX_TOTAL_EXPOSURE_PCT: "50",
  MAX_DAILY_LOSS_PCT: "5",
  STOP_LOSS_PCT: "5",
  ALLOWED_MARKETS: "BTC,ETH,SOL",
  API_SECRET: "chave-teste",
});

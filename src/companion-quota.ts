export interface QuotaLimit {
  key: string;
  limit: number;
  windowSeconds: number;
}

type CounterRow = { count: number; expires_at: number };

export class CompanionQuota {
  constructor(private readonly ctx: DurableObjectState) {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS quota_counters (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/consume")
      return Response.json({ ok: false, error: "Маршрут квоты не найден." }, { status: 404 });

    const body = await request.json().catch(() => null) as { quotas?: unknown } | null;
    if (!body || !Array.isArray(body.quotas) || body.quotas.length < 1 || body.quotas.length > 3)
      return Response.json({ ok: false, error: "Некорректный список квот." }, { status: 400 });

    const quotas: QuotaLimit[] = [];
    const seen = new Set<string>();
    for (const raw of body.quotas) {
      if (!raw || typeof raw !== "object") return Response.json({ ok: false, error: "Некорректная квота." }, { status: 400 });
      const item = raw as Record<string, unknown>;
      const key = typeof item.key === "string" ? item.key : "";
      const limit = Number(item.limit);
      const windowSeconds = Number(item.windowSeconds);
      if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(key) || seen.has(key) ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100_000 ||
          !Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 172_800)
        return Response.json({ ok: false, error: "Некорректные параметры квоты." }, { status: 400 });
      seen.add(key);
      quotas.push({ key, limit, windowSeconds });
    }

    const now = Date.now();
    let exhausted: { key: string; limit: number; count: number } | null = null;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM quota_counters WHERE expires_at <= ?", now);
      for (const quota of quotas) {
        const row = this.ctx.storage.sql.exec(
          "SELECT count, expires_at FROM quota_counters WHERE key = ?",
          quota.key,
        ).toArray()[0] as CounterRow | undefined;
        const count = row && row.expires_at > now ? row.count : 0;
        if (count >= quota.limit) {
          exhausted = { key: quota.key, limit: quota.limit, count };
          return;
        }
      }

      for (const quota of quotas) {
        const row = this.ctx.storage.sql.exec(
          "SELECT count, expires_at FROM quota_counters WHERE key = ?",
          quota.key,
        ).toArray()[0] as CounterRow | undefined;
        const active = !!row && row.expires_at > now;
        const count = active ? row!.count + 1 : 1;
        const expiresAt = active ? row!.expires_at : now + quota.windowSeconds * 1000;
        this.ctx.storage.sql.exec(
          "INSERT INTO quota_counters(key,count,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count, expires_at=excluded.expires_at",
          quota.key, count, expiresAt,
        );
      }
    });

    if (exhausted) {
      return Response.json({ ok: false, allowed: false, error: "Лимит запросов исчерпан.", exhausted }, { status: 429 });
    }
    return Response.json({ ok: true, allowed: true });
  }
}

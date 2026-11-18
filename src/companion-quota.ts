export interface QuotaLimit {
  key: string;
  limit: number;
  windowSeconds: number;
  sliding?: boolean;
}

type CounterRow = { count: number; expires_at: number };

export class CompanionQuota {
  constructor(private readonly ctx: DurableObjectState) {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS quota_counters (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS quota_events_key_expires ON quota_events(key, expires_at);
      CREATE INDEX IF NOT EXISTS quota_events_expires ON quota_events(expires_at);
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
          !Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 172_800 ||
          (item.sliding !== undefined && typeof item.sliding !== "boolean"))
        return Response.json({ ok: false, error: "Некорректные параметры квоты." }, { status: 400 });
      seen.add(key);
      quotas.push({ key, limit, windowSeconds, sliding: item.sliding === true });
    }

    const now = Date.now();
    const exhausted = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM quota_counters WHERE expires_at <= ?", now);
      this.ctx.storage.sql.exec("DELETE FROM quota_events WHERE expires_at <= ?", now);
      for (const quota of quotas) {
        let count = 0;
        if (quota.sliding) {
          const row = this.ctx.storage.sql.exec(
            "SELECT COUNT(*) AS count FROM quota_events WHERE key = ? AND expires_at > ?",
            quota.key, now,
          ).toArray()[0] as { count: number } | undefined;
          count = Number(row?.count || 0);
        } else {
          const row = this.ctx.storage.sql.exec(
            "SELECT count, expires_at FROM quota_counters WHERE key = ?",
            quota.key,
          ).toArray()[0] as CounterRow | undefined;
          count = row && row.expires_at > now ? row.count : 0;
        }
        if (count >= quota.limit) return { key: quota.key, limit: quota.limit, count };
      }

      for (const quota of quotas) {
        if (quota.sliding) {
          this.ctx.storage.sql.exec(
            "INSERT INTO quota_events(key,expires_at) VALUES(?,?)",
            quota.key, now + quota.windowSeconds * 1000,
          );
          continue;
        }
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
      return null;
    });

    if (exhausted) {
      return Response.json({ ok: false, allowed: false, error: "Лимит запросов исчерпан.", exhausted }, { status: 429 });
    }
    return Response.json({ ok: true, allowed: true });
  }
}

import { closePosition, checkTrigger, manualCloseTrigger, openPosition, type Position, type PositionInput } from "./positions";
import { MONEY_SCALE, PRICE_SCALE } from "./money";

interface EngineEnv { HYPERLIQUID_WS_URL?: string; ENGINE_MAX_QUOTE_AGE_MS?: string; }
interface Quote { price: bigint; observedAt: number; }
const MAX_AGE_DEFAULT = 10_000;
const WATCHDOG_MS = 45_000;
const SNAPSHOT_MS = 60_000;
const DEMO_SEED = 1_000n * MONEY_SCALE;
const bigintKeys = new Set(["marginMicro","leverage","entryPrice","takeProfitPrice","stopLossPrice","liquidationPrice","feePpm","slippagePpm","qtyUnits","entryNotionalMicro","entryFeeMicro"]);

function serializePosition(p: Position): string {
  return JSON.stringify(p, (_key, value) => typeof value === "bigint" ? value.toString() : value);
}
function parsePosition(raw: string): Position {
  return JSON.parse(raw, (key, value) => bigintKeys.has(key) && value !== null ? BigInt(value) : value) as Position;
}
function safeSymbol(v: unknown): string {
  const s = String(v ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9:_-]{2,32}$/.test(s)) throw new Error("Некорректный торговый инструмент.");
  return s;
}

/**
 * One account-wide coordinator. SQLite is the source of truth; all quote and
 * trigger indexes are disposable caches rebuilt from SQLite after every eviction.
 */
export class TradingEngine {
  private quotes = new Map<string, Quote>();
  private positions = new Map<string, Position>();
  private bySymbol = new Map<string, Set<string>>();
  private socket: WebSocket | null = null;
  private lastMessageAt = 0;
  private lastSnapshotAt = 0;
  private readonly maxQuoteAgeMs: number;

  constructor(private readonly ctx: DurableObjectState, private readonly env: EngineEnv) {
    this.maxQuoteAgeMs = Math.max(1_000, Number(env.ENGINE_MAX_QUOTE_AGE_MS) || MAX_AGE_DEFAULT);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS accounts (user_id TEXT PRIMARY KEY, balance_micro TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS positions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, symbol TEXT NOT NULL, status TEXT NOT NULL, position_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS positions_status_symbol ON positions(status, symbol)");
    sql.exec("CREATE INDEX IF NOT EXISTS positions_user_status ON positions(user_id, status)");
    sql.exec("CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, position_id TEXT, kind TEXT NOT NULL, amount_micro TEXT NOT NULL, balance_before_micro TEXT NOT NULL, balance_after_micro TEXT NOT NULL, created_at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS engine_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.restorePositions();
    const snapshot = sql.exec("SELECT value FROM engine_meta WHERE key = 'last_snapshot_at'").toArray()[0] as { value?: string } | undefined;
    this.lastSnapshotAt = Number(snapshot?.value ?? 0);
    void ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, openPositions: this.positions.size, socketOpen: this.socket?.readyState === WebSocket.OPEN, quoteCount: this.quotes.size });
      }
      if (request.method !== "POST") return Response.json({ ok: false, error: "Метод не поддерживается." }, { status: 405 });
      const body = await request.json() as Record<string, unknown>;
      if (url.pathname === "/open") return Response.json(this.open(body));
      if (url.pathname === "/close") return Response.json(this.close(body));
      if (url.pathname === "/quote") return Response.json(await this.acceptQuote(body));
      if (url.pathname === "/reconcile") return Response.json(this.reconcile());
      return Response.json({ ok: false, error: "Неизвестный маршрут Engine." }, { status: 404 });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : "Ошибка Engine." }, { status: 400 });
    }
  }

  private restorePositions(): void {
    this.positions.clear();
    this.bySymbol.clear();
    const rows = this.ctx.storage.sql.exec("SELECT position_json FROM positions WHERE status = 'open'").toArray() as Array<{ position_json: string }>;
    for (const row of rows) this.indexPosition(parsePosition(row.position_json));
  }

  private indexPosition(position: Position): void {
    this.positions.set(position.id, position);
    const ids = this.bySymbol.get(position.symbol) ?? new Set<string>();
    ids.add(position.id);
    this.bySymbol.set(position.symbol, ids);
  }

  private ensureAccount(userId: string): bigint {
    const row = this.ctx.storage.sql.exec("SELECT balance_micro FROM accounts WHERE user_id = ?", userId).toArray()[0] as { balance_micro: string } | undefined;
    if (row) return BigInt(row.balance_micro);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO accounts(user_id, balance_micro) VALUES(?, ?)", userId, DEMO_SEED.toString());
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO ledger(operation_id,user_id,kind,amount_micro,balance_before_micro,balance_after_micro,created_at) VALUES(?,?,?,?,?,?,?)",
        "seed:" + userId, userId, "demo_seed", DEMO_SEED.toString(), "0", DEMO_SEED.toString(), Date.now(),
      );
    });
    const created = this.ctx.storage.sql.exec("SELECT balance_micro FROM accounts WHERE user_id = ?", userId).toArray()[0] as { balance_micro: string };
    return BigInt(created.balance_micro);
  }

  private freshQuote(symbol: string): Quote {
    const quote = this.quotes.get(symbol);
    if (!quote || Date.now() - quote.observedAt > this.maxQuoteAgeMs) throw new Error("Котировка устарела или отсутствует. Открытие/закрытие заблокировано до получения свежей цены.");
    return quote;
  }

  private open(body: Record<string, unknown>): { ok: true; position: Position; balanceMicro: string } {
    if (body.mode !== "demo") throw new Error("LIVE отключён. Engine принимает только DEMO-сделки.");
    const userId = String(body.userId ?? "");
    if (!/^\d{1,20}$/.test(userId)) throw new Error("Не подтверждён пользователь Telegram.");
    const symbol = safeSymbol(body.symbol);
    const quote = this.freshQuote(symbol);
    const input: PositionInput = {
      id: crypto.randomUUID(), userId, symbol, side: body.side as "long" | "short",
      marginMicro: BigInt(String(body.marginMicro)), leverage: BigInt(String(body.leverage)),
      entryPrice: quote.price,
      takeProfitPrice: body.takeProfitPrice == null ? null : BigInt(String(body.takeProfitPrice)),
      stopLossPrice: body.stopLossPrice == null ? null : BigInt(String(body.stopLossPrice)),
      liquidationPrice: BigInt(String(body.liquidationPrice)),
      feePpm: BigInt(String(body.feePpm ?? "350")), slippagePpm: BigInt(String(body.slippagePpm ?? "1000")),
    };
    const before = this.ensureAccount(userId);
    const opened = openPosition(input, before);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE accounts SET balance_micro = ? WHERE user_id = ?", opened.balanceAfterMicro.toString(), userId);
      this.ctx.storage.sql.exec("INSERT INTO positions(id,user_id,symbol,status,position_json,updated_at) VALUES(?,?,?,?,?,?)",
        input.id, userId, symbol, "open", serializePosition(opened.position), Date.now());
      this.ctx.storage.sql.exec("INSERT INTO ledger(operation_id,user_id,position_id,kind,amount_micro,balance_before_micro,balance_after_micro,created_at) VALUES(?,?,?,?,?,?,?,?)",
        "open:" + input.id, userId, input.id, "open", opened.balanceDeltaMicro.toString(), before.toString(), opened.balanceAfterMicro.toString(), Date.now());
    });
    this.indexPosition(opened.position);
    return { ok: true, position: opened.position, balanceMicro: opened.balanceAfterMicro.toString() };
  }

  private close(body: Record<string, unknown>): { ok: true; closed: boolean; result?: unknown } {
    const userId = String(body.userId ?? ""), id = String(body.positionId ?? "");
    if (!/^\d{1,20}$/.test(userId) || !id) throw new Error("Не указаны пользователь или позиция.");
    const position = this.positions.get(id);
    if (!position || position.userId !== userId) throw new Error("Открытая позиция не найдена.");
    const quote = this.freshQuote(position.symbol);
    const trigger = body.manual === true ? manualCloseTrigger(position, quote.price) : checkTrigger(position, quote.price);
    if (!trigger) return { ok: true, closed: false };
    const result = closePosition(position, trigger);
    const before = this.ensureAccount(userId);
    const after = before + result.balanceDeltaMicro;
    this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql.exec("SELECT status FROM positions WHERE id = ? AND user_id = ?", id, userId).toArray()[0] as { status: string } | undefined;
      if (!current || current.status !== "open") throw new Error("Позиция уже закрыта.");
      this.ctx.storage.sql.exec("UPDATE accounts SET balance_micro = ? WHERE user_id = ?", after.toString(), userId);
      this.ctx.storage.sql.exec("UPDATE positions SET status = 'closed', position_json = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'open'",
        serializePosition(result.position), Date.now(), id, userId);
      this.ctx.storage.sql.exec("INSERT INTO ledger(operation_id,user_id,position_id,kind,amount_micro,balance_before_micro,balance_after_micro,created_at) VALUES(?,?,?,?,?,?,?,?)",
        "close:" + id, userId, id, result.reason, result.balanceDeltaMicro.toString(), before.toString(), after.toString(), Date.now());
    });
    this.positions.delete(id);
    this.bySymbol.get(position.symbol)?.delete(id);
    return { ok: true, closed: true, result: { ...result, balanceAfterMicro: after.toString() } };
  }

  private async acceptQuote(body: Record<string, unknown>): Promise<{ ok: true; checked: number }> {
    const symbol = safeSymbol(body.symbol);
    const price = BigInt(String(body.price));
    const observedAt = Number(body.observedAt ?? Date.now());
    if (price <= 0n || !Number.isSafeInteger(observedAt) || Math.abs(Date.now() - observedAt) > 5_000) throw new Error("Получена некорректная или устаревшая котировка.");
    this.quotes.set(symbol, { price, observedAt });
    this.lastMessageAt = Date.now();
    let checked = 0;
    for (const id of [...(this.bySymbol.get(symbol) ?? [])]) {
      const position = this.positions.get(id);
      if (!position) continue;
      checked++;
      const trigger = checkTrigger(position, price);
      if (trigger) this.close({ userId: position.userId, positionId: id });
    }
    return { ok: true, checked };
  }

  private reconcile(): { ok: true; openPositions: number; ledgerRows: number } {
    this.restorePositions();
    const ledgerRows = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM ledger").toArray()[0] as { count: number };
    return { ok: true, openPositions: this.positions.size, ledgerRows: Number(ledgerRows.count) };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || now - this.lastMessageAt > this.maxQuoteAgeMs) {
      this.connectMarketSocket();
      this.restorePositions(); // full persisted-position reconciliation after a reconnect
    }
    if (now - this.lastSnapshotAt >= SNAPSHOT_MS) {
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO engine_meta(key,value) VALUES('last_snapshot_at', ?)", String(now));
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO engine_meta(key,value) VALUES('last_open_positions', ?)", String(this.positions.size));
      this.lastSnapshotAt = now;
    }
    await this.ctx.storage.setAlarm(now + WATCHDOG_MS);
  }

  private connectMarketSocket(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    try {
      const socket = new WebSocket(this.env.HYPERLIQUID_WS_URL || "wss://api.hyperliquid.xyz/ws");
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.lastMessageAt = Date.now();
        socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
      });
      socket.addEventListener("message", (event) => {
        this.lastMessageAt = Date.now();
        try {
          const message = JSON.parse(String(event.data)) as { channel?: string; data?: { mids?: Record<string, string> } };
          if (message.channel !== "allMids" || !message.data?.mids) return;
          const now = Date.now();
          for (const [symbol, raw] of Object.entries(message.data.mids)) {
            if (!this.bySymbol.has(symbol)) continue;
            const price = BigInt(Math.round(Number(raw) * Number(PRICE_SCALE)));
            if (price > 0n) void this.acceptQuote({ symbol, price: price.toString(), observedAt: now });
          }
        } catch { /* malformed upstream frames are ignored; watchdog will reconnect if feed goes stale */ }
      });
      socket.addEventListener("close", () => { this.lastMessageAt = 0; });
      socket.addEventListener("error", () => { this.lastMessageAt = 0; });
    } catch {
      this.socket = null;
      this.lastMessageAt = 0;
    }
  }
}

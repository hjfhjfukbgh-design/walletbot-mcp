import { applyEntrySlippage, closePosition, checkTrigger, manualCloseTrigger, openPosition, unrealizedPnl, type Position, type PositionInput } from "./positions";
import { MONEY_SCALE, PRICE_SCALE, divRound, parseFixed } from "./money";

interface EngineEnv { HYPERLIQUID_WS_URL?: string; ENGINE_MAX_QUOTE_AGE_MS?: string; ENGINE_DISABLE_SOCKET?: string; }
interface Quote { price: bigint; observedAt: number; }
const MAX_AGE_DEFAULT = 10_000;
const WATCHDOG_MS = 30_000;
const SNAPSHOT_MS = 60_000;
const SOCKET_SILENCE_MS = 30_000;
const SOCKET_MAX_AGE_MS = 14 * 60_000;
const DEMO_SEED = 1_000n * MONEY_SCALE;
const bigintKeys = new Set(["marginMicro","leverage","entryPrice","takeProfitPrice","stopLossPrice","liquidationPrice","feePpm","slippagePpm","qtyUnits","entryNotionalMicro","entryFeeMicro"]);

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function serializePosition(p: Position): string {
  return JSON.stringify(p, (_key, value) => typeof value === "bigint" ? value.toString() : value);
}
function parsePosition(raw: string): Position {
  return JSON.parse(raw, (key, value) => bigintKeys.has(key) && value !== null ? BigInt(value) : value) as Position;
}
function estimateDemoLiquidation(entry: bigint, leverage: bigint, side: "long" | "short", maintenancePpm: bigint): bigint {
  if (leverage <= 0n || maintenancePpm < 0n || maintenancePpm >= 1_000_000n) throw new Error("Некорректные параметры расчёта ликвидации.");
  const scale = 1_000_000n;
  return side === "long"
    ? divRound(entry * (scale - scale / leverage + maintenancePpm), scale - maintenancePpm, "ceil")
    : divRound(entry * (scale + scale / leverage - maintenancePpm), scale + maintenancePpm, "floor");
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
  private staleSymbols = new Set<string>();
  private socket: WebSocket | null = null;
  private lastMessageAt = 0;
  private socketOpenedAt = 0;
  private reconnectAttempts = 0;
  private nextReconnectAt = 0;
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
    const snapshot = sql.exec("SELECT value FROM engine_meta WHERE key = 'snapshot'").toArray()[0] as { value?: string } | undefined;
    if (snapshot?.value) {
      const saved = JSON.parse(snapshot.value) as { at?: number; quotes?: Record<string, { price: string; observedAt: number }> };
      this.lastSnapshotAt = Number(saved.at ?? 0);
      for (const [symbol, quote] of Object.entries(saved.quotes ?? {})) {
        this.quotes.set(symbol, { price: BigInt(quote.price), observedAt: Number(quote.observedAt) });
      }
    }
    if (this.positions.size) {
      this.connectMarketSocket();
      void ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/account") {
        const userId = url.searchParams.get("userId") ?? "";
        if (!/^\d{1,20}$/.test(userId)) throw new Error("Не подтверждён пользователь Telegram.");
        const balance = this.ensureAccount(userId);
        const rows = this.ctx.storage.sql.exec("SELECT position_json FROM positions WHERE user_id = ? AND status = 'open'", userId).toArray() as Array<{ position_json: string }>;
        return jsonResponse({ ok: true, balanceMicro: balance.toString(), positions: rows.map((row) => parsePosition(row.position_json)) });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, openPositions: this.positions.size, socketOpen: this.socket?.readyState === WebSocket.OPEN, quoteCount: this.quotes.size, staleSymbols: [...this.staleSymbols] });
      }
      if (request.method !== "POST") return Response.json({ ok: false, error: "Метод не поддерживается." }, { status: 405 });
      const body = await request.json() as Record<string, unknown>;
      if (url.pathname === "/open") return jsonResponse(this.open(body));
      if (url.pathname === "/close") return jsonResponse(this.close(body));
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
    this.staleSymbols.clear();
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
    if (!quote || quote.observedAt > Date.now() + 1_000 || Date.now() - quote.observedAt > this.maxQuoteAgeMs) throw new Error("Котировка устарела или отсутствует. Открытие/закрытие заблокировано до получения свежей цены.");
    return quote;
  }

  private open(body: Record<string, unknown>): { ok: true; position: Position; balanceMicro: string } {
    if (body.mode !== "demo") throw new Error("LIVE отключён. Engine принимает только DEMO-сделки.");
    const userId = String(body.userId ?? "");
    if (!/^\d{1,20}$/.test(userId)) throw new Error("Не подтверждён пользователь Telegram.");
    const symbol = safeSymbol(body.symbol);
    const quote = this.freshQuote(symbol);
    const leverage = BigInt(String(body.leverage));
    const side = body.side === "long" ? "long" : body.side === "short" ? "short" : null;
    if (!side) throw new Error("Направление должно быть LONG или SHORT.");
    const slippagePpm = BigInt(String(body.slippagePpm ?? "1000"));
    const entryPrice = applyEntrySlippage(quote.price, side, slippagePpm);
    const liquidationPrice = estimateDemoLiquidation(entryPrice, leverage, side, 5_000n);
    const input: PositionInput = {
      id: crypto.randomUUID(), userId, symbol, side,
      marginMicro: BigInt(String(body.marginMicro)), leverage,
      entryPrice,
      takeProfitPrice: body.takeProfitPrice == null ? null : BigInt(String(body.takeProfitPrice)),
      stopLossPrice: body.stopLossPrice == null ? null : BigInt(String(body.stopLossPrice)),
      liquidationPrice,
      feePpm: BigInt(String(body.feePpm ?? "350")), slippagePpm,
    };
    const before = this.ensureAccount(userId);
    // Risk checks live inside the Durable Object, immediately before the atomic
    // balance/position write. API-only checks are not sufficient under concurrency.
    const maxOrderBps = BigInt(String(body.maxOrderBps ?? ""));
    const maxTotalExposureBps = BigInt(String(body.maxTotalExposureBps ?? ""));
    if (maxOrderBps <= 0n || maxOrderBps > 10_000n || maxTotalExposureBps <= 0n || maxTotalExposureBps > 10_000n)
      throw new Error("Серверные лимиты риска не заданы или некорректны.");
    let openMargin = 0n;
    let unrealized = 0n;
    for (const existing of this.positions.values()) {
      if (existing.userId !== userId || existing.status !== "open") continue;
      openMargin += existing.marginMicro;
      unrealized += unrealizedPnl(existing, this.freshQuote(existing.symbol).price);
    }
    const equity = before + openMargin + unrealized;
    if (equity <= 0n) throw new Error("Демо-капитал исчерпан. Новые позиции заблокированы.");
    if (input.marginMicro * 10_000n > equity * maxOrderBps)
      throw new Error("Маржа превышает серверный лимит одной сделки.");
    if ((openMargin + input.marginMicro) * 10_000n > equity * maxTotalExposureBps)
      throw new Error("Общая маржа превысит серверный лимит открытой экспозиции.");
    const opened = openPosition(input, before);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE accounts SET balance_micro = ? WHERE user_id = ?", opened.balanceAfterMicro.toString(), userId);
      this.ctx.storage.sql.exec("INSERT INTO positions(id,user_id,symbol,status,position_json,updated_at) VALUES(?,?,?,?,?,?)",
        input.id, userId, symbol, "open", serializePosition(opened.position), Date.now());
      this.ctx.storage.sql.exec("INSERT INTO ledger(operation_id,user_id,position_id,kind,amount_micro,balance_before_micro,balance_after_micro,created_at) VALUES(?,?,?,?,?,?,?,?)",
        "open:" + input.id, userId, input.id, "open", opened.balanceDeltaMicro.toString(), before.toString(), opened.balanceAfterMicro.toString(), Date.now());
    });
    const wasIdle = this.positions.size === 0;
    this.indexPosition(opened.position);
    if (wasIdle) {
      this.connectMarketSocket();
      void this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    }
    return { ok: true, position: opened.position, balanceMicro: opened.balanceAfterMicro.toString() };
  }

  private close(body: Record<string, unknown>): { ok: true; closed: boolean; result?: unknown } {
    const userId = String(body.userId ?? ""), id = String(body.positionId ?? "");
    if (!/^\d{1,20}$/.test(userId) || !id) throw new Error("Не указаны пользователь или позиция.");
    const position = this.positions.get(id);
    if (!position || position.userId !== userId) {
      const row = this.ctx.storage.sql.exec("SELECT status FROM positions WHERE id = ? AND user_id = ?", id, userId).toArray()[0] as { status: string } | undefined;
      if (row?.status === "closed") return { ok: true, closed: true };
      throw new Error("Открытая позиция не найдена.");
    }
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
    const symbolPositions = this.bySymbol.get(position.symbol);
    symbolPositions?.delete(id);
    if (symbolPositions?.size === 0) {
      this.bySymbol.delete(position.symbol);
      this.staleSymbols.delete(position.symbol);
    }
    if (this.positions.size === 0) {
      this.socket?.close();
      this.socket = null;
      void this.ctx.storage.deleteAlarm();
    }
    return { ok: true, closed: true, result: { ...result, balanceAfterMicro: after.toString() } };
  }

  private async acceptQuote(body: Record<string, unknown>): Promise<{ ok: true; checked: number }> {
    const symbol = safeSymbol(body.symbol);
    const price = BigInt(String(body.price));
    const observedAt = Number(body.observedAt ?? Date.now());
    if (price <= 0n || !Number.isSafeInteger(observedAt) || Math.abs(Date.now() - observedAt) > 5_000) throw new Error("Получена некорректная или устаревшая котировка.");
    this.quotes.set(symbol, { price, observedAt });
    this.staleSymbols.delete(symbol);
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
    const accounts = this.ctx.storage.sql.exec("SELECT user_id, balance_micro FROM accounts").toArray() as Array<{ user_id: string; balance_micro: string }>;
    let ledgerRows = 0;
    for (const account of accounts) {
      const rows = this.ctx.storage.sql.exec("SELECT amount_micro, balance_before_micro, balance_after_micro FROM ledger WHERE user_id = ? ORDER BY id", account.user_id).toArray() as Array<{ amount_micro: string; balance_before_micro: string; balance_after_micro: string }>;
      ledgerRows += rows.length;
      let expected = 0n;
      for (const row of rows) {
        const before = BigInt(row.balance_before_micro), amount = BigInt(row.amount_micro), after = BigInt(row.balance_after_micro);
        if (before !== expected || before + amount !== after) throw new Error("Обнаружено расхождение в ledger пользователя " + account.user_id + ".");
        expected = after;
      }
      if (expected !== BigInt(account.balance_micro)) throw new Error("Баланс счёта не совпадает с последней записью ledger.");
    }
    return { ok: true, openPositions: this.positions.size, ledgerRows };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    if (this.positions.size === 0) {
      this.socket?.close();
      this.socket = null;
      await this.ctx.storage.deleteAlarm();
      return;
    }
    for (const symbol of this.bySymbol.keys()) {
      const quote = this.quotes.get(symbol);
      if (!quote || quote.observedAt > now + 1_000 || now - quote.observedAt > this.maxQuoteAgeMs) this.staleSymbols.add(symbol);
      else this.staleSymbols.delete(symbol);
    }
    const staleSocket = this.socket?.readyState === WebSocket.OPEN && (now - this.lastMessageAt > SOCKET_SILENCE_MS || now - this.socketOpenedAt > SOCKET_MAX_AGE_MS);
    if (staleSocket) {
      this.socket?.close();
      this.socket = null;
      this.nextReconnectAt = now;
    }
    if ((!this.socket || this.socket.readyState === WebSocket.CLOSED) && now >= this.nextReconnectAt) {
      this.connectMarketSocket();
    }

    // WebSocket is the primary feed. Poll HTTP allMids as a watchdog fallback
    // whenever the socket is unavailable or any open market has a stale quote.
    // This keeps TP/SL/liquidation monitoring alive through feed disconnects.
    if (this.socket?.readyState !== WebSocket.OPEN || this.staleSymbols.size > 0) {
      await this.refreshPublicQuotes();
      for (const symbol of this.bySymbol.keys()) {
        const quote = this.quotes.get(symbol);
        if (!quote || quote.observedAt > Date.now() + 1_000 || Date.now() - quote.observedAt > this.maxQuoteAgeMs)
          this.staleSymbols.add(symbol);
        else this.staleSymbols.delete(symbol);
      }
    }

    if (now - this.lastSnapshotAt >= SNAPSHOT_MS) {
      const quotes = Object.fromEntries([...this.quotes].map(([symbol, quote]) => [symbol, { price: quote.price.toString(), observedAt: quote.observedAt }]));
      this.ctx.storage.sql.exec("INSERT INTO engine_meta(key,value) VALUES('snapshot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ at: now, openPositions: this.positions.size, quotes }));
      this.lastSnapshotAt = now;
    }
    await this.ctx.storage.setAlarm(now + WATCHDOG_MS);
  }

  private async refreshPublicQuotes(): Promise<void> {
    try {
      const response = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "allMids" }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return;
      const mids = await response.json() as Record<string, string>;
      const observedAt = Date.now();
      for (const symbol of this.bySymbol.keys()) {
        try {
          const raw = mids[symbol];
          if (!raw) {
            this.staleSymbols.add(symbol);
            continue;
          }
          const price = parseFixed(raw, PRICE_SCALE, 8);
          if (price <= 0n) throw new Error("Некорректная резервная котировка.");
          await this.acceptQuote({ symbol, price: price.toString(), observedAt });
        } catch {
          // A bad response for one market must not stop refreshes for other open positions.
          this.staleSymbols.add(symbol);
        }
      }
    } catch {
      // Keep the last quote marked stale; opens/closes remain blocked until a fresh feed arrives.
    }
  }

  private connectMarketSocket(): void {
    if (this.env.ENGINE_DISABLE_SOCKET === "true") return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    try {
      const socket = new WebSocket(this.env.HYPERLIQUID_WS_URL || "wss://api.hyperliquid.xyz/ws");
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.lastMessageAt = Date.now();
        this.socketOpenedAt = Date.now();
        this.reconnectAttempts = 0;
        this.nextReconnectAt = 0;
        this.restorePositions(); // full SQLite reconciliation after a successful reconnect
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
            const price = parseFixed(raw, PRICE_SCALE, 8);
            if (price > 0n) {
              void this.acceptQuote({ symbol, price: price.toString(), observedAt: now })
                .catch(() => this.staleSymbols.add(symbol));
            }
          }
        } catch { /* malformed upstream frames are ignored; watchdog will reconnect if feed goes stale */ }
      });
      const failed = () => {
        if (this.socket !== socket) return;
        this.lastMessageAt = 0;
        this.socket = null;
        this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 6);
        const backoff = Math.min(300_000, 5_000 * 2 ** (this.reconnectAttempts - 1));
        this.nextReconnectAt = Date.now() + backoff + Math.floor(Math.random() * 1_000);
      };
      socket.addEventListener("close", failed);
      socket.addEventListener("error", failed);
    } catch {
      this.socket = null;
      this.lastMessageAt = 0;
    }
  }
}

import { applyEntrySlippage, closePosition, checkTrigger, manualCloseTrigger, openPosition, unrealizedPnl, type Position, type PositionInput } from "./positions";
import { MONEY_SCALE, PRICE_SCALE, divRound, feeMicro, notionalMicro, parseFixed } from "./money";
import { riskLimits } from "../env";

interface EngineEnv { HYPERLIQUID_WS_URL?: string; ENGINE_MAX_QUOTE_AGE_MS?: string; ENGINE_DISABLE_SOCKET?: string; MAX_ORDER_PCT?: string; MAX_TOTAL_EXPOSURE_PCT?: string; MAX_DAILY_LOSS_PCT?: string; STOP_LOSS_PCT?: string; ALLOWED_MARKETS?: string; }
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

const AI_PAPER_MARK_MAX_AGE_MS = 10 * 60_000;
const DECIMAL_8_PATTERN = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/;
function parseDecimal8(value: unknown): bigint | null {
  const raw = String(value ?? "");
  if (!DECIMAL_8_PATTERN.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  return BigInt(whole) * PRICE_SCALE + BigInt((fraction + "00000000").slice(0, 8));
}
export function parseFreshAiPaperMark(value: unknown, createdAt: unknown, now = Date.now()): bigint | null {
  const observedAt = Number(createdAt);
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0 ||
      observedAt > now || now - observedAt > AI_PAPER_MARK_MAX_AGE_MS) return null;
  const price = parseDecimal8(value);
  return price !== null && price > 0n ? price : null;
}
function estimateProportionalCost(cost: bigint, entryNotional: bigint, markNotional: bigint): bigint | null {
  if (cost < 0n || entryNotional <= 0n || markNotional < 0n) return null;
  if (cost === 0n || markNotional === 0n) return 0n;
  // Reuse the observed entry cost rate as a conservative estimate for the exit.
  return divRound(cost * markNotional, entryNotional, "ceil");
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
    const positionColumns = sql.exec("PRAGMA table_info(positions)").toArray() as Array<{ name: string }>;
    if (!positionColumns.some((column) => column.name === "close_json")) {
      sql.exec("ALTER TABLE positions ADD COLUMN close_json TEXT");
    }
    if (!positionColumns.some((column) => column.name === "created_at")) {
      sql.exec("ALTER TABLE positions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
      sql.exec("UPDATE positions SET created_at = updated_at WHERE created_at = 0");
    }
    sql.exec("CREATE INDEX IF NOT EXISTS positions_status_symbol ON positions(status, symbol)");
    sql.exec("CREATE INDEX IF NOT EXISTS positions_user_status ON positions(user_id, status)");
    sql.exec("CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, position_id TEXT, kind TEXT NOT NULL, amount_micro TEXT NOT NULL, balance_before_micro TEXT NOT NULL, balance_after_micro TEXT NOT NULL, created_at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS engine_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS live_operations (handle TEXT PRIMARY KEY, user_id TEXT NOT NULL, contract_id INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, leverage INTEGER NOT NULL, margin_usd REAL NOT NULL, notional_usd REAL NOT NULL, preview_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, result_json TEXT)");
    // AI paper storage is isolated from the user's manual DEMO tables.
    sql.exec("CREATE TABLE IF NOT EXISTS ai_paper_accounts (user_id TEXT PRIMARY KEY, balance_micro TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'stopped', strategy_id TEXT NOT NULL DEFAULT 'ma-crossover', strategy_version TEXT NOT NULL DEFAULT '1', risk_config_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS ai_paper_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, kind TEXT NOT NULL, amount_micro TEXT NOT NULL, balance_before_micro TEXT NOT NULL, balance_after_micro TEXT NOT NULL, reference_id TEXT, created_at INTEGER NOT NULL, UNIQUE(user_id, idempotency_key))");
    sql.exec("CREATE INDEX IF NOT EXISTS ai_paper_ledger_user_created ON ai_paper_ledger(user_id, created_at)");
    sql.exec("CREATE TABLE IF NOT EXISTS ai_paper_positions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, qty_units TEXT NOT NULL, entry_price TEXT NOT NULL, margin_micro TEXT NOT NULL, leverage TEXT NOT NULL, fees_micro TEXT NOT NULL, slippage_micro TEXT NOT NULL, stop_loss_price TEXT, take_profit_price TEXT, status TEXT NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER, close_json TEXT)");
    sql.exec("CREATE INDEX IF NOT EXISTS ai_paper_positions_user_status ON ai_paper_positions(user_id, status)");
    sql.exec("CREATE TABLE IF NOT EXISTS ai_paper_decisions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tick_id TEXT NOT NULL, strategy_id TEXT NOT NULL, strategy_version TEXT NOT NULL, market_snapshot_hash TEXT NOT NULL, symbol TEXT NOT NULL, signal TEXT NOT NULL, rationale TEXT NOT NULL, confidence REAL, observed_price TEXT NOT NULL, risk_pass INTEGER NOT NULL, rejection_reason TEXT, position_id TEXT, created_at INTEGER NOT NULL, UNIQUE(user_id, tick_id, symbol))");
    sql.exec("CREATE INDEX IF NOT EXISTS ai_paper_decisions_user_created ON ai_paper_decisions(user_id, created_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS ai_paper_decisions_user_tick ON ai_paper_decisions(user_id, tick_id, created_at DESC)");
    sql.exec("CREATE TABLE IF NOT EXISTS ai_paper_decision_runs (user_id TEXT NOT NULL, tick_id TEXT NOT NULL, lease_expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, tick_id))");
    sql.exec("CREATE INDEX IF NOT EXISTS live_operations_user_status ON live_operations(user_id, status, updated_at)");
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
      if (request.method === "GET" && url.pathname === "/live/status") {
        const userId = url.searchParams.get("userId") ?? "";
        const handle = url.searchParams.get("handle") ?? "";
        if (!/^\d{1,20}$/.test(userId) || !/^[a-f0-9]{32}$/.test(handle))
          return Response.json({ ok: false, error: "Некорректный идентификатор LIVE-операции." }, { status: 400 });
        const row = this.ctx.storage.sql.exec(
          "SELECT handle, user_id, contract_id, symbol, side, leverage, margin_usd, notional_usd, preview_at, expires_at, status, created_at, updated_at, result_json FROM live_operations WHERE handle = ? AND user_id = ?",
          handle, userId,
        ).toArray()[0] as Record<string, unknown> | undefined;
        if (!row) return Response.json({ ok: false, error: "LIVE-операция не найдена." }, { status: 404 });
        let result: unknown = null;
        try { result = row.result_json ? JSON.parse(String(row.result_json)) : null; } catch {}
        return jsonResponse({ ok: true, operation: {
          handle: row.handle, userId: row.user_id, contractId: row.contract_id, symbol: row.symbol,
          side: row.side, leverage: row.leverage, marginUsd: row.margin_usd, notionalUsd: row.notional_usd,
          previewAt: row.preview_at, expiresAt: row.expires_at, status: row.status,
          createdAt: row.created_at, updatedAt: row.updated_at, result,
        } });
      }
      if (request.method === "GET" && url.pathname === "/risk") {
        const userId = url.searchParams.get("userId") ?? "";
        const maxDailyLossBps = BigInt(url.searchParams.get("maxDailyLossBps") ?? "");
        if (!/^\d{1,20}$/.test(userId) || maxDailyLossBps <= 0n || maxDailyLossBps > 10_000n)
          throw new Error("Некорректные параметры дневного лимита риска.");
        this.ensureAccount(userId);
        const dailyNetPnlMicro = this.dailyNetPnl(userId);
        const dailyLossLimitMicro = DEMO_SEED * maxDailyLossBps / 10_000n;
        return jsonResponse({
          ok: true, dailyNetPnlMicro: dailyNetPnlMicro.toString(),
          dailyLossLimitMicro: dailyLossLimitMicro.toString(),
          blocked: dailyNetPnlMicro <= -dailyLossLimitMicro,
          resetAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) + 86_400_000).toISOString(),
        });
      }
      if (request.method === "GET" && url.pathname === "/ai/paper/status") {
        const userId = url.searchParams.get("userId") ?? "";
        return jsonResponse(this.aiPaperStatus(userId));
      }
      if (request.method === "GET" && url.pathname === "/ai/paper/decision") {
        const userId = url.searchParams.get("userId") ?? "";
        const tickId = url.searchParams.get("tickId") ?? "";
        if (!/^\d{1,20}$/.test(userId) || !/^[A-Za-z0-9._:-]{8,128}$/.test(tickId))
          return Response.json({ ok: false, error: "Некорректные параметры решения AI paper." }, { status: 400 });
        const row = this.ctx.storage.sql.exec(
          "SELECT id, tick_id, market_snapshot_hash, symbol, signal, rationale, confidence, created_at FROM ai_paper_decisions WHERE user_id = ? AND tick_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
          userId, tickId,
        ).toArray()[0] as Record<string, unknown> | undefined;
        if (!row) return Response.json({ ok: false, error: "Решение AI PAPER не найдено." }, { status: 404 });
        return Response.json({ ok: true, state: "completed", decision: {
          id: row.id, tickId: row.tick_id, marketSnapshotHash: row.market_snapshot_hash,
          symbol: row.symbol, signal: row.signal, rationale: row.rationale,
          confidence: row.confidence === null ? null : Number(row.confidence), observedAt: Number(row.created_at),
        } });
      }
      if (request.method === "GET" && url.pathname === "/ai/paper/decisions") {
        const userId = url.searchParams.get("userId") ?? "";
        const limit = Number(url.searchParams.get("limit") ?? "50");
        if (!/^\d{1,20}$/.test(userId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          return Response.json({ ok: false, error: "Некорректные параметры истории AI paper решений." }, { status: 400 });
        const rows = this.ctx.storage.sql.exec(
          "SELECT id, tick_id, strategy_id, strategy_version, market_snapshot_hash, symbol, signal, rationale, confidence, observed_price, risk_pass, rejection_reason, position_id, created_at FROM ai_paper_decisions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
          userId, limit,
        ).toArray() as Array<Record<string, unknown>>;
        return jsonResponse({ ok: true, decisions: rows.map(row => ({
          id: row.id, tickId: row.tick_id, strategyId: row.strategy_id, strategyVersion: row.strategy_version,
          marketSnapshotHash: row.market_snapshot_hash, symbol: row.symbol, signal: row.signal,
          rationale: row.rationale, confidence: row.confidence, observedPrice: row.observed_price,
          riskPass: Number(row.risk_pass) === 1, rejectionReason: row.rejection_reason,
          positionId: row.position_id, createdAt: row.created_at,
        })) });
      }
      if (request.method === "GET" && url.pathname === "/ai/paper/positions") {
        const userId = url.searchParams.get("userId") ?? "";
        const status = url.searchParams.get("status") ?? "open";
        const limit = Number(url.searchParams.get("limit") ?? "50");
        if (!/^\d{1,20}$/.test(userId) || !["open", "closed", "all"].includes(status) ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          return Response.json({ ok: false, error: "Некорректные параметры AI paper позиций." }, { status: 400 });
        const rows = status === "all"
          ? this.ctx.storage.sql.exec(
              "SELECT id, symbol, side, qty_units, entry_price, margin_micro, leverage, fees_micro, slippage_micro, stop_loss_price, take_profit_price, status, opened_at, closed_at, close_json FROM ai_paper_positions WHERE user_id = ? ORDER BY opened_at DESC, id DESC LIMIT ?",
              userId, limit,
            ).toArray()
          : this.ctx.storage.sql.exec(
              "SELECT id, symbol, side, qty_units, entry_price, margin_micro, leverage, fees_micro, slippage_micro, stop_loss_price, take_profit_price, status, opened_at, closed_at, close_json FROM ai_paper_positions WHERE user_id = ? AND status = ? ORDER BY opened_at DESC, id DESC LIMIT ?",
              userId, status, limit,
            ).toArray();
        return jsonResponse({ ok: true, positions: rows });
      }
      if (request.method === "GET" && url.pathname === "/account") {
        const userId = url.searchParams.get("userId") ?? "";
        if (!/^\d{1,20}$/.test(userId)) throw new Error("Не подтверждён пользователь Telegram.");
        const balance = this.ensureAccount(userId);
        const rows = this.ctx.storage.sql.exec("SELECT position_json FROM positions WHERE user_id = ? AND status = 'open'", userId).toArray() as Array<{ position_json: string }>;
        return jsonResponse({ ok: true, balanceMicro: balance.toString(), positions: rows.map((row) => parsePosition(row.position_json)) });
      }
      if (request.method === "GET" && url.pathname === "/history") {
        const userId = url.searchParams.get("userId") ?? "";
        if (!/^\d{1,20}$/.test(userId)) throw new Error("Не подтверждён пользователь Telegram.");
        const rows = this.ctx.storage.sql.exec(
          "SELECT position_json, close_json, status, created_at, updated_at FROM positions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100",
          userId,
        ).toArray() as Array<{ position_json: string; close_json: string | null; status: string; created_at: number; updated_at: number }>;
        const trades = rows.flatMap((row) => {
          const position = parsePosition(row.position_json);
          const events: Array<Record<string, unknown>> = [{
            id: position.id + ":open", event: "open", at: row.created_at || row.updated_at,
            market: position.symbol, side: position.side, price: Number(position.entryPrice) / 100_000_000, mode: "paper",
          }];
          if (row.close_json) {
            const close = JSON.parse(row.close_json) as { reason?: string; executionPrice?: string; netPnlMicro?: string; totalNetPnlMicro?: string };
            events.push({
              id: position.id + ":close", event: "close", at: row.updated_at,
              market: position.symbol, side: position.side, reason: close.reason,
              price: close.executionPrice ? (Number(close.executionPrice) / 100_000_000) : undefined,
              pnl: close.totalNetPnlMicro === undefined ? (close.netPnlMicro === undefined ? undefined : Number(close.netPnlMicro) / 1_000_000) : Number(close.totalNetPnlMicro) / 1_000_000,
              mode: "paper",
            });
          }
          return events;
        }).sort((a, b) => Number(b.at) - Number(a.at));
        const ledgerRows = this.ctx.storage.sql.exec(
          "SELECT id, created_at, balance_before_micro, balance_after_micro FROM ledger WHERE user_id = ? ORDER BY id",
          userId,
        ).toArray() as Array<{ id: number; created_at: number; balance_before_micro: string; balance_after_micro: string }>;
        const equity = ledgerRows
          .map((row) => [Number(row.created_at), Number(row.balance_after_micro) / 1_000_000, Number(row.id)] as [number, number, number])
          .sort((a, b) => a[0] - b[0] || a[2] - b[2])
          .map(([at, balance]) => [at, balance] as [number, number]);
        return jsonResponse({ ok: true, trades, equity });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, openPositions: this.positions.size, socketOpen: this.socket?.readyState === WebSocket.OPEN, quoteCount: this.quotes.size, staleSymbols: [...this.staleSymbols] });
      }
      if (request.method !== "POST") return Response.json({ ok: false, error: "Метод не поддерживается." }, { status: 405 });
      const body = await request.json() as Record<string, unknown>;
      if (url.pathname === "/ai/paper/session/start") return this.startAiPaperSession(body);
      if (url.pathname === "/ai/paper/session/stop") return this.stopAiPaperSession(body);
      if (url.pathname === "/ai/paper/fund") return this.fundAiPaper(body);
      if (url.pathname === "/ai/paper/withdraw") return this.withdrawAiPaper(body);
      if (url.pathname === "/ai/paper/decision/claim") return this.claimAiPaperDecision(body);
      if (url.pathname === "/ai/paper/decision/release") return this.releaseAiPaperDecision(body);
      if (url.pathname === "/ai/paper/decision") return this.recordAiPaperDecision(body);
      if (url.pathname === "/ai/paper/position/open") return this.openAiPaperPosition(body);
      if (url.pathname === "/ai/paper/position/close") return this.closeAiPaperPosition(body);
      if (url.pathname === "/live/claim") return this.claimLive(body);
      if (url.pathname === "/live/finish") return this.finishLive(body);
      if (url.pathname === "/open") return jsonResponse(this.open(body));
      if (url.pathname === "/close") return jsonResponse(this.close(body));
      if (url.pathname === "/quote") return Response.json(await this.acceptQuote(body));
      if (url.pathname === "/reconcile") return Response.json(this.reconcile());
      return Response.json({ ok: false, error: "Неизвестный маршрут Engine." }, { status: 404 });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : "Ошибка Engine." }, { status: 400 });
    }
  }

  private claimLive(body: Record<string, unknown>): Response {
    const userId = String(body.userId ?? "");
    const handle = String(body.handle ?? "");
    const contractId = Number(body.contractId);
    const symbol = safeSymbol(body.symbol);
    const side = String(body.side ?? "");
    const leverage = Number(body.leverage);
    const marginUsd = Number(body.marginUsd);
    const notionalUsd = Number(body.notionalUsd);
    const previewAt = Number(body.previewAt);
    const expiresAt = Number(body.expiresAt);
    const now = Date.now();
    if (!/^\d{1,20}$/.test(userId) || !/^[a-f0-9]{32}$/.test(handle) ||
        !Number.isSafeInteger(contractId) || contractId < 0 ||
        (side !== "long" && side !== "short") ||
        !Number.isSafeInteger(leverage) || leverage < 1 ||
        !Number.isFinite(marginUsd) || marginUsd <= 0 ||
        !Number.isFinite(notionalUsd) || notionalUsd <= 0 ||
        !Number.isSafeInteger(previewAt) || previewAt <= 0 ||
        !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 120_000) {
      return Response.json({ ok: false, error: "Некорректные или истёкшие параметры LIVE-операции." }, { status: 400 });
    }

    let existing: Record<string, unknown> | undefined;
    let claimed = false;
    this.ctx.storage.transactionSync(() => {
      existing = this.ctx.storage.sql.exec(
        "SELECT user_id, status FROM live_operations WHERE handle = ?", handle,
      ).toArray()[0] as Record<string, unknown> | undefined;
      if (existing) return;
      this.ctx.storage.sql.exec(
        "INSERT INTO live_operations(handle,user_id,contract_id,symbol,side,leverage,margin_usd,notional_usd,preview_at,expires_at,status,created_at,updated_at,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
        handle, userId, contractId, symbol, side, leverage, marginUsd, notionalUsd, previewAt, expiresAt, "executing", now, now,
      );
      claimed = true;
    });
    if (!claimed) {
      if (String(existing?.user_id ?? "") !== userId)
        return Response.json({ ok: false, error: "LIVE-операция не найдена." }, { status: 404 });
      return Response.json({ ok: false, claimed: false, status: String(existing?.status ?? "unknown") }, { status: 409 });
    }
    return Response.json({ ok: true, claimed: true, status: "executing" });
  }

  private finishLive(body: Record<string, unknown>): Response {
    const userId = String(body.userId ?? "");
    const handle = String(body.handle ?? "");
    const requestedStatus = String(body.status ?? "");
    if (!/^\d{1,20}$/.test(userId) || !/^[a-f0-9]{32}$/.test(handle) ||
        !["completed", "unknown", "reconciled"].includes(requestedStatus)) {
      return Response.json({ ok: false, error: "Некорректный статус LIVE-операции." }, { status: 400 });
    }
    const resultJson = JSON.stringify(body.result ?? null).slice(0, 4_000);
    let row: Record<string, unknown> | undefined;
    this.ctx.storage.transactionSync(() => {
      row = this.ctx.storage.sql.exec(
        "SELECT user_id, status FROM live_operations WHERE handle = ?", handle,
      ).toArray()[0] as Record<string, unknown> | undefined;
      if (!row || String(row.user_id) !== userId) return;
      const current = String(row.status);
      if (current === "completed" || current === "reconciled") return;
      if (requestedStatus === "unknown" && current !== "executing") return;
      if (requestedStatus === "completed" && current !== "executing" && current !== "unknown") return;
      if (requestedStatus === "reconciled" && current !== "executing" && current !== "unknown") return;
      this.ctx.storage.sql.exec(
        "UPDATE live_operations SET status = ?, updated_at = ?, result_json = ? WHERE handle = ? AND user_id = ?",
        requestedStatus, Date.now(), resultJson, handle, userId,
      );
      row.status = requestedStatus;
    });
    if (!row || String(row.user_id) !== userId)
      return Response.json({ ok: false, error: "LIVE-операция не найдена." }, { status: 404 });
    return Response.json({ ok: true, status: String(row.status) });
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

  private closeAiPaperPosition(body: Record<string, unknown>): Response {
    const userId = String(body.userId ?? "");
    const positionId = String(body.positionId ?? "");
    const idempotencyKey = String(body.idempotencyKey ?? "");
    const exitPriceInput = String(body.exitPrice ?? "");
    const rawCloseFee = String(body.closeFeeMicro ?? "0");
    const rawCloseSlippage = String(body.closeSlippageMicro ?? "0");
    const rawFunding = String(body.fundingMicro ?? "0");
    const decimalPattern = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/;
    const integerPattern = /^(?:0|[1-9]\d{0,19})$/;
    const signedIntegerPattern = /^(?:0|-?[1-9]\d{0,19})$/;
    const toScaled8 = (value: string): bigint | null => {
      if (!decimalPattern.test(value)) return null;
      const [whole, fraction = ""] = value.split(".");
      return BigInt(whole) * 100_000_000n + BigInt((fraction + "00000000").slice(0, 8));
    };
    const exitScaled = toScaled8(exitPriceInput);
    if (!/^\d{1,20}$/.test(userId) ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(positionId) ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey) ||
        exitScaled === null || exitScaled <= 0n ||
        !integerPattern.test(rawCloseFee) || !integerPattern.test(rawCloseSlippage) ||
        !signedIntegerPattern.test(rawFunding)) {
      return Response.json({ ok: false, error: "Некорректные параметры закрытия AI paper позиции." }, { status: 400 });
    }
    const closeFee = BigInt(rawCloseFee);
    const closeSlippage = BigInt(rawCloseSlippage);
    const funding = BigInt(rawFunding);
    const maxSqlInt = 9_223_372_036_854_775_807n;
    if (closeFee > maxSqlInt || closeSlippage > maxSqlInt || funding > maxSqlInt || funding < -maxSqlInt)
      return Response.json({ ok: false, error: "Комиссии или funding выходят за допустимый диапазон." }, { status: 400 });
    const exitPrice = (() => {
      const [whole, fraction = ""] = exitPriceInput.split(".");
      return whole + "." + (fraction + "00000000").slice(0, 8);
    })();
    const now = Date.now();
    let duplicate = false;
    let conflict = false;
    let notFound = false;
    let alreadyClosed = false;
    let invalidStoredPosition = false;
    let balanceOverflow = false;
    let result: Record<string, string | number> | null = null;
    let balanceAfter = 0n;

    this.ctx.storage.transactionSync(() => {
      const existingLedger = this.ctx.storage.sql.exec(
        "SELECT kind, reference_id FROM ai_paper_ledger WHERE user_id = ? AND idempotency_key = ?",
        userId, idempotencyKey,
      ).toArray()[0] as { kind: string; reference_id: string | null } | undefined;
      if (existingLedger) {
        const existingPosition = existingLedger.reference_id
          ? this.ctx.storage.sql.exec(
              "SELECT status, close_json FROM ai_paper_positions WHERE id = ? AND user_id = ?",
              existingLedger.reference_id, userId,
            ).toArray()[0] as { status: string; close_json: string | null } | undefined
          : undefined;
        let prior: Record<string, unknown> | null = null;
        try { prior = existingPosition?.close_json ? JSON.parse(existingPosition.close_json) as Record<string, unknown> : null; } catch {}
        const same = existingLedger.kind === "close_position" &&
          existingLedger.reference_id === positionId &&
          existingPosition?.status === "closed" &&
          prior?.idempotencyKey === idempotencyKey &&
          prior?.exitPrice === exitPrice &&
          prior?.closeFeeMicro === closeFee.toString() &&
          prior?.closeSlippageMicro === closeSlippage.toString() &&
          prior?.fundingMicro === funding.toString();
        if (same) {
          duplicate = true;
          result = prior as Record<string, string | number>;
        } else conflict = true;
        return;
      }

      const position = this.ctx.storage.sql.exec(
        "SELECT id, symbol, side, qty_units, entry_price, margin_micro, fees_micro, slippage_micro, status FROM ai_paper_positions WHERE id = ? AND user_id = ?",
        positionId, userId,
      ).toArray()[0] as Record<string, unknown> | undefined;
      if (!position) { notFound = true; return; }
      if (String(position.status) !== "open") { alreadyClosed = true; return; }

      const quantity = toScaled8(String(position.qty_units ?? ""));
      const entry = toScaled8(String(position.entry_price ?? ""));
      const marginRaw = String(position.margin_micro ?? "");
      const openFeesRaw = String(position.fees_micro ?? "0");
      const openSlippageRaw = String(position.slippage_micro ?? "0");
      const side = String(position.side ?? "");
      if (!quantity || quantity <= 0n || !entry || entry <= 0n ||
          !integerPattern.test(marginRaw) || !integerPattern.test(openFeesRaw) ||
          !integerPattern.test(openSlippageRaw) || !["long", "short"].includes(side)) {
        invalidStoredPosition = true;
        return;
      }
      const margin = BigInt(marginRaw);
      const openFees = BigInt(openFeesRaw);
      const openSlippage = BigInt(openSlippageRaw);
      const priceDelta = side === "long" ? exitScaled - entry : entry - exitScaled;
      const grossPnl = quantity * priceDelta / 10_000_000_000n;
      const rawPayout = margin + grossPnl - closeFee - closeSlippage - funding;
      const payout = rawPayout > 0n ? rawPayout : 0n;
      if (payout > maxSqlInt) { balanceOverflow = true; return; }

      const account = this.ctx.storage.sql.exec(
        "SELECT balance_micro FROM ai_paper_accounts WHERE user_id = ?", userId,
      ).toArray()[0] as { balance_micro: string } | undefined;
      if (!account) { invalidStoredPosition = true; return; }
      const before = BigInt(account.balance_micro);
      balanceAfter = before + payout;
      if (balanceAfter > maxSqlInt) { balanceOverflow = true; return; }
      const netPnl = payout - margin - openFees - openSlippage;
      result = {
        positionId, exitPrice, grossPnlMicro: grossPnl.toString(), netPnlMicro: netPnl.toString(),
        payoutMicro: payout.toString(), closeFeeMicro: closeFee.toString(),
        closeSlippageMicro: closeSlippage.toString(), fundingMicro: funding.toString(),
        closedAt: now, idempotencyKey,
      };
      const closeJson = JSON.stringify(result);
      this.ctx.storage.sql.exec(
        "UPDATE ai_paper_accounts SET balance_micro = ?, updated_at = ? WHERE user_id = ?",
        balanceAfter.toString(), now, userId,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO ai_paper_ledger(user_id,idempotency_key,kind,amount_micro,balance_before_micro,balance_after_micro,reference_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
        userId, idempotencyKey, "close_position", payout.toString(), before.toString(), balanceAfter.toString(), positionId, now,
      );
      this.ctx.storage.sql.exec(
        "UPDATE ai_paper_positions SET status = 'closed', closed_at = ?, close_json = ? WHERE id = ? AND user_id = ? AND status = 'open'",
        now, closeJson, positionId, userId,
      );
    });

    if (conflict) return Response.json({ ok: false, error: "Idempotency key уже использован с другой операцией или параметрами закрытия." }, { status: 409 });
    if (notFound) return Response.json({ ok: false, error: "AI paper позиция не найдена." }, { status: 404 });
    if (alreadyClosed) return Response.json({ ok: false, error: "AI paper позиция уже закрыта." }, { status: 409 });
    if (invalidStoredPosition) return Response.json({ ok: false, error: "Позиция или AI paper счёт содержат некорректные данные." }, { status: 409 });
    if (balanceOverflow) return Response.json({ ok: false, error: "Расчёт закрытия выходит за допустимый диапазон баланса." }, { status: 409 });
    if (!result) return Response.json({ ok: false, error: "Не удалось завершить закрытие AI paper позиции." }, { status: 409 });
    return Response.json({ ok: true, duplicate, close: result, balanceMicro: duplicate ? undefined : balanceAfter.toString() }, { status: duplicate ? 200 : 201 });
  }

  private openAiPaperPosition(body: Record<string, unknown>): Response {
    const userId = String(body.userId ?? "");
    const decisionId = String(body.decisionId ?? "");
    const idempotencyKey = String(body.idempotencyKey ?? "");
    let symbol = "";
    try { symbol = safeSymbol(body.symbol); } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : "Некорректный инструмент." }, { status: 400 });
    }
    const side = String(body.side ?? "");
    const qtyUnits = String(body.qtyUnits ?? "");
    const entryPrice = String(body.entryPrice ?? "");
    const rawMargin = String(body.marginMicro ?? "");
    const rawFees = String(body.feeMicro ?? "0");
    const rawSlippage = String(body.slippageMicro ?? "0");
    const leverage = Number(body.leverage);
    const stopLossPrice = body.stopLossPrice === undefined || body.stopLossPrice === null ? null : String(body.stopLossPrice);
    const takeProfitPrice = body.takeProfitPrice === undefined || body.takeProfitPrice === null ? null : String(body.takeProfitPrice);
    const decimalPattern = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/;
    if (!/^\d{1,20}$/.test(userId) ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(decisionId) ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey) ||
        !["long", "short"].includes(side) ||
        !decimalPattern.test(qtyUnits) || Number(qtyUnits) <= 0 ||
        !decimalPattern.test(entryPrice) || Number(entryPrice) <= 0 ||
        !/^(?:0|[1-9]\d{0,18})$/.test(rawMargin) || BigInt(rawMargin) <= 0n ||
        !/^(?:0|[1-9]\d{0,18})$/.test(rawFees) || !/^(?:0|[1-9]\d{0,18})$/.test(rawSlippage) ||
        !Number.isSafeInteger(leverage) || leverage < 1 || leverage > 10 ||
        (stopLossPrice !== null && (!decimalPattern.test(stopLossPrice) || Number(stopLossPrice) <= 0)) ||
        (takeProfitPrice !== null && (!decimalPattern.test(takeProfitPrice) || Number(takeProfitPrice) <= 0))) {
      return Response.json({ ok: false, error: "Некорректные параметры открытия AI paper позиции." }, { status: 400 });
    }
    const margin = BigInt(rawMargin);
    const fees = BigInt(rawFees);
    const slippage = BigInt(rawSlippage);
    const reserve = margin + fees + slippage;
    if (reserve <= 0n || reserve > 9_223_372_036_854_775_807n)
      return Response.json({ ok: false, error: "Резерв позиции выходит за допустимый диапазон." }, { status: 400 });

    const now = Date.now();
    const newPositionId = crypto.randomUUID();
    let positionId = newPositionId;
    let duplicate = false;
    let conflict = false;
    let insufficient = false;
    let openPositionExists = false;
    let positionLimitExceeded = false;
    let invalidDecision = false;
    let invalidMark = false;
    let dailyLossExceeded = false;
    let sessionInactive = false;
    let balanceAfter = 0n;

    this.ctx.storage.transactionSync(() => {
      const existingLedger = this.ctx.storage.sql.exec(
        "SELECT kind, amount_micro, reference_id FROM ai_paper_ledger WHERE user_id = ? AND idempotency_key = ?",
        userId, idempotencyKey,
      ).toArray()[0] as { kind: string; amount_micro: string; reference_id: string | null } | undefined;
      if (existingLedger) {
        const existingPosition = existingLedger.reference_id
          ? this.ctx.storage.sql.exec(
              "SELECT id, symbol, side, qty_units, entry_price, margin_micro, leverage, fees_micro, slippage_micro, stop_loss_price, take_profit_price FROM ai_paper_positions WHERE id = ? AND user_id = ?",
              existingLedger.reference_id, userId,
            ).toArray()[0] as Record<string, unknown> | undefined
          : undefined;
        const existingDecision = existingLedger.reference_id
          ? this.ctx.storage.sql.exec(
              "SELECT id FROM ai_paper_decisions WHERE user_id = ? AND position_id = ?",
              userId, existingLedger.reference_id,
            ).toArray()[0] as { id: string } | undefined
          : undefined;
        const same = existingLedger.kind === "open_position" &&
          existingDecision?.id === decisionId &&
          BigInt(existingLedger.amount_micro) === -reserve &&
          !!existingPosition &&
          String(existingPosition.symbol) === symbol &&
          String(existingPosition.side) === side &&
          String(existingPosition.qty_units) === qtyUnits &&
          String(existingPosition.entry_price) === entryPrice &&
          String(existingPosition.margin_micro) === rawMargin &&
          String(existingPosition.leverage) === String(leverage) &&
          String(existingPosition.fees_micro) === rawFees &&
          String(existingPosition.slippage_micro) === rawSlippage &&
          (existingPosition.stop_loss_price === null ? stopLossPrice === null : String(existingPosition.stop_loss_price) === stopLossPrice) &&
          (existingPosition.take_profit_price === null ? takeProfitPrice === null : String(existingPosition.take_profit_price) === takeProfitPrice);
        if (same) { duplicate = true; positionId = String(existingPosition?.id); }
        else conflict = true;
        return;
      }

      const decision = this.ctx.storage.sql.exec(
        "SELECT id, symbol, signal, risk_pass, position_id, observed_price, created_at FROM ai_paper_decisions WHERE id = ? AND user_id = ?",
        decisionId, userId,
      ).toArray()[0] as { id: string; symbol: string; signal: string; risk_pass: number; position_id: string | null; observed_price: string; created_at: number } | undefined;
      if (!decision || decision.symbol !== symbol || Number(decision.risk_pass) !== 1 ||
          (side === "long" && decision.signal !== "buy") || (side === "short" && decision.signal !== "sell") ||
          decision.position_id !== null) {
        invalidDecision = true;
        return;
      }

      const existingOpen = this.ctx.storage.sql.exec(
        "SELECT id FROM ai_paper_positions WHERE user_id = ? AND symbol = ? AND status = 'open' LIMIT 1",
        userId, symbol,
      ).toArray()[0] as { id: string } | undefined;
      if (existingOpen) { openPositionExists = true; return; }

      const openCount = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM ai_paper_positions WHERE user_id = ? AND status = 'open'",
        userId,
      ).toArray()[0] as { count: number } | undefined;
      if (Number(openCount?.count ?? 0) >= 3) { positionLimitExceeded = true; return; }

      const account = this.ctx.storage.sql.exec(
        "SELECT balance_micro, status FROM ai_paper_accounts WHERE user_id = ?", userId,
      ).toArray()[0] as { balance_micro: string; status: string } | undefined;
      if (!account) { invalidDecision = true; return; }
      if (account.status !== "active") { sessionInactive = true; return; }
      const before = BigInt(account.balance_micro);
      if (before < 0n) { invalidDecision = true; return; }
      if (before < reserve) { insufficient = true; return; }

      // All risk thresholds are server-owned. Missing/malformed bindings fail closed.
      const rawMaxOrderPct = this.env.MAX_ORDER_PCT;
      const rawMaxExposurePct = this.env.MAX_TOTAL_EXPOSURE_PCT;
      const rawMaxDailyLossPct = this.env.MAX_DAILY_LOSS_PCT;
      const validPct = (value: string | undefined): boolean =>
        value !== undefined && value.trim() !== "" &&
        Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 100;
      if (!validPct(rawMaxOrderPct) || !validPct(rawMaxExposurePct) || !validPct(rawMaxDailyLossPct)) {
        invalidDecision = true;
        return;
      }
      const limits = riskLimits(this.env as Parameters<typeof riskLimits>[0]);
      const maxOrderPpm = parseFixed(String(limits.maxOrderPct), 1_000_000n, 6);
      const maxExposurePpm = parseFixed(String(limits.maxTotalExposurePct), 1_000_000n, 6);
      const maxDailyLossPpm = parseFixed(String(limits.maxDailyLossPct), 1_000_000n, 6);
      if (maxOrderPpm <= 0n || maxOrderPpm > 100_000_000n ||
          maxExposurePpm <= 0n || maxExposurePpm > 100_000_000n ||
          maxDailyLossPpm <= 0n || maxDailyLossPpm > 100_000_000n) {
        invalidDecision = true;
        return;
      }

      const now = Date.now();
      const decisionObservedAt = Number(decision.created_at);
      const decisionMark = parseDecimal8(decision.observed_price);
      if (parseFreshAiPaperMark(decision.observed_price, decisionObservedAt, now) === null ||
          decisionMark === null || decisionMark <= 0n) {
        invalidMark = true;
        return;
      }
      const markFor = (market: string): bigint | null => {
        const row = this.ctx.storage.sql.exec(
          "SELECT observed_price, created_at FROM ai_paper_decisions WHERE user_id = ? AND symbol = ? ORDER BY created_at DESC, id DESC LIMIT 1",
          userId, market,
        ).toArray()[0] as { observed_price: string; created_at: number } | undefined;
        if (!row) return null;
        return parseFreshAiPaperMark(row.observed_price, row.created_at, now);
      };

      // Every existing open symbol must have a complete, recent server-recorded mark.
      const openRows = this.ctx.storage.sql.exec(
        "SELECT symbol, side, qty_units, entry_price, margin_micro, fees_micro, slippage_micro FROM ai_paper_positions WHERE user_id = ? AND status = 'open'",
        userId,
      ).toArray() as Array<{ symbol: string; side: string; qty_units: string; entry_price: string; margin_micro: string; fees_micro: string; slippage_micro: string }>;
      let openMargin = 0n;
      let unrealizedEquity = 0n;
      let unrealizedDailyPnl = 0n;
      for (const row of openRows) {
        const mark = markFor(row.symbol);
        const quantity = parseDecimal8(row.qty_units);
        const entry = parseDecimal8(row.entry_price);
        const marginValue = /^\d{1,20}$/.test(row.margin_micro) ? BigInt(row.margin_micro) : -1n;
        const openFees = /^\d{1,20}$/.test(row.fees_micro) ? BigInt(row.fees_micro) : -1n;
        const openSlippage = /^\d{1,20}$/.test(row.slippage_micro) ? BigInt(row.slippage_micro) : -1n;
        if (mark === null || mark <= 0n || quantity === null || quantity <= 0n || entry === null || entry <= 0n ||
            marginValue < 0n || openFees < 0n || openSlippage < 0n ||
            (row.side !== "long" && row.side !== "short")) {
          invalidMark = true;
          return;
        }
        const entryNotional = quantity * entry / 10_000_000_000n;
        const markNotional = quantity * mark / 10_000_000_000n;
        const exitFeeEstimate = estimateProportionalCost(openFees, entryNotional, markNotional);
        const exitSlippageEstimate = estimateProportionalCost(openSlippage, entryNotional, markNotional);
        if (exitFeeEstimate === null || exitSlippageEstimate === null) { invalidMark = true; return; }
        const delta = row.side === "long" ? mark - entry : entry - mark;
        const gross = quantity * delta / 10_000_000_000n;
        openMargin += marginValue;
        // Entry costs already reduced free balance; do not subtract them twice from equity.
        unrealizedEquity += gross - exitFeeEstimate - exitSlippageEstimate;
        // Daily PnL includes the complete round-trip cost of the still-open position.
        unrealizedDailyPnl += gross - openFees - openSlippage - exitFeeEstimate - exitSlippageEstimate;
      }

      // Realized PnL uses durable close results, never ledger payout amounts.
      const utc = new Date(now);
      const dayStart = Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
      const closedRows = this.ctx.storage.sql.exec(
        "SELECT close_json FROM ai_paper_positions WHERE user_id = ? AND status = 'closed' AND closed_at >= ? AND closed_at <= ?",
        userId, dayStart, now,
      ).toArray() as Array<{ close_json: string | null }>;
      let realizedToday = 0n;
      for (const row of closedRows) {
        if (!row.close_json) { invalidMark = true; return; }
        let close: { netPnlMicro?: string };
        try { close = JSON.parse(row.close_json) as { netPnlMicro?: string }; }
        catch { invalidMark = true; return; }
        if (typeof close.netPnlMicro !== "string" || !/^(?:0|-?[1-9]\d{0,19})$/.test(close.netPnlMicro)) {
          invalidMark = true;
          return;
        }
        realizedToday += BigInt(close.netPnlMicro);
      }

      const equity = before + openMargin + unrealizedEquity;
      if (equity <= 0n) { positionLimitExceeded = true; return; }
      const maxOrderReserve = divRound(equity * maxOrderPpm, 100n * 1_000_000n, "floor");
      const maxAggregateMargin = divRound(equity * maxExposurePpm, 100n * 1_000_000n, "floor");
      if (reserve > maxOrderReserve || openMargin + margin > maxAggregateMargin) {
        positionLimitExceeded = true;
        return;
      }
      const newQuantity = parseDecimal8(qtyUnits);
      const newEntry = parseDecimal8(entryPrice);
      const newEntryNotional = newQuantity !== null && newEntry !== null
        ? newQuantity * newEntry / 10_000_000_000n
        : 0n;
      const newMarkNotional = newQuantity !== null
        ? newQuantity * decisionMark / 10_000_000_000n
        : 0n;
      const newFees = BigInt(rawFees);
      const newSlippage = BigInt(rawSlippage);
      const newExitFeeEstimate = estimateProportionalCost(newFees, newEntryNotional, newMarkNotional);
      const newExitSlippageEstimate = estimateProportionalCost(newSlippage, newEntryNotional, newMarkNotional);
      if (newQuantity === null || newEntry === null || newEntryNotional <= 0n ||
          newExitFeeEstimate === null || newExitSlippageEstimate === null) {
        invalidMark = true;
        return;
      }
      // Include the proposed order's entry costs and a conservative same-rate exit-cost estimate.
      const dailyPnlAfterEntry = realizedToday + unrealizedDailyPnl -
        newFees - newSlippage - newExitFeeEstimate - newExitSlippageEstimate;
      const dailyLossLimit = divRound(equity * maxDailyLossPpm, 100n * 1_000_000n, "floor");
      if (dailyLossLimit <= 0n || dailyPnlAfterEntry <= -dailyLossLimit) {
        dailyLossExceeded = true;
        return;
      }
      balanceAfter = before - reserve;

      this.ctx.storage.sql.exec(
        "INSERT INTO ai_paper_positions(id,user_id,symbol,side,qty_units,entry_price,margin_micro,leverage,fees_micro,slippage_micro,stop_loss_price,take_profit_price,status,opened_at,closed_at,close_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        newPositionId, userId, symbol, side, qtyUnits, entryPrice, rawMargin, String(leverage), rawFees, rawSlippage,
        stopLossPrice, takeProfitPrice, "open", now, null, null,
      );
      this.ctx.storage.sql.exec(
        "UPDATE ai_paper_accounts SET balance_micro = ?, updated_at = ? WHERE user_id = ?",
        balanceAfter.toString(), now, userId,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO ai_paper_ledger(user_id,idempotency_key,kind,amount_micro,balance_before_micro,balance_after_micro,reference_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
        userId, idempotencyKey, "open_position", (-reserve).toString(), before.toString(), balanceAfter.toString(), newPositionId, now,
      );
      this.ctx.storage.sql.exec(
        "UPDATE ai_paper_decisions SET position_id = ? WHERE id = ? AND user_id = ? AND position_id IS NULL",
        newPositionId, decisionId, userId,
      );
    });

    if (conflict) return Response.json({ ok: false, error: "Idempotency key уже использован с другой операцией или параметрами позиции." }, { status: 409 });
    if (invalidDecision) return Response.json({ ok: false, error: "Нет действующего одобренного AI paper решения или счёта для этой позиции." }, { status: 409 });
    if (invalidMark) return Response.json({ ok: false, error: "Нет полного свежего ценового снимка для всех открытых AI paper позиций. Новые сделки заблокированы." }, { status: 409 });
    if (dailyLossExceeded) return Response.json({ ok: false, error: "Достигнут серверный дневной лимит убытка AI paper. Новые сделки заблокированы до 00:00 UTC." }, { status: 409 });
    if (sessionInactive) return Response.json({ ok: false, error: "AI paper сессия остановлена. Запустите её явно перед открытием позиции." }, { status: 409 });
    if (openPositionExists) return Response.json({ ok: false, error: "Для этого инструмента уже открыта AI paper позиция." }, { status: 409 });
    if (positionLimitExceeded) return Response.json({ ok: false, error: "Достигнут лимит в три одновременно открытые AI paper позиции." }, { status: 409 });
    if (insufficient) return Response.json({ ok: false, error: "Недостаточно средств на AI paper счёте для маржи и резервов." }, { status: 409 });
    return Response.json({ ok: true, positionId, duplicate, balanceMicro: duplicate ? undefined : balanceAfter.toString() }, { status: duplicate ? 200 : 201 });
  }

  private claimAiPaperDecision(body: Record<string, unknown>): Response {
    const userId = String(body.userId ?? "");
    const tickId = String(body.tickId ?? "");
    if (!/^\d{1,20}$/.test(userId) || !/^[A-Za-z0-9._:-]{8,128}$/.test(tickId))
      return Response.json({ ok: false, error: "Некорректные параметры запуска AI paper." }, { status: 400 });

    const now = Date.now();
    const leaseExpiresAt = now + 120_000;
    let existing: Record<string, unknown> | undefined;
    let inProgress = false;
    this.ctx.storage.transactionSync(() => {
      existing = this.ctx.storage.sql.exec(
        "SELECT id, tick_id, market_snapshot_hash, symbol, signal, rationale, confidence, created_at FROM ai_paper_decisions WHERE user_id = ? AND tick_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        userId, tickId,
      ).toArray()[0] as Record<string, unknown> | undefined;
      if (existing) {
        this.ctx.storage.sql.exec("DELETE FROM ai_paper_decision_runs WHERE user_id = ? AND tick_id = ?", userId, tickId);
        return;
      }
      const pending = this.ctx.storage.sql.exec(
        "SELECT lease_expires_at FROM ai_paper_decision_runs WHERE user_id = ? AND tick_id = ?",
        userId, tickId,
      ).toArray()[0] as { lease_expires_at: number } | undefined;
      if (pending && Number(pending.lease_expires_at) > now) {
        inProgress = true;
        return;
      }
      if (pending) {
        this.ctx.storage.sql.exec(
          "UPDATE ai_paper_decision_runs SET lease_expires_at = ?, updated_at = ? WHERE user_id = ? AND tick_id = ?",
          leaseExpiresAt, now, userId, tickId,
        );
      } else {
        this.ctx.storage.sql.exec(
          "INSERT INTO ai_paper_decision_runs(user_id, tick_id, lease_expires_at, created_at, updated_at) VALUES(?,?,?,?,?)",
          userId, tickId, leaseExpiresAt, now, now,
        );
      }
    });
    if (existing) return Response.json({ ok: true, state: "completed", decision: {
      id: existing.id, tickId: existing.tick_id, marketSnapshotHash: existing.market_snapshot_hash,
      symbol: existing.symbol, signal: existing.signal, rationale: existing.rationale,
      confidence: existing.confidence === null ? null : Number(existing.confidence), observedAt: Number(existing.created_at),
    } });
    if (inProgress) return Response.json({ ok: false, state: "in_progress", error: "Запуск AI PAPER уже выполняется." }, { status: 409 });
    return Response.json({ ok: true, state: "claimed", leaseExpiresAt });
  }

  private releaseAiPaperDecision(body: Record<string, unknown>): Response {
    const userId = String(body.userId ?? "");
    const tickId = String(body.tickId ?? "");
    if (!/^\d{1,20}$/.test(userId) || !/^[A-Za-z0-9._:-]{8,128}$/.test(tickId))
      return Response.json({ ok: false, error: "Некорректные параметры запуска AI paper." }, { status: 400 });
    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec(
        "SELECT 1 AS found FROM ai_paper_decisions WHERE user_id = ? AND tick_id = ? LIMIT 1",
        userId, tickId,
      ).toArray()[0];
      if (!existing) this.ctx.storage.sql.exec(
        "DELETE FROM ai_paper_decision_runs WHERE user_id = ? AND tick_id = ?", userId, tickId,
      );
    });
    return Response.json({ ok: true });
  }

  private recordAiPaperDecision(body: Record<string, unknown>): Response {
    const userId = String(body.userId ?? "");
    const tickId = String(body.tickId ?? "");
    const strategyId = String(body.strategyId ?? "");
    const strategyVersion = String(body.strategyVersion ?? "");
    const marketSnapshotHash = String(body.marketSnapshotHash ?? "");
    let symbol = "";
    try { symbol = safeSymbol(body.symbol); } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : "Некорректный инструмент." }, { status: 400 });
    }
    const signal = String(body.signal ?? "");
    const rationale = String(body.rationale ?? "").trim();
    const confidence = body.confidence === undefined || body.confidence === null ? null : Number(body.confidence);
    const observedPrice = String(body.observedPrice ?? "");
    const riskPass = body.riskPass;
    const rejectionReason = body.rejectionReason === undefined || body.rejectionReason === null ? null : String(body.rejectionReason).trim();
    const positionId = body.positionId === undefined || body.positionId === null ? null : String(body.positionId);
    if (!/^\d{1,20}$/.test(userId) ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(tickId) ||
        !/^[A-Za-z0-9._:-]{1,64}$/.test(strategyId) ||
        !/^[A-Za-z0-9._:-]{1,32}$/.test(strategyVersion) ||
        !/^[a-f0-9]{32,128}$/i.test(marketSnapshotHash) ||
        !["buy", "sell", "hold"].includes(signal) ||
        !rationale || rationale.length > 500 ||
        (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) ||
        !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(observedPrice) ||
        !Number.isFinite(Number(observedPrice)) || Number(observedPrice) <= 0 ||
        typeof riskPass !== "boolean" ||
        (rejectionReason !== null && rejectionReason.length > 300) ||
        (riskPass === false && !rejectionReason) ||
        (positionId !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(positionId))) {
      return Response.json({ ok: false, error: "Некорректные параметры решения AI paper." }, { status: 400 });
    }

    const now = Date.now();
    const serverObservedAt = body.serverObservedAt === undefined ? now : Number(body.serverObservedAt);
    const id = crypto.randomUUID();
    let duplicate = false;
    let conflict = false;
    let invalidTimestamp = false;
    let decisionId = id;
    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec(
        "SELECT id, strategy_id, strategy_version, market_snapshot_hash, signal, rationale, confidence, observed_price, risk_pass, rejection_reason, position_id FROM ai_paper_decisions WHERE user_id = ? AND tick_id = ? AND symbol = ?",
        userId, tickId, symbol,
      ).toArray()[0] as Record<string, unknown> | undefined;
      if (existing) {
        decisionId = String(existing.id);
        const same = String(existing.strategy_id) === strategyId &&
          String(existing.strategy_version) === strategyVersion &&
          String(existing.market_snapshot_hash) === marketSnapshotHash &&
          String(existing.signal) === signal &&
          String(existing.rationale) === rationale &&
          (existing.confidence === null ? confidence === null : Number(existing.confidence) === confidence) &&
          String(existing.observed_price) === observedPrice &&
          Number(existing.risk_pass) === (riskPass ? 1 : 0) &&
          (existing.rejection_reason === null ? rejectionReason === null : String(existing.rejection_reason) === rejectionReason) &&
          (existing.position_id === null ? positionId === null : String(existing.position_id) === positionId);
        if (same) {
          duplicate = true;
          this.ctx.storage.sql.exec("DELETE FROM ai_paper_decision_runs WHERE user_id = ? AND tick_id = ?", userId, tickId);
        } else conflict = true;
        return;
      }
      if (!Number.isSafeInteger(serverObservedAt) || serverObservedAt <= 0 ||
          serverObservedAt > now || now - serverObservedAt > AI_PAPER_MARK_MAX_AGE_MS) {
        invalidTimestamp = true;
        return;
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO ai_paper_decisions(id,user_id,tick_id,strategy_id,strategy_version,market_snapshot_hash,symbol,signal,rationale,confidence,observed_price,risk_pass,rejection_reason,position_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id, userId, tickId, strategyId, strategyVersion, marketSnapshotHash, symbol, signal, rationale,
        confidence, observedPrice, riskPass ? 1 : 0, rejectionReason, positionId, serverObservedAt,
      );
      this.ctx.storage.sql.exec("DELETE FROM ai_paper_decision_runs WHERE user_id = ? AND tick_id = ?", userId, tickId);
    });
    if (conflict) return Response.json({ ok: false, error: "Tick id уже записан с другим решением." }, { status: 409 });
    if (invalidTimestamp) return Response.json({ ok: false, error: "Серверная котировка отсутствует, устарела или имеет неверное время." }, { status: 400 });
    return Response.json({ ok: true, id: decisionId, duplicate }, { status: duplicate ? 200 : 201 });
  }

  private aiPaperStatus(userId: string): Record<string, unknown> {
    if (!/^\d{1,20}$/.test(userId)) throw new Error("Не подтверждён пользователь Telegram.");
    const demoBalance = this.ensureAccount(userId);
    const account = this.ctx.storage.sql.exec(
      "SELECT balance_micro, status, strategy_id, strategy_version FROM ai_paper_accounts WHERE user_id = ?",
      userId,
    ).toArray()[0] as { balance_micro: string; status: string; strategy_id: string; strategy_version: string } | undefined;
    const openPositions = this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM ai_paper_positions WHERE user_id = ? AND status = 'open'",
      userId,
    ).toArray()[0] as { count: number } | undefined;
    return {
      ok: true,
      demoBalanceMicro: demoBalance.toString(),
      aiBalanceMicro: String(account?.balance_micro ?? "0"),
      status: account?.status ?? "stopped",
      strategyId: account?.strategy_id ?? "ma-crossover",
      strategyVersion: account?.strategy_version ?? "1",
      openPositions: Number(openPositions?.count ?? 0),
    };
  }

  private startAiPaperSession(body: Record<string, unknown>): Response {
    const userId = String(body.userId ?? "");
    if (!/^\d{1,20}$/.test(userId))
      return Response.json({ ok: false, error: "Не подтверждён пользователь Telegram." }, { status: 400 });
    let notFound = false;
    let insufficient = false;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const account = this.ctx.storage.sql.exec(
        "SELECT balance_micro FROM ai_paper_accounts WHERE user_id = ?", userId,
      ).toArray()[0] as { balance_micro: string } | undefined;
      if (!account) { notFound = true; return; }
      if (BigInt(account.balance_micro) <= 0n) { insufficient = true; return; }
      this.ctx.storage.sql.exec(
        "UPDATE ai_paper_accounts SET status = 'active', updated_at = ? WHERE user_id = ?",
        now, userId,
      );
    });
    if (notFound) return Response.json({ ok: false, error: "AI paper счёт не найден. Сначала пополните виртуальный баланс." }, { status: 404 });
    if (insufficient) return Response.json({ ok: false, error: "Для запуска AI paper сессии нужен положительный виртуальный баланс." }, { status: 409 });
    return Response.json({ ok: true, status: "active" });
  }

  private stopAiPaperSession(body: Record<string, unknown>): Response {
    const userId = String(body.userId ?? "");
    if (!/^\d{1,20}$/.test(userId))
      return Response.json({ ok: false, error: "Не подтверждён пользователь Telegram." }, { status: 400 });
    let notFound = false;
    let openPositions = 0;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const account = this.ctx.storage.sql.exec(
        "SELECT user_id FROM ai_paper_accounts WHERE user_id = ?", userId,
      ).toArray()[0] as { user_id: string } | undefined;
      if (!account) { notFound = true; return; }
      this.ctx.storage.sql.exec(
        "UPDATE ai_paper_accounts SET status = 'stopped', updated_at = ? WHERE user_id = ?",
        now, userId,
      );
      const count = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM ai_paper_positions WHERE user_id = ? AND status = 'open'",
        userId,
      ).toArray()[0] as { count: number } | undefined;
      openPositions = Number(count?.count ?? 0);
    });
    if (notFound) return Response.json({ ok: false, error: "AI paper счёт не найден." }, { status: 404 });
    return Response.json({ ok: true, status: "stopped", openPositions });
  }

  private fundAiPaper(body: Record<string, unknown>): Response {
    const userId = String(body.userId ?? "");
    const rawAmount = String(body.amountMicro ?? "");
    const idempotencyKey = String(body.idempotencyKey ?? "");
    if (!/^\d{1,20}$/.test(userId) || !/^\d{1,20}$/.test(rawAmount) ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
      return Response.json({ ok: false, error: "Некорректные параметры виртуального пополнения AI-счёта." }, { status: 400 });
    const amount = BigInt(rawAmount);
    if (amount <= 0n) return Response.json({ ok: false, error: "Сумма пополнения должна быть больше нуля." }, { status: 400 });

    // Ensure the legacy DEMO account exists before entering the atomic transfer.
    this.ensureAccount(userId);
    const now = Date.now();
    const operationId = "ai-fund:" + userId + ":" + idempotencyKey;
    let duplicate = false;
    let conflict = false;
    let insufficient = false;
    let demoAfter = 0n;
    let aiAfter = 0n;

    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec(
        "SELECT amount_micro FROM ai_paper_ledger WHERE user_id = ? AND idempotency_key = ?",
        userId, idempotencyKey,
      ).toArray()[0] as { amount_micro: string } | undefined;
      if (existing) {
        if (BigInt(existing.amount_micro) !== amount) conflict = true;
        else duplicate = true;
        return;
      }

      const demoRow = this.ctx.storage.sql.exec(
        "SELECT balance_micro FROM accounts WHERE user_id = ?", userId,
      ).toArray()[0] as { balance_micro: string } | undefined;
      const aiRow = this.ctx.storage.sql.exec(
        "SELECT balance_micro FROM ai_paper_accounts WHERE user_id = ?", userId,
      ).toArray()[0] as { balance_micro: string } | undefined;
      const demoBefore = BigInt(demoRow?.balance_micro ?? "0");
      const aiBefore = BigInt(aiRow?.balance_micro ?? "0");
      if (demoBefore < amount) {
        insufficient = true;
        return;
      }

      demoAfter = demoBefore - amount;
      aiAfter = aiBefore + amount;
      this.ctx.storage.sql.exec(
        "UPDATE accounts SET balance_micro = ? WHERE user_id = ?",
        demoAfter.toString(), userId,
      );
      if (aiRow) {
        this.ctx.storage.sql.exec(
          "UPDATE ai_paper_accounts SET balance_micro = ?, updated_at = ? WHERE user_id = ?",
          aiAfter.toString(), now, userId,
        );
      } else {
        this.ctx.storage.sql.exec(
          "INSERT INTO ai_paper_accounts(user_id,balance_micro,status,strategy_id,strategy_version,risk_config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
          userId, aiAfter.toString(), "stopped", "ma-crossover", "1", "{}", now, now,
        );
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO ledger(operation_id,user_id,kind,amount_micro,balance_before_micro,balance_after_micro,created_at) VALUES(?,?,?,?,?,?,?)",
        operationId, userId, "ai_fund", (-amount).toString(), demoBefore.toString(), demoAfter.toString(), now,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO ai_paper_ledger(user_id,idempotency_key,kind,amount_micro,balance_before_micro,balance_after_micro,reference_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
        userId, idempotencyKey, "fund_from_demo", amount.toString(), aiBefore.toString(), aiAfter.toString(), operationId, now,
      );
    });

    if (conflict) return Response.json({ ok: false, error: "Idempotency key уже использован с другой суммой." }, { status: 409 });
    if (insufficient) return Response.json({ ok: false, error: "Недостаточно средств на DEMO-счёте для виртуального пополнения." }, { status: 409 });
    if (duplicate) {
      const status = this.aiPaperStatus(userId);
      return Response.json({ ...status, duplicate: true, transferredMicro: amount.toString() });
    }
    const status = this.aiPaperStatus(userId);
    return Response.json({ ...status, duplicate: false, transferredMicro: amount.toString() });
  }

  private withdrawAiPaper(body: Record<string, unknown>): Response {
    const userId = String(body.userId ?? "");
    const rawAmount = String(body.amountMicro ?? "");
    const idempotencyKey = String(body.idempotencyKey ?? "");
    if (!/^\d{1,20}$/.test(userId) || !/^\d{1,20}$/.test(rawAmount) ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
      return Response.json({ ok: false, error: "Некорректные параметры возврата AI paper средств." }, { status: 400 });
    const amount = BigInt(rawAmount);
    if (amount <= 0n) return Response.json({ ok: false, error: "Сумма возврата должна быть больше нуля." }, { status: 400 });

    this.ensureAccount(userId);
    const now = Date.now();
    const operationId = "ai-withdraw:" + userId + ":" + idempotencyKey;
    let duplicate = false;
    let conflict = false;
    let insufficient = false;
    let openPositions = false;

    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec(
        "SELECT kind, amount_micro FROM ai_paper_ledger WHERE user_id = ? AND idempotency_key = ?",
        userId, idempotencyKey,
      ).toArray()[0] as { kind: string; amount_micro: string } | undefined;
      if (existing) {
        if (existing.kind !== "withdraw_to_demo" || BigInt(existing.amount_micro) !== -amount) conflict = true;
        else duplicate = true;
        return;
      }

      const openCount = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM ai_paper_positions WHERE user_id = ? AND status = 'open'",
        userId,
      ).toArray()[0] as { count: number } | undefined;
      if (Number(openCount?.count ?? 0) > 0) {
        openPositions = true;
        return;
      }

      const aiRow = this.ctx.storage.sql.exec(
        "SELECT balance_micro FROM ai_paper_accounts WHERE user_id = ?", userId,
      ).toArray()[0] as { balance_micro: string } | undefined;
      const demoRow = this.ctx.storage.sql.exec(
        "SELECT balance_micro FROM accounts WHERE user_id = ?", userId,
      ).toArray()[0] as { balance_micro: string } | undefined;
      const aiBefore = BigInt(aiRow?.balance_micro ?? "0");
      const demoBefore = BigInt(demoRow?.balance_micro ?? "0");
      if (aiBefore < amount) {
        insufficient = true;
        return;
      }

      const aiAfter = aiBefore - amount;
      const demoAfter = demoBefore + amount;
      this.ctx.storage.sql.exec(
        "UPDATE ai_paper_accounts SET balance_micro = ?, updated_at = ? WHERE user_id = ?",
        aiAfter.toString(), now, userId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE accounts SET balance_micro = ? WHERE user_id = ?",
        demoAfter.toString(), userId,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO ledger(operation_id,user_id,kind,amount_micro,balance_before_micro,balance_after_micro,created_at) VALUES(?,?,?,?,?,?,?)",
        operationId, userId, "ai_withdraw", amount.toString(), demoBefore.toString(), demoAfter.toString(), now,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO ai_paper_ledger(user_id,idempotency_key,kind,amount_micro,balance_before_micro,balance_after_micro,reference_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
        userId, idempotencyKey, "withdraw_to_demo", (-amount).toString(), aiBefore.toString(), aiAfter.toString(), operationId, now,
      );
    });

    if (conflict) return Response.json({ ok: false, error: "Idempotency key уже использован с другой операцией или суммой." }, { status: 409 });
    if (openPositions) return Response.json({ ok: false, error: "Закройте открытые AI paper позиции перед возвратом средств." }, { status: 409 });
    if (insufficient) return Response.json({ ok: false, error: "Недостаточно средств на AI paper счёте." }, { status: 409 });
    const status = this.aiPaperStatus(userId);
    return Response.json({ ...status, duplicate, transferredMicro: amount.toString() });
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

  /** UTC-day PnL: realized net PnL from closes today plus fee-aware mark-to-market on open positions. */
  private dailyNetPnl(userId: string, now = Date.now()): bigint {
    const utc = new Date(now);
    const dayStart = Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    const closedRows = this.ctx.storage.sql.exec(
      "SELECT close_json FROM positions WHERE user_id = ? AND status = 'closed' AND updated_at >= ?",
      userId, dayStart,
    ).toArray() as Array<{ close_json: string | null }>;
    let pnl = 0n;
    for (const row of closedRows) {
      if (!row.close_json) continue;
      const close = JSON.parse(row.close_json) as { totalNetPnlMicro?: string; netPnlMicro?: string };
      const value = close.totalNetPnlMicro ?? close.netPnlMicro;
      if (value !== undefined) pnl += BigInt(value);
    }
    for (const position of this.positions.values()) {
      if (position.userId !== userId || position.status !== "open") continue;
      const mark = this.freshQuote(position.symbol).price;
      const gross = unrealizedPnl(position, mark);
      const exitFee = feeMicro(notionalMicro(position.qtyUnits, mark), position.feePpm);
      pnl += gross - position.entryFeeMicro - exitFee;
    }
    return pnl;
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
    const maxDailyLossBps = BigInt(String(body.maxDailyLossBps ?? ""));
    if (maxOrderBps <= 0n || maxOrderBps > 10_000n || maxTotalExposureBps <= 0n || maxTotalExposureBps > 10_000n
      || maxDailyLossBps <= 0n || maxDailyLossBps > 10_000n)
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
    // Daily stop is anchored to the $1,000 demo seed and resets at 00:00 UTC.
    // Include today's realized net PnL, open-position mark-to-market after both fees,
    // and the entry fee of this proposed order. This check runs inside the DO,
    // so concurrent opens cannot race past the loss threshold.
    const dailyLossLimit = DEMO_SEED * maxDailyLossBps / 10_000n;
    const dailyPnlAfterEntry = this.dailyNetPnl(userId) - opened.position.entryFeeMicro;
    if (dailyPnlAfterEntry <= -dailyLossLimit)
      throw new Error("Достигнут дневной лимит убытка демо-счёта. Новые сделки заблокированы до 00:00 UTC.");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE accounts SET balance_micro = ? WHERE user_id = ?", opened.balanceAfterMicro.toString(), userId);
      const openedAt = Date.now();
      this.ctx.storage.sql.exec("INSERT INTO positions(id,user_id,symbol,status,position_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        input.id, userId, symbol, "open", serializePosition(opened.position), openedAt, openedAt);
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
      this.ctx.storage.sql.exec("UPDATE positions SET status = 'closed', position_json = ?, close_json = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'open'",
        serializePosition(result.position), JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value), Date.now(), id, userId);
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

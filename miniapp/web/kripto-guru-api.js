/* Public, DOM-independent API for the Kripto Guru Mini App.
 * Load this file before the visual UI bundle. All order authority remains server-side.
 */
(() => {
  // Preserve host-provided adapters used by the visual preview harness.
  if (window.KriptoGuruAPI) {
    window.dispatchEvent(new Event("kripto-guru-api-ready"));
    return;
  }
  const API_VERSION = "1.0.0";
  const MICRO = 1_000_000n;
  const PRICE_SCALE = 100_000_000n;

  class KriptoGuruApiError extends Error {
    constructor({ code = "API_ERROR", message = "Ошибка API.", status = 0, retryable = false } = {}) {
      super(message);
      this.name = "KriptoGuruApiError";
      this.code = code;
      this.status = status;
      this.retryable = Boolean(retryable);
    }
    toJSON() {
      return { code: this.code, message: this.message, status: this.status, retryable: this.retryable };
    }
  }

  function toScaled(value, scale, label) {
    const text = String(value ?? "").trim().replace(",", ".");
    if (!/^\d+(?:\.\d+)?$/.test(text)) {
      throw new KriptoGuruApiError({ code: "VALIDATION_ERROR", message: `Некорректное значение: ${label}.` });
    }
    const [whole, fraction = ""] = text.split(".");
    const digits = scale.toString().length - 1;
    if (fraction.length > digits) {
      throw new KriptoGuruApiError({ code: "VALIDATION_ERROR", message: `Слишком много знаков после запятой: ${label}.` });
    }
    return (BigInt(whole) * scale + BigInt(fraction.padEnd(digits, "0") || "0")).toString();
  }

  const fromMicro = (value) => Number(BigInt(value ?? "0")) / Number(MICRO);
  const fromPrice = (value) => Number(BigInt(value ?? "0")) / Number(PRICE_SCALE);
  const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

  function telegramInitData() {
    const fromSdk = window.Telegram?.WebApp?.initData;
    if (typeof fromSdk === "string" && fromSdk.length) return fromSdk;
    // Telegram normally exposes initData through the SDK. Read the signed raw
    // launch parameter as a fallback for WebViews where the SDK bridge races
    // page initialization. The server still verifies its HMAC before use.
    const fromParams = (raw) => {
      try { return new URLSearchParams(String(raw || "").replace(/^#/, "")).get("tgWebAppData") || ""; }
      catch { return ""; }
    };
    return fromParams(window.location?.search) || fromParams(window.location?.hash);
  }

  async function waitForTelegramInitData(timeoutMs = 3_000) {
    const startedAt = Date.now();
    let value = telegramInitData();
    while (!value && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      value = telegramInitData();
    }
    return value;
  }

  async function request(path, { method = "GET", body, timeoutMs = 12_000 } = {}) {
    const initData = await waitForTelegramInitData();
    if (!initData) {
      throw new KriptoGuruApiError({
        code: "TELEGRAM_AUTH_REQUIRED",
        message: "Откройте приложение через Telegram, чтобы получить доступ к демо-счёту.",
        status: 401,
        retryable: false,
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `tma ${initData}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let data;
      try { data = await response.json(); }
      catch {
        throw new KriptoGuruApiError({
          code: "INVALID_RESPONSE",
          message: `Сервер вернул некорректный ответ (HTTP ${response.status}).`,
          status: response.status,
          retryable: response.status >= 500,
        });
      }
      if (!response.ok || data?.ok === false) {
        throw new KriptoGuruApiError({
          code: data?.code || (response.status === 401 ? "TELEGRAM_AUTH_REQUIRED" : "API_ERROR"),
          message: data?.error || `Ошибка API (HTTP ${response.status}).`,
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      return data;
    } catch (error) {
      if (error instanceof KriptoGuruApiError) throw error;
      if (controller.signal.aborted) {
        throw new KriptoGuruApiError({ code: "TIMEOUT", message: "Превышено время ожидания API.", retryable: true });
      }
      throw new KriptoGuruApiError({
        code: "NETWORK_ERROR",
        message: "Не удалось связаться с сервером. Проверьте подключение и повторите попытку.",
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function normalizePosition(position) {
    return {
      id: String(position.id),
      symbol: String(position.symbol),
      side: position.side,
      status: position.status,
      leverage: Number(position.leverage),
      marginUsd: fromMicro(position.marginMicro),
      notionalUsd: fromMicro(position.entryNotionalMicro),
      entryPriceUsd: fromPrice(position.entryPrice),
      quantityRaw: String(position.qtyUnits),
      entryFeeUsd: fromMicro(position.entryFeeMicro),
      takeProfitUsd: position.takeProfitPrice == null ? null : fromPrice(position.takeProfitPrice),
      stopLossUsd: position.stopLossPrice == null ? null : fromPrice(position.stopLossPrice),
      liquidationPriceUsd: fromPrice(position.liquidationPrice),
      markPriceUsd: finite(position.markPriceUsd),
      unrealizedGrossPnlUsd: position.unrealizedGrossPnlMicro == null ? null : fromMicro(position.unrealizedGrossPnlMicro),
      estimatedExitFeeUsd: position.estimatedExitFeeMicro == null ? null : fromMicro(position.estimatedExitFeeMicro),
      estimatedNetPnlUsd: position.estimatedNetPnlMicro == null ? null : fromMicro(position.estimatedNetPnlMicro),
      unrealizedPnlUsd: position.estimatedNetPnlMicro == null ? null : fromMicro(position.estimatedNetPnlMicro),
      markObservedAt: position.markObservedAt == null ? null : Number(position.markObservedAt),
      raw: position,
    };
  }

  const wallet = {
    async get() {
      const data = await request("/api/demo");
      return {
        mode: "demo",
        balanceUsd: fromMicro(data.balanceMicro),
        balanceMicro: String(data.balanceMicro),
        positions: (data.positions || []).map(normalizePosition),
        raw: data,
      };
    },
  };

  const markets = {
    async list({ category = "crypto" } = {}) {
      if (!["crypto", "futures"].includes(category)) {
        return { available: false, reason: "Для акций и фондов пока нет подтверждённого источника котировок.", markets: [] };
      }
      const data = await request("/api/contracts");
      const markets = (Array.isArray(data.contracts) ? data.contracts : []).map((item) => ({
        symbol: item.market || String(item.name || "").replace(/-USDC?$/i, ""),
        name: item.name || item.market,
        priceUsd: finite(item.markPrice) ?? finite(item.price),
        markPriceUsd: finite(item.markPrice),
        change24hPct: finite(item.change24hPct),
        volume24hUsd: finite(item.volume24hUsd),
        productType: "future",
        maxLeverage: Number(item.maxLeverage || 1),
        takerFeePct: finite(item.takerFeePct) == null ? null : Number((Number(item.takerFeePct) * 100).toFixed(6)),
        fundingRateHourlyPct: finite(item.fundingRateHourly) == null ? null : Number((Number(item.fundingRateHourly) * 100).toFixed(8)),
        minSizeUsd: finite(item.minSizeQuote),
        tradeable: item.allowed === true,
        source: item.source || "Hyperliquid",
        raw: item,
      })).filter((item) => item.symbol && Number.isFinite(item.priceUsd) && item.priceUsd > 0);
      if (!markets.length) {
        throw new KriptoGuruApiError({
          code: "MARKET_DATA_UNAVAILABLE",
          message: "Поставщик не вернул актуальные котировки. Повторяем загрузку рынка.",
          retryable: true,
        });
      }
      return { available: true, category, markets, raw: data };
    },
  };

  const market = {
    async get(symbol) {
      const normalized = String(symbol || "").trim().toUpperCase();
      if (!normalized) throw new KriptoGuruApiError({ code: "VALIDATION_ERROR", message: "Укажите торговый актив." });
      const [list, quote] = await Promise.all([
        markets.list({ category: "futures" }),
        request("/api/price?market=" + encodeURIComponent(normalized)),
      ]);
      const item = list.markets.find((entry) => entry.symbol === normalized);
      if (!item) throw new KriptoGuruApiError({ code: "MARKET_UNAVAILABLE", message: "Актив сейчас недоступен." });
      return {
        ...item,
        priceUsd: finite(quote.markPrice) ?? finite(quote.price) ?? item.markPriceUsd ?? item.priceUsd,
        markPriceUsd: finite(quote.markPrice) ?? item.markPriceUsd ?? null,
        maxLeverage: Number(item.maxLeverage || 1),
        minMarginUsd: finite(quote.minMargin),
        fundingRateHourlyPct: finite(item.fundingRateHourlyPct),
        takerFeePct: finite(item.takerFeePct),
        productType: "Фьючерс",
        tradeable: item.tradeable === true,
        raw: { contract: item.raw, quote },
      };
    },
    async candles(symbol, interval = "15m") {
      const allowed = ["1m", "5m", "15m", "1h", "4h", "1d"];
      if (!allowed.includes(interval)) {
        throw new KriptoGuruApiError({ code: "VALIDATION_ERROR", message: "Неподдерживаемый таймфрейм." });
      }
      const data = await request("/api/chart?market=" + encodeURIComponent(String(symbol).toUpperCase()) + "&interval=" + encodeURIComponent(interval));
      return { symbol: String(symbol).toUpperCase(), interval: data.interval, source: data.source, candles: data.candles || [], raw: data };
    },
  };

  const trade = {
    async preview({ symbol, side, marginUsd, leverage = 1 } = {}) {
      if (!["long", "short"].includes(side)) {
        throw new KriptoGuruApiError({ code: "VALIDATION_ERROR", message: "Направление должно быть LONG или SHORT." });
      }
      const data = await request("/api/demo/preview", {
        method: "POST",
        body: { symbol: String(symbol || "").toUpperCase(), side, leverage: Number(leverage), ...(marginUsd == null ? {} : { marginMicro: toScaled(marginUsd, MICRO, "маржа") }) },
      });
      return {
        symbol: data.symbol,
        side: data.side,
        priceUsd: finite(data.priceUsd),
        leverage: Number(data.leverage),
        marginUsd: finite(data.marginUsd),
        maxMarginUsd: finite(data.maxMarginUsd),
        volumeUsd: finite(data.volumeUsd),
        entryFeeUsd: finite(data.entryFeeUsd),
        estimatedExitFeeUsd: finite(data.estimatedExitFeeUsd),
        exitFeeUsd: finite(data.estimatedExitFeeUsd),
        liquidationPriceUsd: finite(data.liquidationPriceUsd),
        valid: data.tradeable === true,
        available: data.tradeable === true,
        tradeable: data.tradeable === true,
        reason: data.reason || null,
        raw: data,
      };
    },
    async open({ symbol, side, marginUsd, leverage = 1, takeProfitUsd = null, stopLossUsd = null } = {}) {
      if (!["long", "short"].includes(side)) {
        throw new KriptoGuruApiError({ code: "VALIDATION_ERROR", message: "Направление должно быть LONG или SHORT." });
      }
      const payload = {
        symbol: String(symbol || "").toUpperCase(),
        side,
        leverage: Number(leverage),
        marginMicro: toScaled(marginUsd, MICRO, "маржа"),
        takeProfitPrice: takeProfitUsd == null ? null : toScaled(takeProfitUsd, PRICE_SCALE, "тейк-профит"),
        stopLossPrice: stopLossUsd == null ? null : toScaled(stopLossUsd, PRICE_SCALE, "стоп-лосс"),
      };
      const data = await request("/api/demo/open", { method: "POST", body: payload });
      return { position: normalizePosition(data.position), balanceUsd: fromMicro(data.balanceMicro), balanceMicro: String(data.balanceMicro), raw: data };
    },
    async close(positionId) {
      const data = await request("/api/demo/close", { method: "POST", body: { positionId: String(positionId), manual: true } });
      return { closed: data.closed === true, result: data.result || null, raw: data };
    },
  };

  const live = {
    async status() {
      const data = await request("/api/live/status");
      return {
        connected: data.connected === true,
        readiness: data.readiness || { available: false, ok: false },
        balance: data.balance || { available: false, usd: null },
        issues: Array.isArray(data.issues) ? data.issues : [],
        observedAt: Number(data.observedAt || Date.now()),
        raw: data,
      };
    },
    async preview({ symbol, market, side, marginUsd, leverage = 1 } = {}) {
      if (!["long", "short"].includes(side)) throw new KriptoGuruApiError({ code: "VALIDATION_ERROR", message: "Направление должно быть LONG или SHORT." });
      const data = await request("/api/live/preview", {
        method: "POST",
        body: { market: String(market || symbol || "").toUpperCase(), side, marginUsd: Number(marginUsd), leverage: Number(leverage) },
      });
      return {
        handle: String(data.handle || ""),
        symbol: String(data.market || market || symbol || "").toUpperCase(),
        side: data.side,
        priceUsd: finite(data.priceUsd),
        leverage: Number(data.leverage),
        marginUsd: finite(data.marginUsd),
        notionalUsd: finite(data.notionalUsd),
        risk: data.risk ?? null,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
        expiresInSeconds: Number(data.expiresInSeconds || 0),
        valid: Boolean(data.handle),
        available: Boolean(data.handle),
        raw: data,
      };
    },
    async execute({ handle, confirm } = {}) {
      try {
        return await request("/api/live/execute", {
          method: "POST",
          body: { handle: String(handle || ""), confirm: confirm === true },
        });
      } catch (error) {
        if (error?.status === 202) return { ok: false, status: "unknown", error: error.message };
        throw error;
      }
    },
    async operation(handle) {
      const data = await request("/api/live/operation?handle=" + encodeURIComponent(String(handle || "")));
      return data;
    },
  };

  const history = {
    async list() {
      const data = await request("/api/demo/history");
      return {
        events: (data.trades || []).map((event) => ({
          id: event.id,
          event: event.event,
          timestamp: Number.isFinite(Number(event.at)) ? new Date(Number(event.at)).toLocaleString("ru-RU") : String(event.at || ""),
          symbol: event.market,
          side: event.side,
          priceUsd: finite(event.price),
          netPnlUsd: event.pnl == null ? null : finite(event.pnl),
          reason: event.reason || null,
          mode: "demo",
          raw: event,
        })),
        equity: (data.equity || []).map(([timestamp, balanceUsd]) => ({ timestamp: Number(timestamp), balanceUsd: Number(balanceUsd) })),
        raw: data,
      };
    },
  };

  const companion = {
    async list() {
      const data = await request("/api/companion/conversations");
      return data.conversations || [];
    },
    async get(conversationId) {
      const data = await request("/api/companion/conversations/" + encodeURIComponent(String(conversationId)));
      return data.conversation;
    },
    async send(message, conversationId, attachments = [], mode = "general") {
      const data = await request("/api/companion/chat", {
        method: "POST",
        body: { message: String(message), mode: String(mode), ...(conversationId ? { conversationId: String(conversationId) } : {}), ...(attachments.length ? { attachments } : {}) },
        timeoutMs: 30_000,
      });
      return data;
    },
    async remove(conversationId) {
      return request("/api/companion/conversations/" + encodeURIComponent(String(conversationId)), { method: "DELETE" });
    },
    async limits() {
      const data = await request("/api/companion/limits");
      return data.limits || {};
    },
  };

  const capabilities = {
    async get() {
      return {
        live: { available: true, reason: "LIVE доступен при подключённом Walt и успешной проверке готовности." },
        stocks: { available: false, reason: "Нет подтверждённого источника котировок акций." },
        funds: { available: false, reason: "Нет подтверждённого источника котировок фондов." },
        ipo: { available: false, reason: "Данные IPO пока не подключены." },
        bonuses: { available: false, reason: "Механика бонусов пока не реализована." },
        demo: { available: true },
      };
    },
  };

  const api = Object.freeze({
    version: API_VERSION,
    wallet,
    markets,
    market,
    trade,
    live,
    history,
    companion,
    capabilities,
    errors: Object.freeze({ ApiError: KriptoGuruApiError }),
  });

  Object.defineProperty(window, "KriptoGuruAPI", { value: api, writable: false, configurable: true, enumerable: true });
})();

(() => {
  "use strict";

  const tg = window.Telegram?.WebApp || null;
  const MONEY_SCALE = 1_000_000n;
  const PRICE_SCALE = 100_000_000n;
  const QTY_SCALE = 100_000_000n;
  let marketsCache = null;
  let marketsAt = 0;
  let marketsPending = null;

  function apiError(message, code = "API_ERROR", retryable = false) {
    const error = new Error(message);
    error.code = code;
    error.retryable = retryable;
    return error;
  }

  async function request(route, { method = "GET", query = {}, body } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    const url = "/api/" + route + (params.size ? "?" + params.toString() : "");
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: "tma " + (tg?.initData || ""),
          ...(method === "POST" ? { "Content-Type": "application/json" } : {})
        },
        ...(method === "POST" ? { body: JSON.stringify(body || {}) } : {})
      });
    } catch (error) {
      throw apiError("Не удалось связаться с DEMO-сервисом. Проверьте соединение.", "NETWORK_ERROR", true);
    }
    let data;
    try { data = await response.json(); }
    catch { throw apiError("Сервер вернул некорректный ответ.", "INVALID_RESPONSE", true); }
    if (!response.ok || data?.ok === false) {
      throw apiError(data?.error || ("Ошибка API: " + response.status), "API_REJECTED", response.status >= 500);
    }
    return data;
  }

  const toUsd = (micro) => Number(BigInt(micro || "0")) / Number(MONEY_SCALE);
  const toPrice = (units) => Number(BigInt(units || "0")) / Number(PRICE_SCALE);
  const toQty = (units) => Number(BigInt(units || "0")) / Number(QTY_SCALE);
  const fromUsd = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > 1_000_000_000) throw apiError("Введите корректную сумму маржи.");
    return BigInt(Math.round(n * Number(MONEY_SCALE))).toString();
  };
  const pnlUsd = (position, price) => {
    if (!(price > 0)) return null;
    const entry = BigInt(position.entryPrice || "0");
    const current = BigInt(Math.round(price * Number(PRICE_SCALE)));
    const qty = BigInt(position.qtyUnits || "0");
    const delta = position.side === "short" ? entry - current : current - entry;
    return Number(qty * delta * MONEY_SCALE / (PRICE_SCALE * QTY_SCALE)) / Number(MONEY_SCALE);
  };

  async function getMarkets({ force = false } = {}) {
    if (!force && marketsCache && Date.now() - marketsAt < 15_000) return marketsCache;
    if (!force && marketsPending) return marketsPending;
    marketsPending = request("contracts").then((data) => {
      const list = Array.isArray(data.contracts) ? data.contracts : [];
      marketsCache = list.map((c) => {
        const symbol = String(c.market || c.name || "").replace(/-USDC?$/i, "").toUpperCase();
        return {
          ...c,
          symbol,
          name: symbol,
          priceUsd: Number(c.price || c.markPrice || c.midPrice || 0),
          change24hPct: Number(c.change24hPct || 0),
          volume24hUsd: Number(c.volume24hUsd || 0),
          fundingRateHourlyPct: Number(c.fundingRateHourly || 0) * 100,
          takerFeePct: Number(c.takerFeePct || 0) * 100,
          maxLeverage: Math.max(1, Number(c.maxLeverage || 1)),
          productType: "Фьючерс",
          tradeable: c.allowed !== false && c.liquid !== false
        };
      }).filter((c) => c.symbol);
      marketsAt = Date.now();
      return marketsCache;
    }).finally(() => { marketsPending = null; });
    return marketsPending;
  }

  async function getAccount() {
    return request("demo");
  }

  async function getWallet() {
    const account = await getAccount();
    const rawPositions = Array.isArray(account.positions) ? account.positions : [];
    let markets = [];
    if (rawPositions.length) {
      try { markets = await getMarkets(); } catch { /* Balance remains readable if quotes are temporarily unavailable. */ }
    }
    const bySymbol = new Map(markets.map((m) => [m.symbol, m]));
    const positions = rawPositions.map((p) => {
      const symbol = String(p.symbol || "").toUpperCase();
      const mark = Number(bySymbol.get(symbol)?.priceUsd || 0);
      return {
        id: p.id,
        positionId: p.id,
        symbol,
        side: p.side,
        leverage: Number(p.leverage || 1),
        marginUsd: toUsd(p.marginMicro),
        entryPriceUsd: toPrice(p.entryPrice),
        quantity: toQty(p.qtyUnits),
        unrealizedPnlUsd: mark > 0 ? pnlUsd(p, mark) : Number.NaN
      };
    });
    const balanceUsd = toUsd(account.balanceMicro);
    const marginUsd = positions.reduce((sum, p) => sum + p.marginUsd, 0);
    const unrealizedPnlUsd = positions.reduce((sum, p) => sum + (Number(p.unrealizedPnlUsd) || 0), 0);
    return {
      balanceUsd,
      balance: balanceUsd,
      equityUsd: balanceUsd + marginUsd + unrealizedPnlUsd,
      positions,
      mode: "demo",
      currency: "USDT"
    };
  }

  async function listMarkets({ category = "crypto" } = {}) {
    if (category === "stocks" || category === "funds") {
      return {
        available: false,
        reason: category === "stocks"
          ? "Проверенный источник котировок акций США пока не подключён. Демо-торговля акциями недоступна."
          : "Проверенный источник котировок фондов пока не подключён. Демо-торговля фондами недоступна.",
        markets: []
      };
    }
    const markets = await getMarkets();
    return { available: true, markets };
  }

  async function getMarket(symbol) {
    const key = String(symbol || "").trim().toUpperCase();
    const markets = await getMarkets();
    const contract = markets.find((m) => m.symbol === key);
    if (!contract) throw apiError("Актив не найден в доступном списке рынков.", "MARKET_NOT_FOUND");
    const quote = await request("price", { query: { market: key, leverage: 1 } });
    return {
      ...contract,
      priceUsd: Number(quote.price),
      price: Number(quote.price),
      maxLeverage: Math.min(contract.maxLeverage, Number(quote.maxDemoLeverage || contract.maxLeverage)),
      minMarginUsd: Number(quote.minMargin || 0),
      tradeable: contract.tradeable !== false
    };
  }

  async function getCandles(symbol, interval = "15m") {
    const data = await request("chart", { query: { market: symbol, interval } });
    return { candles: Array.isArray(data.candles) ? data.candles : [], source: data.source, interval: data.interval };
  }

  async function getHistory() {
    const data = await request("demo/history");
    const events = (data.trades || []).map((event) => ({
      ...event,
      symbol: event.market,
      timestamp: event.at ? new Date(Number(event.at)).toLocaleString("ru-RU") : "",
      netPnlUsd: event.pnl === undefined ? null : Number(event.pnl)
    }));
    return { events, history: events, equity: data.equity || [] };
  }

  async function previewTrade(input) {
    const symbol = String(input.symbol || "").toUpperCase();
    const side = String(input.side || "");
    const leverage = Number(input.leverage);
    const marginUsd = Number(input.marginUsd);
    if (side !== "long" && side !== "short") throw apiError("Выберите Лонг или Шорт.");
    if (!Number.isSafeInteger(leverage) || leverage < 1) throw apiError("Некорректное плечо.");
    if (!Number.isFinite(marginUsd) || marginUsd <= 0) throw apiError("Введите сумму маржи больше нуля.");
    const [market, wallet] = await Promise.all([getMarket(symbol), getWallet()]);
    if (market.tradeable === false) throw apiError("Этот рынок недоступен для DEMO-торговли.");
    if (leverage > market.maxLeverage) throw apiError("Максимальное плечо для актива: " + market.maxLeverage + "×.");
    if (marginUsd > wallet.balanceUsd) throw apiError("Недостаточно доступного демо-баланса.");
    const volumeUsd = marginUsd * leverage;
    const minNotional = Number(market.minSizeQuote || 0);
    const maxNotional = Number(market.maxSizeQuote || Number.MAX_SAFE_INTEGER);
    if (volumeUsd < minNotional) throw apiError("Минимальный объём позиции: $" + minNotional.toFixed(2) + ".");
    if (volumeUsd > maxNotional) throw apiError("Максимальный объём позиции: $" + maxNotional.toFixed(2) + ".");
    const feeRate = Number(market.takerFeePct || 0) / 100;
    return {
      valid: true,
      available: true,
      previewId: "demo-" + Date.now(),
      symbol,
      side,
      marginUsd,
      leverage,
      priceUsd: market.priceUsd,
      volumeUsd,
      notionalUsd: volumeUsd,
      entryFeeUsd: volumeUsd * feeRate,
      exitFeeUsd: volumeUsd * feeRate
    };
  }

  async function openTrade(input) {
    const data = await request("demo/open", {
      method: "POST",
      body: {
        symbol: String(input.symbol || "").toUpperCase(),
        side: input.side,
        marginMicro: fromUsd(input.marginUsd),
        leverage: Number(input.leverage)
      }
    });
    return data;
  }

  async function closeTrade(id) {
    if (!id) throw apiError("Не указана позиция для закрытия.");
    return request("demo/close", { method: "POST", body: { positionId: String(id) } });
  }

  window.KriptoGuruAPI = Object.freeze({
    markets: { list: listMarkets },
    wallet: { get: getWallet },
    history: { list: getHistory },
    capabilities: { get: async () => ({
      ipo: { available: false, reason: "Проверенные данные IPO пока недоступны." },
      bonuses: { available: false, reason: "Бонусная программа пока не подключена." },
      live: { available: false, reason: "LIVE заблокирован. Доступен только демо-режим." }
    }) },
    market: { get: getMarket, candles: getCandles },
    trade: { preview: previewTrade, open: openTrade, close: closeTrade }
  });

  window.dispatchEvent(new Event("kripto-guru-api-ready"));
})();

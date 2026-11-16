// Wallet UI layer: reads the demo Engine account without changing the legacy grid state.
(function () {
  const $ui = (selector) => document.querySelector(selector);
  const money = (value) => Number(value || 0).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const priceText = (value) => Number(value || 0).toLocaleString("ru-RU", { maximumFractionDigits: Number(value) >= 1000 ? 2 : 6 });
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const token = (market) => ({ BTC:"₿", ETH:"Ξ", SOL:"◎", BNB:"◆", XRP:"X", DOGE:"Ð", HYPE:"H", SUI:"S", AVAX:"A" }[market] || String(market || "?").slice(0,1));
  let account = null;
  let lastRenderKey = "";
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem("kg:recent:v1") || "[]"); } catch {}
  const authHeaders = () => ({ Authorization: `tma ${window.Telegram?.WebApp?.initData || ""}` });

  async function demoRequest(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({ ok:false, error:`Ошибка ответа: ${response.status}` }));
    if (!response.ok || data.ok === false) throw new Error(data.error || `Ошибка API ${response.status}`);
    return data;
  }

  function getMarket(symbol) {
    return (typeof contracts !== "undefined" ? contracts : []).find((item) => item.market === symbol);
  }
  function toPriceUnits(value) {
    const scaled = Math.round(Number(value) * 100_000_000);
    return BigInt(Number.isSafeInteger(scaled) ? scaled : 0);
  }
  function positionPnl(position, marketPrice) {
    if (!marketPrice || !position.qtyUnits || !position.entryPrice) return 0;
    const qty = BigInt(position.qtyUnits);
    const entry = BigInt(position.entryPrice);
    const current = toPriceUnits(marketPrice);
    const delta = position.side === "long" ? current - entry : entry - current;
    return Number(qty * delta * 1_000_000n / 10_000_000_000_000_000n) / 1_000_000;
  }
  function fmtPnl(value) {
    const n = Number(value || 0);
    return (n >= 0 ? "+" : "−") + "$" + money(Math.abs(n));
  }

  function renderBalance() {
    if (!account) return;
    const balance = Number(BigInt(account.balanceMicro || "0")) / 1_000_000;
    const parts = money(balance).split(",");
    const html = `$${parts[0]}<span>,${parts[1] || "00"}</span>`;
    $ui("#wallet-balance-main").innerHTML = html;
    $ui("#wallet-usdt").textContent = "$" + money(balance);
    $ui("#wallet-assets-total").textContent = "$" + money(balance);
    // Legacy state fields are kept in sync for compatibility with existing grid UI.
    $ui("#home-equity").textContent = "$" + money(balance);
    $ui("#home-cash").textContent = "$" + money(balance);
    $ui("#demo-capital").textContent = "$" + money(balance);
    $ui("#wallet-change-usd").textContent = "Изменение за 24 ч: нет данных";
    $ui("#wallet-change-pct").textContent = "—";
    $ui("#wallet-change-pct").className = "change-chip";
  }

  function renderPositions() {
    if (!account) return;
    const positions = account.positions || [];
    $ui("#wallet-position-count").textContent = String(positions.length);
    if (!positions.length) {
      $ui("#engine-positions").innerHTML = `<div class="empty-wallet"><span class="empty-wallet-icon">${icon("chart")}</span><b>Позиций пока нет</b><button id="empty-open-markets" class="primary-button" type="button">Открыть рынки</button></div>`;
      return;
    }
    $ui("#engine-positions").innerHTML = positions.map((position) => {
      const market = getMarket(position.symbol);
      const current = Number(market?.price || 0);
      const pnl = positionPnl(position, current);
      const margin = Number(BigInt(position.marginMicro || "0")) / 1_000_000;
      const notional = Number(BigInt(position.entryNotionalMicro || "0")) / 1_000_000;
      const entry = Number(BigInt(position.entryPrice || "0")) / 100_000_000;
      const liquidation = Number(BigInt(position.liquidationPrice || "0")) / 100_000_000;
      const tp = position.takeProfitPrice ? Number(BigInt(position.takeProfitPrice)) / 100_000_000 : 0;
      const sl = position.stopLossPrice ? Number(BigInt(position.stopLossPrice)) / 100_000_000 : 0;
      const side = position.side === "long" ? "Лонг" : "Шорт";
      return `<article class="engine-position" data-engine-position="${escapeHtml(position.id)}">
        <div class="engine-position-head"><span class="coin-avatar">${escapeHtml(token(position.symbol))}</span><div class="engine-position-title"><b>${escapeHtml(position.symbol)} · ${side} ${escapeHtml(position.leverage)}×</b><small>Вход: $${priceText(entry)} · Сейчас: $${priceText(current)}</small></div><span class="side-chip ${position.side}">${side}</span></div>
        <div class="engine-position-grid">
          <div><span>Результат</span><b class="engine-pnl ${pnl >= 0 ? "up" : "down"}">${fmtPnl(pnl)}</b></div>
          <div><span>Маржа</span><b>$${money(margin)}</b></div>
          <div><span>Объём</span><b>$${money(notional)}</b></div>
          <div><span>Ликвидация · оценка</span><b>$${priceText(liquidation)}</b></div>
          <div><span>Тейк-профит</span><b>${tp ? "$" + priceText(tp) : "—"}</b></div>
          <div><span>Стоп-лосс</span><b>${sl ? "$" + priceText(sl) : "—"}</b></div>
        </div>
        <div class="engine-position-actions"><button class="secondary-button" type="button" data-view-position="${escapeHtml(position.symbol)}">Подробнее</button><button class="danger-button" type="button" data-close-engine-position="${escapeHtml(position.id)}">Закрыть</button></div>
      </article>`;
    }).join("");
  }

  function renderFavorites() {
    const strip = $ui("#wallet-favorites");
    const markets = (typeof contracts !== "undefined" ? contracts : []);
    if (!markets.length) return;
    let selected = markets.filter((item) => typeof favorites !== "undefined" && favorites.has(item.market));
    if (!selected.length) selected = markets.slice(0, 6);
    strip.innerHTML = selected.slice(0, 10).map((item) => {
      const pct = Number(item.change24hPct || 0);
      const positive = pct >= 0;
      const changeUsd = pct > -100 ? Number(item.price) - Number(item.price) / (1 + pct / 100) : 0;
      return `<button class="favorite-card" type="button" data-wallet-market="${escapeHtml(item.market)}">
        <div class="favorite-top"><span class="coin-avatar">${escapeHtml(token(item.market))}</span><b>${escapeHtml(item.market)}</b><small>${Number(item.maxLeverage || 1)}×</small></div>
        <div class="favorite-price" data-fav-price>${priceText(item.price)}</div>
        <div class="favorite-bottom"><span class="change-chip ${positive ? "up" : "down"}" data-fav-change>${positive ? "↑" : "↓"} ${Math.abs(pct).toFixed(2)}%</span><small class="favorite-change-usd">${changeUsd >= 0 ? "+" : "−"}${money(Math.abs(changeUsd))}</small><svg class="favorite-spark" data-fav-spark viewBox="0 0 58 22" aria-hidden="true"></svg></div>
      </button>`;
    }).join("");
    void loadFavoriteSparklines();
  }

  async function loadFavoriteSparklines() {
    const cards = [...document.querySelectorAll("#wallet-favorites .favorite-card")];
    await Promise.all(cards.map(async (card) => {
      const market = card.dataset.walletMarket;
      const svg = card.querySelector("[data-fav-spark]");
      if (!market || !svg) return;
      try {
        const result = await call("chart", { market, interval:"15m" });
        const values = (result.candles || []).map((candle) => Number(candle[4])).filter((value) => Number.isFinite(value) && value > 0);
        if (values.length < 2) return;
        const min = Math.min(...values), max = Math.max(...values), span = max - min || max * .001;
        const points = values.map((value,index) => [1 + index * 56 / (values.length - 1), 19 - (value - min) / span * 16]);
        const line = points.map(([x,y],index) => (index ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1)).join(" ");
        const rising = values[values.length - 1] >= values[0], stroke = rising ? "#34C759" : "#FF3B30";
        svg.innerHTML = '<path d="' + line + ' L57 22 L1 22 Z" fill="' + stroke + '" opacity=".10"/><path d="' + line + '" fill="none" stroke="' + stroke + '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>';
      } catch { svg.innerHTML = ""; }
    }));
  }

  function renderWallet() {
    renderBalance();
    renderPositions();
    renderFavorites();
  }

  async function loadWallet() {
    try {
      const next = await demoRequest("/api/demo");
      const key = JSON.stringify({ balanceMicro:next.balanceMicro, positions:(next.positions || []).map((p) => [p.id,p.status,p.symbol,p.side,p.leverage,p.entryPrice,p.qtyUnits,p.marginMicro,p.liquidationPrice,p.takeProfitPrice,p.stopLossPrice]) });
      account = next;
      if (key !== lastRenderKey) {
        renderWallet();
        lastRenderKey = key;
      } else if (!$ui("#wallet-favorites .favorite-card") && (typeof contracts !== "undefined" && contracts.length)) {
        renderFavorites();
      }
    } catch (error) {
      const target = $ui("#engine-positions");
      if (target && !account) target.innerHTML = `<div class="empty-wallet"><b>Не удалось загрузить демо-счёт</b><small>${escapeHtml(error.message)}</small><button class="secondary-button" id="wallet-retry" type="button">Повторить</button></div>`;
    }
  }

  function goToTrade(market) {
    document.querySelector('nav button[data-tab="pares"]')?.click();
    if (market) {
      $ui("#q").value = market;
      if (typeof renderPairs === "function") renderPairs();
      const row = [...document.querySelectorAll("#pairs .market-row")].find((item) => item.dataset.market === market);
      row?.click();
    }
  }

  $ui("#wallet-open-history")?.addEventListener("click", () => document.querySelector('nav button[data-tab="hist"]')?.click());
  $ui("#wallet-edit-favorites")?.addEventListener("click", () => {
    document.querySelector('nav button[data-tab="pares"]')?.click();
    $ui("#category-favorites")?.click();
  });
  $ui("#wallet-show-assets")?.addEventListener("click", () => $ui("#wallet-asset-list")?.scrollIntoView({ behavior:"smooth", block:"center" }));
  $ui("#engine-positions")?.addEventListener("click", (event) => { if (event.target.closest("#empty-open-markets")) goToTrade(); });
  $ui("#wallet-add-demo")?.addEventListener("click", () => window.Telegram?.WebApp?.showAlert?.("Пополнение виртуального счёта будет добавлено отдельной функцией. Реальные средства не используются."));
  $ui("#settings-reset-demo")?.addEventListener("click", () => window.Telegram?.WebApp?.showAlert?.("Сброс демо-счёта пока не подключён к Engine. Баланс и история не изменены."));
  $ui("#recent-clear")?.addEventListener("click", () => { recent = []; localStorage.removeItem("kg:recent:v1"); renderRecent(); });
  $ui("#category-futures")?.addEventListener("click", () => {
    document.querySelectorAll(".category-tile").forEach((item) => item.classList.toggle("selected", item.id === "category-futures"));
    if (typeof favoritesOnly !== "undefined") favoritesOnly = false;
    if (typeof renderPairs === "function") renderPairs();
  });
  $ui("#recent-markets")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-recent-market]");
    if (chip) goToTrade(chip.dataset.recentMarket);
  });
  $ui("#pairs")?.addEventListener("click", (event) => {
    const row = event.target.closest(".market-row");
    if (!row) return;
    const market = row.dataset.market;
    recent = [market, ...recent.filter((item) => item !== market)].slice(0, 8);
    try { localStorage.setItem("kg:recent:v1", JSON.stringify(recent)); } catch {}
    renderRecent();
  }, true);
  $ui("#wallet-favorites")?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-wallet-market]");
    if (card) goToTrade(card.dataset.walletMarket);
  });
  $ui("#engine-positions")?.addEventListener("click", async (event) => {
    const close = event.target.closest("[data-close-engine-position]");
    const view = event.target.closest("[data-view-position]");
    if (view) { goToTrade(view.dataset.viewPosition); return; }
    if (!close) return;
    const confirmed = await new Promise((resolve) => {
      const tgApp = window.Telegram?.WebApp;
      if (tgApp?.showConfirm) tgApp.showConfirm("Закрыть демо-позицию по текущей свежей котировке?", resolve);
      else resolve(window.confirm("Закрыть демо-позицию?"));
    });
    if (!confirmed) return;
    close.disabled = true;
    try {
      await demoRequest("/api/demo/close", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ positionId:close.dataset.closeEnginePosition, manual:true }) });
      await loadWallet();
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success");
    } catch (error) {
      window.Telegram?.WebApp?.showAlert?.(error.message);
      close.disabled = false;
    }
  });
  $ui("#engine-positions")?.addEventListener("click", (event) => {
    if (event.target.closest("#wallet-retry")) loadWallet();
  });

  function renderRecent() {
    const box = $ui("#recent-markets");
    if (!box) return;
    box.innerHTML = recent.length ? recent.map((market) => `<button class="recent-chip" type="button" data-recent-market="${escapeHtml(market)}"><span class="coin-avatar">${escapeHtml(token(market))}</span>${escapeHtml(market)}</button>`).join("") : '<span class="recent-empty">Здесь появятся просмотренные активы</span>';
  }

  // Keep the interface responsive: price labels update in a frame, list structure stays untouched.
  function updatePositionPrices() {
    if (!account) return;
    requestAnimationFrame(() => {
      for (const position of account.positions || []) {
        const market = getMarket(position.symbol);
        const card = document.querySelector(`[data-engine-position="${CSS.escape(position.id)}"]`);
        if (!card || !market) continue;
        const pnl = positionPnl(position, market.price);
        const pnlNode = card.querySelector(".engine-pnl");
        if (pnlNode) {
          pnlNode.textContent = fmtPnl(pnl);
          pnlNode.className = "engine-pnl " + (pnl >= 0 ? "up" : "down");
        }
        const quoteNode = card.querySelector(".engine-position-title small");
        if (quoteNode) {
          const entry = Number(BigInt(position.entryPrice || "0")) / 100_000_000;
          quoteNode.textContent = `Вход: $${priceText(entry)} · Сейчас: $${priceText(market.price)}`;
        }
      }
      for (const card of document.querySelectorAll("#wallet-favorites .favorite-card")) {
        const market = getMarket(card.dataset.walletMarket);
        if (!market) continue;
        const priceNode = card.querySelector("[data-fav-price]");
        const changeNode = card.querySelector("[data-fav-change]");
        if (priceNode) priceNode.textContent = "$" + priceText(market.price);
        if (changeNode) {
          const pct = Number(market.change24hPct || 0);
          changeNode.textContent = (pct >= 0 ? "↑ " : "↓ ") + Math.abs(pct).toFixed(2) + "%";
          changeNode.className = "change-chip " + (pct >= 0 ? "up" : "down");
          const changeUsd = pct > -100 ? Number(market.price) - Number(market.price) / (1 + pct / 100) : 0;
          const usdNode = card.querySelector(".favorite-change-usd");
          if (usdNode) usdNode.textContent = (changeUsd >= 0 ? "+" : "−") + "$" + money(Math.abs(changeUsd));
        }
      }
    });
  }

  window.kriptoGuruDemo = { getAccount: () => account, refresh: loadWallet };
  renderRecent();
  setTimeout(renderFavorites, 1_500);
  document.querySelectorAll(".bottom-nav button").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.tab === "hist" && typeof loadHistory === "function") loadHistory();
      if (button.dataset.tab === "pares" && typeof loadPairs === "function" && !contracts.length) loadPairs();
    });
  });
  loadWallet();
  setInterval(loadWallet, 12_000);
  setInterval(updatePositionPrices, 1_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadWallet(); updatePositionPrices(); } });
})();

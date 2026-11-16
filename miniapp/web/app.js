// Mini App: API protegida por initData assinado do Telegram e servida pelo mesmo Worker.
const tg = window.Telegram?.WebApp ?? null;
let telegramInitError = null;
try {
  if (tg) {
    tg.ready?.();
    tg.expand?.();
    tg.setHeaderColor?.('#F2F2F7');
    tg.setBackgroundColor?.('#F2F2F7');
    tg.setBottomBarColor?.('#F2F2F7');
  } else {
    telegramInitError = 'Telegram WebApp SDK недоступен';
    console.error('[Kripto Guru] ' + telegramInitError);
  }
} catch (error) {
  telegramInitError = 'Ошибка Telegram WebApp initialization: ' + (error?.message || error);
  console.error('[Kripto Guru]', error);
}

const $ = (sel) => document.querySelector(sel);
const fmt = (n, d = 2) => (n === null || n === undefined || Number.isNaN(+n) ? '—' : (+n).toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) }));
const usd = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(+n) ? '—' : '$' + fmt(n, d));
const signedPct = (n) => `${n >= 0 ? '↑+' : '↓'}${fmt(Math.abs(n), 2)}%`;
const pctText = (n) => (Number(n) >= 0 ? '↑' : '↓') + fmt(Math.abs(Number(n)) || 0, 2) + '%';
const moneyDecimals = (n) => { const value = Math.abs(Number(n)); return value >= 1000 ? 2 : value >= 1 ? 3 : value > 0 ? Math.min(10, Math.max(4, 5 - Math.floor(Math.log10(value)))) : 2; };
const ASSET_NAMES = {BTC:'Bitcoin',ETH:'Ethereum',SOL:'Solana',BNB:'BNB',XRP:'XRP',DOGE:'Dogecoin',ADA:'Cardano',AVAX:'Avalanche',LINK:'Chainlink',SUI:'Sui',LTC:'Litecoin',BCH:'Bitcoin Cash',HYPE:'Hyperliquid'};
const assetName = (market) => ASSET_NAMES[market] || market;
const compactPrice = (n) => Math.abs(Number(n)) >= 1_000_000 ? (Number(n) / 1_000_000).toFixed(2) + 'M' : Math.abs(Number(n)) >= 1_000 ? (Number(n) / 1_000).toFixed(1) + 'K' : fmt(n, moneyDecimals(n));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

async function call(name, input = {}, { timeoutMs = 12_000, signal: externalSignal } = {}) {
  const route = name === 'configure' ? 'grid' : name;
  const method = name === 'configure' || name === 'control' || name === 'manual' || name === 'demo/open' || name === 'demo/close' ? 'POST' : 'GET';
  const query = method === "GET"
    ? Object.entries(input).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abortExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortExternal();
  else externalSignal?.addEventListener('abort', abortExternal, { once: true });
  let response;
  try {
    response = await fetch(`/api/${route}${query ? `?${query}` : ""}`, {
    signal: controller.signal,
    method,
    headers: {
      Authorization: `tma ${tg.initData}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`Некорректный JSON от API (HTTP ${response.status})`); }
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Ошибка API: ${response.status}`);
    return data;
  } catch (error) {
    if (timedOut) throw new Error(`Таймаут API /api/${route} (${Math.round(timeoutMs / 1000)} с)`);
    if (controller.signal.aborted && externalSignal?.aborted) throw new Error('Запрос отменён');
    throw error instanceof TypeError ? new Error('Сетевая ошибка API: ' + error.message) : error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortExternal);
  }
}

let contractsPromise = null;
let contractsGeneration = 0;
async function getContracts({ force = false } = {}) {
  if (contractsPromise) return contractsPromise;
  if (!force && contracts.length) return { contracts };
  const generation = ++contractsGeneration;
  const request = call('contracts').then(result => {
    const list = Array.isArray(result.contracts) ? result.contracts : [];
    if (generation === contractsGeneration) contracts = list;
    return { ...result, contracts: list };
  });
  contractsPromise = request;
  try { return await request; }
  finally { if (contractsPromise === request) contractsPromise = null; }
}

function showError(err) {
  const msg = err?.message || String(err);
  $('#alert').innerHTML = `<div class="note">${icon('alert')}<span>${esc(msg)}</span></div>`;
  $('#alert').classList.remove('hidden');
}

let state = null;
let contracts = [];
let selectedMarket = '';
let showAssetGrid = false;
let assetChartMode = 'candles';
let lastQuoteUpdate = null;
let topSort = 'up';
let favoritesOnly = false;
const FAVORITES_KEY = 'kripto-guru:favorites:v1';
let favorites = new Set();
try { favorites = new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]')); }
catch (error) { console.warn('[Kripto Guru] Не удалось прочитать избранное из localStorage:', error); favorites = new Set(); }
function saveFavorites() { try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites])); } catch (error) { console.warn('[Kripto Guru] Не удалось сохранить избранное:', error); } }
try { if (localStorage.getItem(FAVORITES_KEY) === null) { favorites = new Set(["BTC", "ETH", "SOL"]); saveFavorites(); } }
catch (error) { console.warn('[Kripto Guru] localStorage недоступен:', error); }

// ---------- menu do perfil e modo ---------- 
const profileTrigger = $('#profile-trigger');
const profileMenu = $('#profile-menu');
function closeProfileMenu() {
  profileMenu.classList.add('hidden');
  profileTrigger.setAttribute('aria-expanded', 'false');
}
profileTrigger.addEventListener('click', (event) => {
  event.stopPropagation();
  const opening = profileMenu.classList.contains('hidden');
  profileMenu.classList.toggle('hidden', !opening);
  profileTrigger.setAttribute('aria-expanded', String(opening));
});
profileMenu.addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', closeProfileMenu);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeProfileMenu(); });
let modeSwitchPending = false;
$('#profile-demo').addEventListener('click', async () => {
  closeProfileMenu();
  if (state?.mode === 'paper' || modeSwitchPending) return;
  modeSwitchPending = true;
  const button = $('#profile-demo');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const result = await call('control', { action: 'mode', mode: 'paper' });
    ctrlMessage(result.message);
    await loadState();
  } catch (error) {
    showError(error);
  } finally {
    modeSwitchPending = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
});
// Реальный режим намеренно заблокирован и не отправляет запросы к API.

// ---------- abas ----------
document.querySelectorAll('.bottom-nav button').forEach((b, index) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.bottom-nav button').forEach((x) => x.classList.toggle('active', x === b));
    $('#nav-indicator').style.transform = 'translateX(' + (index * 100) + '%)';
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
    tg.HapticFeedback?.selectionChanged?.();
    if (b.dataset.tab === 'pares' && !contracts.length) loadPairs();
    if (b.dataset.tab === 'hist') loadHistory();
  }),
);

// ---------- painel ----------
let stateLoading = false;
let stateRefreshQueued = false;
async function loadState() {
  if (document.hidden) { stateRefreshQueued = true; return; }
  if (stateLoading) { stateRefreshQueued = true; return; }
  stateLoading = true;
  try {
    state = await call('state');
    $('#alert').classList.add('hidden');
    renderState();
    if (!contracts.length) loadMarketPreview();
    if (state.grid) loadChart(state.grid.market);
  } catch (e) {
    showError(e);
  } finally {
    stateLoading = false;
    if (stateRefreshQueued && !document.hidden) { stateRefreshQueued = false; queueMicrotask(loadState); }
  }
}

function balanceMarkup(value) {
  const parts = fmt(value, 2).split(',');
  return '<span class="balance-currency">$</span><span class="balance-major">' + esc(parts[0]) + '</span><span class="balance-minor">,' + esc(parts[1] || '00') + '</span>';
}
function gStatus(s) { return !s.grid ? 'Не настроена' : s.paused ? 'Пауза' : s.running ? 'Работает' : 'Готова'; }

function renderState() {
  const s = state;
  $('#mode').textContent = s.mode === 'paper' ? 'ДЕМО' : 'LIVE';
  $('#mode').className = `pill ${s.mode === 'live' ? 'live' : 'demo-pill'}`;
  $('#profile-demo').classList.toggle('selected', s.mode === 'paper');
  const demo = s.paper || {};
  const cash = Number(demo.cash ?? 1000);
  const startCash = Number(demo.startCash ?? 1000);
  const g = s.grid;
  const p = s.position;
  const activeContract = g ? contracts.find((item) => item.market === g.market) : null;
  const currentPositionPnl = p && s.mode === 'paper' && Number(activeContract?.price) > 0
    ? p.qty * (Number(activeContract.price) - p.entryPrice) - p.qty * Number(activeContract.price) * Number(activeContract.takerFeePct || 0)
    : p?.unrealizedPnl;
  const equity = Number(demo.equity ?? cash ?? 1000);
  const pnl = equity - startCash;
  $('#home-equity').innerHTML = balanceMarkup(equity);
  $('#home-equity').setAttribute('aria-label', usd(equity));
  $('#home-cash').textContent = usd(cash);
  $('#home-pnl').textContent = (pnl >= 0 ? '+' : '−') + usd(Math.abs(pnl));
  $('#home-change').textContent = signedPct(startCash ? pnl / startCash * 100 : 0);
  $('#home-change').className = `change-chip ${pnl >= 0 ? 'up' : 'down'}`;
  $('#home-pnl').className = pnl >= 0 ? 'up' : 'down';
  const manualPositions = s.manualPositions || [];
  $('#home-positions').textContent = String((s.position ? 1 : 0) + manualPositions.length);
  $('#run').textContent = s.paused ? 'Пауза' : s.running ? 'Сетка работает' : gStatus(s);
  $('#run').className = `pill ${s.running && !s.paused ? 'on' : ''}`;
  $('#grid-status').textContent = gStatus(s);
  $('#wallet-grid-run').textContent = s.paused ? 'Продолжить' : s.running ? 'Остановить' : g ? 'Запустить' : 'Настроить';
  const gridActionSecondary = !!s.running || !!s.paused;
  $('#wallet-grid-run').classList.toggle('secondary', gridActionSecondary);
  $('#wallet-grid-run').classList.toggle('primary', !gridActionSecondary);
  $('#demo-capital').textContent = usd(equity);
  const quoteTime = lastQuoteUpdate || (s.lastTick ? new Date(s.lastTick) : null);
  $('#market-updated').textContent = quoteTime ? `Live · ${quoteTime.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}` : 'Live · ждём котировку';


  const notes = [
    s.paused && ['pause', s.paused],
    s.lastBlock && ['ban', s.lastBlock],
    s.lastError && ['alert', s.lastError],
    s.mode === 'live' && !s.connected && ['plug', 'Подключение к торговому сервису недоступно'],
  ].filter(Boolean);
  $('#alert').innerHTML = notes.map(([ic, t]) => `<div class="note">${icon(ic)}<span>${esc(t)}</span></div>`).join('');
  $('#alert').classList.toggle('hidden', !notes.length);

  $('#g-desc').textContent = g ? `${g.market} ${usd(g.low)}–${usd(g.high)} · ${g.levels} уровней` : 'Не настроена';
  const rc = s.lastRecenter;
  $('#g-recenter-row').classList.toggle('hidden', !rc);
  if (rc) $('#g-recenter').textContent = `${new Date(rc.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · цена ${usd(rc.price)}`;
  $('#g-trade').textContent = g ? `маржа ${usd(g.marginUsd)} ${g.leverage}x ≈ ${usd(g.notional)} · SL ${usd(g.stopLoss)}` : '—';

  const lp = s.livePosition;
  if (p) {
    const pnl = currentPositionPnl;
    const rows = [
      ['Цена входа', usd(p.entryPrice, moneyDecimals(p.entryPrice))],
      ['Тейк-профит <button type="button" class="help-dot" data-help="tp">?</button>', usd(p.takeProfit, moneyDecimals(p.takeProfit))],
      ['Стоп-лосс <button type="button" class="help-dot" data-help="sl">?</button>', usd(p.stopLoss, moneyDecimals(p.stopLoss))],
      ['Маржа', usd(p.marginUsd)],
      ['Текущий результат', `<span class="pos-pnl ${pnl >= 0 ? 'up' : 'down'}">${usd(pnl, 4)}</span>`],
    ];
    if (lp) {
      const liq = +lp.liquidation_price;
      rows.push(['Ликвидация', `${usd(liq)}${liq && s.lastPrice ? ` (${fmt(((s.lastPrice - liq) / s.lastPrice) * 100, 1)}% до ликвидации)` : ''}`]);
      if (lp.funding_paid_quote !== undefined) rows.push(['Выплаченный фандинг', usd(lp.funding_paid_quote, 4)]);
      if (lp.margin_quote !== undefined) rows.push(['Маржа', usd(lp.margin_quote)]);
    }
    $('#pos').innerHTML = '<div class="position-heading"><span class="coin-avatar">' + esc((g?.market || '₿').slice(0,1)) + '</span><div><b>' + esc(g?.market || 'Позиция') + '</b><small>Покупка · ' + (g?.leverage || 1) + 'x</small></div><strong class="' + (pnl >= 0 ? 'up' : 'down') + '">' + usd(pnl, 4) + '</strong></div>' + rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('') + '<button id="position-close" class="danger position-close" type="button">Закрыть позицию</button>';
  } else {
    $('#pos').innerHTML = `<div class="empty-state">${icon('wallet')}<b>Позиций пока нет</b><small>${g ? 'Сетка ожидает достижения ценового уровня.' : 'Откройте рынки или настройте сетку.'}</small><button id="empty-open-markets" class="secondary" type="button">Открыть рынки</button></div>`;
  }
  if (manualPositions.length) {
    const cards = manualPositions.map((mp) => {
      const isLong = mp.side === 'long';
      const pnl = Number(mp.unrealizedPnl || 0);
      return `<div class="manual-position">
        <div class="position-heading"><span class="coin-avatar">${esc(mp.market.slice(0,1))}</span><div><b>${esc(mp.market)} · <span class="${isLong?'up':'down'}">${isLong?'LONG':'SHORT'}</span></b><small>Вход ${usd(mp.entryPrice, moneyDecimals(mp.entryPrice))} · ${mp.leverage}x</small></div><strong class="${pnl>=0?'up':'down'}">${usd(pnl,4)}</strong></div>
        <div class="row"><span>Текущая цена</span><b>${usd(mp.markPrice, moneyDecimals(mp.markPrice))}</b></div>
        <div class="row"><span>Объём / маржа</span><b>${usd(mp.notionalUsd)} / ${usd(mp.marginUsd)}</b></div>
        <div class="row"><span>Take Profit</span><b>${mp.takeProfit ? usd(mp.takeProfit, moneyDecimals(mp.takeProfit)) : 'Не задан'}</b></div>
        <div class="row"><span>Stop Loss</span><b>${mp.stopLoss ? usd(mp.stopLoss, moneyDecimals(mp.stopLoss)) : 'Не задан'}</b></div>
        <div class="row"><span>Ликвидация · оценка</span><b>${usd(mp.liquidationPrice, moneyDecimals(mp.liquidationPrice))}</b></div>
        <button class="danger position-close" type="button" data-manual-close="${esc(mp.id)}">Закрыть ${isLong?'Лонг':'Шорт'}</button>
      </div>`;
    }).join('');
    if (p) $('#pos').insertAdjacentHTML('beforeend', cards);
    else $('#pos').innerHTML = cards;
  }

  const st = s.stats;
  const eq = s.mode === 'paper' ? s.paper?.equity : null;
  $('#metric-trades').textContent = String(st.trades);
  $('#metric-wins').textContent = `${st.wins}/${st.losses}`;
  $('#metric-pnl').textContent = usd(st.realizedPnl, 4);
  $('#stats').innerHTML = '';
  $('#stats').classList.add('hidden');
}

async function loadChart(market, target = 'chart', interval = '15m') {
  try {
    const c = await call('chart', { market, interval });
    const source = target === 'chart' ? $('#chart-src') : document.querySelector(`[data-chart-source="${target}"]`);
    if (source) source.textContent = `Рыночные свечи · ${{'1m':'1м','5m':'5м','15m':'15м','1h':'1Ч','4h':'4Ч','1d':'1Д'}[interval] || '15м'}`;
    drawChart(c.candles, target, market);
  } catch (e) {
    const svg = document.getElementById(target);
    if (svg) svg.innerHTML = `<text x="10" y="20" fill="currentColor" font-size="12">${esc(e.message)}</text>`;
  }
}

function drawChart(candles, target = 'chart', market = '') {
  const svg = document.getElementById(target);
  if (!svg) return;
  const W = 360, H = 220, P = 8, plotW = 306, plotBottom = 194;
  const g = (target !== 'pair-chart' || showAssetGrid) && state?.grid?.market === market ? state.grid : null;
  const valid = (candles || []).filter((c) => c.length >= 5 && c.slice(1, 5).every((v) => Number.isFinite(+v)));
  const levels = g ? g.levelPrices.map((v) => ({ v, color: 'var(--hint)', dash: '3 4' })) : [];
  if (g && state.position) levels.push(
    { v: state.position.takeProfit, color: 'var(--green)' },
    { v: state.position.entryPrice, color: 'var(--link)' },
  );
  const enginePosition = target === 'pair-chart' ? window.kriptoGuruDemo?.getAccount?.()?.positions?.find((position) => position.symbol === market) : null;
  if (enginePosition) {
    const toPrice = (value) => Number(BigInt(value || "0")) / 100_000_000;
    levels.push({ v: toPrice(enginePosition.entryPrice), color: 'var(--link)', dash: '4 3' });
    if (enginePosition.takeProfitPrice) levels.push({ v: toPrice(enginePosition.takeProfitPrice), color: 'var(--green)', dash: '4 3' });
    if (enginePosition.stopLossPrice) levels.push({ v: toPrice(enginePosition.stopLossPrice), color: 'var(--red)', dash: '4 3' });
    if (enginePosition.liquidationPrice) levels.push({ v: toPrice(enginePosition.liquidationPrice), color: '#A855F7', dash: '2 3' });
  }
  const manualPosition = target === 'pair-chart' ? null : (state?.manualPositions || []).find((position) => position.market === market);
  if (manualPosition) {
    levels.push({ v: manualPosition.entryPrice, color: 'var(--link)' });
    if (manualPosition.takeProfit) levels.push({ v: manualPosition.takeProfit, color: 'var(--green)' });
    if (manualPosition.stopLoss) levels.push({ v: manualPosition.stopLoss, color: 'var(--red)' });
  }
  const quote = contracts.find((item) => item.market === market);
  const livePrice = Number(quote?.price);
  const all = valid.flatMap((c) => [+c[2], +c[3]]).concat(levels.map((l) => l.v), Number.isFinite(livePrice) && livePrice > 0 ? [livePrice] : []);
  if (!valid.length) {
    svg.innerHTML = '<text x="10" y="22" fill="currentColor" font-size="12">Нет данных для графика.</text>';
    return;
  }
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * .06 || hi * .01;
  lo -= pad; hi += pad;
  const y = (v) => plotBottom - ((v - lo) / (hi - lo)) * (plotBottom - P);
  const stepX = (plotW - 2 * P) / Math.max(1, valid.length);
  const bodyW = Math.max(2, Math.min(7, stepX * .62));
  let out = '';
  for (let i = 0; i <= 4; i++) {
    const value = hi - ((hi - lo) * i / 4), yy = y(value);
    out += '<line x1="0" x2="' + plotW + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--line)" stroke-width="1" stroke-dasharray="2 4"/>';
    out += '<text x="312" y="' + (yy + 3) + '" fill="var(--hint)" font-size="10">' + compactPrice(value) + '</text>';
  }
  out += levels.map((l) =>
    `<line x1="0" x2="${plotW}" y1="${y(l.v)}" y2="${y(l.v)}" stroke="${l.color}" stroke-width="1" ${l.dash ? `stroke-dasharray="${l.dash}"` : ''} vector-effect="non-scaling-stroke"/>`
  ).join('');
  if (target === 'pair-chart' && assetChartMode === 'line') {
    const points = valid.map((candle, index) => [P + stepX * (index + .5), y(Number(candle[4]))]);
    const path = points.map(([x, py], index) => (index ? 'L' : 'M') + x.toFixed(2) + ' ' + py.toFixed(2)).join(' ');
    const rising = Number(valid[valid.length - 1][4]) >= Number(valid[0][1]);
    const color = rising ? 'var(--green)' : 'var(--red)';
    out += '<defs><linearGradient id="assetLineFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + color + '" stop-opacity=".22"/><stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>';
    out += '<path d="' + path + ' L ' + points[points.length - 1][0] + ' ' + plotBottom + ' L ' + points[0][0] + ' ' + plotBottom + ' Z" fill="url(#assetLineFill)"/>';
    out += '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  } else {
    for (let i = 0; i < valid.length; i++) {
      const [, o, h, l, c] = valid[i].map(Number);
      const x = P + stepX * (i + .5);
      const rising = c >= o;
      const color = rising ? 'var(--green)' : 'var(--red)';
      const top = Math.min(y(o), y(c));
      const height = Math.max(1.2, Math.abs(y(c) - y(o)));
      out += `<line x1="${x}" x2="${x}" y1="${y(h)}" y2="${y(l)}" stroke="${color}" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
      out += `<rect x="${x - bodyW/2}" y="${top}" width="${bodyW}" height="${height}" rx=".7" fill="${color}"/>`;
    }
  }
  const last = valid[valid.length - 1];
  const caption = document.getElementById('asset-candle-caption');
  if (caption) caption.textContent = 'Закр. ' + new Date(+last[0]).toLocaleString('ru-RU',{weekday:'short',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
  const lastPrice = Number(quote?.price ?? last[4]), lastColor = Number(quote?.change24hPct ?? (lastPrice - +last[1])) >= 0 ? 'var(--green)' : 'var(--red)';
  out += '<line x1="0" x2="' + plotW + '" y1="' + y(lastPrice) + '" y2="' + y(lastPrice) + '" stroke="' + lastColor + '" stroke-width="1.2" stroke-dasharray="4 3"/>';
  out += '<text x="312" y="' + Math.max(11, Math.min(190, y(lastPrice) - 4)) + '" fill="' + lastColor + '" font-size="10" font-weight="700">' + compactPrice(lastPrice) + '</text>';
  const firstTime = new Date(+valid[0][0]).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  const lastTime = new Date(+last[0]).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  out += '<text x="0" y="214" fill="var(--hint)" font-size="10">' + firstTime + '</text><text x="' + plotW + '" y="214" text-anchor="end" fill="var(--hint)" font-size="10">' + lastTime + '</text>';
  const sl = g ? (state.position?.stopLoss ?? g.stopLoss) : null;
  if (Number.isFinite(sl)) {
    const ys = Math.min(H - 2, Math.max(2, y(sl)));
    out += `<line x1="0" x2="${plotW}" y1="${ys}" y2="${ys}" stroke="var(--red)" stroke-width="1.4" stroke-dasharray="4 3"/>`;
    out += `<text x="312" y="${ys - 4}" text-anchor="end" fill="var(--red)" font-size="10">SL ${usd(sl)}</text>`;
  }
  svg.innerHTML = out;
  const old = svg.querySelector('.crosshair-layer');
  old?.remove();
  const ns = 'http://www.w3.org/2000/svg';
  const layer = document.createElementNS(ns, 'g');
  layer.setAttribute('class', 'crosshair-layer');
  layer.style.display = 'none';
  const vline = document.createElementNS(ns, 'line');
  const hline = document.createElementNS(ns, 'line');
  const dot = document.createElementNS(ns, 'circle');
  [vline,hline].forEach((line) => { line.setAttribute('stroke','#59636d'); line.setAttribute('stroke-dasharray','3 3'); line.setAttribute('stroke-width','1'); });
  dot.setAttribute('r','3.5'); dot.setAttribute('fill','#007DFF'); dot.setAttribute('stroke','#fff'); dot.setAttribute('stroke-width','1.5');
  const tip = document.createElementNS(ns, 'rect');
  tip.setAttribute('width','150'); tip.setAttribute('height','92'); tip.setAttribute('rx','8'); tip.setAttribute('fill','rgba(35,42,50,.92)');
  const label = document.createElementNS(ns, 'text'); label.setAttribute('fill','#fff'); label.setAttribute('font-size','9');
  layer.append(vline,hline,dot,tip,label); svg.appendChild(layer);
  const tipLines = [];
  svg.onpointerdown = (event) => { svg.setPointerCapture?.(event.pointerId); };
  svg.onpointermove = (event) => {
    const rect = svg.getBoundingClientRect();
    const px = Math.max(0, Math.min(306, (event.clientX - rect.left) / rect.width * 360));
    const index = Math.max(0, Math.min(valid.length - 1, Math.floor((px - P) / stepX)));
    const candle = valid[index].map(Number);
    const x = P + stepX * (index + .5), closeY = y(candle[4]);
    vline.setAttribute('x1',x); vline.setAttribute('x2',x); vline.setAttribute('y1',8); vline.setAttribute('y2',194);
    hline.setAttribute('x1',0); hline.setAttribute('x2',306); hline.setAttribute('y1',closeY); hline.setAttribute('y2',closeY);
    dot.setAttribute('cx',x); dot.setAttribute('cy',closeY);
    const tx = x > 175 ? 5 : 205, ty = 8;
    tip.setAttribute('x',tx); tip.setAttribute('y',ty);
    label.setAttribute('x',tx+8); label.setAttribute('y',ty+13);
    const date = new Date(candle[0]).toLocaleString('ru-RU',{weekday:'short',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
    label.textContent = '';
    const candleChange = candle[1] ? ((candle[4] - candle[1]) / candle[1]) * 100 : 0;
    const rows = ['Откр. ' + fmt(candle[1],moneyDecimals(candle[1])), 'Закр. ' + fmt(candle[4],moneyDecimals(candle[4])), 'Макс. ' + fmt(candle[2],moneyDecimals(candle[2])), 'Мин. ' + fmt(candle[3],moneyDecimals(candle[3])), 'Изм. ' + pctText(candleChange), date];
    rows.forEach((value, row) => { const span = document.createElementNS(ns,'tspan'); span.setAttribute('x',tx+8); span.setAttribute('dy',row===0?0:13); span.textContent=value; label.appendChild(span); });
    layer.style.display = '';
  };
  svg.onpointerleave = () => { layer.style.display = 'none'; };
}

// ---------- pares ----------
async function loadPairs() {
  $('#pairs').innerHTML = '<div class="market-loading skeleton-row"></div><div class="market-loading skeleton-row"></div><div class="market-loading skeleton-row"></div>';
  try {
    await getContracts({ force: true });
    renderPairs();
    window.kriptoGuruDemo?.marketsUpdated?.();
    if (!contracts.length) window.kriptoGuruDemo?.showFavoritesError?.('Список рынков пуст.');
  } catch (error) {
    $('#pairs').innerHTML = '<div class="empty-state card-empty">' + esc(error.message) + '</div>';
    window.kriptoGuruDemo?.showFavoritesError?.(error.message);
  }
}

function renderPairs() {
  const q = $('#q').value.trim().toUpperCase();
  const list = contracts.filter((c) => (!q || c.market.includes(q)) && (!favoritesOnly || favorites.has(c.market)));
  $('#pairs').innerHTML = list.map((c) => {
    const favorite = favorites.has(c.market);
    const change = c.change24hPct === undefined ? '—' : pctText(c.change24hPct);
    return '<div class="item market-row ' + (c.allowed ? '' : 'blocked') + '" data-market="' + esc(c.market) + '" role="button" tabindex="0" aria-label="Открыть ' + esc(c.market) + '">' +
      '<span class="coin-avatar">' + esc(c.market.slice(0,1)) + '</span>' +
      '<div class="market-copy"><div class="name">' + esc(assetName(c.market)) + ' <small>' + esc(c.market) + '</small><span class="market-leverage">' + Number(c.maxLeverage || 1) + '×</span></div><div class="meta">' + (c.allowed ? 'Фьючерс · Цена котировки' : icon('lock') + ' Недоступен в демо') + '</div></div>' +
      '<div class="market-quote"><b>' + usd(c.price, moneyDecimals(c.price)) + '</b><small class="' + ((c.change24hPct || 0) >= 0 ? 'up' : 'down') + '">' + change + '</small></div>' +
      '<button type="button" class="favorite-toggle ' + (favorite ? 'is-favorite' : '') + '" data-favorite="' + esc(c.market) + '" aria-label="' + (favorite ? 'Убрать из избранного' : 'Добавить в избранное') + '">' + (favorite ? '★' : '☆') + '</button></div>';
  }).join('') || '<div class="empty-state card-empty">Ничего не найдено</div>';
  renderMarketVisuals(list);
}
$('#q').addEventListener('input', renderPairs);
$('#category-favorites').addEventListener('click', () => { favoritesOnly = true; $('#category-favorites').classList.add('selected'); $('#category-crypto').classList.remove('selected'); renderPairs(); });
$('#category-crypto').addEventListener('click', () => { favoritesOnly = false; $('#category-favorites').classList.remove('selected'); $('#category-crypto').classList.add('selected'); renderPairs(); });
$('#pairs').addEventListener('click', (ev) => { const fav=ev.target.closest('[data-favorite]'); if(!fav)return; ev.stopPropagation(); const m=fav.dataset.favorite; favorites.has(m)?favorites.delete(m):favorites.add(m); saveFavorites(); renderPairs(); });
$('#pairs').addEventListener('keydown', (ev) => { if((ev.key==='Enter'||ev.key===' ')&&ev.target.matches('.market-row')){ev.preventDefault();ev.target.click();} });
document.querySelectorAll('[data-top-sort]').forEach((b) => b.addEventListener('click', () => { topSort=b.dataset.topSort; document.querySelectorAll('[data-top-sort]').forEach(x=>x.classList.toggle('selected',x===b)); renderMarketVisuals(contracts.filter(c=>!$('#q').value || c.market.includes($('#q').value.trim().toUpperCase()))); }));
function renderMarketVisuals(source) {
  const items=[...source].filter(c=>Number.isFinite(+c.price)).sort((a,b)=>(b.volume24hUsd||0)-(a.volume24hUsd||0)).slice(0,12);
  const max=Math.max(1,...items.map(c=>+c.volume24hUsd||1));
  $('#heatmap').innerHTML=items.map(c=>{const pct=Number(c.change24hPct||0),strength=Math.min(1,Math.abs(pct)/8),hue=pct>=0?145:0,light=36-strength*8,ratio=Math.max(0.01,(+c.volume24hUsd||1)/max),span=Math.max(2,Math.min(7,Math.round(Math.sqrt(ratio)*7))),rowSpan=Math.max(1,Math.min(3,Math.round(Math.sqrt(ratio)*3)));return `<button type="button" class="heat-cell" style="grid-column:span ${span};grid-row:span ${rowSpan};background:hsl(${hue} 62% ${light}%)" data-heat-market="${esc(c.market)}"><b>${esc(c.market)}</b><small>${signedPct(pct)}</small></button>`;}).join('')||'<div class="market-loading">Нет данных для тепловой карты.</div>';
  const ranked=[...source].sort((a,b)=>topSort==='up'?(b.change24hPct||0)-(a.change24hPct||0):(a.change24hPct||0)-(b.change24hPct||0)).slice(0,8);
  $('#top-day').innerHTML=ranked.map(c=>`<button type="button" class="top-coin ${(c.change24hPct||0)>=0?'positive':'negative'}" data-heat-market="${esc(c.market)}"><span>${esc(c.market.slice(0,1))}</span><b>${esc(c.market)}</b><small class="${(c.change24hPct||0)>=0?'up':'down'}">${signedPct(c.change24hPct||0)}</small></button>`).join('');
}
$('#heatmap,#top-day').addEventListener('click',ev=>{const el=ev.target.closest('[data-heat-market]');if(!el)return;const m=el.dataset.heatMarket;$('#q').value=m;renderPairs();const item=[...document.querySelectorAll('#pairs .item')].find(x=>x.dataset.market===m);item?.click();});

$('#pairs').addEventListener('click', async (ev) => {
  if (ev.target.closest('[data-favorite]')) return;
  const item = ev.target.closest('.market-row');
  if (!item) return;
  const market = item.dataset.market;
  selectedMarket = market;
  const box = $('#pair-detail');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="asset-loading"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const p = await call('price', { market, leverage: 1 });
    window.kriptoGuruAssetMeta = p;
    const c = contracts.find((x) => x.market === market);
    const price = Number(c?.price ?? p.price);
    const change = Number(c?.change24hPct ?? 0);
    const isFav = favorites.has(market);
    const funding = Number(c?.fundingRateHourly ?? 0) * 100;
    box.innerHTML =
      '<div class="asset-topline"><button id="asset-back" class="asset-back secondary" type="button">' + icon('chevron') + 'Рынки</button><button id="asset-favorite" class="asset-favorite ' + (isFav ? 'is-favorite' : '') + '" type="button">' + (isFav ? '★ В избранном' : '☆ В избранное') + '</button></div>' +
      '<div class="asset-identity"><span class="asset-coin">' + esc(market.slice(0,1)) + '</span><div><h2>' + esc(assetName(market)) + '</h2><small>' + esc(market) + ' · Демо-рынок · Цена котировки</small></div></div>' +
      '<div id="asset-live-price" class="asset-detail-price">' + usd(price, moneyDecimals(price)) + '</div>' +
      '<div id="asset-live-change" class="asset-change ' + (change >= 0 ? 'up' : 'down') + '">' + pctText(change) + ' <span>за 24 часа</span></div>' +
      '<div class="asset-chart-wrap"><div class="chart-detail-head"><b>График цены</b><span id="asset-chart-source">Рыночные данные</span></div>' +
      '<div class="asset-chart-controls"><div class="timeframe-control" id="pair-timeframes">' + ['1m','5m','15m','1h','4h','1d'].map((v)=>'<button type="button" data-interval="' + v + '" class="' + (v==='15m'?'selected':'') + '">' + ({'1m':'1м','5m':'5м','15m':'15м','1h':'1Ч','4h':'4Ч','1d':'1Д'}[v]) + '</button>').join('') + '</div><button id="asset-grid-toggle" class="grid-layer-toggle" type="button" ' + (state?.grid?.market === market ? '' : 'disabled') + '>Показать сетку</button></div>' +
      '<svg id="pair-chart" viewBox="0 0 360 220" preserveAspectRatio="none" role="img" aria-label="Свечной график ' + esc(market) + '"></svg><div class="asset-chart-legend"><span><i class="legend-level"></i>Уровни сетки</span><span><i class="legend-entry"></i>Вход</span><span><i class="legend-tp"></i>Тейк-профит</span><span><i class="legend-sl"></i>Стоп-лосс</span></div>' +
      '<div class="chart-caption">Нажмите и ведите пальцем по графику, чтобы посмотреть значения свечи.</div></div>' +
      '<div class="asset-actions"><button id="use-pair" type="button">' + icon('grid') + 'Настроить сетку</button><button id="manual-trade-open" class="secondary" type="button">Открыть Лонг / Шорт</button></div>' +
      '<div class="section-title">О криптовалюте</div><div class="card asset-about"><p>Цена формируется на открытом рынке и может быстро меняться.</p><p>Демо-режим показывает реальные котировки, но использует только виртуальные средства.</p><p>Изменение за 24 часа не гарантирует дальнейшего движения цены.</p></div>' +
      '<div class="section-title">Подробнее</div><div class="card asset-tech">' +
      '<div class="row"><span>Объём за 24 часа</span><b>' + usd(c?.volume24hUsd, 0) + '</b></div>' +
      '<div class="row"><span>Фандинг за час <button type="button" class="help-dot" data-help="funding">?</button></span><b>' + (Number.isFinite(funding) ? (funding >= 0 ? '+' : '') + fmt(funding, 4) + '%' : '—') + '</b></div>' +
      '<div class="row"><span>Доступное плечо</span><b>' + (c?.maxLeverage ?? '—') + 'x</b></div>' +
      '<div class="row"><span>Комиссия тейкера</span><b>' + fmt((c?.takerFeePct ?? 0) * 100, 3) + '%</b></div>' +
      '<div class="row"><span>Минимальная маржа</span><b>' + usd(p.minMargin) + '</b></div>' +
      '<div class="row"><span>Рекомендуемый диапазон</span><b>' + usd(p.suggestion.low, moneyDecimals(p.suggestion.low)) + ' – ' + usd(p.suggestion.high, moneyDecimals(p.suggestion.high)) + '</b></div></div>' +
      '<p class="disclaimer">Данные рынка могут обновляться с задержкой. Это не инвестиционная рекомендация.</p>';
    showAssetGrid = false;
    loadChart(market, 'pair-chart', '15m');
    $('#pair-timeframes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-interval]');
      if (!button) return;
      $('#pair-timeframes').querySelectorAll('button').forEach((x) => x.classList.toggle('selected', x === button));
      loadChart(market, 'pair-chart', button.dataset.interval);
      tg.HapticFeedback?.selectionChanged?.();
    });
    $('#asset-grid-toggle').addEventListener('click', () => { showAssetGrid = !showAssetGrid; $('#asset-grid-toggle').textContent = showAssetGrid ? 'Скрыть сетку' : 'Показать сетку'; loadChart(market, 'pair-chart', $('#pair-timeframes button.selected')?.dataset.interval || '15m'); });
    $('#asset-back').addEventListener('click', () => { box.classList.add('hidden'); $('#q').focus(); });
    $('#asset-favorite').addEventListener('click', () => {
      favorites.has(market) ? favorites.delete(market) : favorites.add(market);
      saveFavorites();
      $('#asset-favorite').textContent = favorites.has(market) ? '★ В избранном' : '☆ В избранное';
      $('#asset-favorite').classList.toggle('is-favorite', favorites.has(market));
      renderPairs();
    });
    $('#use-pair').addEventListener('click', () => {
      const form = $('#grid-form');
      form.market.value = market;
      form.low.value = p.suggestion.low;
      form.high.value = p.suggestion.high;
      form.marginUsd.value = Math.max(+form.marginUsd.value || 0, Math.ceil(p.minMargin * 1.1 * 100) / 100);
      form.leverage.value = 1;
      setTab('ctrl');
    });
    $('#manual-trade-open').addEventListener('click', () => {
      $('#manual-trade-form')?.remove();
      const tradeForm = document.createElement('form');
      tradeForm.id = 'manual-trade-form';
      tradeForm.className = 'card manual-trade-form';
      const decimals = moneyDecimals(price);
      tradeForm.innerHTML = `
        <div class="card-heading"><h3>Новая демо-сделка</h3><span class="soft-tag">ВИРТУАЛЬНО</span></div>
        <div class="side-choice"><label><input type="radio" name="side" value="long" checked><b class="long-choice">Лонг · Рост</b></label><label><input type="radio" name="side" value="short"><b class="short-choice">Шорт · Падение</b></label></div>
        <label>Маржа, USDC<input name="marginUsd" type="number" min="1" step="0.01" value="10" required></label>
        <label>Плечо<select name="leverage"><option value="1">1x</option><option value="2">2x</option><option value="3">3x</option></select></label>
        <label>Take Profit · цена<input name="takeProfit" type="number" min="0" step="any" value="${(price * 1.02).toFixed(decimals)}"></label>
        <label>Stop Loss · цена<input name="stopLoss" type="number" min="0" step="any" value="${(price * .99).toFixed(decimals)}"></label>
        <div class="manual-trade-note">Цена входа берётся по текущей публичной котировке. Ликвидация рассчитывается ориентировочно по упрощённой модели.</div>
        <button type="submit">Открыть демо-позицию</button>`;
      box.querySelector('.asset-actions').after(tradeForm);
      tradeForm.addEventListener('change', (event) => {
        if (event.target.name !== 'side') return;
        const side = tradeForm.elements.side.value;
        tradeForm.elements.takeProfit.value = (price * (side === 'long' ? 1.02 : .98)).toFixed(decimals);
        tradeForm.elements.stopLoss.value = (price * (side === 'long' ? .99 : 1.01)).toFixed(decimals);
      });
      tradeForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = tradeForm.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
          const result = await call('manual', { action:'open', market, side:tradeForm.elements.side.value, marginUsd:Number(tradeForm.elements.marginUsd.value), leverage:Number(tradeForm.elements.leverage.value), takeProfit:Number(tradeForm.elements.takeProfit.value), stopLoss:Number(tradeForm.elements.stopLoss.value) });
          tradeForm.remove();
          tg.showAlert?.(result.message);
          await loadState();
          setTab('painel');
        } catch (error) {
          submit.disabled = false;
          showError(error);
        }
      });
      tradeForm.scrollIntoView({ behavior:'smooth', block:'center' });
    });
  } catch (error) {
    box.innerHTML = '<div class="empty-state"><b>Не удалось загрузить актив</b><small>' + esc(error.message) + '</small><button id="asset-back-error" class="secondary" type="button">Вернуться к рынкам</button></div>';
    $('#asset-back-error').addEventListener('click', () => box.classList.add('hidden'));
  }
});

// ---------- home market preview ----------
let marketPreviewLoading = false;
async function loadMarketPreview() {
  if (document.hidden || marketPreviewLoading) return;
  marketPreviewLoading = true;
  try {
    await getContracts({ force: true });
    window.kriptoGuruDemo?.marketsUpdated?.();
    if (!contracts.length) window.kriptoGuruDemo?.showFavoritesError?.('Список рынков пуст.');
    lastQuoteUpdate = new Date();
    const connection = $('#asset-connection');
    if (connection) { connection.textContent = 'Обновлено ' + lastQuoteUpdate.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); connection.className = 'asset-connection updated'; }
    renderPairs();
    if (state) renderState();
    if (selectedMarket && !$('#pair-detail').classList.contains('hidden')) {
      const active = contracts.find((x) => x.market === selectedMarket);
      if (active) {
        $('#asset-live-price').textContent = usd(active.price, moneyDecimals(active.price));
        $('#asset-live-change').textContent = pctText(active.change24hPct || 0) + ' за 24 часа';
        $('#asset-live-change').className = 'asset-change ' + ((active.change24hPct || 0) >= 0 ? 'up' : 'down');
        const interval = $('#pair-timeframes button.selected')?.dataset.interval || '15m';
        loadChart(selectedMarket, 'pair-chart', interval);
      }
    }
    if (!state?.grid && contracts[0]) loadChart(contracts[0].market);
    $('#market-updated').textContent = `Live · ${new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
  } catch (error) {
    $('#heatmap').textContent = error.message;
    $('#pairs').textContent = error.message;
    window.kriptoGuruDemo?.showFavoritesError?.(error.message);
  } finally { marketPreviewLoading = false; }
}
const helpCopy = {
  levels: 'Уровни делят выбранный ценовой диапазон на шаги. Больше уровней — чаще сигналы, но меньше расстояние между ними.',
  margin: 'Маржа — виртуальная сумма, выделенная под одну сделку сетки. Комиссии и убыток уменьшают демо-баланс.',
  leverage: 'Плечо увеличивает размер позиции относительно маржи. Чем выше плечо, тем быстрее растут и прибыль, и убыток. Начинайте с 1x.',
  grid: 'Сетка выставляет уровни внутри диапазона и открывает демо-позицию при достижении уровня. Сетка не гарантирует прибыль.',
  funding: 'Фандинг — периодический платёж между участниками бессрочного рынка. Значение может быть положительным или отрицательным.',
  tp: 'Тейк-профит — уровень цены, при котором позиция автоматически закрывается с целью зафиксировать результат.',
  sl: 'Стоп-лосс — уровень цены для ограничения убытка. При срабатывании сетка останавливается.',
  liquidation: 'Ликвидация — принудительное закрытие позиции, если залога недостаточно. Большое плечо приближает ликвидацию.'
};
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-help]');
  if (!button) return;
  event.preventDefault();
  tg.showAlert?.(helpCopy[button.dataset.help] || 'Справка пока недоступна.');
});
$('#home-see-all,#home-open-markets,#home-open-markets-sell').addEventListener('click', () => document.querySelector('nav button[data-tab="pares"]').click());
$('#portfolio-trigger').addEventListener('click', () => document.querySelector('nav button[data-tab="painel"]').click());
$('#notifications-trigger').addEventListener('click', () => tg.showAlert?.('Уведомлений пока нет.'));
$('#pos').addEventListener('click', async (event) => {
  if (event.target.closest('#empty-open-markets')) { setTab('pares'); return; }
  const manualClose = event.target.closest('[data-manual-close]');
  if (manualClose) {
    if (!(await confirm('Закрыть ручную демо-позицию по текущей рыночной цене?'))) return;
    try {
      const result = await call('manual', { action:'close', id:manualClose.dataset.manualClose });
      ctrlMessage(result.message);
      await loadState();
    } catch (error) { showError(error); }
    return;
  }
  if (event.target.closest('#position-close')) {
    if (!(await confirm('Закрыть демо-позицию по текущей рыночной цене и остановить сетку?'))) return;
    try { const result = await call('control', { action: 'closeall' }); ctrlMessage(result.message); await loadState(); }
    catch (error) { showError(error); }
  }
});
$('#wallet-grid-settings').addEventListener('click', () => document.querySelector('nav button[data-tab="ctrl"]').click());
$('#wallet-grid-run').addEventListener('click', async () => { if (!state?.grid) { setTab('ctrl'); return; } try { const action = state.paused ? 'resume' : state.running ? 'stop' : 'run'; const r=await call('control',{action}); ctrlMessage(r.message); await loadState(); } catch(e) { showError(e); } });
$('#home-reset-demo').addEventListener('click', () => tg.showAlert?.('Для сброса отправьте боту команду /paper reset. Виртуальный баланс вернётся к $1 000, сетка остановится. История операций сохранится.'));
$('#home-open-grid').addEventListener('click', () => setTab('ctrl'));
document.querySelectorAll('[data-preset]').forEach((button) => button.addEventListener('click', async () => {
  try {
    if (!contracts.length) contracts = (await call('contracts')).contracts;
    const form = $('#grid-form');
    const market = form.market.value.trim().toUpperCase() || state?.grid?.market || 'BTC';
    const contract = contracts.find((x) => x.market === market) || contracts[0];
    if (!contract) throw new Error('Не удалось загрузить список рынков.');
    form.market.value = contract.market;
    const price = Number(contract.price);
    form.low.value = (price * .94).toFixed(6);
    form.high.value = (price * 1.02).toFixed(6);
    const preset = button.dataset.preset;
    const values = preset === 'careful' ? {levels:6,margin:10,leverage:1} : preset === 'active' ? {levels:14,margin:20,leverage:Math.min(3,contract.maxLeverage)} : {levels:9,margin:15,leverage:Math.min(2,contract.maxLeverage)};
    form.levels.value = values.levels;
    form.marginUsd.value = Math.max(values.margin, Number(contract.minSizeQuote || 0));
    form.leverage.value = values.leverage;
    document.querySelectorAll('[data-preset]').forEach((x) => x.classList.toggle('selected', x === button));
    tg.HapticFeedback?.selectionChanged?.();
  } catch (error) { ctrlMessage(error.message, 'error'); }
}));


// ---------- histórico ----------
async function loadHistory() {
  try {
    const h = await call('trades');
    drawEquity(h.equity);
    $('#trades').innerHTML = h.trades.length
      ? `<table><tr><th>Время</th><th>Событие</th><th>Цена</th><th>Результат</th></tr>${h.trades
          .map((t) => {
            const when = new Date(t.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            const ev =
              t.event === 'open'
                ? `<span class="ev ev-open">${icon('open')}${t.side === 'short' ? 'SHORT' : t.side === 'long' ? 'LONG' : 'Покупка'} ${esc(t.market)}</span>`
                : t.reason === 'tp'
                  ? `<span class="ev up">${icon('tp')}TP</span>`
                  : t.reason === 'sl'
                    ? `<span class="ev down">${icon('sl')}SL</span>`
                    : `<span class="ev">${icon('hand')}Вручную</span>`;
            const pnl = t.pnl === undefined ? '' : `<span class="${t.pnl >= 0 ? 'up' : 'down'}">${usd(t.pnl, 4)}</span>`;
            return `<tr><td>${when}${t.mode === 'paper' ? ' <small>(демо)</small>' : ''}</td><td>${ev}</td><td>${usd(t.price, moneyDecimals(t.price))}</td><td>${pnl}</td></tr>`;
          })
          .join('')}</table>`
      : 'Сделок пока нет.';
  } catch (e) {
    $('#trades').textContent = e.message;
  }
}

function drawEquity(points) {
  const svg = $('#equity');
  if (!points || points.length < 2) {
    svg.innerHTML = '<text x="10" y="20" fill="currentColor" font-size="12">Кривая капитала появится после первых сделок.</text>';
    return;
  }
  const W = 360, H = 140, P = 6;
  const vs = points.map((p) => p[1]);
  const lo = Math.min(...vs), hi = Math.max(...vs) || 1;
  const span = hi - lo || hi * 0.01 || 1;
  const t0 = points[0][0], t1 = points[points.length - 1][0] || t0 + 1;
  const x = (t) => P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - lo) / span) * (H - 2 * P);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const up = vs[vs.length - 1] >= vs[0];
  svg.innerHTML = `<path d="${d}" fill="none" stroke="${up ? 'var(--green)' : 'var(--red)'}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>
    <text x="${W - P}" y="14" text-anchor="end" fill="currentColor" font-size="12">${usd(vs[vs.length - 1])}</text>`;
}

// ---------- controles ----------
function ctrlMessage(text, ic = 'save') {
  const box = $('#ctrl-msg');
  box.innerHTML = `<div class="note">${icon(ic)}<span>${esc(text)}</span></div>`;
  box.classList.remove('hidden');
}

function confirm(text) {
  return new Promise((resolve) => tg.showConfirm(text, resolve));
}

$('#grid-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const submitButton = f.querySelector('[type="submit"]');
  if (submitButton?.disabled) return;
  if (submitButton) submitButton.disabled = true;
  const input = {
    market: f.market.value.trim().toUpperCase(),
    low: +f.low.value,
    high: +f.high.value,
    levels: +f.levels.value,
    marginUsd: +f.marginUsd.value,
    leverage: +f.leverage.value,
  };
  try {
    const r = await call('configure', input);
    ctrlMessage(r.message);
    loadState();
  } catch (e) {
    ctrlMessage(e.message, 'error');
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

document.querySelectorAll('[data-action]').forEach((b) =>
  b.addEventListener('click', async () => {
    const action = b.dataset.action;
    const input = { action };
    if (action === 'mode') {
      input.mode = b.dataset.mode;
      if (input.mode === 'live') {
        if (!(await confirm('LIVE использует реальные деньги и кредитное плечо. Подтверждаете?'))) return;
        input.confirm = true;
      }
    }
    if (action === 'closeall' && !(await confirm('Закрыть позицию и остановить сетку?'))) return;
    try {
      tg.HapticFeedback?.impactOccurred('light');
      const r = await call('control', input);
      ctrlMessage(r.message);
      loadState();
    } catch (e) {
      ctrlMessage(e.message, 'error');
    }
  }),
);

// preenche o formulário com o grid atual
function fillForm() {
  const g = state?.grid;
  if (!g) return;
  const f = $('#grid-form');
  f.market.value = g.market;
  f.low.value = g.low;
  f.high.value = g.high;
  f.levels.value = g.levels;
  f.marginUsd.value = g.marginUsd;
  f.leverage.value = g.leverage;
}

$('#home-timeframes').addEventListener('click', (event) => {
  const button = event.target.closest('[data-chart-interval]');
  if (!button) return;
  $('#home-timeframes').querySelectorAll('button').forEach((x) => x.classList.toggle('selected', x === button));
  const market = state?.grid?.market || contracts[0]?.market;
  if (market) loadChart(market, 'chart', button.dataset.chartInterval);
  tg.HapticFeedback?.selectionChanged?.();
});

const onboardingSteps = [
  ['Демо-счёт', 'У вас виртуальные $1 000. Реальные деньги и кошелёк не используются.'],
  ['Настройте сетку', 'Выберите актив, задайте диапазон цены, число уровней и маржу. Система будет искать входы по заданным уровням.'],
  ['Читайте график', 'Свечи показывают открытие, максимум, минимум и закрытие за выбранный период. Котировки рыночные, баланс виртуальный.'],
];
let onboardingIndex = 0;
function showOnboarding() {
  onboardingIndex = 0;
  renderOnboarding();
  $('#onboarding').classList.remove('hidden');
}
function renderOnboarding() {
  const step = onboardingSteps[onboardingIndex];
  $('#onboarding-step').textContent = 'ШАГ ' + (onboardingIndex + 1) + ' ИЗ 3';
  $('#onboarding-title').textContent = step[0];
  $('#onboarding-copy').textContent = step[1];
  $('#onboarding-progress').style.width = ((onboardingIndex + 1) / 3 * 100) + '%';
  $('#onboarding-next').textContent = onboardingIndex === 2 ? 'Готово' : 'Далее';
}
function closeOnboarding() {
  $('#onboarding').classList.add('hidden');
  try { localStorage.setItem('kripto-guru:onboarding:v1', 'done'); } catch {}
}
$('#onboarding-next').addEventListener('click', () => {
  if (onboardingIndex < 2) { onboardingIndex++; renderOnboarding(); }
  else closeOnboarding();
});
$('#onboarding-skip').addEventListener('click', closeOnboarding);
$('#education-banner').addEventListener('click', showOnboarding);
$('#repeat-onboarding').addEventListener('click', showOnboarding);
$('#onboarding').addEventListener('click', (event) => { if (event.target === $('#onboarding')) closeOnboarding(); });
try { if (!localStorage.getItem('kripto-guru:onboarding:v1')) showOnboarding(); } catch {}


loadState().then(fillForm);
const statePoll = setInterval(loadState, 30_000);
const marketPoll = setInterval(loadMarketPreview, 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (stateRefreshQueued) { stateRefreshQueued = false; loadState(); }
    loadMarketPreview();
  }
});
// Mini App: API protegida por initData assinado do Telegram e servida pelo mesmo Worker.
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
try { tg.setHeaderColor?.('#EDECF3'); tg.setBackgroundColor?.('#EDECF3'); } catch {}

const $ = (sel) => document.querySelector(sel);
const fmt = (n, d = 2) => (n === null || n === undefined || Number.isNaN(+n) ? '—' : (+n).toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) }));
const usd = (n, d = 2) => (n === null || n === undefined ? '—' : `$${fmt(n, d)}`);
const signedPct = (n) => `${n >= 0 ? '↑+' : '↓'}${fmt(Math.abs(n), 2)}%`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

async function call(name, input = {}) {
  const route = name === 'configure' ? 'grid' : name;
  const method = name === 'configure' || name === 'control' ? 'POST' : 'GET';
  const query = method === "GET"
    ? Object.entries(input).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";
  const response = await fetch(`/api/${route}${query ? `?${query}` : ""}`, {
    method,
    headers: {
      Authorization: `tma ${tg.initData}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  });
  const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Ошибка API: ${response.status}`);
  return data;
}

function showError(err) {
  const msg = err?.message || String(err);
  $('#alert').innerHTML = `<div class="note">${icon('alert')}<span>${esc(msg)}</span></div>`;
  $('#alert').classList.remove('hidden');
}

let state = null;
let contracts = [];

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
$('#profile-demo').addEventListener('click', async () => {
  closeProfileMenu();
  if (state?.mode === 'paper') return;
  try {
    const result = await call('control', { action: 'mode', mode: 'paper' });
    ctrlMessage(result.message);
    await loadState();
  } catch (error) {
    showError(error);
  }
});
// Реальный режим намеренно заблокирован и не отправляет запросы к API.

// ---------- abas ----------
document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
    tg.HapticFeedback?.selectionChanged?.();
    if (b.dataset.tab === 'pares' && !contracts.length) loadPairs();
    if (b.dataset.tab === 'hist') loadHistory();
  }),
);

// ---------- painel ----------
async function loadState() {
  try {
    state = await call('state');
    $('#alert').classList.add('hidden');
    renderState();
    if (!contracts.length) loadMarketPreview();
    if (state.grid) loadChart(state.grid.market);
  } catch (e) {
    showError(e);
  }
}

function gStatus(s) { return !s.grid ? 'Не настроена' : s.paused ? 'Пауза' : s.running ? 'Работает' : 'Готова'; }

function renderState() {
  const s = state;
  $('#mode').textContent = s.mode === 'paper' ? 'ДЕМО' : 'LIVE';
  $('#mode').className = `pill ${s.mode === 'live' ? 'live' : 'demo-pill'}`;
  $('#profile-demo').classList.toggle('selected', s.mode === 'paper');
  const demo = s.paper || {};
  const equity = Number(demo.equity ?? demo.cash ?? 1000);
  const cash = Number(demo.cash ?? 1000);
  const pnl = equity - cash;
  $('#home-equity').textContent = usd(equity);
  $('#home-cash').textContent = usd(cash);
  $('#home-pnl').textContent = (pnl >= 0 ? '+' : '−') + usd(Math.abs(pnl));
  $('#home-change').textContent = signedPct(equity ? pnl / 1000 * 100 : 0);
  $('#home-change').className = `change-chip ${pnl >= 0 ? 'up' : 'down'}`;
  $('#home-pnl').className = pnl >= 0 ? 'up' : 'down';
  $('#home-positions').textContent = s.position ? '1' : '0';
  $('#run').textContent = s.paused ? 'Пауза' : s.running ? 'Сетка работает' : gStatus(s);
  $('#run').className = `pill ${s.running && !s.paused ? 'on' : ''}`;
  $('#grid-status').textContent = gStatus(s);
  $('#demo-capital').textContent = usd(equity);
  $('#market-updated').textContent = s.lastTick ? `Live · ${new Date(s.lastTick).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}` : 'Live · ждём котировку';


  const notes = [
    s.paused && ['pause', s.paused],
    s.lastBlock && ['ban', s.lastBlock],
    s.lastError && ['alert', s.lastError],
    s.mode === 'live' && !s.connected && ['plug', 'Walt не подключён (/connect в боте)'],
  ].filter(Boolean);
  $('#alert').innerHTML = notes.map(([ic, t]) => `<div class="note">${icon(ic)}<span>${esc(t)}</span></div>`).join('');
  $('#alert').classList.toggle('hidden', !notes.length);

  const g = s.grid;
  $('#g-desc').textContent = g ? `${g.market} ${usd(g.low)}–${usd(g.high)} · ${g.levels} уровней` : 'Не настроена';
  const rc = s.lastRecenter;
  $('#g-recenter-row').classList.toggle('hidden', !rc);
  if (rc) $('#g-recenter').textContent = `${new Date(rc.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · цена ${usd(rc.price)}`;
  $('#g-trade').textContent = g ? `маржа ${usd(g.marginUsd)} ${g.leverage}x ≈ ${usd(g.notional)} · SL ${usd(g.stopLoss)}` : '—';

  const p = s.position;
  const lp = s.livePosition;
  if (p) {
    const pnl = p.unrealizedPnl;
    const rows = [
      ['Цена входа', usd(p.entryPrice)],
      ['Тейк-профит', usd(p.takeProfit)],
      ['Стоп-лосс', usd(p.stopLoss)],
      ['Маржа', usd(p.marginUsd)],
      ['Текущий результат', `<span class="pos-pnl ${pnl >= 0 ? 'up' : 'down'}">${usd(pnl, 4)}</span>`],
    ];
    if (lp) {
      const liq = +lp.liquidation_price;
      rows.push(['Ликвидация', `${usd(liq)}${liq && s.lastPrice ? ` (${fmt(((s.lastPrice - liq) / s.lastPrice) * 100, 1)}% до ликвидации)` : ''}`]);
      if (lp.funding_paid_quote !== undefined) rows.push(['Выплаченный фандинг', usd(lp.funding_paid_quote, 4)]);
      if (lp.margin_quote !== undefined) rows.push(['Маржа', usd(lp.margin_quote)]);
    }
    $('#pos').innerHTML = rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('');
  } else {
    $('#pos').innerHTML = `<div class="empty-state">${icon('wallet')}<b>Позиций пока нет</b><small>${g ? 'Сетка ожидает достижения ценового уровня.' : 'Откройте рынки или настройте сетку.'}</small><button id="empty-open-markets" class="secondary" type="button">Открыть рынки</button></div>`;
  }

  const st = s.stats;
  const eq = s.mode === 'paper' ? s.paper?.equity : null;
  $('#metric-trades').textContent = String(st.trades);
  $('#metric-wins').textContent = `${st.wins}/${st.losses}`;
  $('#metric-pnl').textContent = usd(st.realizedPnl, 4);
  $('#stats').innerHTML = [
    [`${st.trades}`, 'сделок'],
    [`${st.wins}/${st.losses}`, 'TP / SL'],
    [usd(st.realizedPnl, 4), 'Результат закрытых сделок'],
    ...(eq !== null && eq !== undefined ? [[usd(eq), 'капитал ДЕМО']] : []),
    [s.lastTick ? new Date(s.lastTick).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—', 'последнее обновление'],
  ]
    .map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`)
    .join('');
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
  const g = state?.grid?.market === market ? state.grid : null;
  const valid = (candles || []).filter((c) => c.length >= 5 && c.slice(1, 5).every((v) => Number.isFinite(+v)));
  const levels = g ? g.levelPrices.map((v) => ({ v, color: 'var(--hint)', dash: '3 4' })) : [];
  if (g && state.position) levels.push(
    { v: state.position.takeProfit, color: 'var(--green)' },
    { v: state.position.entryPrice, color: 'var(--link)' },
  );
  const all = valid.flatMap((c) => [+c[2], +c[3]]).concat(levels.map((l) => l.v));
  if (!all.length) {
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
    out += '<text x="312" y="' + (yy + 3) + '" fill="var(--hint)" font-size="10">' + fmt(value, value >= 1000 ? 1 : 2) + '</text>';
  }
  out += levels.map((l) =>
    `<line x1="0" x2="${plotW}" y1="${y(l.v)}" y2="${y(l.v)}" stroke="${l.color}" stroke-width="1" ${l.dash ? `stroke-dasharray="${l.dash}"` : ''} vector-effect="non-scaling-stroke"/>`
  ).join('');
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
  const last = valid[valid.length - 1];
  const lastPrice = +last[4], lastColor = +last[4] >= +last[1] ? 'var(--green)' : 'var(--red)';
  out += '<line x1="0" x2="' + plotW + '" y1="' + y(lastPrice) + '" y2="' + y(lastPrice) + '" stroke="' + lastColor + '" stroke-width="1.2" stroke-dasharray="4 3"/>';
  out += '<text x="312" y="' + Math.max(11, Math.min(190, y(lastPrice) - 4)) + '" fill="' + lastColor + '" font-size="10" font-weight="700">' + fmt(lastPrice, lastPrice >= 1000 ? 1 : 3) + '</text>';
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
}

// ---------- pares ----------
async function loadPairs() {
  $('#pairs').innerHTML = '<div class="market-loading skeleton-row"></div><div class="market-loading skeleton-row"></div><div class="market-loading skeleton-row"></div>'; 
  try {
    contracts = (await call('contracts')).contracts;
    renderPairs();
  } catch (e) {
    $('#pairs').textContent = e.message;
  }
}

function renderPairs() {
  const q = $('#q').value.trim().toUpperCase();
  const list = contracts.filter((c) => (!q || c.market.includes(q)));
  $('#pairs').innerHTML =
    list
      .map(
        (c) => `<div class="item ${c.allowed ? '' : 'blocked'}" data-market="${esc(c.market)}">
      <div><div class="name">${esc(c.market)} <span class="quote-price">${usd(c.price, c.price >= 1000 ? 2 : c.price >= 1 ? 3 : 6)}</span></div>
      <div class="meta">${c.change24hPct === undefined ? 'изменение н/д' : `<span class="${c.change24hPct >= 0 ? 'up' : 'down'}">${signedPct(c.change24hPct)}</span>`}</div></div>
      <div class="tag">${c.allowed ? icon('chevron') : `${icon('lock')} недоступен`}</div></div>`,
      )
      .join('') || '<div class="empty-state card-empty">Ничего не найдено</div>';
  renderMarketVisuals(list);
}
$('#q').addEventListener('input', renderPairs);
let topSort = 'up';
document.querySelectorAll('[data-top-sort]').forEach((b) => b.addEventListener('click', () => { topSort=b.dataset.topSort; document.querySelectorAll('[data-top-sort]').forEach(x=>x.classList.toggle('selected',x===b)); renderMarketVisuals(contracts.filter(c=>!$('#q').value || c.market.includes($('#q').value.trim().toUpperCase()))); }));
function renderMarketVisuals(source) {
  const items=[...source].filter(c=>Number.isFinite(+c.price)).sort((a,b)=>(b.volume24hUsd||0)-(a.volume24hUsd||0)).slice(0,12);
  const max=Math.max(1,...items.map(c=>+c.volume24hUsd||1));
  $('#heatmap').innerHTML=items.map(c=>{const pct=Number(c.change24hPct||0),strength=Math.min(1,Math.abs(pct)/8),hue=pct>=0?145:0,light=86-strength*48,span=Math.max(2,Math.round(((+c.volume24hUsd||1)/max)*6));return `<button type="button" class="heat-cell" style="grid-column:span ${span};background:hsl(${hue} 62% ${light}%)" data-heat-market="${esc(c.market)}"><b>${esc(c.market)}</b><small>${signedPct(pct)}</small></button>`;}).join('')||'<div class="market-loading">Нет данных для тепловой карты.</div>';
  const ranked=[...source].sort((a,b)=>topSort==='up'?(b.change24hPct||0)-(a.change24hPct||0):(a.change24hPct||0)-(b.change24hPct||0)).slice(0,8);
  $('#top-day').innerHTML=ranked.map(c=>`<button type="button" class="top-coin" data-heat-market="${esc(c.market)}"><span>${esc(c.market.slice(0,1))}</span><b>${esc(c.market)}</b><small class="${(c.change24hPct||0)>=0?'up':'down'}">${signedPct(c.change24hPct||0)}</small></button>`).join('');
}
$('#heatmap,#top-day').addEventListener('click',ev=>{const el=ev.target.closest('[data-heat-market]');if(!el)return;const m=el.dataset.heatMarket;$('#q').value=m;renderPairs();const item=[...document.querySelectorAll('#pairs .item')].find(x=>x.dataset.market===m);item?.click();});

$('#pairs').addEventListener('click', async (ev) => {
  const item = ev.target.closest('.item');
  if (!item) return;
  const market = item.dataset.market;
  const box = $('#pair-detail');
  box.classList.remove('hidden');
  box.textContent = `Загружаем ${market}…`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  try {
    const p = await call('price', { market, leverage: 3 });
    const c = contracts.find((x) => x.market === market);
    const displayPrice = c?.price ?? p.price;
    box.innerHTML = `<h3>${esc(market)}</h3>
      <div class="asset-detail-price">${usd(displayPrice, displayPrice >= 1000 ? 2 : displayPrice >= 1 ? 3 : 6)}</div><div class="asset-change ${c?.change24hPct >= 0 ? 'up' : 'down'}">${c?.change24hPct === undefined ? 'Изменение недоступно' : signedPct(c.change24hPct)}</div><div class="row"><span>Текущая цена</span><b>${usd(displayPrice, displayPrice >= 1000 ? 2 : displayPrice >= 1 ? 3 : 6)}</b></div>
      <div class="row"><span>Минимальная маржа при ${p.leverage}x</span><b>${usd(p.minMargin)}</b></div>
      <div class="row"><span>Рекомендуемый диапазон (−6% / +2%)</span><b>${usd(p.suggestion.low, 6)} – ${usd(p.suggestion.high, 6)}</b></div>
      <div class="row"><span>Комиссия тейкера</span><b>${fmt((c?.takerFeePct ?? 0) * 100, 3)}%</b></div>
      <div class="chart-detail-head"><b>График</b><select id="pair-interval"><option value="1m">1м</option><option value="5m">5м</option><option value="15m" selected>15м</option><option value="1h">1ч</option><option value="4h">4ч</option><option value="1d">1д</option></select></div>
      <small data-chart-source="pair-chart"></small><svg id="pair-chart" viewBox="0 0 360 220" preserveAspectRatio="none"></svg>
      ${c?.allowed ? `<button id="use-pair">${icon('sliders')}Использовать в сетке</button>` : '<p class="meta">Контракт недоступен по фильтрам ликвидности или LIVE-ограничениям.</p>'}`;
    loadChart(market, 'pair-chart', '15m');
    $('#pair-interval').addEventListener('change', (event) => loadChart(market, 'pair-chart', event.target.value));
    const btn = $('#use-pair');
    if (btn)
      btn.onclick = () => {
        const f = $('#grid-form');
        f.market.value = market;
        f.low.value = p.suggestion.low;
        f.high.value = p.suggestion.high;
        f.marginUsd.value = Math.max(+f.marginUsd.value || 0, Math.ceil(p.minMargin * 1.1 * 100) / 100);
        f.leverage.value = p.leverage;
        document.querySelector('nav button[data-tab="ctrl"]').click();
      };
  } catch (e) {
    box.textContent = e.message;
  }
});

// ---------- home market preview ----------
async function loadMarketPreview() {
  try {
    contracts = (await call('contracts')).contracts;
    renderPairs();
    if (!state?.grid && contracts[0]) loadChart(contracts[0].market);
    $('#market-updated').textContent = `Live · ${new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
  } catch (error) {
    $('#heatmap').textContent = error.message;
    $('#pairs').textContent = error.message;
  }
}
$('#home-see-all,#home-open-markets').addEventListener('click', () => document.querySelector('nav button[data-tab="pares"]').click());
$('#home-open-markets-sell').addEventListener('click', () => tg.showAlert?.('Ручные сделки пока не поддерживаются. Сейчас доступна демо-сетка.'));
$('#portfolio-trigger').addEventListener('click', () => document.querySelector('nav button[data-tab="painel"]').click());
$('#notifications-trigger').addEventListener('click', () => tg.showAlert?.('Уведомлений пока нет.'));
$('#education-banner').addEventListener('click', () => tg.showAlert?.('Обучение: 1) демо использует виртуальные средства; 2) выберите актив и настройте сетку; 3) график показывает реальные рыночные котировки.'));
$('#repeat-onboarding').addEventListener('click', () => $('#education-banner').click());
$('#pos').addEventListener('click', (event) => { if (event.target.closest('#empty-open-markets')) document.querySelector('nav button[data-tab="pares"]').click(); });
$('#wallet-grid-settings').addEventListener('click', () => document.querySelector('nav button[data-tab="ctrl"]').click());
$('#wallet-grid-run').addEventListener('click', async () => { if (!state?.grid) { document.querySelector('nav button[data-tab="ctrl"]').click(); return; } try { const r=await call('control',{action:state.running?'stop':'run'}); ctrlMessage(r.message); await loadState(); } catch(e) { showError(e); } });
$('#home-reset-demo').addEventListener('click', () => tg.showAlert?.('Сброс демо-счёта пока не поддерживается текущим API. Существующий баланс и история сохранены.'));
$('#home-open-grid').addEventListener('click', () => document.querySelector('nav button[data-tab="ctrl"]').click());


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
                ? `<span class="ev ev-open">${icon('open')}Покупка ${esc(t.market)}</span>`
                : t.reason === 'tp'
                  ? `<span class="ev up">${icon('tp')}TP</span>`
                  : t.reason === 'sl'
                    ? `<span class="ev down">${icon('sl')}SL</span>`
                    : `<span class="ev">${icon('hand')}Вручную</span>`;
            const pnl = t.pnl === undefined ? '' : `<span class="${t.pnl >= 0 ? 'up' : 'down'}">${usd(t.pnl, 4)}</span>`;
            return `<tr><td>${when}${t.mode === 'paper' ? ' <small>(paper)</small>' : ''}</td><td>${ev}</td><td>${usd(t.price)}</td><td>${pnl}</td></tr>`;
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

$('#chart-interval').addEventListener('change', () => {
  if (state?.grid?.market) loadChart(state.grid.market, 'chart', $('#chart-interval').value);
});

loadState().then(fillForm);
setInterval(loadState, 30_000);

(() => {
  "use strict";
  const $ = (selector, root=document) => root.querySelector(selector);
  const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
  const tg = window.Telegram?.WebApp || null;
  const state = {
    screen:"wallet", previousScreen:"trading", category:"crypto", markets:[], futures:[],
    favorites:(()=>{try{return new Set(JSON.parse(localStorage.getItem("kg:favorites:v1")||'["BTC","ETH","SOL"]'));}catch{return new Set(["BTC","ETH","SOL"]);}})(),
    recent:(()=>{try{return JSON.parse(localStorage.getItem("kg:recent:v1")||"[]").filter(x=>typeof x==="string").slice(0,8);}catch{return[];}})(),
    editFavorites:false, selected:null, selectedMarket:null, interval:"15m", side:"long", leverage:1, maxLeverage:1,
    margin:0, preview:null, history:[], wallet:null, capabilities:{}, sort:"up", previewSeq:0, confirmPayload:null,
    autoclose:false, busy:false, companionId:null, companionMessages:[], companionConversations:[], companionBusy:false
  };
  const fmt = (v, digits=2) => Number.isFinite(Number(v)) ? new Intl.NumberFormat("ru-RU",{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(Number(v)) : "—";
  const money = (v,d=2) => Number.isFinite(Number(v)) ? "$"+fmt(v,d) : "—";
  const pct = (v) => Number.isFinite(Number(v)) ? (Number(v)>=0?"+":"")+fmt(v,2)+"%" : "—";
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const symbolName = (m) => ({BTC:"Bitcoin",ETH:"Ethereum",SOL:"Solana",GRAM:"Gram",XAUT:"Золото",BNB:"BNB",DOGE:"Dogecoin",XRP:"XRP"}[m] || m);
  const iconFor = (m) => ({BTC:"₿",ETH:"Ξ",SOL:"◎",GRAM:"◆",XAUT:"◈",BNB:"◆",DOGE:"Ð",XRP:"✕"}[m] || String(m||"?").slice(0,1));
  const notify = (message) => { const node=$("#kg-toast"); node.textContent=message; node.classList.add("is-visible"); clearTimeout(notify.timer); notify.timer=setTimeout(()=>node.classList.remove("is-visible"),2600); };
  const normalizeError = (error) => {
    const source=error?.error || error || {};
    return {code:String(source.code || "REQUEST_FAILED"),message:String(source.message || source.detail || "Не удалось выполнить запрос."),retryable:Boolean(source.retryable)};
  };
  const api = () => window.KriptoGuruAPI || null;
  async function invoke(path,...args){
    const root=api();
    if(!root) throw {code:"API_NOT_READY",message:"Демо-сервис ещё подключается. Попробуйте обновить экран.",retryable:true};
    const parts=path.split(".");
    let fn=root;
    for(const part of parts) fn=fn?.[part];
    if(typeof fn!=="function") throw {code:"API_METHOD_MISSING",message:"Метод API временно недоступен: "+path,retryable:false};
    try{return await fn.apply(parts.length>1?parts.slice(0,-1).reduce((o,k)=>o?.[k],root):root,args);}
    catch(error){throw normalizeError(error);}
  }
  function listOf(value,keys=["items","markets","assets","positions","events","history"]){
    if(Array.isArray(value)) return value;
    for(const key of keys) if(Array.isArray(value?.[key])) return value[key];
    if(Array.isArray(value?.data)) return value.data;
    return [];
  }
  function unwrap(value,key){
    if(value && typeof value==="object" && value[key] && typeof value[key]==="object") return value[key];
    if(value?.data && typeof value.data==="object") return value.data;
    return value || {};
  }
  function setScreen(name){
    state.screen=name;
    $$(".kg-screen").forEach(node=>node.classList.toggle("is-active",node.id==="kg-"+name+"-screen"));
    $$("#kg-nav button").forEach(node=>node.classList.toggle("is-active",node.dataset.screen===name));
    $("#kg-nav").hidden=false;
    $("#kg-asset-screen").hidden=true;
    $("#kg-ticket-screen").hidden=true;
    if(tg?.BackButton){tg.BackButton.hide();tg.BackButton.offClick?.(handleNativeBack);}
  }
  function showSubscreen(name){
    $$(".kg-screen").forEach(node=>node.classList.remove("is-active"));
    $("#kg-nav").hidden=true;
    $("#kg-asset-screen").hidden=name!=="asset";
    $("#kg-ticket-screen").hidden=name!=="ticket";
    if(tg?.BackButton){tg.BackButton.show();tg.BackButton.offClick?.(handleNativeBack);tg.BackButton.onClick(handleNativeBack);}
  }
  function handleNativeBack(){
    if(!$("#kg-ticket-screen").hidden){closeTicket();return;}
    if(!$("#kg-asset-screen").hidden){closeAsset();return;}
    setScreen(state.screen);
  }
  function marketMap(){return new Map([...state.markets,...state.futures].map(m=>[m.symbol||m.market,m]));}
  function quoteOf(m){return Number(m?.priceUsd ?? m?.price ?? m?.markPriceUsd ?? m?.markPrice);}
  function changeOf(m){return Number(m?.change24hPct ?? m?.changePct24h ?? m?.change24h);}
  function renderFavorites(){
    const map=marketMap();
    const fav=[...state.favorites].map(s=>map.get(s)).filter(Boolean).slice(0,8);
    $("#kg-favorites").innerHTML=fav.length?fav.map(m=>{
      const s=m.symbol||m.market, change=changeOf(m), price=quoteOf(m);
      return `<button class="kg-favorite" data-open-market="${esc(s)}" type="button"><div class="kg-fav-top"><span class="kg-asset-icon">${esc(iconFor(s))}</span><span class="kg-badge">${Number(m.maxLeverage||1)}×</span><span class="kg-fav-remove" data-remove-favorite="${esc(s)}" ${state.editFavorites?"":"hidden"}>×</span></div><b>${esc(s)}</b><strong>${money(price,price>=100?0:2)}</strong><small class="${change>=0?"kg-change-up":"kg-change-down"}">${pct(change)}</small><svg class="kg-sparkline" viewBox="0 0 100 22" preserveAspectRatio="none"><path d="M1 15 L14 12 L25 16 L37 8 L49 10 L62 4 L74 12 L86 9 L99 18" fill="none" stroke="${change>=0?"#22ad78":"#e45a65"}" stroke-width="2"/></svg></button>`;
    }).join(""):'<div class="kg-empty-inline">Добавьте активы в избранное из списка рынка.</div>';
  }
  function renderWalletAssets(){
    const assets=listOf(state.wallet,["assets","balances"]);
    $("#kg-wallet-assets").innerHTML=assets.length?assets.map(a=>{
      const s=a.symbol||a.asset||"";
      const balance=Number(a.valueUsd ?? a.balanceUsd ?? a.usdValue);
      return `<div class="kg-asset-row" data-open-market="${esc(s)}"><span class="kg-asset-icon">${esc(iconFor(s))}</span><span class="kg-row-copy"><b>${esc(a.name||symbolName(s))}</b><small>${esc(s)}</small></span><strong class="kg-row-value">${Number.isFinite(balance)?money(balance):"—"}</strong></div>`;
    }).join(""):'<div class="kg-empty-inline">Активы появятся после пополнения демо-счёта.</div>';
  }
  function renderRecent(){
    const map=marketMap(), recent=state.recent.map(s=>map.get(s)).filter(Boolean);
    $("#kg-recent").innerHTML=recent.length?recent.map(m=>{const s=m.symbol||m.market;return `<button class="kg-recent-chip" data-open-market="${esc(s)}" type="button"><span class="kg-asset-icon">${esc(iconFor(s))}</span>${esc(s)}</button>`;}).join(""):'<span class="kg-muted">Здесь появятся просмотренные активы</span>';
  }
  function renderHeatmap(markets){
    const ranked=[...markets].filter(m=>Number.isFinite(quoteOf(m))).sort((a,b)=>(Number(b.volume24hUsd||0)-Number(a.volume24hUsd||0))).slice(0,12);
    $("#kg-heatmap").innerHTML=ranked.length?ranked.map((m,i)=>{
      const s=m.symbol||m.market, ch=changeOf(m), strength=Math.min(1,Math.abs(ch||0)/8), hue=ch>=0?145:0, light=36-strength*8;
      const span=i===0?3:((i%4===0)?2:1), row=i===0?2:1;
      return `<button class="kg-heat-cell" style="grid-column:span ${span};grid-row:span ${row};background:hsl(${hue} 62% ${light}%)" data-open-market="${esc(s)}" type="button"><b>${esc(s)}</b><small>${pct(ch)}</small></button>`;
    }).join(""):'<div class="kg-empty-inline">Тепловая карта недоступна: нет проверенных котировок.</div>';
  }
  function renderTopDay(markets){
    const sorted=[...markets].sort((a,b)=>state.sort==="up"?changeOf(b)-changeOf(a):changeOf(a)-changeOf(b)).slice(0,8);
    $("#kg-top-day").innerHTML=sorted.length?sorted.map(m=>{const s=m.symbol||m.market,ch=changeOf(m);return `<button class="kg-top-item" data-open-market="${esc(s)}" type="button"><span class="kg-asset-icon">${esc(iconFor(s))}</span><b>${esc(s)}</b><small class="${ch>=0?"kg-change-up":"kg-change-down"}">${pct(ch)}</small></button>`;}).join(""):'<div class="kg-empty-inline">Нет данных для рейтинга.</div>';
  }
  function currentMarkets(){
    if(state.category==="all"){
      const unique=new Map([...state.markets,...state.futures].map(m=>[m.symbol||m.market,m]));
      return [...unique.values()];
    }
    return state.category==="futures"?state.futures:state.markets;
  }
  function renderMarketList(markets){
    const query=$("#kg-market-search").value.trim().toUpperCase();
    const visible=markets.filter(m=>(m.symbol||m.market||"").toUpperCase().includes(query));
    $("#kg-market-list").innerHTML=visible.length?visible.map(m=>{
      const s=m.symbol||m.market,ch=changeOf(m),p=quoteOf(m);
      return `<div class="kg-market-row"><span class="kg-asset-icon" data-open-market="${esc(s)}">${esc(iconFor(s))}</span><button class="kg-market-copy" data-open-market="${esc(s)}" type="button"><b>${esc(m.name||symbolName(s))} <small>${esc(s)}</small></b><small>Фьючерс · ${Number(m.maxLeverage||1)}×</small></button><div class="kg-market-price">${money(p,p>=100?0:2)}<small class="${ch>=0?"kg-change-up":"kg-change-down"}">${pct(ch)}</small></div><button class="kg-fav-button" data-toggle-favorite="${esc(s)}" type="button" aria-label="Избранное">${state.favorites.has(s)?"★":"☆"}</button></div>`;
    }).join(""):'<div class="kg-empty-inline">По запросу ничего не найдено.</div>';
  }
  async function loadCategory(category){
    state.category=category;
    $$(".kg-category").forEach(b=>b.classList.toggle("is-selected",b.dataset.category===category));
    $$("#kg-search-filters button").forEach(b=>b.classList.toggle("is-selected",b.dataset.searchFilter===category));
    $$(".kg-category").forEach(b=>b.classList.toggle("is-selected",b.dataset.category===category));
    const live=$("#kg-market-live"), unavailable=$("#kg-market-unavailable");
    if(category==="stocks"||category==="funds"){
      live.hidden=true;unavailable.hidden=false;
      $("#kg-unavailable-title").textContent=category==="stocks"?"Акции США":"Фонды";
      try{
        const res=unwrap(await invoke("markets.list",{category}),"markets");
        if(res.available===false) $("#kg-unavailable-reason").textContent=res.reason||"Проверенный источник котировок пока не подключён.";
        else $("#kg-unavailable-reason").textContent="Торговля этими инструментами пока недоступна.";
      }catch(error){$("#kg-unavailable-reason").textContent=normalizeError(error).message;}
      return;
    }
    live.hidden=false;unavailable.hidden=true;
    try{
      const result=unwrap(await invoke("markets.list",{category}),"markets");
      const items=listOf(result,["markets","items"]);
      if(category==="futures") state.futures=items; else state.markets=items;
      const current=category==="futures"?state.futures:state.markets;
      $("#kg-market-title").textContent=category==="futures"?"Фьючерсы":"Все активы";
      $("#kg-market-updated").textContent="Обновлено";
      renderMarketList(current);renderHeatmap(current);renderTopDay(current);renderFavorites();renderRecent();
    }catch(error){
      $("#kg-market-list").innerHTML=`<div class="kg-empty-inline">${esc(normalizeError(error).message)}</div>`;
      $("#kg-heatmap").innerHTML='<div class="kg-empty-inline">Нет данных рынка.</div>';
      $("#kg-top-day").innerHTML="";
    }
  }
  async function setSearchFilter(category){
    state.category=category;
    $$("#kg-search-filters button").forEach(b=>b.classList.toggle("is-selected",b.dataset.searchFilter===category));
    if(category==="all"){
      $("#kg-market-live").hidden=false;$("#kg-market-unavailable").hidden=true;
      try{
        const [cryptoResult,futuresResult]=await Promise.all([invoke("markets.list",{category:"crypto"}),invoke("markets.list",{category:"futures"})]);
        state.markets=listOf(unwrap(cryptoResult,"markets"),["markets","items"]);
        state.futures=listOf(unwrap(futuresResult,"markets"),["markets","items"]);
        const unique=new Map([...state.markets,...state.futures].map(m=>[m.symbol||m.market,m]));
        const all=[...unique.values()];
        $("#kg-market-title").textContent="Все активы";
        $("#kg-market-updated").textContent="Обновлено";
        renderMarketList(all);renderHeatmap(all);renderTopDay(all);renderFavorites();
      }catch(error){$("#kg-market-list").innerHTML=`<div class="kg-empty-inline">${esc(normalizeError(error).message)}</div>`;}
      return;
    }
    await loadCategory(category);
  }
  async function loadWallet(){
    try{
      state.wallet=unwrap(await invoke("wallet.get"),"wallet");
      $("#kg-wallet-balance").textContent=money(Number(state.wallet.balanceUsd ?? state.wallet.balance ?? NaN));
      $("#kg-wallet-currency-value").textContent=money(Number(state.wallet.balanceUsd ?? state.wallet.balance ?? NaN));
      renderWalletAssets();
      const pos=listOf(state.wallet,["positions"]);
      $("#kg-position-count").textContent=String(pos.length);
      renderPositions(pos);
    }catch(error){
      $("#kg-wallet-balance").textContent="—";
      $("#kg-wallet-assets").innerHTML=`<div class="kg-empty-inline">${esc(normalizeError(error).message)}</div>`;
      $("#kg-positions").innerHTML=`<div class="kg-empty-card">${esc(normalizeError(error).message)}</div>`;
    }
  }
  function renderPositions(positions){
    $("#kg-positions").innerHTML=positions.length?positions.map(p=>{
      const s=p.symbol||p.market, side=String(p.side||"").toLowerCase(), pnl=Number(p.unrealizedPnlUsd ?? p.pnlUsd ?? NaN), id=p.id||p.positionId;
      const pnlClass=Number.isFinite(pnl)?(pnl>=0?"kg-positive":"kg-negative"):"kg-muted";
      return `<article class="kg-position"><div class="kg-position-head"><b>${esc(side==="short"?"Шорт":"Лонг")} ${esc(s)}</b><span class="kg-position-pnl ${pnlClass}">${money(pnl)}</span></div><div class="kg-position-meta">Маржа ${money(Number(p.marginUsd))} · Плечо ${Number(p.leverage||1)}×</div><div class="kg-position-foot"><small class="kg-muted">Виртуальная позиция DEMO</small><button class="kg-close-position" data-close-position="${esc(id)}" type="button">Закрыть</button></div></article>`;
    }).join(""):'<div class="kg-empty-card">Открытых позиций пока нет.</div>';
  }
  function renderAssetHistory(symbol){
    if(!$("#kg-asset-history"))return;
    const events=state.history.filter(e=>(e.symbol||e.market)===symbol).slice(0,4);
    $("#kg-asset-history").innerHTML=events.length?events.map(e=>{
      const side=String(e.side||"").toLowerCase(),pnl=Number(e.netPnlUsd??e.pnlUsd??e.pnl);
      const pnlClass=Number.isFinite(pnl)?(pnl>=0?"kg-positive":"kg-negative"):"kg-muted";
      return `<div class="kg-history-row"><span class="kg-history-dot">${side==="short"?"↘":"↗"}</span><span class="kg-history-copy"><b>${esc(e.event||e.type||"Сделка")} · ${esc(symbol)}</b><small>${esc(e.timestamp||e.createdAt||"")}</small></span><strong class="kg-history-value ${pnlClass}">${Number.isFinite(pnl)?money(pnl):"—"}</strong></div>`;
    }).join(""):'<div class="kg-empty-inline">Операций по этому активу пока нет.</div>';
  }
  async function loadHistory(){
    try{
      const result=unwrap(await invoke("history.list"),"history");
      state.history=listOf(result,["events","history","items","trades"]);
      if(state.selectedMarket)renderAssetHistory(state.selectedMarket);
      $("#kg-history").innerHTML=state.history.length?state.history.map(e=>{
        const side=String(e.side||"").toLowerCase(), pnl=Number(e.netPnlUsd ?? e.pnlUsd ?? e.pnl);
        const action=e.event||e.type||e.status||"Сделка";
        const pnlClass=Number.isFinite(pnl)?(pnl>=0?"kg-positive":"kg-negative"):"kg-muted";
        return `<div class="kg-history-row"><span class="kg-history-dot">${side==="short"?"↘":"↗"}</span><span class="kg-history-copy"><b>${esc(action)} · ${esc(e.symbol||e.market||"")}</b><small>${esc(e.timestamp||e.createdAt||"")}</small></span><strong class="kg-history-value ${pnlClass}">${Number.isFinite(pnl)?money(pnl):"—"}</strong></div>`;
      }).join(""):'<div class="kg-empty-card">Сделок пока нет.</div>';
    }catch(error){$("#kg-history").innerHTML=`<div class="kg-empty-card">${esc(normalizeError(error).message)}</div>`;}
  }
  async function loadCapabilities(){
    try{
      state.capabilities=unwrap(await invoke("capabilities.get"),"capabilities");
      const c=state.capabilities;
      if(c.ipo?.available===true) $("#kg-ipo-reason").textContent="Проверенные размещения доступны.";
      if(c.bonuses?.available===true) $("#kg-bonus-reason").textContent="Программа бонусов доступна.";
      if(c.live?.available!==true) $(".kg-settings-note").textContent="Режим: ДЕМО. LIVE заблокирован.";
    }catch(error){console.warn("[Kripto Guru] capabilities unavailable",normalizeError(error));}
  }
  function normalizeCandle(c){
    if(Array.isArray(c)) return {time:Number(c[0]),open:Number(c[1]),high:Number(c[2]),low:Number(c[3]),close:Number(c[4])};
    return {time:Number(c.time??c.timestamp),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)};
  }
  function drawCandles(candles){
    const data=candles.map(normalizeCandle).filter(c=>[c.open,c.high,c.low,c.close].every(Number.isFinite));
    if(!data.length){$("#kg-chart").innerHTML='<div class="kg-empty-inline">Свечи для этого интервала недоступны.</div>';return;}
    const W=340,H=200,top=8,bottom=188,min=Math.min(...data.map(c=>c.low)),max=Math.max(...data.map(c=>c.high)),range=max-min||1;
    const y=v=>bottom-(v-min)/range*(bottom-top),step=W/data.length,body=Math.max(2,step*.48);
    const marks=data.map((c,i)=>{const x=i*step+step/2,up=c.close>=c.open,color=up?"#20a96f":"#e35562",yt=y(Math.max(c.open,c.close)),yb=y(Math.min(c.open,c.close));return `<line x1="${x}" y1="${y(c.high)}" x2="${x}" y2="${y(c.low)}" stroke="${color}" stroke-width="1.2"/><rect x="${x-body/2}" y="${yt}" width="${body}" height="${Math.max(1,yb-yt)}" rx=".7" fill="${color}"/>`;}).join("");
    const grid=[.25,.5,.75].map(p=>`<line x1="0" y1="${top+(bottom-top)*p}" x2="${W}" y2="${top+(bottom-top)*p}" stroke="#eceef3" stroke-dasharray="3 4"/>`).join("");
    $("#kg-chart").innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Свечной график">${grid}${marks}</svg>`;
  }
  async function openAsset(symbol){
    state.previousScreen=state.screen;
    try{
      const detail=unwrap(await invoke("market.get",symbol),"market");
      if(detail.tradeable===false){notify("Этот актив недоступен для DEMO-торговли.");return;}
      state.selected=detail;state.selectedMarket=symbol;
      state.recent=[symbol,...state.recent.filter(x=>x!==symbol)].slice(0,8);
      try{localStorage.setItem("kg:recent:v1",JSON.stringify(state.recent));}catch{}
      renderRecent();
      $("#kg-asset-name").textContent=detail.name||symbolName(symbol);
      $("#kg-asset-symbol").textContent=symbol+" · DEMO-рынок";
      $("#kg-asset-icon").textContent=iconFor(symbol);
      $("#kg-asset-product").textContent=detail.productType||"Фьючерс";
      $("#kg-asset-leverage").textContent=Number(detail.maxLeverage||1)+"×";
      $("#kg-asset-price").textContent=money(Number(detail.priceUsd??detail.price),Number(detail.priceUsd??detail.price)>=100?0:2);
      const ch=Number(detail.change24hPct??detail.changePct24h);
      $("#kg-asset-change").textContent=pct(ch)+" за 24 часа";
      $("#kg-asset-change").className="kg-asset-change "+(ch>=0?"kg-positive":"kg-negative");
      $("#kg-asset-favorite").textContent=state.favorites.has(symbol)?"★ В избранном":"☆ В избранное";
      const rows=[
        ["Объём за 24 часа",money(Number(detail.volume24hUsd))],
        ["Открытый интерес",money(Number(detail.openInterestUsd))],
        ["Фандинг за час",Number.isFinite(Number(detail.fundingRateHourlyPct))?pct(detail.fundingRateHourlyPct):"—"],
        ["Комиссия тейкера",Number.isFinite(Number(detail.takerFeePct))?fmt(detail.takerFeePct,3)+"%":"—"],
        ["Доступное плечо",Number(detail.maxLeverage||1)+"×"]
      ];
      $("#kg-market-details").innerHTML=rows.map(([k,v])=>`<div class="kg-detail-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
      await loadHistory();
      renderAssetHistory(symbol);
      showSubscreen("asset");
      await loadCandles(state.interval);
    }catch(error){notify(normalizeError(error).message);}
  }
  async function loadCandles(interval){
    state.interval=interval;
    $$("#kg-timeframes button").forEach(b=>b.classList.toggle("is-selected",b.dataset.interval===interval));
    $("#kg-chart-state").textContent="Загрузка…";
    try{
      const result=unwrap(await invoke("market.candles",state.selectedMarket,interval),"candles");
      const candles=listOf(result,["candles","items"]);
      if(!candles.length) throw {message:"Свечи для выбранного интервала пока недоступны.",retryable:true};
      drawCandles(candles);$("#kg-chart-state").textContent="Рыночные данные";
    }catch(error){$("#kg-chart").innerHTML=`<div class="kg-empty-inline">${esc(normalizeError(error).message)}</div>`;$("#kg-chart-state").textContent="Нет данных";}
  }
  function closeAsset(){const returnTo=state.previousScreen||"trading";state.selected=null;state.selectedMarket=null;$("#kg-asset-screen").hidden=true;$("#kg-nav").hidden=false;setScreen(returnTo);}
  function openTicket(side){
    if(!state.selected)return;
    state.side=side;state.leverage=1;state.maxLeverage=Math.max(1,Number(state.selected.maxLeverage||1));state.margin=0;state.preview=null;state.autoclose=false;
    $("#kg-ticket-heading").textContent=(side==="long"?"Лонг ":"Шорт ")+state.selectedMarket+" · "+$("#kg-asset-price").textContent;
    $("#kg-ticket-margin").value="";
    $("#kg-ticket-leverage").textContent="1×";
    $("#kg-ticket-available").textContent="Доступно: "+money(Number(state.wallet?.balanceUsd??state.wallet?.balance??0))+" USDT";
    $("#kg-ticket-volume").textContent="Объём: —";
    $("#kg-ticket-preview").textContent="";
    $("#kg-ticket-autoclose").textContent="Автозакрытие";
    showSubscreen("ticket");
    const input=$("#kg-ticket-margin");
    input.focus({preventScroll:true});
    refreshPreview();
  }
  async function refreshPreview(){
    const seq=++state.previewSeq,margin=Number($("#kg-ticket-margin").value);
    state.margin=Number.isFinite(margin)?margin:0;
    $("#kg-ticket-check").disabled=true;
    state.preview=null;
    if(!(state.margin>0)){$("#kg-ticket-volume").textContent="Объём: —";$("#kg-ticket-preview").textContent="";return;}
    try{
      const result=unwrap(await invoke("trade.preview",{symbol:state.selectedMarket,side:state.side,marginUsd:state.margin,leverage:state.leverage}),"preview");
      if(seq!==state.previewSeq)return;
      state.preview=result;
      const volume=Number(result.volumeUsd??result.notionalUsd);
      $("#kg-ticket-volume").textContent="Объём: "+money(volume);
      const fees=[];
      if(result.entryFeeUsd!==undefined)fees.push("Комиссия открытия "+money(Number(result.entryFeeUsd)));
      if(result.exitFeeUsd!==undefined)fees.push("Комиссия закрытия "+money(Number(result.exitFeeUsd)));
      $("#kg-ticket-preview").textContent=fees.join(" · ");
      $("#kg-ticket-check").disabled=!(result.valid!==false && result.available!==false);
    }catch(error){if(seq!==state.previewSeq)return;$("#kg-ticket-preview").textContent=normalizeError(error).message;}
  }
  function closeTicket(){state.previewSeq++;$("#kg-ticket-screen").hidden=true;$("#kg-asset-screen").hidden=false;if(tg?.BackButton){tg.BackButton.show();tg.BackButton.offClick?.(handleNativeBack);tg.BackButton.onClick(handleNativeBack);}}
  function showModal(id){$(id).hidden=false;}
  function closeModals(){$$(".kg-modal").forEach(m=>m.hidden=true);}
  async function confirmTrade(){
    if(!state.preview||state.busy)return;
    state.busy=true;$("#kg-trade-confirm").disabled=true;
    try{
      const result=await invoke("trade.open",{symbol:state.selectedMarket,side:state.side,marginUsd:state.margin,leverage:state.leverage,previewId:state.preview.previewId});
      closeModals();closeTicket();await Promise.all([loadWallet(),loadHistory()]);
      if(state.selectedMarket)renderAssetHistory(state.selectedMarket);
      notify("Демо-сделка открыта.");
    }catch(error){notify(normalizeError(error).message);}
    finally{state.busy=false;$("#kg-trade-confirm").disabled=false;}
  }
  async function closePosition(id){
    if(!id||state.busy)return;
    state.busy=true;
    try{await invoke("trade.close",id);await Promise.all([loadWallet(),loadHistory()]);notify("Демо-позиция закрыта.");}
    catch(error){notify(normalizeError(error).message);}
    finally{state.busy=false;}
  }
  function renderCompanionMessages(){
    const root=$("#kg-ai-messages");
    if(!state.companionMessages.length){
      root.innerHTML='<div class="kg-ai-empty">Привет! Я AI Companion. Могу помочь с вопросами, обучением, технологиями и планированием.</div>';
      return;
    }
    root.innerHTML=state.companionMessages.map(message=>`<div class="kg-ai-message ${message.role==="user"?"is-user":"is-assistant"}"><div>${esc(message.content).replace(/\n/g,"<br>")}</div></div>`).join("");
    root.scrollTop=root.scrollHeight;
  }
  function renderCompanionHistory(){
    const root=$("#kg-ai-history");
    root.innerHTML=state.companionConversations.map(item=>`<div class="kg-ai-history-entry"><button type="button" class="kg-ai-history-item ${item.id===state.companionId?"is-selected":""}" data-ai-conversation="${esc(item.id)}"><span>${esc(item.title||"Новый диалог")}</span><small>${Number(item.messageCount)||0}</small></button><button type="button" class="kg-ai-history-delete" data-ai-delete="${esc(item.id)}" aria-label="Удалить диалог: ${esc(item.title||"Новый диалог")}" title="Удалить диалог">×</button></div>`).join("");
  }
  async function deleteCompanionConversation(id){
    if(!id||state.companionBusy)return;
    state.companionBusy=true;
    try{
      await invoke("companion.remove",id);
      if(state.companionId===id){state.companionId=null;state.companionMessages=[];renderCompanionMessages();}
      await loadCompanionConversations();
      notify("Диалог удалён.");
    }catch(error){notify(normalizeError(error).message);}
    finally{state.companionBusy=false;}
  }
  async function loadCompanionConversations(){
    try{
      state.companionConversations=await invoke("companion.list");
      renderCompanionHistory();
    }catch(error){notify(normalizeError(error).message);}
  }
  async function openCompanionConversation(id){
    if(state.companionBusy)return;
    try{
      const conversation=await invoke("companion.get",id);
      state.companionId=conversation.id;
      state.companionMessages=conversation.messages||[];
      renderCompanionMessages();renderCompanionHistory();
    }catch(error){notify(normalizeError(error).message);}
  }
  function newCompanionConversation(){
    state.companionId=null;state.companionMessages=[];
    renderCompanionMessages();renderCompanionHistory();
    $("#kg-ai-input").focus();
  }
  async function sendCompanionMessage(event){
    event?.preventDefault();
    const input=$("#kg-ai-input"), message=input.value.trim();
    if(!message||state.companionBusy)return;
    state.companionBusy=true;$("#kg-ai-send").disabled=true;input.disabled=true;
    try{
      const result=await invoke("companion.send",message,state.companionId);
      state.companionId=result.conversationId;
      state.companionMessages=result.conversation?.messages||[...state.companionMessages,{role:"user",content:message},{role:"assistant",content:result.answer}];
      input.value="";renderCompanionMessages();await loadCompanionConversations();
    }catch(error){notify(normalizeError(error).message);}
    finally{state.companionBusy=false;$("#kg-ai-send").disabled=false;input.disabled=false;input.focus();}
  }
  function bind(){
    $$("#kg-nav button").forEach(button=>button.addEventListener("click",async()=>{
      setScreen(button.dataset.screen);
      if(state.screen==="wallet")await loadWallet();
      if(state.screen==="trading")await (state.category==="all"?setSearchFilter("all"):loadCategory(state.category));
      if(state.screen==="income"){await loadWallet();await loadHistory();}
      if(state.screen==="bonuses")await loadCapabilities();
      if(state.screen==="companion")await loadCompanionConversations();
    }));
    $("#kg-ai-new").addEventListener("click",newCompanionConversation);
    $("#kg-ai-form").addEventListener("submit",sendCompanionMessage);
    $("#kg-ai-input").addEventListener("keydown",event=>{
      if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();$("#kg-ai-form").requestSubmit();}
    });
    $("#kg-ai-history").addEventListener("click",event=>{
      const remove=event.target.closest("[data-ai-delete]");
      if(remove?.dataset.aiDelete){deleteCompanionConversation(remove.dataset.aiDelete);return;}
      const item=event.target.closest("[data-ai-conversation]");
      if(item?.dataset.aiConversation)openCompanionConversation(item.dataset.aiConversation);
    });
    $$("[data-open-trading]").forEach(b=>b.addEventListener("click",()=>{setScreen("trading");loadCategory("crypto");}));
    $$("[data-open-futures]").forEach(b=>b.addEventListener("click",()=>{setScreen("trading");loadCategory("futures");}));
    $$(".kg-category").forEach(b=>b.addEventListener("click",()=>loadCategory(b.dataset.category)));
    $("#kg-search-open").addEventListener("click",()=>{$("#kg-trading-screen").classList.add("kg-search-mode");$("#kg-search-open").hidden=true;$("#kg-market-search").hidden=false;$("#kg-search-close").hidden=false;$("#kg-search-filters").hidden=false;setSearchFilter("all");$("#kg-market-search").focus();});
    $("#kg-search-close").addEventListener("click",()=>{$("#kg-market-search").value="";$("#kg-trading-screen").classList.remove("kg-search-mode");$("#kg-search-filters").hidden=true;$("#kg-market-search").hidden=true;$("#kg-search-close").hidden=true;$("#kg-search-open").hidden=false;loadCategory("crypto");});
    $("#kg-market-search").addEventListener("input",()=>renderMarketList(currentMarkets()));
    $$("#kg-search-filters button").forEach(b=>b.addEventListener("click",()=>setSearchFilter(b.dataset.searchFilter)));
    $("#kg-market-search").addEventListener("keydown",e=>{if(e.key==="Escape")$("#kg-search-close").click();});
    $("#kg-recent-clear").addEventListener("click",()=>{state.recent=[];try{localStorage.removeItem("kg:recent:v1");}catch{}renderRecent();});
    $$("[data-sort]").forEach(b=>b.addEventListener("click",()=>{state.sort=b.dataset.sort;$$("[data-sort]").forEach(x=>x.classList.toggle("is-selected",x===b));renderTopDay(currentMarkets());}));
    document.addEventListener("click",event=>{
      const remove=event.target.closest("[data-remove-favorite]");
      if(remove){event.preventDefault();event.stopPropagation();state.favorites.delete(remove.dataset.removeFavorite);try{localStorage.setItem("kg:favorites:v1",JSON.stringify([...state.favorites]));}catch{}renderFavorites();return;}
      const open=event.target.closest("[data-open-market]");
      if(open){const symbol=open.dataset.openMarket;if(symbol)openAsset(symbol);return;}
      const fav=event.target.closest("[data-toggle-favorite]");
      if(fav){const symbol=fav.dataset.toggleFavorite;state.favorites.has(symbol)?state.favorites.delete(symbol):state.favorites.add(symbol);try{localStorage.setItem("kg:favorites:v1",JSON.stringify([...state.favorites]));}catch{}renderFavorites();renderMarketList(currentMarkets());}
      const close=event.target.closest("[data-close-position]");
      if(close)closePosition(close.dataset.closePosition);
    });
    document.querySelectorAll("[data-wallet-action]").forEach(button=>button.addEventListener("click",()=>notify("Операции с переводом и реальными средствами отключены. Доступен только демо-режим.")));
    $("#kg-edit-favorites").addEventListener("click",()=>{state.editFavorites=!state.editFavorites;$("#kg-edit-favorites").textContent=state.editFavorites?"Готово":"Изменить";renderFavorites();});
    $("#kg-asset-back").addEventListener("click",closeAsset);
    $("#kg-asset-favorite").addEventListener("click",()=>{const s=state.selectedMarket;if(!s)return;state.favorites.has(s)?state.favorites.delete(s):state.favorites.add(s);renderFavorites();try{localStorage.setItem("kg:favorites:v1",JSON.stringify([...state.favorites]));}catch{}$("#kg-asset-favorite").textContent=state.favorites.has(s)?"★ В избранном":"☆ В избранное";});
    $$("#kg-timeframes button").forEach(b=>b.addEventListener("click",()=>loadCandles(b.dataset.interval)));
    $("#kg-long").addEventListener("click",()=>openTicket("long"));
    $("#kg-short").addEventListener("click",()=>openTicket("short"));
    $("#kg-ticket-close").addEventListener("click",closeTicket);
    $("#kg-ticket-margin").addEventListener("input",refreshPreview);
    $("#kg-ticket-max").addEventListener("click",async()=>{
      const available=Number(state.wallet?.balanceUsd??state.wallet?.balance??0);
      if(!(available>0)){notify("Нет доступного демо-баланса.");return;}
      const request={symbol:state.selectedMarket,side:state.side,leverage:state.leverage};
      const button=$("#kg-ticket-max");
      button.disabled=true;
      try{
        const result=unwrap(await invoke("trade.preview",{...request,marginUsd:available}),"preview");
        if(state.selectedMarket!==request.symbol||state.side!==request.side||state.leverage!==request.leverage)return;
        const maxMargin=Number(result.maxMarginUsd);
        const minMargin=Number(result.minMarginUsd);
        const allowed=Math.min(available,Number.isFinite(maxMargin)?maxMargin:0);
        if(!(allowed>0)|| (Number.isFinite(minMargin)&&allowed<minMargin)){
          notify(result.reason||"Доступного демо-баланса недостаточно для минимальной сделки.");
          return;
        }
        $("#kg-ticket-margin").value=String(Math.floor(allowed*1_000_000)/1_000_000);
        refreshPreview();
      }catch(error){notify(normalizeError(error).message);}
      finally{button.disabled=false;}
    });
    $("#kg-ticket-leverage").addEventListener("click",()=>{
      $("#kg-lev-slider").max=String(state.maxLeverage);$("#kg-lev-slider").value=String(state.leverage);$("#kg-lev-value").textContent=state.leverage+"×";showModal("#kg-leverage-screen");
    });
    $("#kg-lev-slider").addEventListener("input",()=>$("#kg-lev-value").textContent=$("#kg-lev-slider").value+"×");
    $("#kg-lev-min").addEventListener("click",()=>{$("#kg-lev-slider").value="1";$("#kg-lev-value").textContent="1×";});
    $("#kg-lev-max").addEventListener("click",()=>{$("#kg-lev-slider").value=String(state.maxLeverage);$("#kg-lev-value").textContent=state.maxLeverage+"×";});
    $("#kg-lev-apply").addEventListener("click",()=>{state.leverage=Number($("#kg-lev-slider").value);$("#kg-ticket-leverage").textContent=state.leverage+"×";closeModals();refreshPreview();});
    $$("[data-close-modal]").forEach(b=>b.addEventListener("click",closeModals));
    $("#kg-asset-history-all").addEventListener("click",()=>{setScreen("income");loadWallet();loadHistory();});
    $("#kg-ticket-check").addEventListener("click",()=>{
      if(!state.preview)return;
      $("#kg-confirm-details").innerHTML=`<div class="kg-detail-row"><span>Направление</span><b>${state.side==="long"?"Лонг":"Шорт"} ${esc(state.selectedMarket)}</b></div><div class="kg-detail-row"><span>Маржа</span><b>${money(state.margin)}</b></div><div class="kg-detail-row"><span>Плечо</span><b>${state.leverage}×</b></div><div class="kg-detail-row"><span>Объём</span><b>${money(Number(state.preview.volumeUsd??state.preview.notionalUsd))}</b></div>`;
      showModal("#kg-confirm-screen");
    });
    $("#kg-trade-confirm").addEventListener("click",confirmTrade);
    document.addEventListener("keydown",e=>{if(e.key==="Escape"){if(!$("#kg-confirm-screen").hidden||!$("#kg-leverage-screen").hidden)closeModals();else if(!$("#kg-ticket-screen").hidden)closeTicket();else if(!$("#kg-asset-screen").hidden)closeAsset();}});
  }
  let started=false;
  async function start(){
    if(started)return;
    started=true;
    try{tg?.ready?.();tg?.expand?.();tg?.setHeaderColor?.("#ffffff");tg?.setBackgroundColor?.("#f0f0f6");}catch{}
    bind();
    await Promise.all([loadWallet(),loadCapabilities(),loadHistory()]);
    try{await loadCategory("crypto");}catch{}
  }
  window.addEventListener("kripto-guru-api-ready",()=>start());
  if(api()) start();
  else{
    $("#kg-wallet-balance").textContent="—";
    $("#kg-wallet-assets").innerHTML='<div class="kg-empty-inline">Подключаем демо-сервис…</div>';
    setTimeout(()=>{if(api())start();else notify("Демо API ещё не подключён.");},800);
  }
  window.KriptoGuruUI={state,reload:()=>Promise.all([loadWallet(),loadHistory(),loadCategory(state.category)]),openAsset,closeAsset};
})();
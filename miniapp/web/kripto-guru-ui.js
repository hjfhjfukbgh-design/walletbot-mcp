(() => {
  "use strict";
  const $ = (selector, root=document) => root.querySelector(selector);
  const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
  const tg = window.Telegram?.WebApp || null;
  const state = {
    screen:"wallet", previousScreen:"trading", category:"crypto", markets:[], futures:[], fxRateRub:null, currencyMode:"RUB", sparklineCache:{},
    favorites:(()=>{try{return new Set(JSON.parse(localStorage.getItem("kg:favorites:v1")||'["BTC","ETH","SOL"]'));}catch{return new Set(["BTC","ETH","SOL"]);}})(),
    equities:(()=>{try{const saved=JSON.parse(localStorage.getItem("kg:equities:v1"));return Array.isArray(saved)?saved.filter(x=>x&&typeof x.symbol==="string"&&typeof x.name==="string"):[{symbol:"AAPL",name:"Apple",kind:"Акция"}];}catch{return[{symbol:"AAPL",name:"Apple",kind:"Акция"}];}})(),
    editEquities:false,
    recent:(()=>{try{return JSON.parse(localStorage.getItem("kg:recent:v1")||"[]").filter(x=>typeof x==="string").slice(0,8);}catch{return[];}})(),
    editFavorites:false, selected:null, selectedMarket:null, interval:"15m", side:"long", leverage:1, maxLeverage:1,
    margin:0, preview:null, history:[], wallet:null, capabilities:{}, sort:"up", previewSeq:0, confirmPayload:null,
    autoclose:false, busy:false, companionId:null, companionMessages:[], companionConversations:[], companionLimits:null, companionInitialized:false, companionBusy:false, companionMode:"general", companionAttachments:[], companionRecorder:null, companionRecordChunks:[]
  };
  let marketLoadEpoch=0,marketRefreshInFlight=false,marketLastUpdatedAt=0,marketSearchTimer=0,marketVisibilityListenerInstalled=false;
  const fmt = (v, digits=2) => Number.isFinite(Number(v)) ? new Intl.NumberFormat("ru-RU",{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(Number(v)) : "—";
  const priceDigits = (value, metadata) => {
    const candidates = [metadata?.priceDecimals, metadata?.raw?.priceDecimals, metadata?.raw?.contract?.priceDecimals];
    const declared = candidates.find(v => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 12);
    return declared === undefined ? null : Number(declared);
  };
  const formatPrice = (value, metadata) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const digits = priceDigits(number, metadata);
    return new Intl.NumberFormat("ru-RU", digits === null
      ? { maximumSignificantDigits: 7, useGrouping: true }
      : { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: true }).format(number);
  };
  const money = (v,d=2) => Number.isFinite(Number(v)) ? "$"+fmt(v,d) : "—";
  const moneyRub = (v,d=2) => Number.isFinite(Number(v)) && Number.isFinite(state.fxRateRub) ? fmt(Number(v)*state.fxRateRub,d)+" ₽" : "—";
  const priceMoney = (v, metadata) => Number.isFinite(Number(v)) ? "$"+formatPrice(v, metadata) : "—";
  async function loadFxRate(){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);try{const response=await fetch("https://open.er-api.com/v6/latest/USD",{signal:controller.signal,cache:"no-store"});if(!response.ok)throw new Error("FX HTTP "+response.status);const data=await response.json();const rate=Number(data?.rates?.RUB);if(data?.result!=="success"||!Number.isFinite(rate)||rate<=0)throw new Error("Invalid USD/RUB rate");state.fxRateRub=rate;return rate;}catch(error){console.warn("[Kripto Guru] USD/RUB rate unavailable",error);state.fxRateRub=null;return null;}finally{clearTimeout(timer);}}
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
    const returningFromSubscreen=!$("#kg-asset-screen").hidden||!$("#kg-ticket-screen").hidden;
    state.screen=name;
    $$(".kg-screen").forEach(node=>node.classList.toggle("is-active",node.id==="kg-"+name+"-screen"));
    $$("#kg-nav button").forEach(node=>node.classList.toggle("is-active",node.dataset.screen===name));
    $("#kg-nav").hidden=false;
    $("#kg-asset-screen").hidden=true;
    $("#kg-ticket-screen").hidden=true;
    syncMarketPolling(returningFromSubscreen||name==="wallet");
    syncCandlePolling();
    if(tg?.BackButton){tg.BackButton.hide();tg.BackButton.offClick?.(handleNativeBack);}
  }
  function showSubscreen(name){
    marketLoadEpoch++;
    document.querySelectorAll(".kg-screen").forEach(node=>node.classList.remove("is-active"));
    $("#kg-nav").hidden=true;
    $("#kg-asset-screen").hidden=name!=="asset";
    $("#kg-ticket-screen").hidden=name!=="ticket";
    syncMarketPolling();
    if(name==="ticket")syncCandlePolling();
    if(tg?.BackButton){tg.BackButton.show();tg.BackButton.offClick?.(handleNativeBack);tg.BackButton.onClick(handleNativeBack);}
  }
  function handleNativeBack(){
    if(!$("#kg-ticket-screen").hidden){closeTicket();return;}
    if(!$("#kg-asset-screen").hidden){closeAsset();return;}
    setScreen(state.screen);
  }
  function marketMap(){return new Map([...state.markets,...state.futures].map(m=>[m.symbol||m.market,m]));}
  function quoteOf(m){const mark=Number(m?.markPriceUsd ?? m?.markPrice),mid=Number(m?.priceUsd ?? m?.price);return Number.isFinite(mark)&&mark>0?mark:Number.isFinite(mid)&&mid>0?mid:0;}
  function changeOf(m){return Number(m?.change24hPct ?? m?.changePct24h ?? m?.change24h);}
  function renderFavorites(){
    const map=marketMap();
    const fav=[...state.favorites].map(s=>map.get(s)).filter(Boolean).slice(0,8);
    $("#kg-favorites").innerHTML=fav.length?fav.map(m=>{
      const s=m.symbol||m.market, change=changeOf(m), price=quoteOf(m);
      const points=state.sparklineCache[s]||[];
      const path=points.length>1?points.map((v,i)=>`${i?"L":"M"}${(i/(points.length-1)*100).toFixed(1)} ${(20-(v-Math.min(...points))/(Math.max(...points)-Math.min(...points)||1)*16).toFixed(1)}`).join(" "):"";
      const chart=path?`<svg class="kg-sparkline" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="${change>=0?"#32ad70":"#e45a65"}" stroke-width="2"/></svg>`:'<div class="kg-sparkline kg-sparkline-empty" aria-hidden="true"></div>';
      const delta=Number.isFinite(price)&&Number.isFinite(change)?Math.abs(price*change/100):NaN; const sign=change>=0?"↑":"↓";
      return `<button class="kg-favorite" data-open-market="${esc(s)}" type="button"><div class="kg-fav-top"><span class="kg-asset-icon">${esc(iconFor(s))}</span><span class="kg-badge">${Number(m.maxLeverage||1)}×</span><span class="kg-fav-remove" data-remove-favorite="${esc(s)}" ${state.editFavorites?"":"hidden"}>×</span></div><b>${esc(s)}</b><strong>${priceMoney(price,m)}</strong><div class="kg-fav-change"><small class="${Number.isFinite(change)?(change>=0?"kg-change-up":"kg-change-down"):"kg-muted"}">${Number.isFinite(change)?sign+" "+fmt(Math.abs(change),2)+"%":"—"}</small><small class="${Number.isFinite(delta)?(change>=0?"kg-change-up":"kg-change-down"):"kg-muted"}">${Number.isFinite(delta)?(change>=0?"+":"−")+priceMoney(delta,m):"—"}</small></div>${chart}</button>`;
    }).join(""):'<div class="kg-empty-inline">Добавьте активы в избранное из списка рынка.</div>';
  }

  async function loadFavoriteSparklines(){
    const symbols=[...state.favorites].slice(0,8);
    await Promise.all(symbols.map(async symbol=>{
      try{
        const result=await invoke("market.candles",symbol,"1h");
        const candles=listOf(result,["candles","items"]);
        const points=candles.map(c=>Number(c.close??c.c??c.closePrice)).filter(Number.isFinite).slice(-24);
        if(points.length>1)state.sparklineCache[symbol]=points;
      }catch(error){console.debug("[Kripto Guru] Sparkline unavailable for",symbol,normalizeError(error).code);}
    }));
    renderFavorites();
  }
  function renderWalletAssets(){
    const assets=listOf(state.wallet,["assets","balances"]);
    $("#kg-wallet-assets").innerHTML=assets.length?assets.map(a=>{
      const s=a.symbol||a.asset||"";
      const balance=Number(a.valueUsd ?? a.balanceUsd ?? a.usdValue);
      return `<div class="kg-asset-row" ${s?`data-open-market="${esc(s)}"`:""}><span class="kg-asset-icon">${esc(iconFor(s))}</span><span class="kg-row-copy"><b>${esc(a.name||symbolName(s))}</b><small>${esc(s)}</small></span><strong class="kg-wallet-row-value">${moneyRub(balance)}</strong></div>`;
    }).join(""):'<div class="kg-empty-inline">Активы появятся здесь после зачисления на счёт.</div>';
  }
  function saveEquities(){try{localStorage.setItem("kg:equities:v1",JSON.stringify(state.equities));}catch{notify("Не удалось сохранить список на этом устройстве.");}}
  function renderWalletEquities(){
    const root=$("#kg-wallet-equities");if(!root)return;
    root.innerHTML=state.equities.length?state.equities.map(item=>{
      const symbol=item.symbol.toUpperCase();
      const logo=symbol==="AAPL"?'<span class="kg-asset-icon kg-brand-apple" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M16.7 12.8c0-2.1 1.7-3.1 1.8-3.2-1-1.5-2.6-1.7-3.2-1.7-1.4-.2-2.8.9-3.5.9-.7 0-1.8-.9-3-.9-1.6 0-3.1.9-3.9 2.3-1.7 2.9-.4 7.2 1.2 9.5.8 1.1 1.7 2.3 2.9 2.2 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.2 0 2-1.1 2.8-2.2.9-1.3 1.3-2.5 1.3-2.6-.1 0-2.4-.9-2.4-3.6ZM14.4 6.4c.6-.7 1-1.7.9-2.7-.9 0-1.9.6-2.5 1.3-.5.6-1 1.6-.9 2.6 1 .1 1.9-.5 2.5-1.2Z" fill="currentColor"/></svg></span>':'<span class="kg-asset-icon kg-equity-generic" aria-hidden="true">'+esc(symbol.slice(0,1))+'</span>';
      return '<div class="kg-asset-row kg-equity-row">'+logo+'<span class="kg-row-copy"><b>'+esc(item.name)+'</b><small>'+esc(symbol)+' · котировка недоступна</small></span><span class="kg-wallet-row-value">—</span>'+(state.editEquities?'<button class="kg-equity-remove" type="button" data-remove-equity="'+esc(symbol)+'" aria-label="Убрать '+esc(item.name)+'">−</button>':'')+'</div>';
    }).join(""):'<div class="kg-empty-inline">Добавьте акции и фонды, которыми хотите пользоваться.</div>';
    $("#kg-edit-equities").textContent=state.editEquities?"Готово":"Изменить";
    $("#kg-equities-add-wrap").hidden=!state.editEquities;
    root.classList.toggle("is-editing",state.editEquities);
  }
  const equityPresets=[{symbol:"AAPL",name:"Apple",kind:"Акция"},{symbol:"MSFT",name:"Microsoft",kind:"Акция"},{symbol:"NVDA",name:"NVIDIA",kind:"Акция"},{symbol:"TSLA",name:"Tesla",kind:"Акция"},{symbol:"AMZN",name:"Amazon",kind:"Акция"},{symbol:"GOOGL",name:"Alphabet",kind:"Акция"},{symbol:"SPY",name:"S&P 500 ETF",kind:"Фонд"},{symbol:"QQQ",name:"NASDAQ 100 ETF",kind:"Фонд"},{symbol:"VOO",name:"Vanguard S&P 500",kind:"Фонд"}];
  function openEquitiesEditor(){
    const root=$("#kg-equities-editor"),list=$("#kg-equities-presets");
    list.innerHTML=equityPresets.filter(p=>!state.equities.some(x=>x.symbol===p.symbol)).map(p=>'<button type="button" class="kg-equity-preset" data-add-equity="'+p.symbol+'"><span><b>'+esc(p.name)+'</b><small>'+p.symbol+' · '+p.kind+'</small></span><strong>＋</strong></button>').join("")||'<div class="kg-empty-inline">Все предложенные активы уже добавлены.</div>';
    root.hidden=false;$("#kg-equities-symbol").focus();
  }
  function addEquity(symbol,name,kind="Акция"){
    const normalized=String(symbol||"").trim().toUpperCase().replace(/[^A-Z0-9.^-]/g,"").slice(0,12);
    if(!normalized){notify("Введите корректный тикер.");return;}
    if(state.equities.some(x=>x.symbol===normalized)){notify("Этот актив уже есть в списке.");return;}
    const preset=equityPresets.find(x=>x.symbol===normalized);
    state.equities.push({symbol:normalized,name:name||preset?.name||normalized,kind:kind||preset?.kind||"Акция"});saveEquities();renderWalletEquities();openEquitiesEditor();notify("Актив добавлен.");
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
      return `<div class="kg-market-row"><span class="kg-asset-icon" data-open-market="${esc(s)}">${esc(iconFor(s))}</span><button class="kg-market-copy" data-open-market="${esc(s)}" type="button"><b>${esc(m.name||symbolName(s))} <small>${esc(s)}</small></b><small>Фьючерс · ${Number(m.maxLeverage||1)}×</small></button><div class="kg-market-price">${priceMoney(p,m)}<small class="${ch>=0?"kg-change-up":"kg-change-down"}">${pct(ch)}</small></div><button class="kg-fav-button" data-toggle-favorite="${esc(s)}" type="button" aria-label="Избранное">${state.favorites.has(s)?"★":"☆"}</button></div>`;
    }).join(""):'<div class="kg-empty-inline">По запросу ничего не найдено.</div>';
  }
  async function loadCategory(category){
    const requestId=++marketLoadEpoch;
    state.category=category;
    $$(".kg-category").forEach(b=>b.classList.toggle("is-selected",b.dataset.category===category));
    $$("#kg-search-filters button").forEach(b=>b.classList.toggle("is-selected",b.dataset.searchFilter===category));
    const live=$("#kg-market-live"),unavailable=$("#kg-market-unavailable");
    live.hidden=false;unavailable.hidden=true;
    try{
      const result=unwrap(await invoke("markets.list",{category}),"markets");
      if(requestId!==marketLoadEpoch||state.category!==category)return;
      const items=listOf(result,["markets","items"]);
      if(category==="futures") state.futures=items; else state.markets=items;
      const current=category==="futures"?state.futures:state.markets;
      $("#kg-market-title").textContent=category==="futures"?"Фьючерсы":"Все активы";
      markMarketFresh();
      renderMarketList(current);renderHeatmap(current);renderTopDay(current);renderFavorites();renderRecent();if(category==="crypto")loadFavoriteSparklines();
    }catch(error){
      if(requestId!==marketLoadEpoch||state.category!==category)return;
      const current=category==="futures"?state.futures:state.markets;
      if(current.length){markMarketStale();renderMarketList(current);renderHeatmap(current);renderTopDay(current);renderFavorites();renderRecent();}
      else{
        $("#kg-market-list").innerHTML='<div class="kg-empty-inline">'+esc(normalizeError(error).message)+'</div>';
        $("#kg-heatmap").innerHTML='<div class="kg-empty-inline">Нет данных рынка.</div>';
        $("#kg-top-day").innerHTML="";
        markMarketStale();
      }
    }
  }
  async function setSearchFilter(category){
    const requestId=++marketLoadEpoch;
    state.category=category;
    $$("#kg-search-filters button").forEach(b=>b.classList.toggle("is-selected",b.dataset.searchFilter===category));
    if(category==="all"){
      $("#kg-market-live").hidden=false;$("#kg-market-unavailable").hidden=true;
      try{
        const [cryptoResult,futuresResult]=await Promise.all([invoke("markets.list",{category:"crypto"}),invoke("markets.list",{category:"futures"})]);
        if(requestId!==marketLoadEpoch||state.category!==category)return;
        state.markets=listOf(unwrap(cryptoResult,"markets"),["markets","items"]);
        state.futures=listOf(unwrap(futuresResult,"markets"),["markets","items"]);
        const unique=new Map([...state.markets,...state.futures].map(m=>[m.symbol||m.market,m]));
        const all=[...unique.values()];
        $("#kg-market-title").textContent="Все активы";
        markMarketFresh();
        renderMarketList(all);renderHeatmap(all);renderTopDay(all);renderFavorites();renderRecent();
      }catch(error){
        if(requestId!==marketLoadEpoch||state.category!==category)return;
        const unique=new Map([...state.markets,...state.futures].map(m=>[m.symbol||m.market,m]));
        const all=[...unique.values()];
        if(all.length){markMarketStale();renderMarketList(all);renderHeatmap(all);renderTopDay(all);renderFavorites();renderRecent();}
        else{$("#kg-market-list").innerHTML='<div class="kg-empty-inline">'+esc(normalizeError(error).message)+'</div>';markMarketStale();}
      }
      return;
    }
    await loadCategory(category);
  }
  function markMarketFresh(){
    marketLastUpdatedAt=Date.now();
    const label=$("#kg-market-updated");
    if(label){label.textContent="Обновлено · "+new Date(marketLastUpdatedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});label.classList.remove("is-stale");}
  }
  function markMarketStale(){
    const label=$("#kg-market-updated");
    if(label){label.textContent=marketLastUpdatedAt?"Данные устарели · "+new Date(marketLastUpdatedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"Нет свежих котировок";label.classList.add("is-stale");}
  }
  function syncMarketPolling(refreshOnStart=false){
    const marketScreenActive=(state.screen==="wallet"||state.screen==="trading")&&$("#kg-asset-screen").hidden&&$("#kg-ticket-screen").hidden;
    const shouldPoll=document.visibilityState==="visible"&&marketScreenActive;
    if(shouldPoll){
      if(!marketRefreshTimer)marketRefreshTimer=setInterval(refreshMarketData,15000);
      if(refreshOnStart)void refreshMarketData();
    }else if(marketRefreshTimer){
      clearInterval(marketRefreshTimer);
      marketRefreshTimer=null;
    }
  }
  async function refreshMarketData(){
    if(document.visibilityState!=="visible"||!(state.screen==="wallet"||state.screen==="trading")||!$("#kg-asset-screen").hidden||!$("#kg-ticket-screen").hidden||$("#kg-market-live").hidden||marketRefreshInFlight)return;
    const category=state.category;
    const requestId=marketLoadEpoch;
    marketRefreshInFlight=true;
    try{
      if(category==="all"){
        const [cryptoResult,futuresResult]=await Promise.all([invoke("markets.list",{category:"crypto"}),invoke("markets.list",{category:"futures"})]);
        if(requestId!==marketLoadEpoch||state.category!==category)return;
        state.markets=listOf(unwrap(cryptoResult,"markets"),["markets","items"]);
        state.futures=listOf(unwrap(futuresResult,"markets"),["markets","items"]);
        const unique=new Map([...state.markets,...state.futures].map(m=>[m.symbol||m.market,m]));
        const all=[...unique.values()];
        renderMarketList(all);renderHeatmap(all);renderTopDay(all);renderFavorites();renderRecent();
      }else{
        const result=unwrap(await invoke("markets.list",{category}),"markets");
        if(requestId!==marketLoadEpoch||state.category!==category)return;
        const items=listOf(result,["markets","items"]);
        if(category==="futures")state.futures=items;else state.markets=items;
        renderMarketList(items);renderHeatmap(items);renderTopDay(items);renderFavorites();renderRecent();
      }
      markMarketFresh();
    }catch{
      if(requestId===marketLoadEpoch&&state.category===category)markMarketStale();
    }finally{marketRefreshInFlight=false;}
  }
  async function loadWallet(){
    try{
      state.wallet=unwrap(await invoke("wallet.get"),"wallet");
      const balanceUsd=Number(state.wallet.balanceUsd ?? state.wallet.balance ?? NaN),balanceRub=balanceUsd*Number(state.fxRateRub);const shownBalance=state.currencyMode==="USD"?balanceUsd:balanceRub;$("#kg-wallet-balance").innerHTML=Number.isFinite(shownBalance)?fmt(shownBalance)+(state.currencyMode==="USD"?' <span>USD</span>':' <span class="kg-ruble-symbol">₽</span>'):"—";
      $("#kg-wallet-currency-value").textContent=Number.isFinite(balanceUsd)?(state.currencyMode==="USD"?fmt(balanceUsd)+" $":(Number.isFinite(balanceRub)?fmt(balanceRub)+" ₽":"—")):"—";const currencySubtitle=$("#kg-wallet-currency .kg-card-copy small");if(currencySubtitle)currencySubtitle.textContent=Number.isFinite(state.fxRateRub)?"Курс: 1 $ = "+fmt(state.fxRateRub,2)+" ₽ · нажмите для смены валюты":"Курс доллара недоступен";
      const walletAssets=listOf(state.wallet,["assets","balances"]);
      const cryptoValues=walletAssets.map(asset=>Number(asset.valueUsd ?? asset.balanceUsd ?? asset.usdValue)).filter(Number.isFinite);
      const totalNode=$("#kg-wallet-crypto-total");
      if(totalNode)totalNode.textContent=cryptoValues.length?moneyRub(cryptoValues.reduce((sum,value)=>sum+value,0)):"—";
      renderWalletAssets();
      renderWalletEquities();
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
      if(c.bonuses?.available===true) $("#kg-bonus-reason").textContent="Программа бонусов доступна.";
      if(c.live?.available!==true) $(".kg-settings-note").textContent="Режим: ДЕМО. LIVE заблокирован.";
    }catch(error){console.warn("[Kripto Guru] capabilities unavailable",normalizeError(error));}
  }
  function normalizeCandle(c){
    const rawTime = Array.isArray(c) ? c[0] : (c?.time ?? c?.timestamp);
    const rawOpen = Array.isArray(c) ? c[1] : c?.open;
    const rawHigh = Array.isArray(c) ? c[2] : c?.high;
    const rawLow = Array.isArray(c) ? c[3] : c?.low;
    const rawClose = Array.isArray(c) ? c[4] : c?.close;

    const time = Number(rawTime);
    const open = Number(rawOpen);
    const high = Number(rawHigh);
    const low = Number(rawLow);
    const close = Number(rawClose);

    if (!Number.isFinite(time) || time <= 0) return null;
    if (![open, high, low, close].every(Number.isFinite)) return null;
    if ([open, high, low, close].some(value => value <= 0)) return null;
    if (high < Math.max(open, close) || low > Math.min(open, close)) return null;
    if (high < low) return null;

    return { time, open, high, low, close };
  }
  function drawCandles(candles){
    const data = (Array.isArray(candles) ? candles : [])
      .map(normalizeCandle)
      .filter(Boolean);

    const chart = $("#kg-chart");
    const wasAtEnd = chart.scrollWidth <= chart.clientWidth || chart.scrollLeft + chart.clientWidth >= chart.scrollWidth - 12;
    const previousScrollLeft = chart.scrollLeft;
    if (!data.length) {
      chart.innerHTML = '<div class="kg-empty-inline">Свечи для этого интервала недоступны.</div>';
      return;
    }

    const H = 200, top = 12, bottom = 172, rightMargin = 60;
    const chartWidth = Math.max(280, data.length * 12);
    const W = chartWidth + rightMargin;
    const lows = data.map(c => c.low);
    const highs = data.map(c => c.high);
    let min = Math.min(...lows);
    let max = Math.max(...highs);
    let range = max - min;
    if (range === 0) {
      const pad = max !== 0 ? Math.abs(max) * 0.01 : 1;
      min -= pad;
      max += pad;
      range = max - min;
    }

    const y = v => bottom - ((v - min) / range) * (bottom - top);
    const step = chartWidth / data.length;
    const body = Math.max(2, step * 0.48);

    const marks = data.map((c, i) => {
      const x = i * step + step / 2;
      const up = c.close >= c.open;
      const color = up ? "#20a96f" : "#e35562";
      const yt = y(Math.max(c.open, c.close));
      const yb = y(Math.min(c.open, c.close));
      const bodyHeight = Math.max(1, yb - yt);
      return `<line x1="${x}" y1="${y(c.high)}" x2="${x}" y2="${y(c.low)}" stroke="${color}" stroke-width="1.2"/><rect x="${x - body / 2}" y="${yt}" width="${body}" height="${bodyHeight}" rx=".7" fill="${color}"/>`;
    }).join("");

    const grid = [0, 0.25, 0.5, 0.75, 1].map(p => {
      const val = max - p * range;
      const yPos = top + (bottom - top) * p;
      const labelText = new Intl.NumberFormat("ru-RU", { maximumSignificantDigits: 7, useGrouping: true }).format(val);
      return `<line x1="0" y1="${yPos}" x2="${chartWidth}" y2="${yPos}" stroke="rgba(148,163,184,.24)" stroke-dasharray="3 4"/><text x="${chartWidth + 6}" y="${yPos + 3.5}" fill="#94a3b8" font-size="9" font-family="sans-serif">${esc(labelText)}</text>`;
    }).join("");

    const timeLabelsCount = Math.min(data.length, 4);
    const timeLabels = Array.from({ length: timeLabelsCount }, (_, i) => {
      const idx = Math.floor((i / (timeLabelsCount - 1 || 1)) * (data.length - 1));
      const c = data[idx];
      const xPos = idx * step + step / 2;
      const d = new Date(c.time > 1e12 ? c.time : c.time * 1000);
      const timeStr = Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return `<text x="${xPos}" y="${H - 4}" fill="#8e919b" font-size="9" font-family="sans-serif" text-anchor="middle">${esc(timeStr)}</text>`;
    }).join("");

    chart.innerHTML = `<svg width="${W}" height="${H}" style="width:${W}px;min-width:${W}px;max-width:none" viewBox="0 0 ${W} ${H}" role="img" aria-label="Свечной график">${grid}${marks}${timeLabels}</svg>`;
    chart.scrollLeft = wasAtEnd ? chart.scrollWidth : Math.min(previousScrollLeft, Math.max(0, chart.scrollWidth - chart.clientWidth));
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
      $("#kg-asset-price").textContent=priceMoney(Number(detail.priceUsd??detail.price),detail);
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
      syncCandlePolling();
    }catch(error){console.warn("[Kripto Guru] Asset open failed",error);notify(normalizeError(error).message);}
  }
  function syncCandlePolling(refreshOnStart=false){
    const active=document.visibilityState==="visible"&&!$("#kg-asset-screen").hidden&&$("#kg-ticket-screen").hidden&&Boolean(state.selectedMarket);
    if(active){
      if(!candleRefreshTimer)candleRefreshTimer=setInterval(refreshCandles,15000);
      if(refreshOnStart)void refreshCandles();
    }else{
      if(candleRefreshTimer){clearInterval(candleRefreshTimer);candleRefreshTimer=null;}
      candleLoadEpoch++;
    }
  }
  async function refreshCandles(){
    if(document.visibilityState!=="visible"||$("#kg-asset-screen").hidden||!$("#kg-ticket-screen").hidden||!state.selectedMarket||candleRefreshInFlight)return;
    const symbol=state.selectedMarket,interval=state.interval,requestId=++candleLoadEpoch;
    candleRefreshInFlight=true;
    try{
      const result=unwrap(await invoke("market.candles",symbol,interval),"candles");
      const candles=listOf(result,["candles","items"]);
      if(!candles.length)throw {message:"Свечи для выбранного интервала пока недоступны.",retryable:true};
      if(requestId!==candleLoadEpoch||symbol!==state.selectedMarket||interval!==state.interval||document.visibilityState!=="visible"||$("#kg-asset-screen").hidden||!$("#kg-ticket-screen").hidden)return;
      drawCandles(candles);
      const updated=new Date();
      $("#kg-chart-state").textContent="Обновлено "+updated.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
    }catch(error){
      if(requestId===candleLoadEpoch&&!$("#kg-asset-screen").hidden)$("#kg-chart-state").textContent="Ожидаем обновление";
    }finally{candleRefreshInFlight=false;}
  }
  async function loadCandles(interval){
    state.interval=interval;
    const requestId=++candleLoadEpoch,symbol=state.selectedMarket;
    document.querySelectorAll("#kg-timeframes button").forEach(b=>b.classList.toggle("is-selected",b.dataset.interval===interval));
    $("#kg-chart-state").textContent="Загрузка…";
    try{
      const result=unwrap(await invoke("market.candles",symbol,interval),"candles");
      const candles=listOf(result,["candles","items"]);
      if(!candles.length) throw {message:"Свечи для выбранного интервала пока недоступны.",retryable:true};
      if(requestId!==candleLoadEpoch||symbol!==state.selectedMarket||interval!==state.interval)return;
      drawCandles(candles);$("#kg-chart-state").textContent="Рыночные данные";
    }catch(error){
      if(requestId!==candleLoadEpoch)return;
      $("#kg-chart").innerHTML=`<div class="kg-empty-inline">${esc(normalizeError(error).message)}</div>`;$("#kg-chart-state").textContent="Нет данных";
    }
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
  function closeTicket(){state.previewSeq++;$("#kg-ticket-screen").hidden=true;$("#kg-asset-screen").hidden=false;syncCandlePolling(true);if(tg?.BackButton){tg.BackButton.show();tg.BackButton.offClick?.(handleNativeBack);tg.BackButton.onClick(handleNativeBack);}}
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
  function renderCompanionMode(){
    const status=$("#kg-ai-mode-status");
    if(status){
      status.hidden=state.companionMode==="general";
      status.textContent=state.companionMode==="learning"?"Учебный режим · пошаговое обучение":state.companionMode==="research"?"Исследование · проверяемые источники Google Search":"";
    }
    const learn=$('[data-ai-tool="learn"]'),research=$('[data-ai-tool="research"]');
    if(learn){learn.classList.toggle("is-selected",state.companionMode==="learning");learn.setAttribute("aria-pressed",String(state.companionMode==="learning"));}
    if(research){research.classList.toggle("is-selected",state.companionMode==="research");research.setAttribute("aria-pressed",String(state.companionMode==="research"));}
  }
  function renderCompanionMessages(){
    const root=$("#kg-ai-messages");
    if(!state.companionMessages.length){
      root.innerHTML='<div class="kg-ai-welcome"><div class="kg-gemini-spark" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M24 2.5C27.8 15.1 32.9 20.2 45.5 24 32.9 27.8 27.8 32.9 24 45.5 20.2 32.9 15.1 27.8 2.5 24 15.1 20.2 20.2 15.1 24 2.5Z"/></svg></div><b>Привет! Я Kripto Guru AI.</b><p>Что будем разбирать сегодня?</p></div>';
      return;
    }
    root.innerHTML=state.companionMessages.map(message=>{
      const sources=(Array.isArray(message.sources)?message.sources:[]).map(source=>{
        try{const url=new URL(source.url);if(url.protocol!=="https:")return "";return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(source.title||url.hostname)}</a>`;}catch{return "";}
      }).filter(Boolean).join("");
      const sourceBlock=sources?`<div class="kg-ai-sources"><b>Источники Google Search</b>${sources}</div>`:"";
      return `<div class="kg-ai-message ${message.role==="user"?"is-user":"is-assistant"}"><div>${esc(message.content).replace(/\n/g,"<br>")}</div>${sourceBlock}</div>`;
    }).join("");
    root.scrollTop=root.scrollHeight;
  }
  function renderCompanionHistory(){
    const root=$("#kg-ai-history");
    root.innerHTML=state.companionConversations.length?state.companionConversations.map(item=>`<div class="kg-ai-history-entry"><button type="button" class="kg-ai-history-item ${item.id===state.companionId?"is-selected":""}" data-ai-conversation="${esc(item.id)}"><span>${esc(item.title||"Новый диалог")}</span><small>${Number(item.messageCount)||0}</small></button><button type="button" class="kg-ai-history-delete" data-ai-delete="${esc(item.id)}" aria-label="Удалить диалог: ${esc(item.title||"Новый диалог")}" title="Удалить диалог">×</button></div>`).join(""):'<div class="kg-ai-history-empty">Здесь появятся ваши диалоги. Начните новый чат, чтобы сохранить историю.</div>';
  }
  async function deleteCompanionConversation(id){
    if(!id||state.companionBusy)return;
    state.companionBusy=true;
    try{
      const removedActive=state.companionId===id;
      await invoke("companion.remove",id);
      if(removedActive){state.companionId=null;state.companionMessages=[];renderCompanionMessages();}
      await loadCompanionConversations();
      // Release the delete lock before loading the next active conversation.
      if(removedActive&&state.companionConversations.length){
        state.companionBusy=false;
        await openCompanionConversation(state.companionConversations[0].id);
      }
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
      state.companionMode=conversation.mode||"general";
      renderCompanionMode();renderCompanionMessages();renderCompanionHistory();
    }catch(error){notify(normalizeError(error).message);}
  }
  function setCompanionMenu(open){
    const menu=$("#kg-ai-menu"),backdrop=$("#kg-ai-menu-backdrop"),trigger=$("#kg-ai-menu-open");
    menu.classList.toggle("is-open",open);
    menu.setAttribute("aria-hidden",String(!open));
    menu.inert=!open;
    backdrop.hidden=!open;
    trigger.setAttribute("aria-expanded",String(open));
  }
  function renderCompanionLimits(){
    const root=$("#kg-ai-limits-content"),limits=state.companionLimits;
    if(!limits){root.innerHTML='<span>Не удалось загрузить лимиты.</span>';return;}
    const rows=[
      ["Сообщений","до "+limits.messagesPerWindow+" за "+Math.round(limits.rateWindowSeconds/60)+" мин."],
      ["Длина сообщения",Number(limits.maxMessageChars).toLocaleString("ru-RU")+" символов"],
      ["История диалога","до "+limits.maxStoredMessages+" сообщений"],
      ["Контекст ответа","до "+limits.maxContextMessages+" сообщений"],
      ["Ответ ИИ","до "+limits.maxOutputTokens+" токенов"],
      ["Список диалогов","до "+limits.maxConversations]
    ];
    root.innerHTML=rows.map(([label,value])=>'<div class="kg-ai-limit-row"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong></div>').join("");
  }
  async function loadCompanionLimits(){
    try{state.companionLimits=await invoke("companion.limits");renderCompanionLimits();}
    catch{state.companionLimits=null;renderCompanionLimits();}
  }
  function newCompanionConversation(focus=true){
    state.companionId=null;state.companionMessages=[];state.companionAttachments=[];
    renderCompanionMode();renderCompanionMessages();renderCompanionAttachments();renderCompanionHistory();setCompanionMenu(false);
    if(focus)$("#kg-ai-input").focus();
  }
  function renderCompanionAttachments(){
    const root=$("#kg-ai-attachments");
    root.innerHTML=state.companionAttachments.map((file,index)=>'<div class="kg-ai-attachment-chip"><span>'+esc(file.name)+'</span><button type="button" data-remove-attachment="'+index+'" aria-label="Убрать вложение">×</button></div>').join("");
    root.hidden=!state.companionAttachments.length;
  }
  function fileToBase64(file){
    return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]||"");reader.onerror=()=>reject(new Error("Не удалось прочитать файл."));reader.readAsDataURL(file);});
  }
  async function addCompanionFiles(fileList){
    const allowed=/^(image\/(jpeg|png|webp|gif)|audio\/(mpeg|mp3|wav|aac|ogg|flac|webm|mp4|m4a)|video\/(mp4|webm))$/i;
    for(const file of [...fileList]){
      if(state.companionAttachments.length>=4){notify("Можно добавить не больше 4 файлов.");break;}
      if(!allowed.test(file.type)){notify("Поддерживаются изображения, аудио и видео MP4/WebM.");continue;}
      if(file.size>5*1024*1024){notify("Размер одного файла — максимум 5 МБ.");continue;}
      if(state.companionAttachments.some(x=>x.name===file.name&&x.size===file.size)){continue;}
      try{state.companionAttachments.push({name:file.name,size:file.size,mimeType:file.type,dataBase64:await fileToBase64(file)});renderCompanionAttachments();}
      catch(error){notify(error.message);}
    }
  }
  async function toggleCompanionRecording(){
    if(state.companionRecorder?.state==="recording"){state.companionRecorder.stop();return;}
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){notify("Запись аудио не поддерживается этим браузером. Разрешите доступ к микрофону или обновите Telegram.");return;}
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const types=["audio/mp4","audio/webm;codecs=opus","audio/ogg;codecs=opus"];
      const mimeType=types.find(type=>MediaRecorder.isTypeSupported?.(type))||"";
      const recorder=new MediaRecorder(stream,mimeType?{mimeType}:undefined);
      state.companionRecordChunks=[];
      recorder.ondataavailable=event=>{if(event.data?.size)state.companionRecordChunks.push(event.data);};
      recorder.onerror=()=>{stream.getTracks().forEach(track=>track.stop());state.companionRecorder=null;$("#kg-ai-voice").classList.remove("is-recording");notify("Не удалось записать аудио.");};
      recorder.onstop=async()=>{
        stream.getTracks().forEach(track=>track.stop());
        const blob=new Blob(state.companionRecordChunks,{type:recorder.mimeType||"audio/webm"});
        state.companionRecorder=null;$("#kg-ai-voice").classList.remove("is-recording");
        if(blob.size){const ext=blob.type.includes("mp4")?"m4a":blob.type.includes("ogg")?"ogg":"webm";await addCompanionFiles([new File([blob],"Голосовое сообщение."+ext,{type:blob.type})]);}
      };
      state.companionRecorder=recorder;recorder.start(250);$("#kg-ai-voice").classList.add("is-recording");notify("Идёт запись. Нажмите микрофон ещё раз, чтобы остановить.");
      window.setTimeout(()=>{if(state.companionRecorder===recorder&&recorder.state==="recording"){recorder.stop();notify("Запись остановлена (лимит 90 секунд).");}},90_000);
    }catch(error){notify(error?.name==="NotAllowedError"?"Разрешите доступ к микрофону в настройках Telegram.":"Не удалось включить микрофон: "+(error.message||"ошибка доступа"));}
  }
  async function sendCompanionMessage(event){
    event?.preventDefault();
    const input=$("#kg-ai-input"), message=input.value.trim();
    if((!message&&!state.companionAttachments.length)||state.companionBusy)return;
    state.companionBusy=true;$("#kg-ai-send").disabled=true;input.disabled=true;
    try{
      const result=await invoke("companion.send",message||"Проанализируй приложенные файлы.",state.companionId,state.companionAttachments.map(({name,mimeType,dataBase64})=>({name,mimeType,dataBase64})),state.companionMode);
      state.companionId=result.conversationId;
      state.companionMessages=result.conversation?.messages||[...state.companionMessages,{role:"user",content:message},{role:"assistant",content:result.answer}];
      input.value="";state.companionAttachments=[];renderCompanionAttachments();renderCompanionMessages();await loadCompanionConversations();
    }catch(error){notify(normalizeError(error).message);}
    finally{state.companionBusy=false;$("#kg-ai-send").disabled=false;input.disabled=false;input.focus();}
  }
  function openProfile(){
    const user=tg?.initDataUnsafe?.user||{};
    const first=typeof user.first_name==="string"?user.first_name.trim():"";
    const last=typeof user.last_name==="string"?user.last_name.trim():"";
    const name=[first,last].filter(Boolean).join(" ")||"Профиль Kripto Guru";
    const username=typeof user.username==="string"?user.username.trim():"";
    $("#kg-profile-name").textContent=name;
    $("#kg-profile-username").textContent=username?"@"+username:"";
    $("#kg-profile-username").hidden=!username;
    const avatar=$("#kg-profile-avatar");
    avatar.replaceChildren();
    let photoUrl="";
    try{const parsed=new URL(typeof user.photo_url==="string"?user.photo_url:"");if(parsed.protocol==="https:"&&(parsed.hostname==="t.me"||parsed.hostname==="telegram.org"))photoUrl=parsed.href;}catch{}
    if(photoUrl){
      const image=document.createElement("img");
      image.src=photoUrl;image.alt="";image.referrerPolicy="no-referrer";
      avatar.append(image);
    }else{
      const initials=[first,last].filter(Boolean).map(part=>Array.from(part)[0]||"").join("").slice(0,2).toUpperCase();
      avatar.textContent=initials||"KG";
    }
    $("#kg-profile-sheet").hidden=false;
    $("#kg-profile-backdrop").hidden=false;
    $("#kg-wallet-profile").setAttribute("aria-expanded","true");
    $("#kg-profile-close").focus();
  }
  function closeProfile(){
    $("#kg-profile-sheet").hidden=true;
    $("#kg-profile-backdrop").hidden=true;
    $("#kg-wallet-profile").setAttribute("aria-expanded","false");
    $("#kg-wallet-profile").focus();
  }
  function bind(){
    $("#kg-wallet-profile").addEventListener("click",openProfile);
    $("#kg-profile-close").addEventListener("click",closeProfile);
    $("#kg-profile-backdrop").addEventListener("click",closeProfile);
    $("#kg-wallet-currency").addEventListener("click",()=>{state.currencyMode=state.currencyMode==="USD"?"RUB":"USD";if(state.wallet){const balanceUsd=Number(state.wallet.balanceUsd ?? state.wallet.balance ?? NaN),balanceRub=balanceUsd*Number(state.fxRateRub),shown=state.currencyMode==="USD"?balanceUsd:balanceRub;$("#kg-wallet-balance").innerHTML=Number.isFinite(shown)?fmt(shown)+(state.currencyMode==="USD"?' <span>USD</span>':' <span class="kg-ruble-symbol">₽</span>'):"—";$("#kg-wallet-currency-value").textContent=Number.isFinite(balanceUsd)?(state.currencyMode==="USD"?fmt(balanceUsd)+" $":(Number.isFinite(balanceRub)?fmt(balanceRub)+" ₽":"—")):"—";}});
    $("#kg-wallet-ai").addEventListener("click",async()=>{setScreen("companion");await Promise.all([loadCompanionConversations(),loadCompanionLimits()]);state.companionInitialized=true;newCompanionConversation(false);});
    $$("#kg-nav button").forEach(button=>button.addEventListener("click",async()=>{
      setScreen(button.dataset.screen);
      if(state.screen==="wallet")await loadWallet();
      if(state.screen==="trading")await (state.category==="all"?setSearchFilter("all"):loadCategory(state.category));
      if(state.screen==="income"){await loadWallet();await loadHistory();}
      if(state.screen==="bonuses")await loadCapabilities();
      if(state.screen==="companion"){
         await Promise.all([loadCompanionConversations(),loadCompanionLimits()]);
         state.companionInitialized=true;
         newCompanionConversation(false);
       }
    }));
    $("#kg-ai-new").addEventListener("click",newCompanionConversation);
    $("#kg-ai-new-menu").addEventListener("click",newCompanionConversation);
    $("#kg-ai-menu-open").addEventListener("click",()=>setCompanionMenu(true));
    $("#kg-ai-menu-close").addEventListener("click",()=>setCompanionMenu(false));
    $("#kg-ai-menu-backdrop").addEventListener("click",()=>setCompanionMenu(false));
    $("#kg-ai-form").addEventListener("submit",sendCompanionMessage);
    const aiScreen=$("#kg-companion-screen"), aiInput=$("#kg-ai-input");
    const syncComposer=()=>{const focused=document.activeElement===aiInput;aiScreen.classList.toggle("kg-composer-expanded",focused||Boolean(aiInput.value));};
    aiInput.addEventListener("focus",()=>{syncComposer();});
    aiInput.addEventListener("blur",()=>{window.setTimeout(syncComposer,120);});
    aiInput.addEventListener("input",()=>{aiInput.style.height="auto";aiInput.style.height=Math.min(aiInput.scrollHeight,130)+"px";syncComposer();});
    if(window.visualViewport){const syncViewport=()=>{const keyboardOpen=document.activeElement===aiInput&&window.visualViewport.height<window.innerHeight-120;aiScreen.classList.toggle("kg-keyboard-open",keyboardOpen);$("#kg-nav").hidden=keyboardOpen;};window.visualViewport.addEventListener("resize",syncViewport);window.visualViewport.addEventListener("scroll",syncViewport);aiInput.addEventListener("focus",syncViewport);aiInput.addEventListener("blur",()=>{aiScreen.classList.remove("kg-keyboard-open");$("#kg-nav").hidden=false;});}
    $("#kg-ai-attach").addEventListener("click",()=>{$("#kg-ai-file-input").setAttribute("accept","image/jpeg,image/png,image/webp,image/gif,audio/*,video/mp4,video/webm");$("#kg-ai-file-input").click();});
    $("#kg-ai-file-input").addEventListener("change",event=>{addCompanionFiles(event.target.files||[]);event.target.value="";event.target.setAttribute("accept","image/jpeg,image/png,image/webp,image/gif,audio/*,video/mp4,video/webm");});
    $("#kg-ai-attachments").addEventListener("click",event=>{const button=event.target.closest("[data-remove-attachment]");if(!button)return;state.companionAttachments.splice(Number(button.dataset.removeAttachment),1);renderCompanionAttachments();});
    $("#kg-ai-voice").addEventListener("click",toggleCompanionRecording);
    $$(".kg-gemini-tools [data-ai-tool]").forEach(button=>button.addEventListener("click",()=>{
      const tool=button.dataset.aiTool,input=$("#kg-ai-file-input");
      if(tool==="learn"){
        state.companionMode=state.companionMode==="learning"?"general":"learning";
        newCompanionConversation(false);
        notify(state.companionMode==="learning"?"Учебный режим включён. Начнём с базовых понятий.":"Обычный режим включён.");
      }else if(tool==="research"){
        state.companionMode=state.companionMode==="research"?"general":"research";
        newCompanionConversation(false);
        notify(state.companionMode==="research"?"Режим исследования включён. Ответы будут показаны только с реальными источниками Google Search.":"Обычный режим включён.");
      }else if(tool==="image"){
        input.setAttribute("accept","image/jpeg,image/png,image/webp,image/gif");
        input.click();
      }else if(tool==="video"){
        input.setAttribute("accept","video/mp4,video/webm");
        input.click();
      }
    }));
    $("#kg-ai-input").addEventListener("keydown",event=>{
      if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();$("#kg-ai-form").requestSubmit();}
    });
    $("#kg-ai-history").addEventListener("click",event=>{
      const remove=event.target.closest("[data-ai-delete]");
      if(remove?.dataset.aiDelete){deleteCompanionConversation(remove.dataset.aiDelete);return;}
      const item=event.target.closest("[data-ai-conversation]");
      if(item?.dataset.aiConversation){setCompanionMenu(false);openCompanionConversation(item.dataset.aiConversation);}
    });
    $$("[data-open-trading]").forEach(b=>b.addEventListener("click",()=>{setScreen("trading");loadCategory("crypto");}));
    $$("[data-open-futures]").forEach(b=>b.addEventListener("click",()=>{setScreen("trading");loadCategory("futures");}));
    $$(".kg-category").forEach(b=>b.addEventListener("click",()=>loadCategory(b.dataset.category)));
    $("#kg-search-open").addEventListener("click",()=>{$("#kg-trading-screen").classList.add("kg-search-mode");$("#kg-search-open").hidden=true;$("#kg-market-search").hidden=false;$("#kg-search-close").hidden=false;$("#kg-search-filters").hidden=false;setSearchFilter("all");$("#kg-market-search").focus();});
    $("#kg-search-close").addEventListener("click",()=>{$("#kg-market-search").value="";$("#kg-trading-screen").classList.remove("kg-search-mode");$("#kg-search-filters").hidden=true;$("#kg-market-search").hidden=true;$("#kg-search-close").hidden=true;$("#kg-search-open").hidden=false;loadCategory("crypto");});
    $("#kg-market-search").addEventListener("input",()=>{
      clearTimeout(marketSearchTimer);
      marketSearchTimer=setTimeout(()=>renderMarketList(currentMarkets()),120);
    });
    $("#kg-market-search").addEventListener("keydown",event=>{
      if(event.key==="Enter"){clearTimeout(marketSearchTimer);renderMarketList(currentMarkets());}
      if(event.key==="Escape"){event.currentTarget.value="";clearTimeout(marketSearchTimer);renderMarketList(currentMarkets());}
    });
    if(!marketVisibilityListenerInstalled){
      document.addEventListener("visibilitychange",()=>{syncMarketPolling(true);syncCandlePolling(true);});
      marketVisibilityListenerInstalled=true;
    }
    $$("#kg-search-filters button").forEach(b=>b.addEventListener("click",()=>setSearchFilter(b.dataset.searchFilter)));
    $("#kg-market-search").addEventListener("keydown",e=>{if(e.key==="Escape")$("#kg-search-close").click();});
    $("#kg-recent-clear").addEventListener("click",()=>{state.recent=[];try{localStorage.removeItem("kg:recent:v1");}catch{}renderRecent();});
    $$("[data-sort]").forEach(b=>b.addEventListener("click",()=>{state.sort=b.dataset.sort;$$("[data-sort]").forEach(x=>x.classList.toggle("is-selected",x===b));renderTopDay(currentMarkets());}));
    document.addEventListener("click",event=>{
      const historyOpen=event.target.closest("[data-open-history]");
      if(historyOpen){setScreen("income");loadHistory();return;}
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
    $("#kg-edit-equities").addEventListener("click",()=>{state.editEquities=!state.editEquities;renderWalletEquities();});
    $("#kg-add-equity").addEventListener("click",openEquitiesEditor);
    $("#kg-equities-presets").addEventListener("click",event=>{const button=event.target.closest("[data-add-equity]");if(button){const preset=equityPresets.find(x=>x.symbol===button.dataset.addEquity);if(preset)addEquity(preset.symbol,preset.name,preset.kind);}});
    $("#kg-equities-custom-form").addEventListener("submit",event=>{event.preventDefault();const symbol=$("#kg-equities-symbol").value;addEquity(symbol,symbol.trim().toUpperCase());$("#kg-equities-symbol").value="";});
    $("#kg-equities-editor").addEventListener("click",event=>{if(event.target.closest("[data-close-equities]"))$("#kg-equities-editor").hidden=true;});
    $("#kg-wallet-equities").addEventListener("click",event=>{const button=event.target.closest("[data-remove-equity]");if(!button)return;state.equities=state.equities.filter(x=>x.symbol!==button.dataset.removeEquity);saveEquities();renderWalletEquities();});

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
    document.addEventListener("keydown",e=>{if(e.key==="Escape"){if(!$("#kg-confirm-screen").hidden||!$("#kg-leverage-screen").hidden)closeModals();else if(!$("#kg-ticket-screen").hidden)closeTicket();else if(!$("#kg-asset-screen").hidden)closeAsset();else if(!$("#kg-profile-sheet").hidden)closeProfile();else if($("#kg-ai-menu").classList.contains("is-open"))setCompanionMenu(false);}});
  }
  let started=false;
  let marketRefreshTimer=null;
  let candleRefreshTimer=null;
  let candleRefreshInFlight=false;
  let candleLoadEpoch=0;
  async function start(){
    if(started)return;
    started=true;
    try{tg?.ready?.();tg?.expand?.();tg?.setHeaderColor?.("#ffffff");tg?.setBackgroundColor?.("#f0f0f6");}catch{}
    bind();
    // Market quotes are the first screen's primary content. Start this request
    // immediately instead of waiting for FX, capabilities, history or wallet.
    const marketTask=loadCategory("crypto").catch(error=>{
      console.warn("[Kripto Guru] Initial market load failed",normalizeError(error).code);
    }).finally(()=>syncMarketPolling());
    await Promise.all([loadFxRate(),loadCapabilities(),loadHistory()]);
    await Promise.all([loadWallet(),marketTask]);

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
// Asset-detail presentation and DEMO order flow.
(() => {
  const $v = (selector, root=document) => root.querySelector(selector);
  const money = (value, digits=2) => Number(value || 0).toLocaleString("ru-RU",{minimumFractionDigits:digits,maximumFractionDigits:digits});
  const priceText = (value) => Number(value || 0).toLocaleString("ru-RU",{maximumFractionDigits:Number(value)>=1000?2:6});
  const safe = (value) => String(value ?? "").replace(/[&<>"]/g,(c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  const toUnits = (value, decimals) => {
    const text=String(value ?? "").trim().replace(",",".");
    const match=/^(\d+)(?:\.(\d+))?$/.exec(text);
    if(!match) throw new Error("Введите корректное положительное число.");
    if((match[2]||"").length>decimals) throw new Error("Слишком много знаков после запятой.");
    return BigInt(match[1])*(10n**BigInt(decimals))+BigInt((match[2]||"").padEnd(decimals,"0")||"0");
  };
  const fromPriceUnits = (value) => Number(BigInt(value || "0"))/100_000_000;
  const fromMoneyUnits = (value) => Number(BigInt(value || "0"))/1_000_000;
  const account = () => window.kriptoGuruDemo?.getAccount?.() || null;
  const activeMarket = () => typeof selectedMarket !== "undefined" ? selectedMarket : "";
  const contractFor = (market) => typeof contracts !== "undefined" ? contracts.find((item)=>item.market===market) : null;
  const currentPrice = (market) => Number(contractFor(market)?.price || window.kriptoGuruAssetMeta?.price || 0);
  const sideName = (side) => side==="long" ? "Лонг" : "Шорт";
  const sideSign = (side) => side==="long" ? 1 : -1;
  let ticketOverlay=null, quoteTimer=null, ticketState=null;

  function renderExistingPosition(box, market) {
    const position=account()?.positions?.find((item)=>item.symbol===market);
    if(!position) return;
    const price=currentPrice(market);
    const entry=fromPriceUnits(position.entryPrice);
    const qty=BigInt(position.qtyUnits||"0");
    const current=BigInt(Math.round(price*100_000_000));
    const delta=position.side==="long" ? current-BigInt(position.entryPrice) : BigInt(position.entryPrice)-current;
    const pnl=Number(qty*delta*1_000_000n/10_000_000_000_000_000n)/1_000_000;
    const margin=fromMoneyUnits(position.marginMicro);
    const card=document.createElement("div");
    card.className="asset-existing-position";
    card.innerHTML=`<div class="existing-position-top"><b>Ваша открытая позиция</b><span class="side-chip ${position.side}">${sideName(position.side)} ${safe(position.leverage)}×</span></div>
      <div class="existing-position-main"><strong class="${pnl>=0?"up":"down"}">${pnl>=0?"+":"−"}$${money(Math.abs(pnl))}</strong><span>Текущий результат</span></div>
      <div class="existing-position-meta"><span>Вход: <b>$${priceText(entry)}</b></span><span>Маржа: <b>$${money(margin)}</b></span></div>`;
    box.querySelector(".asset-chart-wrap")?.before(card);
  }

  function enhanceAsset() {
    const box=$v("#pair-detail");
    if(!box || box.classList.contains("hidden")) return;
    const actions=box.querySelector(".asset-actions");
    if(!actions || actions.dataset.enhanced==="1") return;
    actions.dataset.enhanced="1";
    const market=activeMarket();
    document.body.classList.add("asset-open");
    setTimeout(()=>window.scrollTo(0,0),0);

    const top=box.querySelector(".asset-topline");
    if(top && !$v("#asset-connection",top)){
      const connection=document.createElement("span");
      connection.id="asset-connection";
      const time=typeof lastQuoteUpdate!=="undefined" && lastQuoteUpdate ? lastQuoteUpdate.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "";
      connection.textContent=time ? "Обновлено "+time : "Нет связи с котировками";
      connection.className=time?"asset-connection updated":"asset-connection stale";
      top.insertBefore(connection,top.lastElementChild);
    }

    const about=box.querySelector(".asset-about");
    if(about){about.previousElementSibling?.remove();about.remove();}
    box.querySelector(".asset-chart-legend")?.remove();
    box.querySelector(".asset-note")?.remove();
    box.querySelector("#asset-grid-toggle")?.remove();
    box.querySelectorAll(".asset-tech .row").forEach((row)=>{
      if(/Минимальная маржа|Рекомендуемый диапазон/.test(row.textContent||"")) row.remove();
    });
    const contract=contractFor(market);
    const openInterest=contract?.openInterestUsd ?? contract?.openInterest;
    if(openInterest!==undefined && Number.isFinite(Number(openInterest))){
      const row=document.createElement("div");
      row.className="row";
      row.innerHTML="<span>Открытый интерес</span><b>"+(Number(openInterest)>1000?"$"+money(openInterest,0):"$"+priceText(openInterest))+"</b>";
      box.querySelector(".asset-tech")?.prepend(row);
    }
    const detailsTitle=[...box.querySelectorAll(".section-title")].find((node)=>node.textContent?.trim()==="Подробнее");
    if(detailsTitle) detailsTitle.textContent="Детали";

    const chartHead=box.querySelector(".chart-detail-head");
    if(chartHead && !$v("#asset-candle-caption",chartHead)){
      const caption=document.createElement("span");
      caption.id="asset-candle-caption";
      caption.textContent="Закрытие свечи";
      chartHead.append(caption);
    }

    const controls=box.querySelector(".asset-chart-controls");
    if(controls && !$v("#asset-chart-modes",controls)){
      const modes=document.createElement("div");
      modes.id="asset-chart-modes";
      modes.className="segmented-control asset-chart-modes";
      modes.innerHTML='<button type="button" class="'+(assetChartMode==="candles"?"selected":"")+'" data-chart-mode="candles">Свечи</button><button type="button" class="'+(assetChartMode==="line"?"selected":"")+'" data-chart-mode="line">Линия</button>';
      controls.append(modes);
      modes.addEventListener("click",(event)=>{
        const button=event.target.closest("[data-chart-mode]");
        if(!button) return;
        assetChartMode=button.dataset.chartMode;
        modes.querySelectorAll("button").forEach((item)=>item.classList.toggle("selected",item===button));
        const interval=box.querySelector("#pair-timeframes button.selected")?.dataset.interval || "15m";
        loadChart(market,"pair-chart",interval);
      });
    }

    renderExistingPosition(box,market);
    actions.remove();
    const tradeBar=document.createElement("div");
    tradeBar.id="asset-trade-bar";
    tradeBar.className="asset-trade-bar";
    tradeBar.innerHTML='<button type="button" class="primary-button long-button" data-asset-side="long">↗ Лонг</button><button type="button" class="primary-button short-button" data-asset-side="short">↘ Шорт</button>';
    document.body.append(tradeBar);
    tradeBar.addEventListener("click",(event)=>{
      const button=event.target.closest("[data-asset-side]");
      if(!button) return;
      const c=contractFor(market);
      openDemoTicket({market,side:button.dataset.assetSide,price:currentPrice(market),contract:c,maxLeverage:Number(window.kriptoGuruAssetMeta?.maxDemoLeverage||3)});
    });
  }

  const pairBox=$v("#pair-detail");
  if(pairBox){
    const observer=new MutationObserver(()=>enhanceAsset());
    observer.observe(pairBox,{childList:true,subtree:true});
    pairBox.addEventListener("click",(event)=>{
      if(event.target.closest("#asset-back") || event.target.closest("#asset-back-error")){
        setTimeout(()=>{
          document.body.classList.remove("asset-open");
          $v("#asset-trade-bar")?.remove();
        },0);
      }
    });
  }

  function liquidationPrice(entry, leverage, side){
    const mmr=.005, lev=Math.max(1,Number(leverage));
    return side==="long"
      ? entry*(1-1/lev+mmr)/(1-mmr)
      : entry*(1+1/lev-mmr)/(1+mmr);
  }
  function closePrice(value, mode, kind, side, entry, notional){
    if(value==="" || value==null) return null;
    const n=Number(String(value).replace(",","."));
    if(!Number.isFinite(n)||n<=0) throw new Error("Значение TP/SL должно быть положительным.");
    const direction=sideSign(side)*(kind==="tp"?1:-1);
    if(mode==="price") return n;
    if(mode==="usd" && notional<=0) throw new Error("Сначала укажите маржу и плечо.");
    const pct=mode==="percent"?n:(n/notional*100);
    return entry*(1+direction*pct/100);
  }
  function validateStops(state){
    const liq=liquidationPrice(state.price,state.leverage,state.side);
    const tp=closePrice(state.tpValue,state.closeMode,"tp",state.side,state.price,state.margin*state.leverage);
    const sl=closePrice(state.slValue,state.closeMode,"sl",state.side,state.price,state.margin*state.leverage);
    if(tp!==null && (state.side==="long" ? tp<=state.price : tp>=state.price))
      throw new Error("Тейк-профит должен находиться в прибыльной стороне от входа.");
    if(sl!==null && !(state.side==="long" ? liq<sl && sl<state.price : state.price<sl && sl<liq))
      throw new Error("Стоп-лосс должен находиться строго между ценой входа и ценой ликвидации.");
    return {liq,tp,sl};
  }
  function closeTicket(){
    if(quoteTimer) clearInterval(quoteTimer);
    quoteTimer=null;
    ticketOverlay?.remove();
    ticketOverlay=null;
    ticketState=null;
  }
  function showTicketToast(message){
    let toast=$v("#kg-toast");
    if(!toast){toast=document.createElement("div");toast.id="kg-toast";toast.className="kg-toast";document.body.append(toast);}
    toast.textContent=message;
    toast.classList.add("visible");
    setTimeout(()=>toast.classList.remove("visible"),2400);
  }
  function mountSheet(content){
    if(!ticketOverlay){
      ticketOverlay=document.createElement("div");
      ticketOverlay.className="sheet-backdrop";
      ticketOverlay.addEventListener("click",(event)=>{if(event.target===ticketOverlay) closeTicket();});
      document.body.append(ticketOverlay);
    }
    ticketOverlay.innerHTML='<section class="bottom-sheet" role="dialog" aria-modal="true">'+content+'</section>';
    ticketOverlay.querySelector(".sheet-close")?.addEventListener("click",closeTicket);
    ticketOverlay.querySelectorAll("[data-ticket-cancel]").forEach((button)=>button.addEventListener("click",closeTicket));
  }
  function renderTicketMain(){
    const s=ticketState, available=fromMoneyUnits(account()?.balanceMicro||"0");
    const volume=Number(s.margin||0)*s.leverage;
    mountSheet(`<div class="sheet-grabber"></div><div class="sheet-header"><h2>${sideName(s.side)} · ${safe(s.market)}</h2><button class="sheet-close" type="button" aria-label="Закрыть">×</button></div>
      <div class="ticket-market-chip">${sideName(s.side)} ${safe(s.market)} · <b id="ticket-live-price">$${priceText(s.price)}</b></div>
      <div class="ticket-amount-wrap"><span>$</span><input id="ticket-margin" class="number-input" type="number" inputmode="decimal" min="1" step="0.01" placeholder="0,00" value="${s.marginText}"><button id="ticket-leverage" class="sheet-chip" type="button">${s.leverage}×</button></div>
      <div class="ticket-volume">Объём: <b id="ticket-volume">$ ${money(volume)}</b></div>
      <div class="ticket-available">Доступно: <b>$${money(available)} USDT</b><button id="ticket-max" class="text-action" type="button">Макс</button></div>
      <div class="ticket-actions"><span class="sheet-chip">Оплата в долларах</span><button id="ticket-autoclose" class="sheet-chip" type="button">Автозакрытие</button></div>
      <div class="sheet-footer"><button id="ticket-check" class="primary-button full-width" type="button" disabled>Проверить</button></div>`);
    const input=$v("#ticket-margin",ticketOverlay), button=$v("#ticket-check",ticketOverlay);
    const update=()=>{
      s.marginText=input.value;
      const value=Number(input.value.replace(",","."));
      s.margin=Number.isFinite(value)?value:0;
      $v("#ticket-volume",ticketOverlay).textContent="Объём: $"+money(s.margin*s.leverage);
      const required=s.margin*(1+s.leverage*.00035);
      button.disabled=!(s.margin>=1 && required<=available);
      button.classList.toggle("disabled",button.disabled);
    };
    input.addEventListener("input",update);
    update();
    $v("#ticket-max",ticketOverlay).addEventListener("click",()=>{input.value=money(available/(1+s.leverage*.00035),2).replace(/\s/g,"").replace(",",".");update();});
    $v("#ticket-leverage",ticketOverlay).addEventListener("click",renderLeverageSheet);
    $v("#ticket-autoclose",ticketOverlay).addEventListener("click",renderAutoCloseSheet);
    button.addEventListener("click",()=>{try{validateStops(s);renderConfirmSheet();}catch(error){showTicketToast(error.message);}});
  }
  function renderLeverageSheet(){
    const s=ticketState, max=s.maxLeverage;
    const liq=liquidationPrice(s.price,s.leverage,s.side);
    mountSheet(`<div class="sheet-grabber"></div><div class="sheet-header"><h2>Плечо</h2><button class="sheet-close" type="button">×</button></div>
      <div class="leverage-value"><button id="lev-min" class="sheet-chip" type="button">Мин</button><strong id="lev-value">${s.leverage}×</strong><button id="lev-max" class="sheet-chip" type="button">Макс</button></div>
      <input id="lev-slider" class="leverage-range" type="range" min="1" max="${max}" step="1" value="${s.leverage}">
      <div class="leverage-scale"><span>1×</span><span>${max}×</span></div>
      <div class="sheet-info-row"><span>Цена ликвидации</span><b id="lev-liquidation">$${priceText(liq)}</b></div>
      <p class="sheet-hint">Оценочная цена. Не является гарантией цены ликвидации биржи.</p>
      <div class="sheet-footer"><button id="lev-apply" class="primary-button full-width" type="button">Применить</button></div>`);
    const slider=$v("#lev-slider",ticketOverlay);
    const update=()=>{s.leverage=Number(slider.value);$v("#lev-value",ticketOverlay).textContent=s.leverage+"×";$v("#lev-liquidation",ticketOverlay).textContent="$"+priceText(liquidationPrice(s.price,s.leverage,s.side));};
    slider.addEventListener("input",update);
    $v("#lev-min",ticketOverlay).addEventListener("click",()=>{slider.value="1";update();});
    $v("#lev-max",ticketOverlay).addEventListener("click",()=>{slider.value=String(max);update();});
    $v("#lev-apply",ticketOverlay).addEventListener("click",renderTicketMain);
  }
  function renderAutoCloseSheet(){
    const s=ticketState;
    const liq=liquidationPrice(s.price,s.leverage,s.side);
    mountSheet(`<div class="sheet-grabber"></div><div class="sheet-header"><h2>Автозакрытие</h2><button class="sheet-close" type="button">×</button></div>
      <div class="segmented-control" id="close-mode"><button data-close-mode="price" class="${s.closeMode==="price"?"selected":""}">Цена</button><button data-close-mode="percent" class="${s.closeMode==="percent"?"selected":""}">%</button><button data-close-mode="usd" class="${s.closeMode==="usd"?"selected":""}">$</button></div>
      <label class="sheet-field">Тейк-профит<input id="ticket-tp" type="number" inputmode="decimal" step="any" placeholder="${s.closeMode==="price"?"Цена TP":"Цель прибыли"}" value="${s.tpValue}"></label>
      <label class="sheet-field">Стоп-лосс<input id="ticket-sl" type="number" inputmode="decimal" step="any" placeholder="${s.closeMode==="price"?"Цена SL":"Допустимый убыток"}" value="${s.slValue}"></label>
      <div class="sheet-info-row"><span>Ожидаемый результат TP</span><b id="ticket-tp-result">—</b></div>
      <div class="sheet-info-row"><span>Ожидаемый результат SL</span><b id="ticket-sl-result">—</b></div>
      <div class="sheet-info-row"><span>Оценочная ликвидация</span><b>${priceText(liq)}</b></div>
      <p id="close-validation" class="sheet-hint">Стоп-лосс должен быть строго внутри цены входа и ликвидации.</p>
      <div class="sheet-footer"><button id="close-apply" class="primary-button full-width" type="button">Применить</button></div>`);
    ticketOverlay.querySelectorAll("[data-close-mode]").forEach((button)=>button.addEventListener("click",()=>{
      s.closeMode=button.dataset.closeMode;
      ticketOverlay.querySelectorAll("[data-close-mode]").forEach((item)=>item.classList.toggle("selected",item===button));
      renderAutoCloseSheet();
    }));
    const updatePreview=()=>{
      s.tpValue=$v("#ticket-tp",ticketOverlay).value;
      s.slValue=$v("#ticket-sl",ticketOverlay).value;
      const notional=s.margin*s.leverage;
      try {
        const tp=closePrice(s.tpValue,s.closeMode,"tp",s.side,s.price,notional);
        const sl=closePrice(s.slValue,s.closeMode,"sl",s.side,s.price,notional);
        const tpPnl=tp===null?null:notional*Math.abs(tp-s.price)/s.price;
        const slPnl=sl===null?null:-notional*Math.abs(sl-s.price)/s.price;
        $v("#ticket-tp-result",ticketOverlay).textContent=tpPnl===null?"—":"+$"+money(tpPnl);
        $v("#ticket-sl-result",ticketOverlay).textContent=slPnl===null?"—":"−$"+money(Math.abs(slPnl));
        $v("#close-validation",ticketOverlay).textContent="Стоп-лосс должен быть строго между входом и ликвидацией.";
        $v("#close-validation",ticketOverlay).classList.remove("down");
      } catch(error) {
        $v("#close-validation",ticketOverlay).textContent=error.message;
        $v("#close-validation",ticketOverlay).classList.add("down");
      }
    };
    $v("#ticket-tp",ticketOverlay).addEventListener("input",updatePreview);
    $v("#ticket-sl",ticketOverlay).addEventListener("input",updatePreview);
    updatePreview();
    $v("#close-apply",ticketOverlay).addEventListener("click",()=>{
      try{validateStops(s);renderTicketMain();}catch(error){$v("#close-validation",ticketOverlay).textContent=error.message;$v("#close-validation",ticketOverlay).classList.add("down");}
    });
  }
  function renderConfirmSheet(){
    const s=ticketState, available=fromMoneyUnits(account()?.balanceMicro||"0");
    const {liq,tp,sl}=validateStops(s);
    const marginMicro=toUnits(s.marginText,6);
    const notional=s.margin*s.leverage;
    const fee=notional*.00035;
    mountSheet(`<div class="sheet-grabber"></div><div class="sheet-header"><h2>Проверка сделки</h2><button class="sheet-close" type="button">×</button></div>
      <div class="confirm-side ${s.side}">${sideName(s.side)} · ${safe(s.market)}</div>
      <div class="confirm-price">$${priceText(s.price)}<small>Цена котировки</small></div>
      <div class="sheet-info-row"><span>Объём</span><b>$${money(notional)}</b></div>
      <div class="sheet-info-row"><span>Маржа</span><b>$${money(s.margin)}</b></div>
      <div class="sheet-info-row"><span>Плечо</span><b>${s.leverage}×</b></div>
      <div class="sheet-info-row"><span>Комиссия открытия · оценка</span><b>$${money(fee)}</b></div>
      <div class="sheet-info-row"><span>Цена ликвидации · оценка</span><b>$${priceText(liq)}</b></div>
      <div class="sheet-info-row"><span>Тейк-профит</span><b>${tp===null?"—":"$"+priceText(tp)}</b></div>
      <div class="sheet-info-row"><span>Стоп-лосс</span><b>${sl===null?"—":"$"+priceText(sl)}</b></div>
      <div class="sheet-footer confirm-actions"><button id="ticket-cancel" class="secondary-button" type="button">Отмена</button><button id="ticket-confirm" class="primary-button" type="button">Подтвердить</button></div>`);
    $v("#ticket-cancel",ticketOverlay).addEventListener("click",renderTicketMain);
    $v("#ticket-confirm",ticketOverlay).addEventListener("click",async(event)=>{
      const button=event.currentTarget;button.disabled=true;button.textContent="Открываем…";
      try{
        const payload={
          symbol:s.market,side:s.side,marginMicro:marginMicro.toString(),leverage:s.leverage,
          takeProfitPrice:tp===null?null:toUnits(tp.toFixed(8),8).toString(),
          stopLossPrice:sl===null?null:toUnits(sl.toFixed(8),8).toString()
        };
        await call("demo/open",payload);
        closeTicket();
        await window.kriptoGuruDemo?.refresh?.();
        document.body.classList.remove("asset-open");
        $v("#asset-trade-bar")?.remove();
        $v("#pair-detail")?.classList.add("hidden");
        document.querySelector('nav button[data-tab="painel"]')?.click();
        setTimeout(()=>{$v("#engine-positions")?.scrollIntoView({behavior:"smooth",block:"center"});},250);
        showTicketToast("Позиция открыта");
        tg.HapticFeedback?.notificationOccurred?.("success");
      }catch(error){
        showTicketToast(error.message);
        button.disabled=false;button.textContent="Подтвердить";
      }
    });
  }

  async function openDemoTicket(options){
    const market=options.market, side=options.side;
    closeTicket();
    try { await window.kriptoGuruDemo?.refresh?.(); } catch(error) { showTicketToast(error.message); return; }
    const c=contractFor(market)||options.contract||{};
    const available=fromMoneyUnits(account()?.balanceMicro||"0");
    const maxLeverage=Math.max(1,Math.min(Number(options.maxLeverage||3),Number(c.maxLeverage||options.maxLeverage||3)));
    ticketState={market,side,price:Number(options.price||c.price),margin:0,marginText:"",leverage:1,maxLeverage,tpValue:"",slValue:"",closeMode:"price"};
    renderTicketMain();
    if(quoteTimer) clearInterval(quoteTimer);
    quoteTimer=setInterval(async()=>{
      try{
        const result=await call("price",{market,leverage:ticketState.leverage});
        ticketState.price=Number(result.price);
        const node=$v("#ticket-live-price",ticketOverlay);
        if(node) node.textContent="$"+priceText(ticketState.price);
      }catch{}
    },5000);
  }
  window.openDemoTicket=openDemoTicket;

  document.addEventListener("keydown",(event)=>{if(event.key==="Escape" && ticketOverlay) closeTicket();});
})();

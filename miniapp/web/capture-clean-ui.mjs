import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root=path.resolve("miniapp/web");
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml"};
const server=http.createServer((req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,"http://127.0.0.1").pathname);
  const file=path.resolve(root,"."+pathname);
  if(!file.startsWith(root)){res.writeHead(403);res.end("Forbidden");return;}
  const target=pathname==="/" ? path.join(root,"index.html") : file;
  fs.readFile(target,(error,body)=>{
    if(error){res.writeHead(404);res.end("Not found");return;}
    res.writeHead(200,{"content-type":mime[path.extname(target)]||"application/octet-stream","cache-control":"no-store"});
    res.end(body);
  });
});
await new Promise(resolve=>server.listen(4173,"127.0.0.1",resolve));
const browser=await chromium.launch({headless:true});
const positions=[];
const history=[];
const marketData=[
  {symbol:"BTC",name:"Bitcoin",priceUsd:91240.5,change24hPct:2.42,volume24hUsd:8900000000,openInterestUsd:198750000,fundingRateHourlyPct:0.001,maxLeverage:50,takerFeePct:0.035,tradeable:true},
  {symbol:"ETH",name:"Ethereum",priceUsd:3120.2,change24hPct:-0.83,volume24hUsd:5200000000,openInterestUsd:92000000,fundingRateHourlyPct:-0.002,maxLeverage:30,takerFeePct:0.035,tradeable:true},
  {symbol:"SOL",name:"Solana",priceUsd:142.8,change24hPct:4.16,volume24hUsd:1900000000,openInterestUsd:61000000,fundingRateHourlyPct:0.001,maxLeverage:20,takerFeePct:0.04,tradeable:true}
];
const candles=Array.from({length:30},(_,i)=>{
  const base=91200+Math.sin(i*.55)*125+i*2.3;
  return {time:1700000000+i*900,open:base,high:base+38,low:base-31,close:base+(i%2?18:-12)};
});
try{
  for(const device of [{width:390,height:844},{width:430,height:932}]){
    const page=await browser.newPage({viewport:device,deviceScaleFactor:3,isMobile:true,hasTouch:true});
    const pageErrors=[];
    const consoleErrors=[];
    page.on("pageerror",error=>pageErrors.push(error.message));
    page.on("console",message=>{if(message.type()==="warning"||message.type()==="error")consoleErrors.push(message.text());});
    await page.route("https://telegram.org/js/telegram-web-app.js",route=>route.fulfill({status:200,contentType:"text/javascript",body:""}));
    await page.route("**/kripto-guru-api.js*",route=>route.fulfill({status:200,contentType:"text/javascript",body:""}));
    await page.addInitScript(()=>{
      try{
        if(location.origin!=="null"){
          localStorage.setItem("kg:favorites:v1",JSON.stringify(["BTC","ETH","SOL"]));
          localStorage.setItem("kg:recent:v1",JSON.stringify(["BTC","ETH"]));
        }
      }catch{}
      const mockPositions=[];
      const mockHistory=[];
      const companionHistory=[];
      window.__candleCalls=0;window.__candleIntervals=[];window.__marketListCalls=0;
      window.__productMode="demo";
      window.__lastTradeOpen=null;
      const markets=[
        {symbol:"BTC",name:"Bitcoin",priceUsd:91240.5,change24hPct:2.42,volume24hUsd:8900000000,openInterestUsd:198750000,fundingRateHourlyPct:0.001,maxLeverage:50,takerFeePct:0.035,tradeable:true},
        {symbol:"ETH",name:"Ethereum",priceUsd:3120.2,change24hPct:-0.83,volume24hUsd:5200000000,openInterestUsd:92000000,fundingRateHourlyPct:-0.002,maxLeverage:30,takerFeePct:0.035,tradeable:true},
        {symbol:"SOL",name:"Solana",priceUsd:142.8,change24hPct:4.16,volume24hUsd:1900000000,openInterestUsd:61000000,fundingRateHourlyPct:0.001,maxLeverage:20,takerFeePct:0.04,tradeable:true}
      ];
      const orderedCandles=Array.from({length:30},(_,i)=>{const base=91200+Math.sin(i*.55)*125+i*2.3;return {time:1700000000+i*900,open:base,high:base+38,low:base-31,close:base+(i%2?18:-12)};});const candles=[...orderedCandles].reverse();candles.push({...orderedCandles[10]});candles.push({...orderedCandles[5],high:0});
      window.Telegram={WebApp:{initData:"preview-only-init-data",ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},BackButton:{isVisible:false,handler:null,show(){this.isVisible=true;},hide(){this.isVisible=false;},onClick(fn){this.handler=fn;},offClick(fn){if(this.handler===fn)this.handler=null;},__trigger(){this.handler?.();}},HapticFeedback:{selectionChanged(){},impactOccurred(){},notificationOccurred(){}}}};
      window.KriptoGuruAPI={
        wallet:{async get(){return {mode:"demo",balanceUsd:1000,assets:[{symbol:"BTC",name:"Bitcoin",valueUsd:0},{symbol:"ETH",name:"Ethereum",valueUsd:0},{symbol:"SOL",name:"Solana",valueUsd:0}],positions:mockPositions.map(x=>({...x}))};}},
        markets:{async list({category}){window.__marketListCalls++;if(category==="stocks"||category==="funds")return {available:false,reason:"Проверенный источник котировок пока не подключён."};return {available:true,markets:markets.map(x=>({...x}))};}},
        market:{async get(symbol){const item=markets.find(x=>x.symbol===symbol);if(!item)throw {code:"NOT_FOUND",message:"Инструмент не найден"};return {...item,productType:"Фьючерс"};},async candles(symbol,interval){window.__candleCalls++;window.__candleIntervals.push(interval);return {candles};}},
        trade:{
          async preview({marginUsd,leverage}){return {valid:marginUsd>=10&&marginUsd<=50,available:marginUsd>=10&&marginUsd<=50,maxMarginUsd:50,minMarginUsd:10,priceUsd:91240.5,volumeUsd:marginUsd*leverage,entryFeeUsd:marginUsd*leverage*.00035,exitFeeUsd:marginUsd*leverage*.00035};},
          async open(payload){window.__lastTradeOpen={...payload};const p={id:"preview-position-1",symbol:payload.symbol,side:payload.side,marginUsd:payload.marginUsd,leverage:payload.leverage};mockPositions.push(p);mockHistory.unshift({event:"Открытие",symbol:p.symbol,side:p.side,timestamp:"Сейчас"});return {position:p};},
          async close(id){const i=mockPositions.findIndex(x=>x.id===id);if(i>=0){const p=mockPositions.splice(i,1)[0];mockHistory.unshift({event:"Закрытие",symbol:p.symbol,side:p.side,netPnlUsd:.37,timestamp:"Сейчас"});}return {closed:true};}
        },
        history:{async list(){return {events:mockHistory.map(x=>({...x}))};}},
        capabilities:{async get(){return {ipo:{available:false,reason:"Нет источника IPO"},stocks:{available:false},funds:{available:false},bonuses:{available:false},live:{available:false}};}},
        productMode:{async get(){return window.__productMode||"demo";},async set(mode){if(mode!=="demo"&&mode!=="ai")throw {code:"MODE_LOCKED",message:"LIVE заблокирован"};window.__productMode=mode;return {ok:true,productMode:mode};}},
        companion:{async list(){return companionHistory.map(x=>({...x}));},async get(id){return {id,messages:[{role:"user",content:"Привет"},{role:"assistant",content:"Здравствуйте!"}]};},async send(message,id){const conversationId=id||"preview-conversation-1";companionHistory.unshift({id:conversationId,title:message.slice(0,32),messageCount:2});return {conversationId,answer:"Тестовый ответ ИИ",conversation:{id:conversationId,messages:[{role:"user",content:message},{role:"assistant",content:"Тестовый ответ ИИ"}]}};},async remove(id){const index=companionHistory.findIndex(x=>x.id===id);if(index>=0)companionHistory.splice(index,1);return {ok:true};}},
      };
    });
    await page.goto("http://127.0.0.1:4173/",{waitUntil:"networkidle"});
    await page.waitForSelector("#kg-wallet-balance");
    try{
      await page.waitForFunction(()=>document.querySelector("#kg-wallet-balance")?.textContent.includes("₽"),null,{timeout:6000});
    }catch(error){
      const debug=await page.evaluate(()=>({apiReady:!!window.KriptoGuruAPI,uiReady:!!window.KriptoGuruUI,balance:document.querySelector("#kg-wallet-balance")?.textContent,body:document.body.innerText.slice(0,500)}));
      throw new Error("wallet API startup failed: "+JSON.stringify(debug)+" pageErrors="+pageErrors.join("; ")+" "+error.message);
    }
    await page.waitForFunction(()=>document.querySelectorAll("#kg-favorites .kg-favorite").length===3);
    if(await page.locator("#kg-favorites .kg-favorite").count()!==3)throw new Error("wallet should show three favorite markets");
    if(await page.locator("#kg-nav button").count()!==3)throw new Error("bottom navigation should have three tabs");
    const navOrder=await page.locator("#kg-nav button").evaluateAll(nodes=>nodes.map(node=>node.dataset.screen).join(","));
    if(navOrder!=="wallet,trading,companion")throw new Error("bottom navigation should contain wallet, trading, and AI Companion in that order");
    const navLabels=await page.locator("#kg-nav button small").allTextContents();
    if(navLabels.includes("Доход")||navLabels.includes("Бонусы"))throw new Error("Income and Bonuses must not appear in bottom navigation");
    if(!(await page.locator(".kg-wallet-hero").isVisible()))throw new Error("wallet balance hero must be visible on the first screen");
    const marketCallsBefore=await page.evaluate(()=>window.__marketListCalls);
    await page.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(before=>window.__marketListCalls>before,marketCallsBefore);

    if(!(await page.locator("#kg-product-mode").isVisible()))throw new Error("product mode selector must be visible on wallet home");
    if(!(await page.locator('[data-product-mode="live"]').isDisabled()))throw new Error("LIVE selector must remain disabled until full close contract is verified");
    await page.locator('[data-product-mode="ai"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-product-mode="ai"]')?.classList.contains("is-active"));
    if(!(await page.locator("#kg-product-mode-status").innerText()).includes("Автоматические сделки пока отключены"))throw new Error("AI Trading selector must disclose paper-only/no-auto-execution status");
    await page.screenshot({path:`clean-product-mode-ai-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator('[data-product-mode="demo"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-product-mode="demo"]')?.classList.contains("is-active"));

    if(!(await page.locator("#kg-wallet-quick-actions").isVisible()))throw new Error("wallet quick actions must be visible on the first screen");
    if(await page.locator("#kg-wallet-quick-actions button").count()!==4)throw new Error("wallet should show four reference quick actions");
    if(!(await page.locator("#kg-wallet-currency").isVisible()))throw new Error("wallet currency row should be visible");
    const walletOrder=await page.locator("#kg-wallet-screen").evaluate(el=>[...el.children].filter(x=>["kg-wallet-hero","kg-wallet-quick-actions","kg-wallet-currency"].some(id=>x.id===id||x.classList.contains(id))).slice(0,3).map(x=>x.className||x.id).join(","));
    if(!walletOrder.includes("kg-wallet-hero,kg-wallet-quick-actions,kg-wallet-currency"))throw new Error("wallet first-screen order is incorrect: "+walletOrder);
    await page.screenshot({path:`clean-wallet-${device.width}x${device.height}.png`,fullPage:false});
    const agentHeading=page.locator("#kg-wallet-screen .kg-section-head").filter({hasText:"Аккаунты ИИ-агента"});
    await agentHeading.evaluate(el=>el.scrollIntoView({block:"center",behavior:"instant"}));
    const agentLayout=await page.evaluate(()=>{
      const heading=[...document.querySelectorAll("#kg-wallet-screen .kg-section-head")].find(el=>el.innerText.includes("Аккаунты ИИ-агента"));
      const card=heading?.nextElementSibling?.getBoundingClientRect();
      const h=heading?.getBoundingClientRect();
      const nav=document.querySelector("#kg-nav").getBoundingClientRect();
      return {headingTop:h?.top,headingBottom:h?.bottom,cardTop:card?.top,cardBottom:card?.bottom,navTop:nav.top,viewportHeight:innerHeight,scrollY:scrollY};
    });
    if(agentLayout.scrollY<=0||agentLayout.headingTop<0||agentLayout.headingBottom>agentLayout.navTop-8||agentLayout.cardTop<agentLayout.headingBottom||agentLayout.cardBottom>agentLayout.navTop-8)throw new Error("AI-agent heading and full card must be reachable above fixed navigation: "+JSON.stringify(agentLayout));
    await page.screenshot({path:`clean-wallet-agent-${device.width}x${device.height}.png`,fullPage:false});
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
    const walletScrollCheck=await page.evaluate(()=>{
      const nav=document.querySelector("#kg-nav").getBoundingClientRect();
      const finalCard=document.querySelector("#kg-wallet-screen .kg-discover-list .kg-discover-card:last-child").getBoundingClientRect();
      return {scrollY:window.scrollY,navTop:nav.top,navBottom:nav.bottom,cardBottom:finalCard.bottom,viewportHeight:window.innerHeight};
    });
    if(walletScrollCheck.scrollY<=0)throw new Error("wallet screen should scroll to the final section");
    if(walletScrollCheck.navTop>=walletScrollCheck.viewportHeight||walletScrollCheck.navBottom>walletScrollCheck.viewportHeight)throw new Error("wallet bottom navigation must remain fixed inside the viewport");
    if(walletScrollCheck.cardBottom>walletScrollCheck.navTop-8)throw new Error("wallet final card is obscured by bottom navigation: "+JSON.stringify(walletScrollCheck));
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.locator('#kg-nav button[data-screen="trading"]').click();
    await page.waitForSelector("#kg-market-list .kg-market-row");
    await page.screenshot({path:`clean-catalog-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-search-open").click();
    await page.waitForSelector("#kg-search-filters:not([hidden])");
    const visibleSearchFilters=await page.locator("#kg-search-filters button:visible").count();
    if(visibleSearchFilters!==3)throw new Error("search must expose only crypto, futures and all filters; found "+visibleSearchFilters);
    if(await page.locator('[data-search-filter="stocks"]:visible,[data-search-filter="funds"]:visible').count())throw new Error("stocks and funds must be absent from search results");
    await page.locator('[data-search-filter="all"]').click();
    await page.waitForSelector("#kg-market-list .kg-market-row");
    await page.locator("#kg-market-search").fill("BTC");
    await page.waitForFunction(() => document.querySelectorAll("#kg-market-list .kg-market-row").length === 1, null, {timeout:3000});
    if(await page.locator("#kg-market-list .kg-market-row").count()!==1)throw new Error("all-market search should filter BTC once");
    await page.screenshot({path:`clean-search-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-search-close").click();
    if(await page.locator('[data-category="stocks"]:visible,[data-category="funds"]:visible').count())throw new Error("stocks and funds categories must be removed from product navigation");
    await page.locator('[data-category="futures"]').click();
    await page.waitForSelector('#kg-market-list [data-open-market="BTC"]');
    await page.evaluate(()=>{const native=window.setInterval.bind(window);window.setInterval=(callback,delay,...args)=>native(callback,delay===15000?100:delay,...args);});
    await page.locator('#kg-market-list [data-open-market="BTC"]').first().click();
    try{await page.waitForSelector("#kg-asset-screen:not([hidden])",{timeout:10000});}
    catch(error){const debug=await page.evaluate(()=>({toast:document.querySelector("#kg-toast")?.textContent,assetHidden:document.querySelector("#kg-asset-screen")?.hidden,selected:window.KriptoGuruUI?.state?.selectedMarket,screen:window.KriptoGuruUI?.state?.screen}));throw new Error("Asset open failed: "+JSON.stringify({debug,consoleErrors,pageErrors})+" "+error.message);}
    await page.waitForSelector("#kg-chart svg");
    const candleChart=await page.locator("#kg-chart").evaluate(el=>({scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,svgWidth:el.querySelector("svg")?.getBoundingClientRect().width,times:[...el.querySelectorAll("rect[data-time]")].map(node=>Number(node.dataset.time))}));
    if(!(candleChart.svgWidth>candleChart.clientWidth&&candleChart.scrollWidth>candleChart.clientWidth))throw new Error("candlestick history must scroll horizontally: "+JSON.stringify(candleChart));
    if(candleChart.times.length!==30||candleChart.times.some((time,index)=>index>0&&time<=candleChart.times[index-1]))throw new Error("candles must be valid, unique and sorted ascending: "+JSON.stringify(candleChart.times));
    for(const interval of ["1m","5m","15m","1h","4h","1d"]){
      await page.locator('#kg-timeframes [data-interval="'+interval+'"]').click();
      await page.waitForFunction(target=>window.__candleIntervals.at(-1)===target,interval,{timeout:3000});
    }
    await page.locator("#kg-chart").evaluate(el=>{el.scrollLeft=30;});
    const scrollBeforeRefresh=await page.locator("#kg-chart").evaluate(el=>el.scrollLeft);
    const initialCandleCalls=await page.evaluate(()=>window.__candleCalls);
    await page.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(previous=>window.__candleCalls>previous,initialCandleCalls,{timeout:3000});
    const scrollAfterRefresh=await page.locator("#kg-chart").evaluate(el=>el.scrollLeft);
    if(Math.abs(scrollAfterRefresh-scrollBeforeRefresh)>1)throw new Error("realtime candle refresh must preserve historical scroll position: "+JSON.stringify({scrollBeforeRefresh,scrollAfterRefresh}));
    if(!(await page.locator("#kg-asset-name").innerText()).includes("Bitcoin"))throw new Error("asset detail title missing");
    await page.screenshot({path:`clean-asset-${device.width}x${device.height}.png`,fullPage:false});
    const assetScreen=page.locator("#kg-asset-screen");
    await assetScreen.evaluate(el=>{el.scrollTop=el.scrollHeight;});
    const aboutLayout=await page.evaluate(()=>{
      const about=document.querySelector("#kg-asset-screen .kg-asset-about");
      const actions=document.querySelector("#kg-asset-screen .kg-asset-actions");
      const a=about.getBoundingClientRect();
      const b=actions.getBoundingClientRect();
      return {aboutTop:a.top,aboutBottom:a.bottom,actionsTop:b.top,viewportBottom:innerHeight,scrollTop:document.querySelector("#kg-asset-screen").scrollTop};
    });
    if(aboutLayout.scrollTop<=0||aboutLayout.aboutTop<0||aboutLayout.aboutBottom>aboutLayout.actionsTop+1)throw new Error("asset about section must be fully reachable above fixed trade actions: "+JSON.stringify(aboutLayout));
    await page.screenshot({path:`clean-asset-about-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-long").click();
    await page.waitForSelector("#kg-ticket-screen:not([hidden])");
    await page.waitForTimeout(250);
    const pausedCandleCalls=await page.evaluate(()=>window.__candleCalls);
    await page.waitForTimeout(250);
    if(await page.evaluate(()=>window.__candleCalls)!==pausedCandleCalls)throw new Error("candlestick polling must pause while the ticket screen is open");
    if(!(await page.evaluate(()=>document.activeElement?.id==="kg-ticket-margin")))throw new Error("ticket amount input should autofocus during the user gesture");
    await page.locator("#kg-ticket-autoclose").click();
    if(await page.locator("#kg-ticket-autoclose").getAttribute("aria-pressed")!=="true")throw new Error("auto-close toggle must enable");
    if(!(await page.locator("#kg-ticket-autoclose-fields").isVisible()))throw new Error("auto-close target fields must be visible");
    await page.locator("#kg-ticket-tp").fill("5");
    await page.locator("#kg-ticket-sl").fill("2");
    await page.locator("#kg-ticket-max").click();
    await page.waitForFunction(()=>document.querySelector("#kg-ticket-margin")?.value==="50");
    await page.waitForFunction(()=>document.querySelector("#kg-ticket-check")?.disabled===false);
    if(await page.locator("#kg-ticket-margin").inputValue()!=="50")throw new Error("Max must use the server-approved margin cap, not the full demo balance");
    const volumeText=await page.locator("#kg-ticket-volume").innerText();
    if(!volumeText.startsWith("Объём: $"))throw new Error("ticket volume label should appear exactly once: "+volumeText);
    const autoClosePreview=await page.locator("#kg-ticket-preview").innerText();
    if(!autoClosePreview.includes("TP $")||!autoClosePreview.includes("SL $"))throw new Error("auto-close targets must appear in ticket preview: "+autoClosePreview);
    await page.screenshot({path:`clean-ticket-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-ticket-leverage").click();
    await page.waitForSelector("#kg-leverage-screen:not([hidden])");
    await page.screenshot({path:`clean-leverage-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-lev-max").click();
    await page.locator("#kg-lev-apply").click();
    await page.locator("#kg-ticket-check").click();
    await page.waitForSelector("#kg-confirm-screen:not([hidden])");
    await page.screenshot({path:`clean-confirm-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-trade-confirm").click();
    const submittedAutoClose=await page.evaluate(()=>window.__lastTradeOpen);
    if(Math.abs(Number(submittedAutoClose?.takeProfitUsd)-91240.5*1.05)>0.02||Math.abs(Number(submittedAutoClose?.stopLossUsd)-91240.5*.98)>0.02)throw new Error("DEMO trade must receive the configured TP/SL prices: "+JSON.stringify(submittedAutoClose));
    await page.waitForSelector("#kg-asset-screen:not([hidden])");
    const candleCallsBeforeResume=await page.evaluate(()=>window.__candleCalls);
    await page.waitForFunction(previous=>window.__candleCalls>previous,candleCallsBeforeResume,{timeout:3000});
    await page.locator("#kg-asset-history-all").click();
    await page.waitForSelector("#kg-income-screen.is-active");
    await page.waitForSelector(".kg-position");
    const missingPnl=page.locator(".kg-position-pnl").first();
    if((await missingPnl.innerText()).trim()!=="—")throw new Error("missing position PnL must render as an em dash");
    if(!(await missingPnl.evaluate(el=>el.classList.contains("kg-muted"))))throw new Error("missing position PnL must use neutral styling");
    await page.screenshot({path:`clean-income-history-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator('#kg-nav button[data-screen="companion"]').click();
    await page.waitForSelector("#kg-companion-screen.is-active");
    await page.waitForSelector("#kg-companion-screen .kg-ai-welcome");
    await page.waitForFunction(()=>getComputedStyle(document.querySelector("#kg-nav")).display!=="none");
    if(!(await page.locator("#kg-ai-input").isVisible()))throw new Error("AI Companion composer must be visible on the home screen");
    if(!(await page.locator("#kg-companion-screen .kg-ai-welcome").isVisible()))throw new Error("AI Companion welcome must be visible on the home screen");
    await page.screenshot({path:`clean-companion-home-${device.width}x${device.height}.png`,fullPage:false});

    // Playwright cannot open the native iOS keyboard. Emulate the reduced app viewport
    // and draw a test-only iOS-style keyboard so the screenshot represents both states.
    await page.locator("#kg-ai-input").focus();
    await page.waitForFunction(()=>document.querySelector("#kg-companion-screen").classList.contains("kg-composer-expanded"));
    await page.evaluate(()=>{
      document.querySelector("#kg-companion-screen").classList.add("kg-keyboard-open");
      const style=document.createElement("style");
      style.id="kg-test-keyboard-style";
      style.textContent=`
        #kg-companion-screen.kg-keyboard-open{height:calc(100dvh - 280px)!important;min-height:calc(100dvh - 280px)!important}
        #kg-test-keyboard{position:fixed;z-index:1000;right:0;bottom:0;left:0;height:280px;box-sizing:border-box;padding:8px 5px 20px;background:#d5d8df;border-top:1px solid #c5c9d1;color:#252a33;font:13px -apple-system,BlinkMacSystemFont,sans-serif}
        #kg-test-keyboard .kg-test-kb-toolbar{display:flex;justify-content:space-between;align-items:center;height:26px;padding:0 8px;color:#606775;font-size:11px}
        #kg-test-keyboard .kg-test-kb-row{display:flex;justify-content:center;gap:4px;margin:7px 0}
        #kg-test-keyboard .kg-test-kb-key{display:grid;place-items:center;flex:1;min-width:0;height:39px;border-radius:5px;background:#fff;box-shadow:0 1px 0 #aeb3bc;font-size:16px}
        #kg-test-keyboard .kg-test-kb-key.kg-test-kb-wide{flex:1.45;background:#b9bec8;font-size:13px}
        #kg-test-keyboard .kg-test-kb-key.kg-test-kb-space{flex:5}
      `;
      document.head.appendChild(style);
      const keyboard=document.createElement("div");
      keyboard.id="kg-test-keyboard";
      keyboard.setAttribute("aria-hidden","true");
      const row=(keys,wide=[])=>'<div class="kg-test-kb-row">'+keys.map(key=>'<span class="kg-test-kb-key '+(wide.includes(key)?"kg-test-kb-wide":"")+'">'+key+'</span>').join("")+'</div>';
      keyboard.innerHTML='<div class="kg-test-kb-toolbar"><span>◉</span><span>Русский</span><span>🎙</span></div>'+
        row(["Й","Ц","У","К","Е","Н","Г","Ш","Щ","З","Х"])+
        row(["Ф","Ы","В","А","П","Р","О","Л","Д","Ж","Э"])+
        row(["⇧","Я","Ч","С","М","И","Т","Ь","Б","Ю","⌫"],["⇧","⌫"])+
        row(["123","😊","Пробел","↵"],["123","😊","↵"]);
      keyboard.querySelector(".kg-test-kb-row:last-child .kg-test-kb-key:nth-child(3)").classList.add("kg-test-kb-space");
      document.body.appendChild(keyboard);
    });
    if(await page.locator(".kg-gemini-tools").evaluate(el=>getComputedStyle(el).display)!=="none")throw new Error("Gemini tool shortcuts must hide while the keyboard is open");
    if(await page.locator("#kg-nav").evaluate(el=>getComputedStyle(el).display)==="none")throw new Error("bottom navigation must remain visible while the keyboard is open");
    const composerAboveKeyboard=await page.evaluate(()=>{
      const composer=document.querySelector("#kg-ai-form").getBoundingClientRect();
      const keyboard=document.querySelector("#kg-test-keyboard").getBoundingClientRect();
      return composer.bottom<=keyboard.top+1;
    });
    if(!composerAboveKeyboard)throw new Error("AI composer must remain above the on-screen keyboard");
    await page.screenshot({path:`clean-companion-keyboard-${device.width}x${device.height}.png`,fullPage:false});
    await page.evaluate(()=>{document.querySelector("#kg-test-keyboard")?.remove();document.querySelector("#kg-test-keyboard-style")?.remove();document.querySelector("#kg-companion-screen").classList.remove("kg-keyboard-open");document.querySelector("#kg-ai-input").blur();});
    await page.locator("#kg-ai-input").fill("Проверь связь");
    await page.locator("#kg-ai-send").click();
    try{
      await page.waitForFunction(()=>document.querySelector("#kg-ai-messages")?.innerText.includes("Тестовый ответ ИИ"),null,{timeout:6000});
    }catch(error){
      const debug=await page.evaluate(()=>({
        apiReady:!!window.KriptoGuruAPI,
        companionMethods:Object.keys(window.KriptoGuruAPI?.companion||{}),
        input:document.querySelector("#kg-ai-input")?.value,
        sendDisabled:document.querySelector("#kg-ai-send")?.disabled,
        messages:document.querySelector("#kg-ai-messages")?.innerText,
        toast:document.querySelector("#kg-toast")?.innerText,
        history:document.querySelector("#kg-ai-history")?.innerText
      }));
      throw new Error("AI Companion send failed: "+JSON.stringify(debug)+" pageErrors="+pageErrors.join("; ")+" "+error.message);
    }
    if(!(await page.locator("#kg-ai-messages").innerText()).includes("Проверь связь"))throw new Error("AI Companion should render the sent user message");
    await page.screenshot({path:`clean-companion-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-ai-menu-open").click();
    await page.waitForSelector("#kg-ai-menu.is-open");
    await page.locator("#kg-ai-history [data-ai-delete]").first().click();
    await page.waitForFunction(()=>document.querySelectorAll("#kg-ai-history [data-ai-conversation]").length===0);
    if(!(await page.locator("#kg-ai-messages").innerText()).includes("Привет! Я Kripto Guru AI."))throw new Error("deleting the active AI conversation should reset the chat view");
    if(pageErrors.length)throw new Error("browser errors: "+pageErrors.join("; "));
    await page.close();
  }
}finally{
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}

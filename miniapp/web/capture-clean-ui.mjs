// PR #695: capture the current-main two-level mode hierarchy and theme-safe surfaces.
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
function contrastRatio(foreground,background){
  const luminance=value=>{
    const channels=value.match(/[0-9a-f]{2}/gi)?.map(part=>parseInt(part,16)/255)||[];
    if(channels.length!==3)return 0;
    const linear=channels.map(channel=>channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4);
    return linear[0]*.2126+linear[1]*.7152+linear[2]*.0722;
  };
  const values=[luminance(foreground),luminance(background)].sort((a,b)=>b-a);
  return (values[0]+.05)/(values[1]+.05);
}
async function assertMutedContrast(page,theme){
  const result=await page.evaluate(()=>{
    const style=getComputedStyle(document.documentElement);
    return Object.fromEntries(["--kg-muted","--kg-bg","--kg-card","--kg-surface-2"].map(key=>[key,style.getPropertyValue(key).trim()]));
  });
  const foreground=result["--kg-muted"];
  for(const key of ["--kg-bg","--kg-card","--kg-surface-2"]){
    const ratio=contrastRatio(foreground,result[key]);
    if(ratio<4.5)throw new Error(theme+" muted text contrast below WCAG AA on "+key+": "+ratio.toFixed(2)+" ("+foreground+" / "+result[key]+")");
  }
}
async function captureDarkVariant(page,name,device){
  await page.evaluate(()=>{const select=document.querySelector("#kg-profile-theme-select");select.value="dark";select.dispatchEvent(new Event("change",{bubbles:true}));const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";});
  await page.waitForTimeout(240); // allow the intentional 180ms glass-surface transition to finish before asserting computed colors
  const colors=await page.evaluate(()=>{
    const root=getComputedStyle(document.documentElement);
    const currency=document.querySelector(".kg-wallet-currency");
    return {
      bg:root.getPropertyValue("--kg-bg").trim().toLowerCase(),
      card:root.getPropertyValue("--kg-card").trim().toLowerCase(),
      body:getComputedStyle(document.body).backgroundColor,
      surface:currency?getComputedStyle(currency).backgroundColor:null
    };
  });
  const composerBackground=await page.evaluate(()=>getComputedStyle(document.querySelector("#kg-ai-form")).backgroundColor);
  const composerChannels=composerBackground.match(/[0-9.]+/g)?.slice(0,3).map(Number)||[];
  if(composerChannels.length!==3||composerChannels.reduce((sum,value)=>sum+value,0)/3>90){
    const debug=await page.evaluate(()=>({theme:document.documentElement.dataset.theme,preference:document.documentElement.dataset.themePreference,saved:localStorage.getItem("kg:theme:v1"),glass:getComputedStyle(document.documentElement).getPropertyValue("--kg-glass"),composer:getComputedStyle(document.querySelector("#kg-ai-form")).backgroundColor,darkSelector:!!document.querySelector('html[data-theme="dark"]')}));
    throw new Error("Dark theme Companion composer must use a dark surface: "+composerBackground+" debug="+JSON.stringify(debug));
  }
  if(colors.bg!=="#000000"||colors.card!=="#1c1c1e"||colors.body!=="rgb(0, 0, 0)"||colors.surface!=="rgb(28, 28, 30)"){
    throw new Error("Dark theme token/surface mismatch: "+JSON.stringify(colors));
  }
  await assertMutedContrast(page,"dark");
  await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-${name}-dark-${device.width}x${device.height}.png`,fullPage:false});
  await page.evaluate(()=>{const select=document.querySelector("#kg-profile-theme-select");select.value="light";select.dispatchEvent(new Event("change",{bubbles:true}));const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";});
  await page.waitForTimeout(240);
  await assertMutedContrast(page,"light");
}
const marketData=[
  {symbol:"BTC",name:"Bitcoin",priceUsd:91240.5,change24hPct:2.42,volume24hUsd:8900000000,openInterestUsd:198750000,fundingRateHourlyPct:0.001,maxLeverage:50,takerFeePct:0.035,tradeable:true},
  {symbol:"ETH",name:"Ethereum",priceUsd:3120.2,change24hPct:-0.83,volume24hUsd:5200000000,openInterestUsd:92000000,fundingRateHourlyPct:-0.002,maxLeverage:30,takerFeePct:0.035,tradeable:true},
  {symbol:"SOL",name:"Solana",priceUsd:142.8,change24hPct:4.16,volume24hUsd:1900000000,openInterestUsd:61000000,fundingRateHourlyPct:0.001,maxLeverage:20,takerFeePct:0.04,tradeable:true}
];
try{
  for(const device of [{width:360,height:800},{width:375,height:812},{width:390,height:844},{width:430,height:932}]){
    const page=await browser.newPage({viewport:device,deviceScaleFactor:3,isMobile:true,hasTouch:true});
    const pageErrors=[];
    const consoleErrors=[];
    page.on("pageerror",error=>pageErrors.push(error.message));
    page.on("console",message=>{if(message.type()==="warning"||message.type()==="error")consoleErrors.push(message.text());});
    await page.route("**/telegram-web-app.js*",route=>route.fulfill({status:200,contentType:"text/javascript",body:""}));
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
      const mockAiPaperOpen=Array.from({length:12},(_,i)=>({id:"paper-open-"+i,symbol:["BTC","ETH","SOL"][i%3],side:i%2?"short":"long",status:"open",entry_price:"9124050000000",margin_micro:"10000000",leverage:"2",opened_at:Date.now()-i*60000,closed_at:null}));
      const mockAiPaperClosed=Array.from({length:12},(_,i)=>({id:"paper-closed-"+i,symbol:["BTC","ETH","SOL"][i%3],side:i%2?"short":"long",status:"closed",entry_price:"9124050000000",margin_micro:"10000000",leverage:"2",opened_at:Date.now()-3600000-i*60000,closed_at:Date.now()-i*30000}));
      const mockAiPaperDecisions=Array.from({length:12},(_,i)=>({id:"paper-decision-"+i,symbol:["BTC","ETH","SOL"][i%3],signal:i%3===0?"buy":i%3===1?"sell":"hold",rationale:i===0?"<img src=x onerror=alert(1)>":"Тестовое решение "+i,riskPass:i%2===0,rejectionReason:i%2?"Ограничение риска":null,observedPrice:"9124050000000",createdAt:Date.now()-i*30000}));
      window.__aiPaperStatus="stopped";window.__aiPaperStartCalls=0;window.__aiPaperStopCalls=0;
      window.__candleCalls=0;window.__candleIntervals=[];window.__marketListCalls=0;
      window.__productMode="demo";
      window.__lastTradeOpen=null;
      const markets=[
        {symbol:"BTC",name:"Bitcoin",priceUsd:91240.5,change24hPct:2.42,volume24hUsd:8900000000,openInterestUsd:198750000,fundingRateHourlyPct:0.001,maxLeverage:50,takerFeePct:0.035,tradeable:true},
        {symbol:"ETH",name:"Ethereum",priceUsd:3120.2,change24hPct:-0.83,volume24hUsd:5200000000,openInterestUsd:92000000,fundingRateHourlyPct:-0.002,maxLeverage:30,takerFeePct:0.035,tradeable:true},
        {symbol:"SOL",name:"Solana",priceUsd:142.8,change24hPct:4.16,volume24hUsd:1900000000,openInterestUsd:61000000,fundingRateHourlyPct:0.001,maxLeverage:20,takerFeePct:0.04,tradeable:true}
      ];
      const orderedCandles=Array.from({length:30},(_,i)=>{const base=91200+Math.sin(i*.55)*125+i*2.3;return {time:1700000000+i*900,open:base,high:base+38,low:base-31,close:base+(i%2?18:-12),volume:1200+i*35};});const candles=[...orderedCandles].reverse();candles.push({...orderedCandles[10]});candles.push({...orderedCandles[5],high:0});
      window.Telegram={WebApp:{initData:"preview-only-init-data",ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},BackButton:{isVisible:false,handler:null,calls:{show:0,hide:0,onClick:0,offClick:0},show(){this.calls.show++;this.isVisible=true;},hide(){this.calls.hide++;this.isVisible=false;},onClick(fn){this.calls.onClick++;this.handler=fn;},offClick(fn){this.calls.offClick++;if(this.handler===fn)this.handler=null;},__trigger(){this.handler?.();}},HapticFeedback:{selectionChanged(){},impactOccurred(){},notificationOccurred(){}}}};
      window.KriptoGuruAPI={
        wallet:{async get(){return {mode:"demo",balanceUsd:1000,assets:[{symbol:"BTC",name:"Bitcoin",valueUsd:0},{symbol:"ETH",name:"Ethereum",valueUsd:0},{symbol:"SOL",name:"Solana",valueUsd:0}],positions:mockPositions.map(x=>({...x}))};}},
        markets:{async list({category}){window.__marketListCalls++;if(category==="stocks"||category==="funds")return {available:false,reason:"Проверенный источник котировок пока не подключён."};return {available:true,markets:markets.map(x=>({...x}))};}},
        market:{async get(symbol){const item=markets.find(x=>x.symbol===symbol);if(!item)throw {code:"NOT_FOUND",message:"Инструмент не найден"};return {...item,productType:"Фьючерс"};},async candles(symbol,interval){window.__candleCalls++;window.__candleIntervals.push(interval);window.__mockCandleVolumes=candles.slice(0,2).map(item=>item.volume);return {candles};}},
        trade:{
          async preview({marginUsd,leverage}){return {valid:marginUsd>=10&&marginUsd<=50,available:marginUsd>=10&&marginUsd<=50,maxMarginUsd:50,minMarginUsd:10,priceUsd:91240.5,volumeUsd:marginUsd*leverage,entryFeeUsd:marginUsd*leverage*.00035,exitFeeUsd:marginUsd*leverage*.00035};},
          async open(payload){window.__lastTradeOpen={...payload};const p={id:"preview-position-1",symbol:payload.symbol,side:payload.side,marginUsd:payload.marginUsd,leverage:payload.leverage};mockPositions.push(p);mockHistory.unshift({event:"Открытие",symbol:p.symbol,side:p.side,timestamp:"Сейчас"});return {position:p};},
          async close(id){const i=mockPositions.findIndex(x=>x.id===id);if(i>=0){const p=mockPositions.splice(i,1)[0];mockHistory.unshift({event:"Закрытие",symbol:p.symbol,side:p.side,netPnlUsd:.37,timestamp:"Сейчас"});}return {closed:true};}
        },
        history:{async list(){return {events:mockHistory.map(x=>({...x}))};}},
        capabilities:{async get(){return {ipo:{available:false,reason:"Нет источника IPO"},stocks:{available:false},funds:{available:false},bonuses:{available:false},live:{available:false}};}},
        productMode:{async get(){return window.__productMode||"demo";},async set(mode){if(mode!=="demo"&&mode!=="ai")throw {code:"MODE_LOCKED",message:"LIVE заблокирован"};window.__productMode=mode;return {ok:true,productMode:mode};}},
        aiPaper:{
          async status(){return {demoBalanceUsd:window.__aiDemoBalance??1000,balanceUsd:window.__aiPaperBalance??100,openPositions:mockAiPaperOpen.length,status:window.__aiPaperStatus};},
          async fund({amountUsd,idempotencyKey}){const amount=Number(amountUsd);if(!(amount>0)||amount>(window.__aiDemoBalance??1000))throw {code:"VALIDATION_ERROR",message:"Недостаточно виртуальных средств DEMO"};const keys=window.__aiTransferKeys??(window.__aiTransferKeys={});if(keys[idempotencyKey])return keys[idempotencyKey];window.__aiDemoBalance=(window.__aiDemoBalance??1000)-amount;window.__aiPaperBalance=(window.__aiPaperBalance??100)+amount;return keys[idempotencyKey]={ok:true};},
          async withdraw({amountUsd,idempotencyKey}){const amount=Number(amountUsd);if(!(amount>0)||amount>(window.__aiPaperBalance??100))throw {code:"VALIDATION_ERROR",message:"Недостаточно средств на AI paper-счёте"};const keys=window.__aiTransferKeys??(window.__aiTransferKeys={});if(keys[idempotencyKey])return keys[idempotencyKey];window.__aiPaperBalance=(window.__aiPaperBalance??100)-amount;window.__aiDemoBalance=(window.__aiDemoBalance??1000)+amount;return keys[idempotencyKey]={ok:true};},
          async start(){window.__aiPaperStartCalls++;window.__aiPaperStatus="active";return {status:"active"};},
          async stop(){window.__aiPaperStopCalls++;window.__aiPaperStatus="stopped";return {status:"stopped"};},
          async positions({status="open",limit=10}={}){const rows=status==="closed"?mockAiPaperClosed:mockAiPaperOpen;return {positions:rows.slice(0,limit).map(row=>({...row}))};},
          async decisions({limit=10}={}){return {decisions:mockAiPaperDecisions.slice(0,limit).map(row=>({...row}))};}
        },
        companion:{async list(){return companionHistory.map(x=>({id:x.id,title:x.title,messageCount:x.messageCount}));},async get(id){const item=companionHistory.find(x=>x.id===id);return item?.conversation||{id,messages:[{role:"user",content:"Привет"},{role:"assistant",content:"Здравствуйте!"}]};},async send(message,id,attachments=[],mode="general",requestId){const conversationId=id||"preview-conversation-1";const conversation={id:conversationId,messages:[{role:"user",content:message},{role:"assistant",content:"Тестовый ответ ИИ"}]};const item={id:conversationId,title:message.slice(0,32),messageCount:2,conversation};const index=companionHistory.findIndex(x=>x.id===conversationId);if(index>=0)companionHistory[index]=item;else companionHistory.unshift(item);return {ok:true,state:"queued",conversationId,requestId};},async status(conversationId,requestId){return {ok:true,requestId,state:"completed",response:{answer:"Тестовый ответ ИИ",sources:[]}};},async remove(id){const index=companionHistory.findIndex(x=>x.id===id);if(index>=0)companionHistory.splice(index,1);return {ok:true};}},
      };
    });
    await page.goto("http://127.0.0.1:4173/",{waitUntil:"networkidle"});
    if(await page.locator("#kg-companion-screen .kg-gemini-model").evaluate(node=>node.tagName)!=="SPAN")throw new Error("Single available AI model must be a static label, not an inert selector");
    const walletShortcuts=await page.locator("#kg-wallet-quick-actions button").evaluateAll(nodes=>nodes.map(node=>node.dataset.walletShortcut));
    if(walletShortcuts.join(",")!=="trading,income,agents,virtual-transfer")throw new Error("Wallet quick actions must be real navigation shortcuts, not fake money operations: "+walletShortcuts.join(","));
    if(await page.locator("#kg-wallet-quick-actions [data-wallet-action]").count())throw new Error("Fake real-money actions must not be rendered");
    const viewport=await page.evaluate(()=>({width:window.innerWidth,scrollWidth:document.documentElement.scrollWidth}));
    if(viewport.scrollWidth>viewport.width+1)throw new Error("Unexpected horizontal page overflow at "+device.width+"px: "+JSON.stringify(viewport));
    await page.waitForSelector("#kg-wallet-balance");
    try{await page.waitForFunction(()=>document.querySelector("#kg-market-updated")?.textContent.includes("Обновлено"),null,{timeout:8000});}
    catch(error){const debug=await page.evaluate(()=>({updated:document.querySelector("#kg-market-updated")?.textContent,apiReady:!!window.KriptoGuruAPI,marketCalls:window.__marketListCalls,toast:document.querySelector("#kg-toast")?.textContent,marketList:document.querySelector("#kg-market-list")?.innerText,theme:document.documentElement.dataset.theme}));throw new Error("Initial market freshness label missing: "+JSON.stringify(debug)+" pageErrors="+pageErrors.join("; ")+" "+error.message);}
    const freshnessLabel=await page.locator("#kg-market-updated").innerText();
    if(!/^Обновлено · \d{2}:\d{2}:\d{2}$/.test(freshnessLabel))throw new Error("Market freshness time must use Russian 24-hour format: "+freshnessLabel);
    if(await page.evaluate(()=>document.documentElement.dataset.theme)!=="dark")throw new Error("New installs must default to dark theme");
    if(await page.evaluate(()=>document.documentElement.dataset.themePreference)!=="dark")throw new Error("Default theme preference must be dark");
    await page.locator("#kg-wallet-profile").click();
    await page.waitForSelector("#kg-profile-sheet:not([hidden])");
    await page.locator("#kg-profile-theme-select").selectOption("light");
    if(await page.evaluate(()=>document.documentElement.dataset.theme)!=="light")throw new Error("Light theme selection must apply immediately");
    await page.locator("#kg-profile-theme-select").selectOption("system");
    await page.emulateMedia({colorScheme:"dark"});
    await page.waitForFunction(()=>document.documentElement.dataset.theme==="dark");
    await page.emulateMedia({colorScheme:"light"});
    await page.waitForFunction(()=>document.documentElement.dataset.theme==="light");
    await page.locator("#kg-profile-theme-select").selectOption("light");
    await page.evaluate(()=>window.Telegram.WebApp.BackButton.handler?.());
    const walletBackState=await page.evaluate(()=>({visible:window.Telegram.WebApp.BackButton.isVisible,handler:typeof window.Telegram.WebApp.BackButton.handler,profileHidden:document.querySelector("#kg-profile-sheet").hidden}));
    if(!walletBackState.profileHidden||walletBackState.visible||walletBackState.handler!=="object")throw new Error("closing a standalone profile sheet must hide and detach Telegram BackButton: "+JSON.stringify(walletBackState));
    // Theme preference changes intentionally show a transient confirmation toast.
    // Dismiss it in the screenshot harness so it cannot obscure the wallet preview.
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";});
    await page.waitForTimeout(200);
    if(await page.locator("#kg-toast.is-visible").count())throw new Error("Transient toast must not cover clean UI screenshots");
    await page.reload({waitUntil:"networkidle"});
    await page.waitForSelector("#kg-wallet-balance");
    const persistedTheme=await page.evaluate(()=>({theme:document.documentElement.dataset.theme,preference:document.documentElement.dataset.themePreference,saved:localStorage.getItem("kg:theme:v1")}));
    if(persistedTheme.theme!=="light"||persistedTheme.preference!=="light"||persistedTheme.saved!=="light")throw new Error("Theme preference must persist after reload: "+JSON.stringify(persistedTheme));
    try{
      await page.waitForFunction(()=>document.querySelector("#kg-wallet-balance")?.textContent.includes("₽"),null,{timeout:6000});
    }catch(error){
      const debug=await page.evaluate(()=>({apiReady:!!window.KriptoGuruAPI,uiReady:!!window.KriptoGuruUI,balance:document.querySelector("#kg-wallet-balance")?.textContent,body:document.body.innerText.slice(0,500)}));
      throw new Error("wallet API startup failed: "+JSON.stringify(debug)+" pageErrors="+pageErrors.join("; ")+" "+error.message);
    }
    await page.waitForFunction(()=>document.querySelectorAll("#kg-favorites .kg-favorite").length===3);
    if(await page.locator("#kg-favorites .kg-favorite").count()!==3)throw new Error("wallet should show three favorite markets");
    if(await page.locator("#kg-nav button").count()!==4)throw new Error("bottom navigation should have four tabs");
    const navOrder=await page.locator("#kg-nav button").evaluateAll(nodes=>nodes.map(node=>node.dataset.screen).join(","));
    if(navOrder!=="wallet,trading,agents,companion")throw new Error("bottom navigation should contain wallet, trading, agents, and AI Companion in that order");
    const navLabels=await page.locator("#kg-nav button small").allTextContents();
    if(navLabels.includes("Доход")||navLabels.includes("Бонусы"))throw new Error("Income and Bonuses must not appear in bottom navigation");
    if(!(await page.locator(".kg-wallet-hero").isVisible()))throw new Error("wallet balance hero must be visible on the first screen");
    const marketCallsBefore=await page.evaluate(()=>window.__marketListCalls);
    await page.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(before=>window.__marketListCalls>before,marketCallsBefore);

    if(!(await page.locator("#kg-market-mode").isVisible()))throw new Error("top-level market mode selector must be visible on wallet home");
    if(await page.locator("#kg-market-mode [data-market-mode]").count()!==2)throw new Error("only DEMO and LIVE may exist as top-level market modes");
    if(!(await page.locator('[data-market-mode="demo"]').evaluate(node=>node.classList.contains("is-active"))))throw new Error("DEMO must be the active top-level market mode");
    if(!(await page.locator('[data-market-mode="live"]').isDisabled()))throw new Error("LIVE selector must remain disabled until full close contract is verified");
    if(!(await page.locator("#kg-product-mode").isVisible()))throw new Error("trading method selector must be visible on wallet home");
    if(await page.locator("#kg-product-mode [data-product-mode]").count()!==2)throw new Error("only Manual and AI Piper may exist as trading methods");
    if(await page.locator('[data-product-mode="ai"] b').innerText()!=="AI Piper")throw new Error("AI trading method must be labelled AI Piper");
    if(await page.locator('[data-product-mode="ai"] small').innerText()!=="Автономный DEMO")throw new Error("AI Piper subtitle must identify its DEMO scope");
    await page.locator('[data-product-mode="ai"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-product-mode="ai"]')?.classList.contains("is-active"));
    const aiModeStatus=await page.locator("#kg-product-mode-status").innerText();
    if(!aiModeStatus.includes("DEMO · AI Piper")||!aiModeStatus.includes("виртуальные средства"))throw new Error("AI Piper must disclose DEMO-only virtual funds");
    await page.waitForFunction(()=>document.querySelector("#kg-ai-paper-status-note")?.textContent.includes("Состояние из защищённого API"));
    if(!(await page.locator(".kg-ai-paper-transfer").isVisible()))throw new Error("AI paper virtual funding controls should be visible in AI mode");
    await page.locator("#kg-ai-paper-amount").fill("25");
    await page.locator("#kg-ai-paper-fund").click();
    await page.waitForFunction(()=>document.querySelector("#kg-ai-paper-transfer-note")?.textContent.includes("перевод из DEMO выполнен"));
    if(!(await page.locator("#kg-ai-paper-balance").innerText()).includes("125"))throw new Error("AI paper balance did not update after virtual funding");
    if(!(await page.locator("#kg-ai-paper-demo-balance").innerText()).includes("975"))throw new Error("DEMO balance did not decrease after virtual funding");
    await page.locator("#kg-ai-paper-amount").fill("10");
    await page.locator("#kg-ai-paper-withdraw").click();
    await page.waitForFunction(()=>document.querySelector("#kg-ai-paper-transfer-note")?.textContent.includes("возвращены в DEMO"));
    if(!(await page.locator("#kg-ai-paper-balance").innerText()).includes("115"))throw new Error("AI paper balance did not update after virtual withdrawal");
    if(!(await page.locator("#kg-ai-paper-demo-balance").innerText()).includes("985"))throw new Error("DEMO balance did not increase after virtual withdrawal");
    await page.evaluate(()=>{window.__aiPaperBalance=0;});
    await page.locator('[data-product-mode="demo"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-product-mode="demo"]')?.classList.contains("is-active"));
    if(!(await page.locator("#kg-ai-paper-start").isDisabled()))throw new Error("AI PAPER start must be disabled outside AI mode");
    await page.locator('[data-product-mode="ai"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-product-mode="ai"]')?.classList.contains("is-active"));
    if(!(await page.locator("#kg-ai-paper-start").isDisabled()))throw new Error("AI PAPER start must be disabled when virtual balance is zero");
    await page.evaluate(()=>{window.__aiPaperBalance=115;});
    await page.locator('[data-product-mode="demo"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-product-mode="demo"]')?.classList.contains("is-active"));
    await page.locator('[data-product-mode="ai"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-product-mode="ai"]')?.classList.contains("is-active"));
    if(!(await page.locator("#kg-ai-paper-start").isEnabled())||!(await page.locator("#kg-ai-paper-start").isVisible()))throw new Error("AI PAPER start must be enabled in AI mode with positive virtual balance");
    if(await page.locator("#kg-ai-paper-stop").isVisible())throw new Error("AI PAPER Stop must be hidden before a session starts");
    await page.locator("#kg-ai-paper-start").click();
    await page.waitForFunction(()=>document.querySelector("#kg-ai-paper-status")?.textContent==="Активна");
    if(!(await page.locator("#kg-ai-paper-stop").isVisible())||await page.locator("#kg-ai-paper-start").isVisible())throw new Error("Start must activate session and expose Stop only");
    const paperLists=await page.evaluate(()=>({
      open:document.querySelectorAll("#kg-ai-paper-open-list .kg-ai-paper-history-item").length,
      closed:document.querySelectorAll("#kg-ai-paper-closed-list .kg-ai-paper-history-item").length,
      decisions:document.querySelectorAll("#kg-ai-paper-decisions-list .kg-ai-paper-history-item").length,
      injected:document.querySelectorAll("#kg-ai-paper-decisions-list img").length,
      rationale:document.querySelector("#kg-ai-paper-decisions-list").textContent
    }));
    if(paperLists.open!==10||paperLists.closed!==10||paperLists.decisions!==10)throw new Error("AI PAPER history lists must cap at 10 rows: "+JSON.stringify(paperLists));
    if(paperLists.injected!==0||!paperLists.rationale.includes("<img src=x onerror=alert(1)>"))throw new Error("Model-provided rationale must render as text, never HTML: "+JSON.stringify(paperLists));
    await page.mouse.move(0,0);
    await page.evaluate(()=>document.activeElement?.blur());
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-product-mode-ai-${device.width}x${device.height}.png`,fullPage:false});
    await captureDarkVariant(page,"product-mode-ai",device);
    await page.locator('[data-product-mode="demo"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-product-mode="demo"]')?.classList.contains("is-active"));
    if(!(await page.locator("#kg-ai-paper-summary").isVisible())||!(await page.locator("#kg-ai-paper-stop").isVisible()))throw new Error("Stop must remain available if an active session is present after product mode changes");
    await page.locator("#kg-ai-paper-stop").click();
    await page.waitForFunction(()=>document.querySelector("#kg-ai-paper-status")?.textContent==="Остановлена");
    if(await page.locator("#kg-ai-paper-summary").isVisible())throw new Error("Stopped AI PAPER summary must hide in DEMO mode");
    if(!(await page.locator("#kg-ai-paper-start").isDisabled()))throw new Error("AI PAPER start must remain disabled in DEMO mode");
    if(await page.evaluate(()=>window.__aiPaperStartCalls)!==1||await page.evaluate(()=>window.__aiPaperStopCalls)!==1)throw new Error("AI PAPER start/stop API methods must be called exactly once");
    await page.locator('[data-product-mode="demo"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-product-mode="demo"]')?.classList.contains("is-active"));
    if(await page.locator('[data-product-mode="ai"]').evaluate(node=>node.classList.contains("is-active")))throw new Error("AI mode must be inactive after returning to DEMO");
    if(!(await page.locator("#kg-product-mode-status").innerText()).includes("DEMO"))throw new Error("DEMO mode status must match the selected mode");
    await page.mouse.move(0,0);
    await page.evaluate(()=>document.activeElement?.blur());
    await page.waitForTimeout(200);
    const inactiveAiStyle=await page.locator('[data-product-mode="ai"]').evaluate(node=>({background:getComputedStyle(node).backgroundColor,focused:node.matches(":focus"),hovered:node.matches(":hover"),active:node.classList.contains("is-active"),matchesActive:node.matches("#kg-product-mode button.is-active"),className:node.className,ariaPressed:node.getAttribute("aria-pressed"),style:node.getAttribute("style")}));
    if(inactiveAiStyle.active||inactiveAiStyle.background!=="rgba(0, 0, 0, 0)")throw new Error("Inactive AI mode must not look selected after returning to DEMO: "+JSON.stringify(inactiveAiStyle));

    if(!(await page.locator("#kg-wallet-quick-actions").isVisible()))throw new Error("wallet quick actions must be visible on the first screen");
    if(await page.locator("#kg-wallet-quick-actions button").count()!==4)throw new Error("wallet should show four reference quick actions");
    if(!(await page.locator("#kg-wallet-currency").isVisible()))throw new Error("wallet currency row should be visible");
    const walletOrder=await page.locator("#kg-wallet-screen").evaluate(el=>[...el.children].filter(x=>["kg-wallet-hero","kg-wallet-quick-actions","kg-wallet-currency"].some(id=>x.id===id||x.classList.contains(id))).slice(0,3).map(x=>x.className||x.id).join(","));
    if(!walletOrder.includes("kg-wallet-hero,kg-wallet-quick-actions,kg-wallet-currency"))throw new Error("wallet first-screen order is incorrect: "+walletOrder);
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-wallet-${device.width}x${device.height}.png`,fullPage:false});
    await captureDarkVariant(page,"wallet",device);
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
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-wallet-agent-${device.width}x${device.height}.png`,fullPage:false});
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
    const walletScrollCheck=await page.evaluate(()=>{
      const nav=document.querySelector("#kg-nav").getBoundingClientRect();
      const finalCard=document.querySelector("#kg-wallet-screen #kg-wallet-recent-history").getBoundingClientRect();
      return {scrollY:window.scrollY,navTop:nav.top,navBottom:nav.bottom,cardBottom:finalCard.bottom,viewportHeight:window.innerHeight};
    });
    if(walletScrollCheck.scrollY<=0)throw new Error("wallet screen should scroll to the final section");
    if(walletScrollCheck.navTop>=walletScrollCheck.viewportHeight||walletScrollCheck.navBottom>walletScrollCheck.viewportHeight)throw new Error("wallet bottom navigation must remain fixed inside the viewport");
    if(walletScrollCheck.cardBottom>walletScrollCheck.navTop-8)throw new Error("wallet final card is obscured by bottom navigation: "+JSON.stringify(walletScrollCheck));
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.locator('#kg-nav button[data-screen="agents"]').click();
    if(!(await page.locator("#kg-agents-screen .kg-agents-hero").innerText()).includes("подтверждённая активность агентов"))throw new Error("Agents hero must not imply that a strategy runner is active");
    await page.waitForSelector("#kg-agents-paper-account");
    await page.waitForFunction(()=>document.querySelector("#kg-agents-paper-note")?.textContent==="Состояние из защищённого API");
    if(!(await page.locator("#kg-agents-paper-balance").innerText()).includes("115"))throw new Error("Agents screen must show the real AI paper balance");
    if(!(await page.locator("#kg-agents-demo-balance").innerText()).includes("985"))throw new Error("Agents screen must show the DEMO funding balance");
    if((await page.locator("#kg-agents-paper-positions").innerText()).trim()!=="12")throw new Error("Agents screen must show the confirmed paper position count");
    if(!(await page.locator("#kg-agents-paper-status").innerText()).includes("Остановлен"))throw new Error("Agents screen must show the real stopped status");
    if(!(await page.locator(".kg-agents-safety-note").innerText()).includes("виртуальные средства"))throw new Error("Agents screen must disclose virtual-only funds");
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-agents-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-agents-open-funding").click();
    await page.waitForFunction(()=>document.querySelector("#kg-wallet-screen").classList.contains("is-active")&&document.querySelector('#kg-product-mode [data-product-mode="ai"]').classList.contains("is-active"));
    if(await page.evaluate(()=>document.activeElement?.id)!=="kg-ai-paper-amount")throw new Error("Agents virtual funding entry must focus the AI paper amount field");
    await page.locator("#kg-ai-paper-amount").evaluate(el=>el.blur());
    await page.waitForTimeout(140);
    await page.locator('#kg-product-mode [data-product-mode="demo"]').click();
    await page.waitForFunction(()=>document.querySelector('#kg-product-mode [data-product-mode="demo"]').classList.contains("is-active"));
    await page.locator('#kg-nav button[data-screen="trading"]').click();
    await page.waitForSelector("#kg-market-list .kg-market-row");
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-catalog-${device.width}x${device.height}.png`,fullPage:false});
    await captureDarkVariant(page,"catalog",device);
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
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-search-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-search-close").click();
    if(await page.locator('[data-category="stocks"]:visible,[data-category="funds"]:visible').count())throw new Error("stocks and funds categories must be removed from product navigation");
    await page.locator('[data-category="futures"]').click();
    await page.waitForSelector('#kg-market-list [data-open-market="BTC"]');
    await page.evaluate(()=>{const native=window.setInterval.bind(window);window.setInterval=(callback,delay,...args)=>native(callback,delay===15000?100:delay,...args);});
    await page.locator('#kg-market-list [data-open-market="BTC"]').first().click();
    try{await page.waitForSelector("#kg-asset-screen:not([hidden])",{timeout:10000});}
    catch(error){const debug=await page.evaluate(()=>({toast:document.querySelector("#kg-toast")?.textContent,assetHidden:document.querySelector("#kg-asset-screen")?.hidden,selected:window.KriptoGuruUI?.state?.selectedMarket,screen:window.KriptoGuruUI?.state?.screen}));throw new Error("Asset open failed: "+JSON.stringify({debug,consoleErrors,pageErrors})+" "+error.message);}
    await page.waitForSelector("#kg-chart svg");
    await page.evaluate(()=>window.Telegram.WebApp.BackButton.handler?.());
    if(await page.locator("#kg-asset-screen:not([hidden])").count())throw new Error("native BackButton must close the instrument screen");
    if(!(await page.locator("#kg-nav").evaluate(el=>!el.hidden)))throw new Error("native BackButton from instrument must restore bottom navigation");
    await page.locator('#kg-market-list [data-open-market="BTC"]').first().click();
    await page.waitForSelector("#kg-asset-screen:not([hidden])");
    await page.waitForSelector("#kg-chart svg");
    const candleChart=await page.locator("#kg-chart").evaluate(el=>({scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,svgWidth:el.querySelector("svg")?.getBoundingClientRect().width,times:[...el.querySelectorAll("rect[data-time]")].map(node=>Number(node.dataset.time))}));
    if(!(candleChart.svgWidth>candleChart.clientWidth&&candleChart.scrollWidth>candleChart.clientWidth))throw new Error("candlestick history must scroll horizontally: "+JSON.stringify(candleChart));
    if(candleChart.times.length!==30||candleChart.times.some((time,index)=>index>0&&time<=candleChart.times[index-1]))throw new Error("candles must be valid, unique and sorted ascending: "+JSON.stringify(candleChart.times));
    const chartOverlays=await page.evaluate(()=>({bars:document.querySelectorAll("#kg-chart .kg-volume-bar").length,currentLine:document.querySelectorAll("#kg-chart .kg-current-price-line").length,candles:document.querySelectorAll("#kg-chart rect[data-time]").length,volumeCount:document.querySelector("#kg-chart")?.dataset.volumeCount,firstVolume:document.querySelector("#kg-chart")?.dataset.firstVolume,mockVolumes:window.__mockCandleVolumes,chartHtml:document.querySelector("#kg-chart")?.innerHTML.slice(-900)}));
    if(chartOverlays.bars!==30||chartOverlays.currentLine!==1)throw new Error("chart must show volume bars and a current price guide: "+JSON.stringify(chartOverlays));
    await page.locator("#kg-chart").evaluate(el=>{el.scrollLeft=el.scrollWidth;});
    const chartBox=await page.locator("#kg-chart").boundingBox();
    await page.mouse.move(chartBox.x+chartBox.width*.52,chartBox.y+chartBox.height*.5);
    await page.mouse.down();
    await page.waitForTimeout(460);
    const crosshairVisible=await page.locator(".kg-chart-crosshair").getAttribute("opacity");
    const crosshairLabel=await page.locator(".kg-crosshair-label").textContent();
    if(crosshairVisible!=="1"||!["O","H","L","C"].every(label=>crosshairLabel.includes(label)))throw new Error("Long-press chart crosshair must show OHLC: "+JSON.stringify({crosshairVisible,crosshairLabel}));
    await page.mouse.up();
    const axisLabels=await page.locator("#kg-chart svg text").evaluateAll(nodes=>{const svg=nodes[0]?.ownerSVGElement;const width=Number(svg?.getAttribute("viewBox")?.split(" ")[2]||0);return nodes.filter(node=>Number(node.getAttribute("x"))>width-61).map(node=>{const r=node.getBoundingClientRect();return {text:node.textContent,left:r.left,right:r.right};});});
    const chartBounds=await page.locator("#kg-chart").evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right};});
    if(axisLabels.some(label=>label.left<chartBounds.left-1||label.right>chartBounds.right+1))throw new Error("Right price-axis labels must remain fully visible at "+device.width+"px: "+JSON.stringify({axisLabels,chartBounds}));
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
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-asset-${device.width}x${device.height}.png`,fullPage:false});
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
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-asset-about-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-long").click();
    await page.waitForSelector("#kg-ticket-screen:not([hidden])");
    await page.evaluate(()=>window.Telegram.WebApp.BackButton.handler?.());
    if(await page.locator("#kg-ticket-screen:not([hidden])").count())throw new Error("native BackButton must close the trade ticket");
    if(!(await page.locator("#kg-asset-screen:not([hidden])").count()))throw new Error("closing trade ticket must return to the instrument screen");
    await page.locator("#kg-long").click();
    await page.waitForSelector("#kg-ticket-screen:not([hidden])");
    await page.waitForTimeout(250);
    const pausedCandleCalls=await page.evaluate(()=>window.__candleCalls);
    await page.waitForTimeout(250);
    if(await page.evaluate(()=>window.__candleCalls)!==pausedCandleCalls)throw new Error("candlestick polling must pause while the ticket screen is open");
    if(!(await page.evaluate(()=>document.activeElement?.id==="kg-ticket-margin")))throw new Error("ticket amount input should autofocus during the user gesture");
    if(await page.locator("#kg-ticket-autoclose,#kg-ticket-autoclose-fields,#kg-ticket-tp,#kg-ticket-sl").count())throw new Error("Unverified TP/SL controls must not be exposed before API contract support");
    if(!(await page.locator(".kg-ticket-risk-note").innerText()).includes("TP/SL"))throw new Error("Ticket must explain why TP/SL controls are unavailable");
    await page.locator("#kg-ticket-max").click();
    await page.waitForFunction(()=>document.querySelector("#kg-ticket-margin")?.value==="50");
    await page.waitForFunction(()=>document.querySelector("#kg-ticket-check")?.disabled===false);
    if(await page.locator("#kg-ticket-margin").inputValue()!=="50")throw new Error("Max must use the server-approved margin cap, not the full demo balance");
    const volumeText=await page.locator("#kg-ticket-volume").innerText();
    if(!volumeText.startsWith("Объём: $"))throw new Error("ticket volume label should appear exactly once: "+volumeText);
    const feePreview=await page.locator("#kg-ticket-preview").innerText();
    if(!feePreview.includes("Комиссия открытия")||!feePreview.includes("Комиссия закрытия"))throw new Error("Supported open/close fees must appear in ticket preview: "+feePreview);
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-ticket-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-ticket-leverage").click();
    await page.waitForSelector("#kg-leverage-screen:not([hidden])");
    await page.evaluate(()=>window.Telegram.WebApp.BackButton.handler?.());
    if(await page.locator("#kg-leverage-screen:not([hidden])").count())throw new Error("native BackButton must dismiss the leverage modal first");
    if(!(await page.locator("#kg-ticket-screen:not([hidden])").count()))throw new Error("dismissing leverage modal must preserve the trade ticket");
    await page.locator("#kg-ticket-leverage").click();
    await page.waitForSelector("#kg-leverage-screen:not([hidden])");
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-leverage-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-lev-max").click();
    await page.locator("#kg-lev-apply").click();
    await page.locator("#kg-ticket-check").click();
    await page.waitForSelector("#kg-confirm-screen:not([hidden])");
    await page.evaluate(()=>window.Telegram.WebApp.BackButton.handler?.());
    if(await page.locator("#kg-confirm-screen:not([hidden])").count())throw new Error("native BackButton must dismiss trade confirmation first");
    if(!(await page.locator("#kg-ticket-screen:not([hidden])").count()))throw new Error("dismissing trade confirmation must preserve the ticket");
    await page.locator("#kg-ticket-check").click();
    await page.waitForSelector("#kg-confirm-screen:not([hidden])");
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-confirm-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-trade-confirm").click();
    const submittedTrade=await page.evaluate(()=>window.__lastTradeOpen);
    if("takeProfitUsd" in (submittedTrade||{})||"stopLossUsd" in (submittedTrade||{}))throw new Error("Unverified TP/SL fields must not be sent to the trade API: "+JSON.stringify(submittedTrade));
    await page.waitForSelector("#kg-asset-screen:not([hidden])");
    const candleCallsBeforeResume=await page.evaluate(()=>window.__candleCalls);
    await page.waitForFunction(previous=>window.__candleCalls>previous,candleCallsBeforeResume,{timeout:3000});
    await page.locator("#kg-asset-history-all").click();
    await page.waitForSelector("#kg-income-screen.is-active");
    await page.waitForSelector(".kg-position");
    const missingPnl=page.locator(".kg-position-pnl").first();
    if((await missingPnl.innerText()).trim()!=="—")throw new Error("missing position PnL must render as an em dash");
    if(!(await missingPnl.evaluate(el=>el.classList.contains("kg-muted"))))throw new Error("missing position PnL must use neutral styling");
    await page.locator("#kg-income-tabs [data-income-tab=history]").click();
    if(!(await page.locator("#kg-income-history-panel").isVisible())||await page.locator("#kg-income-open-panel").isVisible())throw new Error("income tabs must switch between open positions and history");
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-income-history-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator('#kg-nav button[data-screen="companion"]').click();
    await page.waitForSelector("#kg-companion-screen.is-active");
    await page.waitForSelector("#kg-companion-screen .kg-ai-welcome");
    await page.waitForFunction(()=>getComputedStyle(document.querySelector("#kg-nav")).display!=="none");
    if(!(await page.locator("#kg-ai-input").isVisible()))throw new Error("AI Companion composer must be visible on the home screen");
    const composerHeight=await page.locator("#kg-ai-input").evaluate(el=>el.getBoundingClientRect().height);
    if(composerHeight<44)throw new Error("AI Companion composer must be at least 44px high so the two-line placeholder is not clipped: "+composerHeight);
    if(!(await page.locator("#kg-companion-screen .kg-ai-welcome").isVisible()))throw new Error("AI Companion welcome must be visible on the home screen");
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-companion-home-${device.width}x${device.height}.png`,fullPage:false});
    await captureDarkVariant(page,"companion-home",device);

    // Playwright cannot open the native iOS keyboard. Emulate the reduced app viewport
    // and draw a test-only iOS-style keyboard so the screenshot represents both states.
    await page.locator("#kg-ai-input").focus();
    await page.waitForFunction(()=>document.querySelector("#kg-companion-screen").classList.contains("kg-composer-expanded"));
    await page.evaluate(()=>{
      document.querySelector("#kg-companion-screen").classList.add("kg-keyboard-open");
      document.querySelector("#kg-nav").hidden=true;
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
    if(!(await page.locator("#kg-nav").evaluate(el=>el.hidden)))throw new Error("bottom navigation must be hidden while the keyboard is open");
    const composerAboveKeyboard=await page.evaluate(()=>{
      const composer=document.querySelector("#kg-ai-form").getBoundingClientRect();
      const keyboard=document.querySelector("#kg-test-keyboard").getBoundingClientRect();
      return composer.bottom<=keyboard.top+1;
    });
    if(!composerAboveKeyboard)throw new Error("AI composer must remain above the on-screen keyboard");
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-companion-keyboard-${device.width}x${device.height}.png`,fullPage:false});
    await page.evaluate(()=>{document.querySelector("#kg-test-keyboard")?.remove();document.querySelector("#kg-test-keyboard-style")?.remove();document.querySelector("#kg-companion-screen").classList.remove("kg-keyboard-open");document.querySelector("#kg-nav").hidden=false;document.querySelector("#kg-ai-input").blur();});
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
    await page.evaluate(()=>{const toast=document.querySelector("#kg-toast");toast?.classList.remove("is-visible");if(toast)toast.textContent="";}); await page.screenshot({path:`clean-companion-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-ai-menu-open").click();
    await page.waitForSelector("#kg-ai-menu.is-open");
    const historySearch=page.locator("#kg-ai-history-search");
    await historySearch.fill("Проверь");
    if(await page.locator("#kg-ai-history [data-ai-conversation]").count()!==1)throw new Error("AI history search should match conversation titles");
    await historySearch.fill("несуществующий диалог");
    if(await page.locator("#kg-ai-history [data-ai-conversation]").count()!==0)throw new Error("AI history search should show no results for unmatched text");
    await historySearch.fill("");
    await page.locator("#kg-ai-history [data-ai-delete]").first().click();
    await page.waitForFunction(()=>document.querySelectorAll("#kg-ai-history [data-ai-conversation]").length===0);
    if(!(await page.locator("#kg-ai-messages").innerText()).includes("Привет! Я Kripto Guru AI."))throw new Error("deleting the active AI conversation should reset the chat view");
    const backBefore=await page.evaluate(()=>({handler:typeof window.Telegram.WebApp.BackButton.handler,visible:window.Telegram.WebApp.BackButton.isVisible,calls:{...window.Telegram.WebApp.BackButton.calls},onClickType:typeof window.Telegram.WebApp.BackButton.onClick,profileHidden:document.querySelector("#kg-profile-sheet").hidden,menuOpen:document.querySelector("#kg-ai-menu").classList.contains("is-open")}));
    await page.evaluate(()=>window.Telegram.WebApp.BackButton.handler?.());
    const backAfter=await page.evaluate(()=>({handler:typeof window.Telegram.WebApp.BackButton.handler,visible:window.Telegram.WebApp.BackButton.isVisible,calls:{...window.Telegram.WebApp.BackButton.calls},onClickType:typeof window.Telegram.WebApp.BackButton.onClick,profileHidden:document.querySelector("#kg-profile-sheet").hidden,menuOpen:document.querySelector("#kg-ai-menu").classList.contains("is-open")}));
    if(backAfter.menuOpen)throw new Error("AI history drawer must close with Telegram BackButton: "+JSON.stringify({backBefore,backAfter}));
    await page.locator("#kg-ai-menu-open").click();
    await page.waitForSelector("#kg-ai-menu.is-open");
    await page.locator("#kg-ai-menu-profile").click();
    await page.waitForFunction(()=>!document.querySelector("#kg-profile-sheet").hidden);
    await page.evaluate(()=>window.Telegram.WebApp.BackButton.handler?.());
    if(!await page.locator("#kg-profile-sheet").evaluate(el=>el.hidden))throw new Error("profile entry from AI drawer must use native BackButton to dismiss");
    const aiProfileBack=await page.evaluate(()=>({visible:window.Telegram.WebApp.BackButton.isVisible,handler:typeof window.Telegram.WebApp.BackButton.handler,menuOpen:document.querySelector("#kg-ai-menu").classList.contains("is-open")}));
    if(aiProfileBack.visible||aiProfileBack.handler!=="object"||aiProfileBack.menuOpen)throw new Error("AI menu profile navigation closes the drawer; native Back must then hide and detach after dismissing profile: "+JSON.stringify(aiProfileBack));
    if(pageErrors.length)throw new Error("browser errors: "+pageErrors.join("; "));
    await page.close();
  }
}finally{
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}

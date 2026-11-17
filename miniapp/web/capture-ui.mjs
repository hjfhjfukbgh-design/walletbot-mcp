// Playwright previews for wallet, four product categories, Income, Bonuses and DEMO order flow.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve("miniapp/web");
const mime = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".svg":"image/svg+xml" };
const markets = [
  { market:"BTC", price:91240.5, change24hPct:2.42, volume24hUsd:8_900_000_000, maxLeverage:50, allowed:true, takerFeePct:0.00035, fundingRateHourly:0.00001, minSizeQuote:10 },
  { market:"ETH", price:3120.2, change24hPct:-0.83, volume24hUsd:4_100_000_000, maxLeverage:50, allowed:true, takerFeePct:0.00035, fundingRateHourly:-0.00002, minSizeQuote:10 },
  { market:"SOL", price:142.8, change24hPct:4.16, volume24hUsd:1_200_000_000, maxLeverage:20, allowed:true, takerFeePct:0.00035, fundingRateHourly:0.00003, minSizeQuote:10 },
  { market:"HYPE", price:29.14, change24hPct:5.82, volume24hUsd:480_000_000, maxLeverage:10, allowed:true, takerFeePct:0.00035, fundingRateHourly:0.00001, minSizeQuote:10 },
  { market:"XRP", price:2.18, change24hPct:-2.31, volume24hUsd:760_000_000, maxLeverage:20, allowed:true, takerFeePct:0.00035, fundingRateHourly:0.00001, minSizeQuote:10 },
  { market:"DOGE", price:0.1632, change24hPct:1.12, volume24hUsd:360_000_000, maxLeverage:20, allowed:true, takerFeePct:0.00035, fundingRateHourly:0.00001, minSizeQuote:10 },
];
let includePosition = false;
const previewPosition = {id:"preview-position",userId:"123456",symbol:"BTC",side:"long",marginMicro:"100000000",leverage:"5",entryPrice:"9000000000000",qtyUnits:"555555",entryNotionalMicro:"500000000",entryFeeMicro:"175000",liquidationPrice:"7200000000000",takeProfitPrice:"9400000000000",stopLossPrice:"8850000000000",feePpm:"350",slippagePpm:"1000",status:"open",openedAt:Date.now()-600000};
const now = Date.now();
const candles = Array.from({length:36},(_,i)=>{
  const base=91200 + Math.sin(i/3)*180 + i*2.5;
  return [now-(36-i)*900000,base-18,base+75,base-82,base+24];
});
const server = http.createServer((req,res)=>{
  const url = new URL(req.url || "/", "http://127.0.0.1:4173");
  if (url.pathname === "/__preview/position") { includePosition = true; return send(res,{ok:true}); }
  if (url.pathname === "/__preview/empty") { includePosition = false; return send(res,{ok:true}); }
  if (url.pathname === "/api/demo") return send(res,{ok:true,balanceMicro:includePosition?"900000000":"1000000000",positions:includePosition?[previewPosition]:[]});
  if (url.pathname === "/api/state") return send(res,{
    ok:true,mode:"paper",running:false,paused:null,connected:false,lastPrice:null,lastTick:null,lastError:null,lastBlock:null,lastRecenter:null,
    stats:{trades:0,wins:0,losses:0,realizedPnl:0},grid:null,position:null,livePosition:null,
    paper:{cash:1000,startCash:1000,equity:1000},manualPositions:[],
    limits:{maxLeverage:3,maxOrderPct:25,maxTotalExposurePct:50,maxDailyLossPct:5,stopLossPct:5,minVolume24hUsd:0}
  });
  if (url.pathname === "/api/contracts") return send(res,{ok:true,contracts:markets});
  if (url.pathname === "/api/chart") return send(res,{ok:true,source:"preview",interval:url.searchParams.get("interval") || "15m",candles});
  if (url.pathname === "/api/trades") return send(res,{ok:true,trades:[],equity:[]});
  if (url.pathname === "/api/price") {
    const item=markets.find(x=>x.market===url.searchParams.get("market")) || markets[0];
    return send(res,{ok:true,market:item.market,price:item.price,leverage:1,maxDemoLeverage:3,minMargin:10,suggestion:{low:item.price*.94,high:item.price*1.02}});
  }
  if (url.pathname.startsWith("/api/")) return send(res,{ok:false,error:"Mock endpoint not found"},404);
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(root, requested);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(file,(error,bytes)=>{
    if(error){res.writeHead(404);res.end("not found");return;}
    res.writeHead(200,{"Content-Type":mime[path.extname(file)] || "application/octet-stream"});
    res.end(bytes);
  });
});
function send(res,data,status=200){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*"});res.end(JSON.stringify(data));}
server.listen(4173,"127.0.0.1");

const browser = await chromium.launch({headless:true});
async function assertViewport(page,label){
  const result=await page.evaluate(()=>{
    const nav=document.querySelector(".bottom-nav")?.getBoundingClientRect();
    return {width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,navLeft:nav?.left??0,navRight:nav?.right??0};
  });
  if(result.scrollWidth>result.width+1) throw new Error(`${label}: горизонтальное переполнение ${result.scrollWidth}px при ширине ${result.width}px`);
  if(result.navLeft < -1 || result.navRight > result.width+1) throw new Error(`${label}: нижняя навигация выходит за экран`);
}

async function assertHitAboveNav(page, selector, label) {
  const result = await page.evaluate((sel) => {
    const target = Array.from(document.querySelectorAll(sel)).at(-1);
    const nav = document.querySelector(".bottom-nav");
    if (!target) return {error:"missing target "+sel};
    const r=target.getBoundingClientRect(), n=nav?.getBoundingClientRect();
    const x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2));
    const y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2));
    const hit=document.elementFromPoint(x,y);
    return {top:r.top,bottom:r.bottom,navTop:n?.top??innerHeight,hit:!!hit&&(hit===target||target.contains(hit)),hitTag:hit?.tagName,hitId:hit?.id};
  },selector);
  if(result.error || result.bottom > result.navTop-1 || !result.hit)
    throw new Error(label+": target not clear/clickable above nav "+JSON.stringify(result));
}

async function assertBottomAccessible(page, selector, label) {
  const target = page.locator(selector).last();
  await target.waitFor({ state: "visible" });
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  const result = await page.evaluate((sel) => {
    const element = Array.from(document.querySelectorAll(sel)).at(-1);
    const nav = document.querySelector(".bottom-nav");
    if (!element) return { error: "target not found: " + sel };
    const rect = element.getBoundingClientRect();
    const navTop = nav ? nav.getBoundingClientRect().top : window.innerHeight;
    return { elementBottom: rect.bottom, navTop, viewportHeight: window.innerHeight, scrollY: window.scrollY };
  }, selector);
  if (result.error) throw new Error(label + ": " + result.error);
  if (result.elementBottom > result.navTop + 1) {
    throw new Error(label + ": последний блок недоступен над нижней навигацией " + JSON.stringify(result));
  }
}

try {
  for (const device of [{width:390,height:844},{width:430,height:932}]) {
    const {width,height}=device;
    const page = await browser.newPage({viewport:{width,height},deviceScaleFactor:3,isMobile:true,hasTouch:true});
    const pageErrors=[];
    page.on("pageerror",error=>pageErrors.push(error.message));
    await page.addInitScript(()=>{
      localStorage.setItem("kripto-guru:onboarding:v1","done");
      localStorage.setItem("kg:recent:v1", JSON.stringify(["BTC","ETH"]));
      window.Telegram={WebApp:{
        initData:"mock-preview-init-data",ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},
        BackButton:{
          isVisible:false,_handler:null,
          show(){this.isVisible=true;},hide(){this.isVisible=false;},
          onClick(handler){this._handler=handler;},offClick(handler){if(this._handler===handler)this._handler=null;},
          __trigger(){this._handler?.();}
        },
        HapticFeedback:{selectionChanged(){},impactOccurred(){},notificationOccurred(){}},
        showAlert(message){window.__lastAlert=message;},showConfirm(_message,callback){callback(true);}
      }};
    });
    await page.route("https://telegram.org/js/telegram-web-app.js",route=>route.fulfill({status:200,contentType:"text/javascript",body:""}));
    await page.goto("http://127.0.0.1:4173/",{waitUntil:"networkidle"});
    await page.waitForTimeout(1800);
    await page.locator("#wallet-usdt").waitFor({state:"visible"});
    await page.locator("#wallet-favorites").waitFor({state:"visible"});
    await page.locator("#wallet-asset-list").waitFor({state:"visible"});
    await assertViewport(page,"wallet");
    await page.screenshot({path:`wallet-${width}x${height}-dsf3.png`,fullPage:false});
    await page.screenshot({path:`wallet-full-${width}x${height}-dsf3.png`,fullPage:true});
    await assertBottomAccessible(page,"#wallet-asset-list","wallet asset list scroll end");
    await page.screenshot({path:`wallet-maxscroll-${width}x${height}-dsf3.png`,fullPage:false});
    await page.locator('nav button[data-tab="hist"]').click();
    await page.waitForTimeout(300);
    await assertViewport(page,"income");
    await page.locator(".empty-wallet .primary-button").scrollIntoViewIfNeeded();
    await assertHitAboveNav(page,".empty-wallet .primary-button","income empty-position CTA hit-test");
    await assertBottomAccessible(page,".empty-wallet .primary-button","income empty-position CTA scroll end");
    await page.evaluate(async()=>{await fetch("/__preview/position"); await window.kriptoGuruDemo.refresh();});
    await page.waitForTimeout(450);
    if(await page.locator("#wallet-position-count").textContent()!=="1") throw new Error("income preview: открытая демо-позиция не появилась");
    await page.evaluate(()=>window.scrollTo({top:0,behavior:"instant"}));
    await assertViewport(page,"income-position");
    await page.screenshot({path:`income-position-${width}x${height}-dsf3.png`,fullPage:false});
    await page.screenshot({path:`income-position-full-${width}x${height}-dsf3.png`,fullPage:true});
    await page.evaluate(async()=>{await fetch("/__preview/empty"); await window.kriptoGuruDemo.refresh();});
    await page.waitForTimeout(250);
    await page.locator('nav button[data-tab="painel"]').click();
    await page.locator('nav button[data-tab="pares"]').click();
    await page.waitForTimeout(900);
    if(await page.locator('[data-market-category]').count()!==4) throw new Error("catalog: expected four product categories");
    await assertViewport(page,"market-catalog");
    await page.screenshot({path:`market-catalog-${width}x${height}-dsf3.png`,fullPage:false});
    await page.locator("#category-stocks").click();
    await page.locator("#equities-market-content").waitFor({state:"visible"});
    if(!(await page.locator(".equities-empty").innerText()).includes("Котировки пока не подключены")) throw new Error("stocks category must show honest unavailable state");
    await page.screenshot({path:`market-stocks-${width}x${height}-dsf3.png`,fullPage:false});
    await page.locator("#category-funds").click();
    if(!(await page.locator("#equities-title").innerText()).includes("Фонды")) throw new Error("funds category did not switch");
    await page.screenshot({path:`market-funds-${width}x${height}-dsf3.png`,fullPage:false});
    await page.locator("#category-futures").click();
    await page.locator("#pairs .market-row").first().waitFor({state:"visible"});
    if (await page.locator("#q").isVisible()) throw new Error("market search should start collapsed");
    await page.locator("#trade-search-toggle").click();
    await page.locator("#q").waitFor({state:"visible"});
    await page.locator("#q").fill("BTC");
    if (await page.locator("#pairs .market-row").count() !== 1) throw new Error("expanded market search did not filter BTC");
    await page.keyboard.press("Escape");
    if (await page.locator("#q").isVisible()) throw new Error("market search did not collapse on Escape");
    await page.locator("#category-crypto").click();
    await page.locator("#pairs .market-row").first().waitFor({state:"visible"});
    await assertViewport(page,"trade");
    await page.screenshot({path:`trade-${width}x${height}-dsf3.png`,fullPage:false});
    await page.locator("#pairs").scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.screenshot({path:`trade-list-${width}x${height}-dsf3.png`,fullPage:false});
    await assertBottomAccessible(page,"#pairs .market-row","trade last market row scroll end");
    await page.screenshot({path:`trade-maxscroll-${width}x${height}-dsf3.png`,fullPage:false});
    await page.locator("#pairs .market-row").first().click();
    await page.waitForTimeout(1100);
    await page.evaluate(()=>{window.scrollTo({top:0,behavior:"instant"});document.documentElement.scrollTop=0;document.body.scrollTop=0;});
    await page.waitForFunction(()=>window.Telegram?.WebApp?.BackButton?.isVisible===true);
    if(await page.locator("#asset-back").isVisible()) throw new Error("Telegram asset view should use native BackButton, not a duplicate in-page back control");
    await page.screenshot({path:`asset-${width}x${height}-dsf3.png`,fullPage:false});
    await page.locator("#asset-trade-bar [data-asset-side=long]").click();
    await page.waitForTimeout(350);
    const ticketDebug=await page.evaluate(()=>{
      const overlay=document.querySelector(".sheet-backdrop");
      const input=document.querySelector("#ticket-margin");
      const style=input?getComputedStyle(input):null;
      const rect=input?.getBoundingClientRect();
      return {
        overlayCount:document.querySelectorAll(".sheet-backdrop").length,
        overlayClass:overlay?.className||null,
        overlayDisplay:overlay?getComputedStyle(overlay).display:null,
        inputCount:document.querySelectorAll("#ticket-margin").length,
        inputDisplay:style?.display||null,
        inputVisibility:style?.visibility||null,
        inputRect:rect?{width:rect.width,height:rect.height}:null,
        bodyClass:document.body.className,
        toast:document.querySelector("#kg-toast")?.textContent||null
      };
    });
    if(!ticketDebug.inputRect || ticketDebug.inputRect.width===0 || ticketDebug.inputRect.height===0) {
      throw new Error("DEMO ticket did not become visible: "+JSON.stringify({ticketDebug,pageErrors}));
    }
    await page.locator("#ticket-margin").waitFor({state:"visible"});
    await page.waitForTimeout(250);
    await page.locator("#ticket-margin").fill("50");
    await page.waitForTimeout(150);
    await page.screenshot({path:`ticket-${width}x${height}-dsf3.png`,fullPage:false});
    await page.locator("#ticket-leverage").click();
    await page.waitForTimeout(150);
    await page.screenshot({path:`leverage-${width}x${height}-dsf3.png`,fullPage:false});
    await page.locator("#lev-apply").click();
    await page.locator("#ticket-autoclose").click();
    await page.waitForTimeout(150);
    await page.screenshot({path:`tp-sl-${width}x${height}-dsf3.png`,fullPage:false});
    await page.keyboard.press("Escape");
    await page.locator("#asset-trade-bar [data-asset-side=short]").click();
    await page.locator("#ticket-margin").waitFor({state:"visible"});
    await page.locator("#ticket-margin").fill("50");
    await page.keyboard.press("Escape");
    const assetState=await page.evaluate(()=>({
      open:document.body.classList.contains("asset-open"),
      navDisplay:getComputedStyle(document.querySelector(".bottom-nav")).display
    }));
    if(!assetState.open || assetState.navDisplay!=="none") throw new Error("Asset detail state/nav invalid before back: "+JSON.stringify(assetState));
    await page.evaluate(()=>window.Telegram.WebApp.BackButton.__trigger());
    await page.waitForTimeout(200);
    const returnedState=await page.evaluate(()=>({
      open:document.body.classList.contains("asset-open"),
      navDisplay:getComputedStyle(document.querySelector(".bottom-nav")).display
    }));
    if(returnedState.open || returnedState.navDisplay==="none") throw new Error("Bottom navigation did not return after asset back: "+JSON.stringify(returnedState));
    await page.locator('nav button[data-tab="hist"]').click();
    await page.waitForTimeout(350);
    await page.screenshot({path:`history-${width}x${height}-dsf3.png`,fullPage:false});
    await assertBottomAccessible(page,"#trades","history scroll end");
    await page.screenshot({path:`history-maxscroll-${width}x${height}-dsf3.png`,fullPage:false});
    await page.locator('nav button[data-tab="ctrl"]').click();
    await page.waitForTimeout(250);
    await assertViewport(page,"bonuses");
    await page.locator(".bonus-card").waitFor({state:"visible"});
    if(!(await page.locator("#tab-ctrl h1").innerText()).includes("Бонусы")) throw new Error("bottom navigation fourth tab is not Bonuses");
    if(pageErrors.length) throw new Error("JavaScript errors: "+pageErrors.join(" | "));
    await page.screenshot({path:`bonuses-${width}x${height}-dsf3.png`,fullPage:false});
    await page.locator(".bonus-settings > summary").click();
    await page.locator(".bonus-settings-content .disclaimer").waitFor({state:"visible"});
    await assertBottomAccessible(page,".disclaimer","expanded bonuses settings scroll end");
    await page.screenshot({path:`bonuses-maxscroll-${width}x${height}-dsf3.png`,fullPage:false});
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

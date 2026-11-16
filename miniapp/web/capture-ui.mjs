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
const now = Date.now();
const candles = Array.from({length:36},(_,i)=>{
  const base=91200 + Math.sin(i/3)*180 + i*2.5;
  return [now-(36-i)*900000,base-18,base+75,base-82,base+24];
});
const server = http.createServer((req,res)=>{
  const url = new URL(req.url || "/", "http://127.0.0.1:4173");
  if (url.pathname === "/api/demo") return send(res,{ok:true,balanceMicro:"1000000000",positions:[]});
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
    return send(res,{ok:true,market:item.market,price:item.price,leverage:1,minMargin:10,suggestion:{low:item.price*.94,high:item.price*1.02}});
  }
  return send(res,{ok:false,error:"Mock endpoint not found"},404);
});
function send(res,data,status=200){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*"});res.end(JSON.stringify(data));}
server.listen(4173,"127.0.0.1");

const browser = await chromium.launch({headless:true});
try {
  for (const width of [390,430]) {
    const page = await browser.newPage({viewport:{width,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
    await page.addInitScript(()=>{
      localStorage.setItem("kripto-guru:onboarding:v1","done");
      window.Telegram={WebApp:{
        initData:"mock-preview-init-data",ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},
        HapticFeedback:{selectionChanged(){},impactOccurred(){},notificationOccurred(){}},
        showAlert(message){window.__lastAlert=message;},showConfirm(_message,callback){callback(true);}
      }};
    });
    await page.route("https://telegram.org/js/telegram-web-app.js",route=>route.fulfill({status:200,contentType:"text/javascript",body:""}));
    await page.goto("http://127.0.0.1:4173/",{waitUntil:"networkidle"});
    await page.waitForTimeout(900);
    await page.screenshot({path:`wallet-${width}x844.png`,fullPage:true});
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

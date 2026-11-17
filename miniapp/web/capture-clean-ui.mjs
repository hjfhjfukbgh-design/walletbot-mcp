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
    page.on("pageerror",error=>pageErrors.push(error.message));
    await page.addInitScript(()=>{
      const mockPositions=[];
      const mockHistory=[];
      const markets=[
        {symbol:"BTC",name:"Bitcoin",priceUsd:91240.5,change24hPct:2.42,volume24hUsd:8900000000,openInterestUsd:198750000,fundingRateHourlyPct:0.001,maxLeverage:50,takerFeePct:0.035,tradeable:true},
        {symbol:"ETH",name:"Ethereum",priceUsd:3120.2,change24hPct:-0.83,volume24hUsd:5200000000,openInterestUsd:92000000,fundingRateHourlyPct:-0.002,maxLeverage:30,takerFeePct:0.035,tradeable:true},
        {symbol:"SOL",name:"Solana",priceUsd:142.8,change24hPct:4.16,volume24hUsd:1900000000,openInterestUsd:61000000,fundingRateHourlyPct:0.001,maxLeverage:20,takerFeePct:0.04,tradeable:true}
      ];
      const candles=Array.from({length:30},(_,i)=>{const base=91200+Math.sin(i*.55)*125+i*2.3;return {time:1700000000+i*900,open:base,high:base+38,low:base-31,close:base+(i%2?18:-12)};});
      window.Telegram={WebApp:{initData:"preview-only-init-data",ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},BackButton:{isVisible:false,handler:null,show(){this.isVisible=true;},hide(){this.isVisible=false;},onClick(fn){this.handler=fn;},offClick(fn){if(this.handler===fn)this.handler=null;},__trigger(){this.handler?.();}},HapticFeedback:{selectionChanged(){},impactOccurred(){},notificationOccurred(){}}}};
      window.KriptoGuruAPI={
        wallet:{async get(){return {mode:"demo",balanceUsd:1000,assets:[{symbol:"BTC",name:"Bitcoin",valueUsd:0},{symbol:"ETH",name:"Ethereum",valueUsd:0},{symbol:"SOL",name:"Solana",valueUsd:0}],positions:mockPositions.map(x=>({...x}))};}},
        markets:{async list({category}){if(category==="stocks"||category==="funds")return {available:false,reason:"Проверенный источник котировок пока не подключён."};return {available:true,markets:markets.map(x=>({...x}))};}},
        market:{async get(symbol){const item=markets.find(x=>x.symbol===symbol);if(!item)throw {code:"NOT_FOUND",message:"Инструмент не найден"};return {...item,productType:"Фьючерс"};},async candles(symbol,interval){return {candles:interval==="1m"?candles:candles};}},
        trade:{
          async preview({marginUsd,leverage}){return {valid:marginUsd>0,available:true,volumeUsd:marginUsd*leverage,entryFeeUsd:marginUsd*leverage*.00035,exitFeeUsd:marginUsd*leverage*.00035};},
          async open(payload){const p={id:"preview-position-1",symbol:payload.symbol,side:payload.side,marginUsd:payload.marginUsd,leverage:payload.leverage,unrealizedPnlUsd:.42};mockPositions.push(p);mockHistory.unshift({event:"Открытие",symbol:p.symbol,side:p.side,pnl:0,timestamp:"Сейчас"});return {position:p};},
          async close(id){const i=mockPositions.findIndex(x=>x.id===id);if(i>=0){const p=mockPositions.splice(i,1)[0];mockHistory.unshift({event:"Закрытие",symbol:p.symbol,side:p.side,netPnlUsd:.37,timestamp:"Сейчас"});}return {closed:true};}
        },
        history:{async list(){return {events:mockHistory.map(x=>({...x}))};}},
        capabilities:{async get(){return {ipo:{available:false,reason:"Нет источника IPO"},stocks:{available:false},funds:{available:false},bonuses:{available:false},live:{available:false}};}}
      };
    });
    await page.goto("http://127.0.0.1:4173/",{waitUntil:"networkidle"});
    await page.waitForSelector("#kg-wallet-balance");
    await page.waitForFunction(()=>document.querySelector("#kg-wallet-balance")?.textContent.includes("1"));
    await page.waitForFunction(()=>document.querySelectorAll("#kg-favorites .kg-favorite").length===3);
    if(await page.locator("#kg-favorites .kg-favorite").count()!==3)throw new Error("wallet should show three favorite markets");
    if(await page.locator("#kg-nav button").count()!==4)throw new Error("bottom navigation should have four tabs");
    await page.screenshot({path:`clean-wallet-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator('#kg-nav button[data-screen="trading"]').click();
    await page.waitForSelector("#kg-market-list .kg-market-row");
    await page.screenshot({path:`clean-catalog-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator('[data-category="stocks"]').click();
    await page.waitForSelector("#kg-market-unavailable:not([hidden])");
    if(!(await page.locator("#kg-unavailable-reason").innerText()).includes("источник"))throw new Error("stocks must show honest unavailable reason");
    await page.screenshot({path:`clean-stocks-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator('[data-category="funds"]').click();
    await page.waitForSelector("#kg-market-unavailable:not([hidden])");
    await page.locator('[data-category="futures"]').click();
    await page.waitForSelector('#kg-market-list [data-open-market="BTC"]');
    await page.locator('#kg-market-list [data-open-market="BTC"]').first().click();
    await page.waitForSelector("#kg-asset-screen:not([hidden])");
    await page.waitForSelector("#kg-chart svg");
    if(!(await page.locator("#kg-asset-name").innerText()).includes("Bitcoin"))throw new Error("asset detail title missing");
    await page.screenshot({path:`clean-asset-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-long").click();
    await page.waitForSelector("#kg-ticket-screen:not([hidden])");
    if(!(await page.evaluate(()=>document.activeElement?.id==="kg-ticket-margin")))throw new Error("ticket amount input should autofocus during the user gesture");
    await page.locator("#kg-ticket-margin").fill("50");
    await page.waitForFunction(()=>document.querySelector("#kg-ticket-check")?.disabled===false);
    const volumeText=await page.locator("#kg-ticket-volume").innerText();
    if(!volumeText.startsWith("Объём: $"))throw new Error("ticket volume label should appear exactly once: "+volumeText);
    await page.screenshot({path:`clean-ticket-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator("#kg-ticket-leverage").click();
    await page.waitForSelector("#kg-leverage-screen:not([hidden])");
    await page.locator("#kg-lev-max").click();
    await page.locator("#kg-lev-apply").click();
    await page.locator("#kg-ticket-check").click();
    await page.waitForSelector("#kg-confirm-screen:not([hidden])");
    await page.locator("#kg-trade-confirm").click();
    await page.waitForSelector("#kg-asset-screen:not([hidden])");
    await page.locator("#kg-asset-back").click();
    await page.locator('#kg-nav button[data-screen="income"]').click();
    await page.waitForSelector("#kg-income-screen.is-active");
    await page.waitForSelector(".kg-position");
    await page.screenshot({path:`clean-income-${device.width}x${device.height}.png`,fullPage:false});
    await page.locator('#kg-nav button[data-screen="bonuses"]').click();
    await page.waitForSelector("#kg-bonuses-screen.is-active");
    await page.screenshot({path:`clean-bonuses-${device.width}x${device.height}.png`,fullPage:false});
    if(pageErrors.length)throw new Error("browser errors: "+pageErrors.join("; "));
    await page.close();
  }
}finally{
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}

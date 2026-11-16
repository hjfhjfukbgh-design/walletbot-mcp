// Operações do bot usadas pelos comandos do Telegram e pela API da Mini App.
import { riskLimits, type Env } from "./env";
import { connectWalt, currentPrice } from "./bot";
import { publicContracts, publicMid } from "./prices";
import { cachedContracts, loadState, saveState } from "./state";
import { marketAllowed } from "./risk";
import { notional, sizeError, step, stopLossPrice, validateConfig, type GridConfig } from "./strategy/grid";
import { findContract, type Walt } from "./walt";

export async function walt(env: Env): Promise<Walt> {
  const w = await connectWalt(env);
  if (!w) throw new Error("Walt não conectado — use /connect");
  return w;
}

export async function stopGrid(env: Env): Promise<string> {
  const s = await loadState(env);
  s.running = false;
  await saveState(env, s);
  return "Grid parado. A posição aberta (se houver) continua com TP/SL no Walt. /closeall para fechar.";
}

export async function resumeGrid(env: Env): Promise<string> {
  const s = await loadState(env);
  s.paused = undefined;
  s.day = undefined; // recomeça a contagem de perda diária
  await saveState(env, s);
  return "Pausa removida. O próximo tick roda normalmente.";
}

export async function configureGrid(env: Env, args: string[]): Promise<string> {
  const limits = riskLimits(env);
  const market = (args[0] ?? "BTC").toUpperCase();
  if (!marketAllowed(limits, market)) return `Mercado fora da whitelist: ${limits.allowedMarkets.join(", ")}`;
  const state = await loadState(env);
  const contract = state.mode === "live"
    ? findContract(await cachedContracts(env, async () => (await walt(env)).contracts()), market)
    : findContract(await publicContracts(), market);
  if (!contract) return `Mercado ${market} não encontrado na lista pública ou no Walt.`;
  if ((contract.volume24hUsd ?? 0) < limits.minVolume24hUsd)
    return `${market} tem volume 24h de $${Math.round(contract.volume24hUsd ?? 0).toLocaleString("en-US")}, abaixo do mínimo de $${limits.minVolume24hUsd.toLocaleString("en-US")} (pouca liquidez).`;
  if (args.length < 5) {
    // sugestão pronta para copiar: faixa de −6% a +2% do preço atual
    const price = state.mode === "live" ? await (await walt(env)).rate(contract) : await publicMid(market);
    const d = contract.priceDecimals;
    const lo = (price * 0.94).toFixed(d);
    const hi = (price * 1.02).toFixed(d);
    return [
      `Preço atual de ${market}: $${price}`,
      "",
      "Uso: /grid <mercado> <low> <high> <degraus> <margemUSD por trade> [alavancagem]",
      "Sugestão (faixa −6% a +2%, 8 degraus, $5 de margem, 3x) — copie e envie:",
      `/grid ${market} ${lo} ${hi} 8 5 3`,
    ].join("\n");
  }
  const cfg: GridConfig = {
    market,
    contract,
    low: Number(args[1]),
    high: Number(args[2]),
    levels: Number(args[3]),
    marginUsd: Number(args[4]),
    leverage: Math.min(Math.trunc(Number(args[5] ?? 1)), limits.maxLeverage),
  };
  const err = validateConfig(cfg);
  if (err) return `Config inválida: ${err}`;
  const s = await loadState(env);
  if (s.grid?.position) return "Há uma posição aberta no grid atual. Use /closeall antes de reconfigurar.";
  const price = state.mode === "live" ? await (await walt(env)).rate(contract) : await publicMid(market);
  const sizeErr = sizeError(cfg, Math.min(price, cfg.high));
  if (sizeErr) return `Config inválida: ${sizeErr}`;
  s.grid = { cfg };
  s.running = false;
  await saveState(env, s);
  return [
    `Grid ${market} (contrato #${contract.contractId}) configurado:`,
    `• ${cfg.levels} degraus de $${step(cfg).toFixed(contract.priceDecimals)} entre $${cfg.low} e $${cfg.high} (preço atual $${price})`,
    `• Cada entrada: margem $${cfg.marginUsd} ${cfg.leverage}x ≈ $${notional(cfg).toFixed(2)} nocional, TP no degrau de cima`,
    `• Stop-loss: $${stopLossPrice(cfg, limits.stopLossPct).toFixed(contract.priceDecimals)} (para o grid)`,
    `Use /run para iniciar (modo ${s.mode}).`,
  ].join("\n");
}

export async function runGrid(env: Env): Promise<string> {
  const s = await loadState(env);
  if (!s.grid) return "Configure antes com /grid.";
  const price = await currentPrice(s.grid.cfg, s.mode === "live" ? await connectWalt(env) : null);
  const { low, high } = s.grid.cfg;
  const warn =
    price > high || price < low ? `\n⚠️ Preço fora da faixa $${low}–$${high}: só entra quando o preço chegar nela.` : "";
  s.running = true;
  s.paused = undefined;
  s.lastPrice = price;
  await saveState(env, s);
  return `▶️ Grid ${s.grid.cfg.market} iniciado em modo ${s.mode.toUpperCase()} (preço $${price}). Ticks a cada 5 min.${warn}`;
}

export async function setMode(env: Env, args: string[]): Promise<string> {
  const s = await loadState(env);
  const target = args[0]?.toLowerCase();
  if (target !== "paper" && target !== "live") return `Modo atual: ${s.mode === "paper" ? "ДЕМО" : "LIVE"}. Используйте /demo или /live CONFIRMO.`;
  if (s.grid?.position) return "Feche a posição (/closeall) antes de trocar de modo.";
  if (target === "live") {
    return "LIVE пока закрыт: сначала подключаем подтверждение каждой сделки, сверку открытых позиций и жёсткие лимиты риска. ДЕМО работает полностью без кошелька.";
  }
  s.mode = target;
  s.grid = undefined; // DEMO and LIVE use different contract identifiers
  s.running = false;
  s.day = undefined;
  await saveState(env, s);
  return `Режим ${target === "paper" ? "ДЕМО" : "LIVE"} включён. Сетка остановлена — запустите её командой /run.`;
}

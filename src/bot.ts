// Tick: preço → posição atual → (fechou por TP/SL?) → entrada no degrau → travas de risco → ordem.
import { riskLimits, type Env } from "./env";
import { McpClient } from "./mcp";
import { getAccessToken } from "./oauth";
import { publicMid } from "./prices";
import { pushEquity, pushPrice, recordTrade } from "./history";
import { checkOpen, dailyLossExceeded } from "./risk";
import { loadState, saveState, type BotState } from "./state";
import { exitHit, outOfRange, planEntry, recenter, sizeError, type GridConfig, type GridPosition } from "./strategy/grid";
import { Walt } from "./walt";

export async function connectWalt(env: Env): Promise<Walt | null> {
  const token = await getAccessToken(env);
  return token ? new Walt(new McpClient(env.WALT_MCP_URL, token)) : null;
}

export async function currentPrice(cfg: GridConfig, walt: Walt | null): Promise<number> {
  return walt ? walt.rate(cfg.contract) : publicMid(cfg.market);
}

/** PnL de uma posição do grid saindo a `exit` (inclui taxa taker na saída; a da entrada já saiu da margem). */
export function positionPnl(pos: GridPosition, exit: number, takerFeePct: number): number {
  return pos.qty * (exit - pos.entryPrice) - pos.qty * exit * takerFeePct;
}

export function paperEquity(state: BotState, price: number): number {
  const pos = state.grid?.position;
  const fee = state.grid?.cfg.contract.takerFeePct ?? 0;
  return state.paper.cash + (pos ? positionPnl(pos, price, fee) : 0);
}

/** Executa um tick e devolve as mensagens a enviar ao dono. */
export async function tick(env: Env): Promise<string[]> {
  const state = await loadState(env);
  if (!state.running || !state.grid || state.paused) return [];
  const msgs: string[] = [];
  try {
    await runTick(env, state, msgs);
    state.lastError = undefined;
  } catch (e) {
    const err = (e as Error).message;
    if (err !== state.lastError) msgs.push(`⚠️ Erro no tick: ${err}`);
    state.lastError = err;
  }
  state.lastTick = new Date().toISOString();
  await saveState(env, state);
  return msgs;
}

async function recordClose(
  env: Env,
  state: BotState,
  pos: GridPosition,
  exit: number,
  pnl: number,
  reason: "tp" | "sl" | "manual",
): Promise<void> {
  state.stats.trades++;
  state.stats.realizedPnl += pnl;
  if (pnl >= 0) state.stats.wins++;
  else state.stats.losses++;
  const cfg = state.grid!.cfg;
  await recordTrade(env, {
    at: new Date().toISOString(),
    market: cfg.market,
    event: "close",
    price: exit,
    marginUsd: pos.marginUsd,
    leverage: cfg.leverage,
    pnl,
    reason,
    mode: state.mode,
  });
  if (state.mode === "paper") pushEquity(state, state.paper.cash, true);
}

async function runTick(env: Env, state: BotState, msgs: string[]): Promise<void> {
  const grid = state.grid!;
  const { cfg } = grid;
  const limits = riskLimits(env);
  const live = state.mode === "live";
  if (live) {
    state.running = false;
    state.paused = "LIVE временно заблокирован до включения подтверждения каждой сделки и проверки лимитов риска";
    msgs.push(`⏸️ ${state.paused}`);
    return;
  }
  const walt = live ? await connectWalt(env) : null;
  if (live && !walt) {
    state.paused = "Реальный режим: нет подключения к Walt (/connect)";
    msgs.push(`⏸️ Пауза: ${state.paused}`);
    return;
  }

  const price = await currentPrice(cfg, live ? walt : null);
  state.lastPrice = price;
  pushPrice(state, cfg.market, price);
  if (live) {
    // saldo para a curva de patrimônio: no máximo uma consulta por hora
    const last = state.equity?.[state.equity.length - 1];
    if (!last || Date.now() - last[0] >= 3_600_000) pushEquity(state, await walt!.balanceUsd().catch(() => last?.[1] ?? 0));
  } else {
    pushEquity(state, paperEquity(state, price));
  }

  // 1) a posição do grid ainda está aberta?
  if (grid.position) {
    const pos = grid.position;
    let closedBy: "tp" | "sl" | null = null;
    if (live) {
      // a abertura é assíncrona no Walt: espera 2 min antes de concluir que a posição sumiu
      const recent = Date.now() - Date.parse(pos.openedAt) < 120_000;
      if (!recent && !(await walt!.openPosition(cfg.contract.contractId)))
        closedBy = price >= (pos.takeProfit + pos.stopLoss) / 2 ? "tp" : "sl";
    } else {
      closedBy = exitHit(pos, price);
    }
    if (!closedBy) return; // posição aberta: TP/SL cuidam da saída
    const exit = closedBy === "tp" ? pos.takeProfit : pos.stopLoss;
    const pnl = positionPnl(pos, exit, cfg.contract.takerFeePct);
    if (!live) state.paper.cash += pnl;
    await recordClose(env, state, pos, exit, pnl, closedBy);
    grid.position = undefined;
    if (closedBy === "tp") {
      msgs.push(`🟢 Тейк-профит ${cfg.market}, уровень ${pos.level + 1}: выход ~${exit} (результат ~${pnl.toFixed(2)})`);
    } else {
      state.running = false;
      msgs.push(`🛑 Стоп-лосс ${cfg.market}: выход ~${exit} (результат ~${pnl.toFixed(2)}). Сетка остановлена — /run для перезапуска.`);
      return;
    }
  } else if (live && (await walt!.openPosition(cfg.contract.contractId))) {
    const block = `на счёте уже есть позиция ${cfg.market}, открытая не сеткой — закройте её или используйте /closeall`;
    if (block !== state.lastBlock) msgs.push(`🚫 ${block}`);
    state.lastBlock = block;
    return;
  }

  // 2) fora da faixa e sem posição: recentra (ou avisa uma vez)
  if (outOfRange(grid.cfg, price)) {
    if (!limits.autoRecenter) {
      const block = `цена ${price} вышла за диапазон ${cfg.low}–${cfg.high} — настройте сетку заново через /grid`;
      if (block !== state.lastBlock) msgs.push(`↔️ ${block}`);
      state.lastBlock = block;
      return;
    }
    const next = recenter(grid.cfg, price, limits.recenterDownPct, limits.recenterUpPct);
    const err = sizeError(next, next.high);
    if (err) {
      const block = `не удалось перенести диапазон сетки: ${err}`;
      if (block !== state.lastBlock) msgs.push(`🚫 ${block}`);
      state.lastBlock = block;
      return;
    }
    grid.cfg = next;
    state.lastRecenter = { at: new Date().toISOString(), low: next.low, high: next.high, price };
    msgs.push(`🔄 Диапазон сетки ${next.market} перенесён: ${next.low}–${next.high} (цена ${price})`);
  }

  // 3) entrada no degrau
  const plan = planEntry(grid.cfg, price, limits.stopLossPct);
  if (!plan) return;

  const equity = live ? await walt!.balanceUsd() : paperEquity(state, price);
  const today = new Date().toISOString().slice(0, 10);
  if (state.day?.date !== today) state.day = { date: today, startEquity: equity };
  const ctx = { equityUsd: equity, openMarginUsd: 0, dayStartEquityUsd: state.day.startEquity };
  if (dailyLossExceeded(ctx, limits)) {
    state.paused = `дневной убыток достиг ${limits.maxDailyLossPct}% (${equity.toFixed(2)} против ${state.day.startEquity.toFixed(2)}). Используйте /resume`;
    msgs.push(`🛑 Pausado: ${state.paused}`);
    return;
  }
  const decision = checkOpen(cfg.market, cfg.marginUsd, cfg.leverage, ctx, live ? limits : { ...limits, allowedMarkets: ["*"] });
  if (!decision.ok) {
    const block = `entrada bloqueada pelo risco: ${decision.reason}`;
    if (block !== state.lastBlock) msgs.push(`🚫 ${block}`);
    state.lastBlock = block;
    return;
  }

  if (live) {
    try {
      await walt!.openLong(cfg.contract, cfg.marginUsd, cfg.leverage, price, plan.takeProfit, plan.stopLoss);
    } catch (e) {
      // não repetir: o guia do Walt avisa que retry cego pode abrir duas vezes
      state.paused = `не удалось открыть ордер (${(e as Error).message}). Проверьте /status и приложение Walt, затем используйте /resume`;
      msgs.push(`⏸️ Pausado: ${state.paused}`);
      return;
    }
  } else {
    state.paper.cash -= plan.qty * price * cfg.contract.takerFeePct;
  }
  grid.position = plan;
  state.lastBlock = undefined;
  await recordTrade(env, {
    at: plan.openedAt,
    market: cfg.market,
    event: "open",
    price,
    marginUsd: cfg.marginUsd,
    leverage: cfg.leverage,
    mode: state.mode,
  });
  msgs.push(
    `🔵 Покупка ${cfg.market}, уровень ${plan.level + 1}, цена ~${price}: маржа ${cfg.marginUsd}, плечо ${cfg.leverage}x | TP ${plan.takeProfit} | SL ${plan.stopLoss}${live ? "" : " (демо)"}`,
  );
}

/** Fecha a posição do grid e para (comando /closeall). */
export async function closeAll(env: Env): Promise<string> {
  const state = await loadState(env);
  if (!state.grid) return "Сетка не настроена.";
  const { cfg } = state.grid;
  const walt = state.mode === "live" ? await connectWalt(env) : null;
  state.running = false;
  if (state.mode === "live") {
    if (!walt) return "Walt не подключён — закройте позицию в приложении Walt.";
    if (await walt.openPosition(cfg.contract.contractId)) await walt.closePosition(cfg.contract.contractId);
    const pos = state.grid.position;
    if (pos) {
      const price = await currentPrice(cfg, state.mode === "live" ? walt : null);
      await recordClose(env, state, pos, price, positionPnl(pos, price, cfg.contract.takerFeePct), "manual");
    }
    state.grid.position = undefined;
    await saveState(env, state);
    return `Запрос на закрытие позиции ${cfg.market} отправлен. Сетка остановлена. Проверьте статус через /status.`;
  }
  const pos = state.grid.position;
  let msg = "Открытой позиции нет. Сетка остановлена.";
  if (pos) {
    const price = await currentPrice(cfg, walt);
    const pnl = positionPnl(pos, price, cfg.contract.takerFeePct);
    state.paper.cash += pnl;
    await recordClose(env, state, pos, price, pnl, "manual");
    state.grid.position = undefined;
    msg = `Демо-позиция закрыта по цене ${price} (результат ${pnl.toFixed(2)}). Сетка остановлена.`;
  }
  await saveState(env, state);
  return msg;
}

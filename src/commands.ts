import { riskLimits, type Env } from "./env";
import { closeAll, paperEquity } from "./bot";
import { configureGrid, resumeGrid, runGrid, setMode, stopGrid, walt } from "./service";
import { callbackParams, disconnect, getAccessToken, handleCallback, startAuthorization } from "./oauth";
import { defaultState, loadState, saveState, saveTools } from "./state";
import { notional, step } from "./strategy/grid";
import { COMMANDS, notifyOwner, type TgUpdate } from "./telegram";
import { handleTenantUpdate } from "./tenants";
import { previewReason } from "./walt";
import { loadManualPositions } from "./manual";

/** Processa um comando do dono e devolve a resposta em texto. */
export async function handleCommand(env: Env, text: string): Promise<string> {
  // endereço do redirect colado sem /code
  if (!text.trim().startsWith("/") && /[?&]code=/.test(text) && /[?&]state=/.test(text)) text = `/code ${text}`;
  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = rawCmd.replace(/^\//, "").replace(/@.*$/, "").toLowerCase();
  switch (cmd) {
    case "start":
    case "help":
      return help();
    case "status":
      return status(env);
    case "connect":
      return [
        "1) Откройте ссылку, авторизуйтесь в Walt и подтвердите действие в Telegram:",
        await startAuthorization(env),
        "",
        "2) Браузер откроет страницу http://localhost:8787/… которая не загрузится — так и должно быть.",
        "3) Скопируйте полный адрес этой страницы и отправьте сюда (с /code или без него).",
        "Сделайте это в течение нескольких минут: код быстро истекает.",
      ].join("\n");
    case "code":
      if (!args.length) return "Использование: /code <полный адрес страницы localhost после авторизации>";
      await handleCallback(env, callbackParams(args.join(" ")));
      return "✅ Walt подключён! Следующий шаг: /conta — проверить или создать Perps-счёт агента.";
    case "disconnect":
      await disconnect(env);
      return "Аккаунт Walt отключён.";
    case "conta":
      return conta(env, args[0] === "CONFIRMO");
    case "saldo":
      return `💰 ${JSON.stringify(await (await walt(env)).call("balance_get"), null, 1)}`;
    case "tools":
      return tools(env);
    case "call":
      return call(env, args);
    case "grid":
      return configureGrid(env, args);
    case "run":
      return runGrid(env);
    case "stop":
      return stopGrid(env);
    case "closeall":
      return closeAll(env);
    case "demo":
      return setMode(env, ["paper"]);
    case "live":
      return setMode(env, ["live", args[0] ?? ""]);
    case "mode":
      return setMode(env, args);
    case "risk":
      return risk(env);
    case "testalert":
      await notifyOwner(env, ["🔔 Teste de alerta do walletbot-mcp."]);
      return env.ALERT_CHAT_ID ? `Тестовое уведомление отправлено в ${env.ALERT_CHAT_ID}.` : "Тестовое уведомление отправлено (ALERT_CHAT_ID не задан: сообщение направлено вам).";
    case "resume":
      return resumeGrid(env);
    case "paper":
      return paperCmd(env, args);
    default:
      return `Comando desconhecido. ${help()}`;
  }
}

function help(): string {
  return [
    "Kripto Guru — управление демо-сеткой",
    "",
    "Основные команды:",
    "/demo — включить демо-режим без кошелька",
    "/live CONFIRMO — запросить включение LIVE",
    "/status — состояние, баланс и результат",
    "/grid — настроить рынок и параметры сетки",
    "/run — запустить сетку",
    "/stop — остановить сетку",
    "/closeall — закрыть позицию и остановить",
    "/resume — снять автоматическую паузу",
    "/paper reset — сбросить демо-счёт до $1 000 (история сохранится)",
    "",
    "Для подключения Walt в LIVE: /connect. Код авторизации отправляется через /code.",
    "В ДЕМО используются виртуальные средства и публичные рыночные данные. Реальные ордера не отправляются."
  ].join("\n");
}

async function status(env: Env): Promise<string> {
  const s = await loadState(env);
  const connected = !!(await getAccessToken(env).catch(() => null));
  const lines = [
    `Режим: ${s.mode === "paper" ? "ДЕМО" : "LIVE"} | ${s.running ? "▶️ работает" : "⏹️ остановлена"}${s.paused ? ` | ⏸️ ${s.paused}` : ""}`,
    `Walt: ${connected ? "подключён ✅" : "не подключён (/connect)"}`,
  ];
  if (s.grid) {
    const { cfg, position: p } = s.grid;
    lines.push(
      `Сетка ${cfg.market} (#${cfg.contract.contractId}): ${cfg.low}–${cfg.high}, ${cfg.levels} уровней с шагом ${step(cfg).toFixed(cfg.contract.priceDecimals)}`,
      `На сделку: маржа ${cfg.marginUsd}, плечо ${cfg.leverage}x (объём ~${notional(cfg).toFixed(2)})`,
      p
        ? `Позиция: покупка, уровень ${p.level + 1}, вход ~${p.entryPrice} | тейк-профит ${p.takeProfit} | стоп-лосс ${p.stopLoss}`
        : "Позиции нет (ожидание ценового уровня)",
    );
  } else lines.push("Сетка не настроена (/grid)");
  if (s.lastPrice) lines.push(`Последняя цена: ${s.lastPrice}`);
  lines.push(
    `Сделок: ${s.stats.trades} (прибыльных: ${s.stats.wins}, убыточных: ${s.stats.losses}) | Реализованный результат: ~${s.stats.realizedPnl.toFixed(2)}`,
  );
  if (s.mode === "paper")
    lines.push(`ДЕМО: виртуальный капитал $${(s.lastPrice ? paperEquity(s, s.lastPrice) : s.paper.cash).toFixed(2)} (начальный капитал ${s.paper.startCash})`);
  if (s.lastRecenter)
    lines.push(`Последний перенос диапазона: ${s.lastRecenter.at} → ${s.lastRecenter.low}–${s.lastRecenter.high} (цена ${s.lastRecenter.price})`);
  if (s.lastTick) lines.push(`Последнее обновление сетки: ${s.lastTick}`);
  if (s.lastError) lines.push(`Последняя ошибка: ${s.lastError}`);
  return lines.join("\n");
}

async function conta(env: Env, confirm: boolean): Promise<string> {
  const w = await walt(env);
  const r = await w.readiness();
  if (r.ok) return "✅ Perps-счёт агента готов (проверка пройдена). Перед реальным режимом пополните баланс USDC в Walt.";
  const issues = r.issues.map((i) => `• ${i.code}: ${i.description ?? ""}`).join("\n");
  if (!r.issues.some((i) => i.code === "agent.account.not_found")) return `⚠️ Что нужно исправить:\n${issues}`;
  if (!confirm) {
    const p = await w.preview("perps_prepare_account_create", {});
    return [
      `Perps-счёт этого агента ещё не создан:\n${issues}`,
      "",
      p.ok ? "Предварительная проверка пройдена. Для создания отправьте: /conta CONFIRMO" : `Создание отклонено при предварительной проверке: ${previewReason(p)}`,
    ].join("\n");
  }
  await w.createAccount();
  return "Запрос на создание отправлен ✅ (операция асинхронная). Через несколько секунд выполните /conta ещё раз для проверки.";
}

async function tools(env: Env): Promise<string> {
  const w = await walt(env);
  const list = await w.listTools();
  await saveTools(env, list);
  return [
    `Инструменты Walt (${list.length}):`,
    ...list.map((t) => `• ${t.name}(${Object.keys(t.inputSchema?.properties ?? {}).join(", ")})`),
    "",
    "Schemas completos: /tools.json?secret=<TELEGRAM_WEBHOOK_SECRET>",
  ].join("\n");
}

async function call(env: Env, args: string[]): Promise<string> {
  const tool = args[0];
  if (!tool) return "Использование: /call <инструмент> [json]";
  if (tool === "perps_execute_operation") return "Используйте команды бота для операций: это предотвращает повторное выполнение.";
  let params: Record<string, unknown> = {};
  if (args.length > 1) {
    try {
      params = JSON.parse(args.slice(1).join(" "));
    } catch {
      return "Некорректный JSON.";
    }
  }
  const data = await (await walt(env)).call(tool, params);
  return `✅ ${tool}\n${typeof data === "string" ? data : JSON.stringify(data, null, 1)}`;
}




function risk(env: Env): string {
  const l = riskLimits(env);
  return [
    "Ограничения риска:",
    "• Плечо: по лимиту выбранного контракта",
    `• Максимальная маржа на сделку: ${l.maxOrderPct}% капитала`,
    `• Максимальный дневной убыток: ${l.maxDailyLossPct}% (бот остановится)`,
    `• Стоп-лосс: ${l.stopLossPct}% ниже нижней границы сетки (на Walt через авто закрытие)`,
    `• Разрешённые рынки: ${l.allowedMarkets.join(", ")}`,
    `• Автоматический перенос диапазона: ${l.autoRecenter ? `включён (−${l.recenterDownPct}% / +${l.recenterUpPct}% от цены)` : "выключен"}`,
  ].join("\n");
}

async function paperCmd(env: Env, args: string[]): Promise<string> {
  if (args[0] !== "reset") return "Использование: /paper reset [сумма]";
  const s = await loadState(env);
  if (s.mode !== "paper") return "Доступно только в демо-режиме.";
  if ((await loadManualPositions(env)).length) return "Перед сбросом закройте все ручные демо-позиции.";
  const cash = Number(args[1] ?? 1000);
  if (!(cash > 0)) return "Некорректный баланс.";
  const fresh = defaultState();
  fresh.paper = { cash, startCash: cash };
  if (s.grid) fresh.grid = { cfg: s.grid.cfg };
  await saveState(env, fresh);
  return `Демо-счёт сброшен до ${cash}.`;
}

/** Route every private Telegram chat to its isolated tenant namespace. */
export async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  await handleTenantUpdate(env, update);
}

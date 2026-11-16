import type { Env } from "./env";

export interface TgUpdate {
  message?: { chat: { id: number; type?: string }; from?: { id: number }; text?: string };
}

export async function tg(env: Env, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function send(env: Env, chatId: string | number, text: string): Promise<void> {
  // limite do Telegram: 4096 caracteres por mensagem
  for (let i = 0; i < text.length; i += 4000) {
    await tg(env, "sendMessage", { chat_id: chatId, text: text.slice(i, i + 4000), disable_web_page_preview: true });
  }
}

/** Alertas automáticos: vão para ALERT_CHAT_ID (canal) se configurado; se o envio falhar, caem no dono. */
export async function notifyOwner(env: Env, msgs: string[]): Promise<void> {
  if (msgs.length === 0) return;
  const text = msgs.join("\n");
  if (env.ALERT_CHAT_ID) {
    const res = (await tg(env, "sendMessage", { chat_id: env.ALERT_CHAT_ID, text, disable_web_page_preview: true })) as {
      ok?: boolean;
      description?: string;
    };
    if (res.ok) return;
    if (env.OWNER_CHAT_ID)
      await send(env, env.OWNER_CHAT_ID, `⚠️ Не удалось отправить сообщение в канал ${env.ALERT_CHAT_ID} (${res.description ?? "ошибка"}). Уведомление:\n${text}`);
    return;
  }
  if (env.OWNER_CHAT_ID) await send(env, env.OWNER_CHAT_ID, text);
}

export const COMMANDS: Array<[string, string]> = [
  ["start", "Открыть главное меню"],
  ["help", "Список команд"],
  ["demo", "Включить демо без кошелька"],
  ["live", "Запросить включение LIVE"],
  ["status", "Состояние бота и результат"],
  ["grid", "Настроить торговую сетку"],
  ["run", "Запустить сетку"],
  ["stop", "Остановить сетку"],
  ["closeall", "Закрыть позицию и остановить"],
  ["resume", "Снять автоматическую паузу"],
  ["connect", "Подключить Walt для LIVE"],
];

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

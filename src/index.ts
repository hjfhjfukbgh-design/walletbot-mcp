import { tick } from "./bot";
import { handleApi } from "./api";
import { handleCompanionApi } from "./companion";
import { handleUpdate } from "./commands";
import type { Env } from "./env";
import { handleCallback } from "./oauth";
import { loadTools } from "./state";
import { handleTenantTick, listTenantIds, oauthTenantId, tenantEnv } from "./tenants";
import { send } from "./telegram";
import { monitorManualTrades } from "./manual";
import { TradingEngine } from "./trading/engine";

export { TradingEngine };
import { COMMANDS, tg, timingSafeEqual, type TgUpdate } from "./telegram";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/telegram") {
      const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))
        return new Response("forbidden", { status: 403 });
      const update = (await req.json()) as TgUpdate;
      // responde 200 na hora para o Telegram não reenviar; processa em segundo plano
      ctx.waitUntil(handleUpdate(env, update));
      return new Response("ok");
    }

    if (url.pathname.startsWith("/api/companion")) return handleCompanionApi(req, env);
    if (url.pathname.startsWith("/api/")) return handleApi(req, env, ctx);

    if (req.method === "GET" && url.pathname === "/oauth/callback") {
      try {
        const stateId = url.searchParams.get("state") ?? "";
        const userId = await oauthTenantId(env, stateId);
        if (!userId) throw new Error("Параметр OAuth state неизвестен или истёк. Вернитесь в Telegram и выполните /connect ещё раз.");
        const scoped = tenantEnv(env, userId);
        await handleCallback(scoped, url.searchParams);
        ctx.waitUntil(send(env, userId, "✅ Walt подключён! Используйте /tools, чтобы посмотреть инструменты и проверить их соответствие."));
        return html("Walt подключён ✅", "Эту страницу можно закрыть и вернуться в Telegram.");
      } catch (e) {
        return html("Ошибка подключения", (e as Error).message, 400);
      }
    }

    if (req.method === "GET" && url.pathname === "/setup") {
      const secret = url.searchParams.get("secret") ?? "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))
        return new Response("forbidden", { status: 403 });
      const requireTelegramOk = (method: string, result: unknown) => {
        const value = result as { ok?: boolean; description?: string };
        if (value?.ok !== true) {
          throw new Error(`Telegram ${method} отклонил запрос: ${value?.description ?? "ответ ok не подтверждён"}`);
        }
        return result;
      };
      const webhook = requireTelegramOk("setWebhook", await tg(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      }));
      const commands = requireTelegramOk("setMyCommands", await tg(env, "setMyCommands", {
        commands: COMMANDS.map(([command, description]) => ({ command, description })),
      }));
      const menu = env.MINIAPP_URL
        ? requireTelegramOk("setChatMenuButton(default)", await tg(env, "setChatMenuButton", {
            scope: { type: "default" },
            menu_button: { type: "web_app", text: "Панель", web_app: { url: env.MINIAPP_URL } },
          }))
        : "MINIAPP_URL не задан";
      // Устанавливаем кнопку также явно для личного чата владельца:
      // Telegram может хранить персональную настройку меню отдельно от настройки по умолчанию.
      const ownerMenu = env.MINIAPP_URL && env.OWNER_CHAT_ID
        ? requireTelegramOk("setChatMenuButton(owner)", await tg(env, "setChatMenuButton", {
            chat_id: Number(env.OWNER_CHAT_ID),
            menu_button: { type: "web_app", text: "Панель", web_app: { url: env.MINIAPP_URL } },
          }))
        : "OWNER_CHAT_ID не задан";
      const readDefaultMenu = requireTelegramOk("getChatMenuButton(default)", await tg(env, "getChatMenuButton", { scope: { type: "default" } }));
      const readOwnerMenu = env.OWNER_CHAT_ID
        ? requireTelegramOk("getChatMenuButton(owner)", await tg(env, "getChatMenuButton", { chat_id: Number(env.OWNER_CHAT_ID) }))
        : "OWNER_CHAT_ID не задан";
      return Response.json({ webhook, commands, menu, ownerMenu, readDefaultMenu, readOwnerMenu, expectedMiniappUrl: env.MINIAPP_URL });
    }

    // tools/list completo salvo pelo último /tools (protegido pelo mesmo segredo do webhook)
    if (req.method === "GET" && url.pathname === "/tools.json") {
      const secret = url.searchParams.get("secret") ?? "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))
        return new Response("forbidden", { status: 403 });
      return new Response(JSON.stringify((await loadTools(env)) ?? [], null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    return env.ASSETS ? env.ASSETS.fetch(req) : new Response("static assets not configured", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        // Cada usuário roda em namespace isolado; notificações nunca vão para outro usuário.
        const userIds = await listTenantIds(env);
        await Promise.all(userIds.map((userId) => handleTenantTick(env, userId, async (scoped) => [...await tick(scoped), ...await monitorManualTrades(scoped)])));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

function html(title: string, body: string, status = 200): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1>${esc(title)}</h1><p>${esc(body)}</p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

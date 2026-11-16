import { tick } from "./bot";
import { handleApi } from "./api";
import { handleUpdate } from "./commands";
import type { Env } from "./env";
import { handleCallback } from "./oauth";
import { loadTools } from "./state";
import { handleTenantTick, listTenantIds, oauthTenantId, tenantEnv } from "./tenants";
import { send } from "./telegram";
import { COMMANDS, notifyOwner, tg, timingSafeEqual, type TgUpdate } from "./telegram";

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

    if (url.pathname.startsWith("/api/")) return handleApi(req, env, ctx);

    if (req.method === "GET" && url.pathname === "/oauth/callback") {
      try {
        const stateId = url.searchParams.get("state") ?? "";
        const userId = await oauthTenantId(env, stateId);
        if (!userId) throw new Error("OAuth state desconhecido ou expirado. Volte ao Telegram e use /connect novamente.");
        const scoped = tenantEnv(env, userId);
        await handleCallback(scoped, url.searchParams);
        ctx.waitUntil(send(env, userId, "✅ Walt conectado! Use /tools para ver as tools e revisar o mapeamento."));
        return html("Walt conectado ✅", "Pode fechar esta página e voltar ao Telegram.");
      } catch (e) {
        return html("Falha na conexão", (e as Error).message, 400);
      }
    }

    if (req.method === "GET" && url.pathname === "/setup") {
      const secret = url.searchParams.get("secret") ?? "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))
        return new Response("forbidden", { status: 403 });
      // Com o Telegram Serverless ligado o webhook é do tgcloud (que encaminha para /api/telegram);
      // só registra o webhook direto no Worker quando não há Mini App configurada.
      const webhook = env.MINIAPP_URL
        ? "gerenciado pelo Telegram Serverless"
        : await tg(env, "setWebhook", {
            url: `${url.origin}/telegram`,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ["message"],
            drop_pending_updates: true,
          });
      const commands = await tg(env, "setMyCommands", {
        commands: COMMANDS.map(([command, description]) => ({ command, description })),
      });
      const menu = env.MINIAPP_URL
        ? await tg(env, "setChatMenuButton", {
            menu_button: { type: "web_app", text: "Painel", web_app: { url: env.MINIAPP_URL } },
          })
        : "sem MINIAPP_URL";
      return Response.json({ webhook, commands, menu });
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

    return new Response("walletbot-mcp ok");
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        // Cada usuário roda em namespace isolado; notificações nunca vão para outro usuário.
        const userIds = await listTenantIds(env);
        await Promise.all(userIds.map((userId) => handleTenantTick(env, userId, tick)));
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

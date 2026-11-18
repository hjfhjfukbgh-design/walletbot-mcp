import { handleCompanionApi } from "./companion";
import type { Env } from "./env";

/**
 * Minimal preview surface for validating Gemini integration.
 * It deliberately exposes only the companion API and static Mini App assets:
 * no trading API, Telegram webhook, OAuth callback, cron, or production bindings.
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/companion")) {
      return handleCompanionApi(req, env);
    }
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

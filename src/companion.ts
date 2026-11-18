import type { Env } from "./env";
import { tenantEnv } from "./tenants";

type CompanionSource = { title: string; url: string };
type ChatMessage = { role: "user" | "assistant"; content: string; createdAt: string; sources?: CompanionSource[] };
type CompanionMode = "general" | "learning" | "research";
type Conversation = { id: string; title: string; createdAt: string; updatedAt: string; messages: ChatMessage[]; mode?: CompanionMode };

const PREFIX = "companion:conversation:";
const MAX_MESSAGE_CHARS = 4_000;
const MAX_STORED_MESSAGES = 20;
const MAX_CONTEXT_MESSAGES = 8;
const MAX_OUTPUT_TOKENS = 450;
const RATE_LIMIT = 8;
const RATE_WINDOW_SECONDS = 60;
const MAX_CONVERSATIONS = 50;

export async function handleCompanionApi(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE")
    return json({ ok: false, error: "Метод не поддерживается." }, 405);

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("tma "))
    return json({ ok: false, error: "Откройте приложение через Telegram." }, 401);
  const userId = await validateTelegramInitData(authorization.slice(4), env.TELEGRAM_BOT_TOKEN);
  if (!userId) return json({ ok: false, error: "Сессия Telegram недействительна или устарела. Перезапустите приложение." }, 401);

  const scoped = tenantEnv(env, userId);
  const path = new URL(req.url).pathname;
  try {
    if (req.method === "GET" && path === "/api/companion/limits") {
      return json({ ok: true, limits: {
        messagesPerWindow: RATE_LIMIT,
        rateWindowSeconds: RATE_WINDOW_SECONDS,
        maxMessageChars: MAX_MESSAGE_CHARS,
        maxStoredMessages: MAX_STORED_MESSAGES,
        maxContextMessages: MAX_CONTEXT_MESSAGES,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxConversations: MAX_CONVERSATIONS,
      } });
    }

    if (req.method === "GET" && path === "/api/companion/conversations") {
      const page = await scoped.STATE.list({ prefix: PREFIX, limit: 50 });
      const conversations = await Promise.all(page.keys.map(async ({ name }) => {
        const item = await scoped.STATE.get<Conversation>(name, "json");
        return item ? { id: item.id, title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt, messageCount: item.messages.length, mode: item.mode ?? "general" } : null;
      }));
      return json({ ok: true, conversations: conversations.filter(Boolean).sort((a, b) => b!.updatedAt.localeCompare(a!.updatedAt)) });
    }

    const match = path.match(/^\/api\/companion\/conversations\/([a-f0-9-]{36})$/i);
    if (match && req.method === "GET") {
      const conversation = await scoped.STATE.get<Conversation>(PREFIX + match[1], "json");
      return conversation ? json({ ok: true, conversation }) : json({ ok: false, error: "Диалог не найден." }, 404);
    }
    if (match && req.method === "DELETE") {
      await scoped.STATE.delete(PREFIX + match[1]);
      return json({ ok: true });
    }

    if (req.method !== "POST" || path !== "/api/companion/chat")
      return json({ ok: false, error: "Маршрут не найден." }, 404);
    if (!env.GEMINI_API_KEY)
      return json({ ok: false, error: "ИИ временно не настроен: отсутствует серверный ключ Gemini." }, 503);

    const body = await req.json().catch(() => ({})) as { message?: unknown; conversationId?: unknown; attachments?: unknown; mode?: unknown };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (body.mode !== undefined && body.mode !== "general" && body.mode !== "learning" && body.mode !== "research") return json({ ok: false, error: "Неизвестный режим AI Companion." }, 400);
    const mode: CompanionMode = body.mode === "learning" ? "learning" : body.mode === "research" ? "research" : "general";
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (!message && !rawAttachments.length) return json({ ok: false, error: "Напишите сообщение или приложите файл." }, 400);
    if (rawAttachments.length > 4) return json({ ok: false, error: "Можно приложить не больше 4 файлов." }, 400);
    const attachments: Array<{ name: string; mimeType: string; dataBase64: string }> = [];
    let totalBytes = 0;
    for (const item of rawAttachments) {
      if (!item || typeof item !== "object") return json({ ok: false, error: "Некорректное вложение." }, 400);
      const file = item as { name?: unknown; mimeType?: unknown; dataBase64?: unknown };
      const mimeType = typeof file.mimeType === "string" ? file.mimeType.toLowerCase() : "";
      const name = typeof file.name === "string" ? file.name.slice(0, 120) : "Вложение";
      const dataBase64 = typeof file.dataBase64 === "string" ? file.dataBase64 : "";
      if (!/^(image\/(jpeg|png|webp|gif)|audio\/(mpeg|mp3|wav|aac|ogg|flac|webm|mp4|m4a)|video\/(mp4|webm))$/.test(mimeType))
        return json({ ok: false, error: "Формат файла не поддерживается." }, 415);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64) || dataBase64.length % 4 !== 0)
        return json({ ok: false, error: "Файл повреждён или имеет неверный формат." }, 400);
      const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
      const size = dataBase64.length / 4 * 3 - padding;
      if (!size || size > 5 * 1024 * 1024) return json({ ok: false, error: "Размер файла должен быть не больше 5 МБ." }, 413);
      if (mimeType.startsWith("video/")) {
        const expectedExtension = mimeType === "video/mp4" ? /\.mp4$/i : /\.webm$/i;
        if (!expectedExtension.test(name)) return json({ ok: false, error: "Расширение видео не соответствует его MIME-типу." }, 415);
        let decoded: string;
        try {
          decoded = atob(dataBase64);
        } catch {
          return json({ ok: false, error: "Видео повреждено или имеет неверное кодирование." }, 400);
        }
        if (decoded.length !== size) return json({ ok: false, error: "Размер видео не соответствует закодированным данным." }, 400);
        if (mimeType === "video/mp4") {
          if (decoded.length < 16 || decoded.slice(4, 8) !== "ftyp") return json({ ok: false, error: "Файл не прошёл проверку контейнера MP4." }, 415);
          const boxSize = decoded.charCodeAt(0) * 0x1000000 + decoded.charCodeAt(1) * 0x10000 + decoded.charCodeAt(2) * 0x100 + decoded.charCodeAt(3);
          if (boxSize < 16 || boxSize > decoded.length) return json({ ok: false, error: "Заголовок контейнера MP4 повреждён." }, 400);
        } else if (decoded.length < 4 || decoded.charCodeAt(0) !== 0x1a || decoded.charCodeAt(1) !== 0x45 || decoded.charCodeAt(2) !== 0xdf || decoded.charCodeAt(3) !== 0xa3) {
          return json({ ok: false, error: "Файл не прошёл проверку контейнера WebM." }, 415);
        }
      }
      totalBytes += size;
      if (totalBytes > 8 * 1024 * 1024) return json({ ok: false, error: "Общий размер вложений — максимум 8 МБ." }, 413);
      attachments.push({ name, mimeType, dataBase64 });
    }
    if (message.length > MAX_MESSAGE_CHARS)
      return json({ ok: false, error: `Сообщение слишком длинное. Максимум ${MAX_MESSAGE_CHARS} символов.` }, 413);

    let conversation: Conversation;
    const requestedId = typeof body.conversationId === "string" ? body.conversationId : "";
    if (!requestedId) {
      const existingConversations = await scoped.STATE.list({ prefix: PREFIX, limit: MAX_CONVERSATIONS });
      if (existingConversations.keys.length >= MAX_CONVERSATIONS) {
        return json({ ok: false, error: "Достигнут лимит в 50 диалогов. Удалите старый диалог, чтобы создать новый." }, 409);
      }
    }
    if (requestedId) {
      if (!/^[a-f0-9-]{36}$/i.test(requestedId)) return json({ ok: false, error: "Некорректный ID диалога." }, 400);
      const existing = await scoped.STATE.get<Conversation>(PREFIX + requestedId, "json");
      if (!existing) return json({ ok: false, error: "Диалог не найден." }, 404);
      const existingMode = existing.mode ?? "general";
      if (existingMode !== mode) return json({ ok: false, error: "Режим диалога нельзя менять в середине истории. Создайте новый чат для другого режима." }, 409);
      conversation = { ...existing, mode: existingMode };
    } else {
      const now = new Date().toISOString();
      conversation = { id: crypto.randomUUID(), title: (message || attachments.map(file => file.name).join(", ") || "Вложения").slice(0, 72), createdAt: now, updatedAt: now, messages: [], mode };
    }

    const userContent = message || "Проанализируй приложенные файлы.";
    const history = [...conversation.messages, { role: "user" as const, content: userContent, createdAt: new Date().toISOString() }].slice(-MAX_CONTEXT_MESSAGES);
    const model = (env.GEMINI_MODEL || "gemini-3.5-flash-lite").trim();
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(model)) return json({ ok: false, error: "Некорректная настройка модели Gemini." }, 500);

    // Invalid requests must not consume the user's Gemini message quota.
    const rateKey = "companion:rate:" + Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000));
    const current = (await scoped.STATE.get<number>(rateKey, "json")) ?? 0;
    if (current >= RATE_LIMIT) return json({ ok: false, error: "Слишком много сообщений. Подождите минуту." }, 429);
    await scoped.STATE.put(rateKey, JSON.stringify(current + 1), { expirationTtl: RATE_WINDOW_SECONDS + 5 });

    // Conservative free-tier guard for Google Search grounding (Gemini 3+).
    // Reserve 40 search-query units per research prompt; hard cap: 1,000/month globally, 200/user.
    const researchMonth = new Date().toISOString().slice(0, 7);
    const researchGlobalKey = "companion:research:global:" + researchMonth;
    const researchUserKey = "companion:research:user:" + researchMonth;
    const researchGlobalUsed = (await env.STATE.get<number>(researchGlobalKey, "json")) ?? 0;
    const researchUserUsed = (await scoped.STATE.get<number>(researchUserKey, "json")) ?? 0;
    if (mode === "research") {
      if (researchGlobalUsed + 40 > 1_000 || researchUserUsed + 40 > 200)
        return json({ ok: false, error: "Месячный бесплатный лимит веб-исследований исчерпан. Попробуйте в следующем месяце." }, 429);
      await env.STATE.put(researchGlobalKey, JSON.stringify(researchGlobalUsed + 40), { expirationTtl: 45 * 24 * 60 * 60 });
      await scoped.STATE.put(researchUserKey, JSON.stringify(researchUserUsed + 40), { expirationTtl: 45 * 24 * 60 * 60 });
    }

    let response: Response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: mode === "learning" ? "Ты — интерактивный преподаватель Kripto Guru. Обучай криптотрейдингу на русском с нуля и по шагам: краткая цель, понятное объяснение, безопасный пример, затем один контрольный вопрос или небольшое упражнение. Подстраивай сложность под ответы ученика и исправляй ошибки корректно. Объясняй свечи, LONG/SHORT, плечо, маржу, комиссии, ликвидацию, стоп-лосс, риск-менеджмент и различие DEMO/LIVE. Не обещай доходность, не давай персональных указаний купить/продать и не исполняй сделки. У тебя нет доступа к счетам и торговым API. Не проси пароли, API-ключи и секреты." : "Ты — Kripto Guru AI Companion, универсальный русскоязычный ИИ-помощник. Отвечай ясно, по делу и естественно. Помогай с повседневными вопросами, обучением, технологиями, работой и планированием. Не утверждай, что выполняешь действия вне чата. У тебя нет доступа к счетам, API-инструментам или исполнению сделок. Если обсуждается рынок или трейдинг, отделяй факты от предположений и не обещай доходность. Не проси у пользователя пароли, API-ключи и секреты." }] },
          contents: history.map((item, index) => ({
            role: item.role === "assistant" ? "model" : "user",
            parts: [
              { text: item.content },
              ...(index === history.length - 1 ? attachments.map(file => ({ inlineData: { mimeType: file.mimeType, data: file.dataBase64 } })) : []),
            ],
          })),
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.7 },
        }),
        signal: AbortSignal.timeout(25_000),
      });
    } catch (error) {
      console.error("[companion] Gemini request failed:", error instanceof Error ? error.name : "unknown");
      return json({ ok: false, error: "Gemini не ответил вовремя. Попробуйте ещё раз." }, 504);
    }

    const payload = await response.json().catch(() => null) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } } | null;
    if (!response.ok) {
      const providerMessage = payload?.error?.message ?? "unknown provider error";
      console.error("[companion] Gemini API rejected request:", response.status, providerMessage.slice(0, 300));
      if (response.status === 429) return json({ ok: false, error: "Лимит запросов Gemini исчерпан. Попробуйте через минуту." }, 429);
      if (response.status === 401 || response.status === 403) return json({ ok: false, error: "Gemini отклонил API-ключ. Нужно проверить ключ в настройках сервера." }, 503);
      if (response.status === 404) return json({ ok: false, error: "Выбранная модель Gemini недоступна. Проверьте настройку GEMINI_MODEL." }, 503);
      if (response.status === 400) return json({ ok: false, error: "Gemini отклонил формат запроса. Проверьте настройки модели." }, 502);
      return json({ ok: false, error: "Сервис Gemini временно недоступен. Попробуйте ещё раз." }, response.status >= 500 ? 503 : 502);
    }
    const answer = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!answer) return json({ ok: false, error: "ИИ вернул пустой ответ. Попробуйте переформулировать вопрос." }, 502);

    const now = new Date().toISOString();
    const attachmentLabel = attachments.length ? "\n[Вложения: " + attachments.map(file => file.name).join(", ") + "]" : "";
    const updatedMessages: ChatMessage[] = [...conversation.messages, { role: "user", content: userContent + attachmentLabel, createdAt: now }, { role: "assistant", content: answer, createdAt: now }];
    conversation.messages = updatedMessages.slice(-MAX_STORED_MESSAGES);
    conversation.updatedAt = now;
    await scoped.STATE.put(PREFIX + conversation.id, JSON.stringify(conversation));
    return json({ ok: true, conversationId: conversation.id, answer, conversation });
  } catch (error) {
    console.error("[companion] request failed", error instanceof Error ? error.message : "unknown error");
    return json({ ok: false, error: "Внутренняя ошибка AI Companion." }, 500);
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function validateTelegramInitData(initData: string, botToken: string): Promise<string | null> {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash") ?? "";
    const authDate = Number(params.get("auth_date") ?? 0);
    const now = Math.floor(Date.now() / 1000);
    if (!/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(authDate) || authDate < now - 86_400 || authDate > now + 60) return null;
    params.delete("hash");
    const pairs: Array<[string, string]> = [];
    params.forEach((value, key) => pairs.push([key, value]));
    const checkString = pairs.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("\n");
    const encoder = new TextEncoder();
    const hmac = async (keyBytes: Uint8Array, data: string) => {
      const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
    };
    // Telegram Web Apps HMAC: HMAC-SHA256(key="WebAppData", message=botToken).
    const secret = await hmac(encoder.encode("WebAppData"), botToken);
    const actual = [...await hmac(secret, checkString)].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (actual.length !== hash.length) return null;
    let mismatch = 0;
    for (let i = 0; i < actual.length; i++) mismatch |= actual.charCodeAt(i) ^ hash.toLowerCase().charCodeAt(i);
    if (mismatch !== 0) return null;
    const user = JSON.parse(params.get("user") ?? "{}") as { id?: number | string };
    return user.id && /^\d{1,20}$/.test(String(user.id)) ? String(user.id) : null;
  } catch { return null; }
}

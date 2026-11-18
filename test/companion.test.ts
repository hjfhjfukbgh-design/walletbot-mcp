import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCompanionApi } from "../src/companion";
import type { Env } from "../src/env";
import { env as baseEnv, memoryQuota } from "./helpers";

function isolatedEnv(seed: Record<string, string> = {}, quotaSeed: Record<string, number> = {}): Env {
  const e = baseEnv();
  e.COMPANION_QUOTA = memoryQuota(quotaSeed);
  const values = new Map<string, string>(Object.entries(seed));
  e.STATE = {
    get: async (key: string, type?: string) => {
      const value = values.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
    list: async (options?: { prefix?: string; limit?: number }) => ({
      keys: [...values.keys()]
        .filter((key) => key.startsWith(options?.prefix ?? ""))
        .slice(0, options?.limit ?? 1000)
        .map((name) => ({ name, expiration: undefined, metadata: undefined })),
      list_complete: true,
    }),
  } as unknown as KVNamespace;
  e.GEMINI_API_KEY = "test-gemini-secret";
  return e;
}

async function signedInitData(botToken: string, userId: string, authDate = Math.floor(Date.now() / 1000)): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    user: JSON.stringify({ id: Number(userId), first_name: "Test" }),
  });
  const encoder = new TextEncoder();
  const hmac = async (keyBytes: Uint8Array, value: string) => {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  };
  // Telegram Web Apps test signature: HMAC-SHA256(key="WebAppData", message=botToken).
  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const hash = [...await hmac(secret, checkString)].map((value) => value.toString(16).padStart(2, "0")).join("");
  params.set("hash", hash);
  return params.toString();
}

async function call(e: Env, userId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const initData = await signedInitData(e.TELEGRAM_BOT_TOKEN, userId);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `tma ${initData}`);
  return handleCompanionApi(new Request(`https://worker.test${path}`, { ...init, headers }), e);
}

describe("AI Companion API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects requests without valid Telegram initData", async () => {
    const e = isolatedEnv();
    const response = await handleCompanionApi(new Request("https://worker.test/api/companion/conversations"), e);
    expect(response.status).toBe(401);
  });

  it("rejects correctly signed but expired Telegram initData", async () => {
    const e = isolatedEnv();
    const expired = await signedInitData(e.TELEGRAM_BOT_TOKEN, "111", Math.floor(Date.now() / 1000) - 86_401);
    const response = await handleCompanionApi(new Request("https://worker.test/api/companion/conversations", {
      headers: { Authorization: `tma ${expired}` },
    }), e);
    expect(response.status).toBe(401);
  });

  it("sends messages to Gemini server-side and persists tenant-scoped conversation history", async () => {
    const e = isolatedEnv();
    let sentHeaders: Headers | undefined;
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/v1beta/models/gemini-3.5-flash-lite:generateContent");
      sentHeaders = new Headers(init?.headers);
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ candidates: [{ content: { parts: [{ text: "Привет! Я на связи." }] } }] });
    });

    const response = await call(e, "111", "/api/companion/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Привет" }),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { answer: string; conversationId: string; conversation: { messages: Array<{ role: string; content: string }> } };
    expect(result.answer).toBe("Привет! Я на связи.");
    expect(result.conversation.messages.map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(sentHeaders?.get("x-goog-api-key")).toBe("test-gemini-secret");
    expect(JSON.stringify(sentBody)).toContain("Привет");
    expect(JSON.stringify(result)).not.toContain("test-gemini-secret");

    const ownHistory = await call(e, "111", "/api/companion/conversations");
    expect(await ownHistory.json()).toMatchObject({ conversations: [{ id: result.conversationId, title: "Привет", messageCount: 2 }] });
    const otherHistory = await call(e, "222", "/api/companion/conversations");
    expect(await otherHistory.json()).toMatchObject({ conversations: [] });
  });

  it("uses real Google Search grounding and persists verified source links in research mode", async () => {
    const e = isolatedEnv();
    let sentBody: any;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toContain("/models/gemini-2.5-flash-lite:generateContent");
      sentBody = JSON.parse(String(init?.body));
      return Response.json({ candidates: [{
        content: { parts: [{ text: "Подтверждённый обзор." }] },
        groundingMetadata: {
          webSearchQueries: ["проверка источников"],
          groundingChunks: [{ web: { uri: "https://example.com/report", title: "Первичный отчёт" } }],
        },
      }] });
    });
    const response = await call(e, "111", "/api/companion/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Сделай исследование", mode: "research" }),
    });
    expect(response.status).toBe(200);
    expect(sentBody.tools).toEqual([{ googleSearchRetrieval: {} }]);
    const result = await response.json() as { sources: Array<{ title: string; url: string }>; conversation: { mode: string; messages: Array<{ sources?: Array<{ title: string; url: string }> }> } };
    expect(result.sources).toEqual([{ title: "Первичный отчёт", url: "https://example.com/report" }]);
    expect(result.conversation.mode).toBe("research");
    expect(result.conversation.messages[1].sources).toEqual(result.sources);
  });

  it("does not fabricate sources when Google Search grounding returns none", async () => {
    const e = isolatedEnv();
    const fetchMock = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: "Неподтверждённый текст." }] }, groundingMetadata: { groundingChunks: [] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await call(e, "111", "/api/companion/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Исследуй", mode: "research" }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("проверяемых источников") });
  });

  it("blocks research when the free-tier daily budget guard is exhausted", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const e = isolatedEnv({}, { ["research:global:" + day]: 20 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await call(e, "111", "/api/companion/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Исследуй", mode: "research" }),
    });
    expect(response.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends image and audio attachments to Gemini as inline media", async () => {
    const e = isolatedEnv();
    let sentBody: any;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return Response.json({ candidates: [{ content: { parts: [{ text: "Файл получен." }] } }] });
    });
    const response = await call(e, "111", "/api/companion/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Посмотри вложения", attachments: [
        { name: "photo.png", mimeType: "image/png", dataBase64: "aGVsbG8=" },
        { name: "voice.webm", mimeType: "audio/webm", dataBase64: "d29ybGQ=" },
      ] }),
    });
    expect(response.status).toBe(200);
    const parts = sentBody.contents.at(-1).parts;
    expect(parts).toContainEqual({ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } });
    expect(parts).toContainEqual({ inlineData: { mimeType: "audio/webm", data: "d29ybGQ=" } });
    const result = await response.json() as { conversation: { messages: Array<{ content: string }> } };
    expect(result.conversation.messages[0].content).toContain("photo.png");
    expect(result.conversation.messages[0].content).toContain("voice.webm");
  });

  it("rejects unsupported attachment types before calling Gemini", async () => {
    const e = isolatedEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await call(e, "111", "/api/companion/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Файл", attachments: [
        { name: "payload.exe", mimeType: "application/octet-stream", dataBase64: "aGVsbG8=" },
      ] }),
    });
    expect(response.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let another Telegram user read or delete a conversation", async () => {
    const e = isolatedEnv();
    vi.stubGlobal("fetch", async () => Response.json({ candidates: [{ content: { parts: [{ text: "Ответ" }] } }] }));
    const created = await call(e, "111", "/api/companion/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Проверка" }),
    });
    const { conversationId } = await created.json() as { conversationId: string };

    const foreignRead = await call(e, "222", `/api/companion/conversations/${conversationId}`);
    expect(foreignRead.status).toBe(404);
    await call(e, "222", `/api/companion/conversations/${conversationId}`, { method: "DELETE" });
    const ownerRead = await call(e, "111", `/api/companion/conversations/${conversationId}`);
    expect(ownerRead.status).toBe(200);
  });

  it("validates message length before calling Gemini", async () => {
    const e = isolatedEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await call(e, "111", "/api/companion/chat", {
      method: "POST",
      body: JSON.stringify({ message: "x".repeat(4001) }),
    });
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the advertised maximum of 50 conversations", async () => {
    const seed: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      seed[`tenant:111:companion:conversation:${id}`] = JSON.stringify({
        id, title: "Старый диалог", createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), messages: [],
      });
    }
    const e = isolatedEnv(seed);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await call(e, "111", "/api/companion/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Новый диалог" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("50 диалогов") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not spend the message quota on invalid requests", async () => {
    const e = isolatedEnv();
    const fetchMock = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: "Принято" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 8; i++) {
      const invalid = await call(e, "111", "/api/companion/chat", {
        method: "POST",
        body: JSON.stringify({ message: "   " }),
      });
      expect(invalid.status).toBe(400);
    }

    const valid = await call(e, "111", "/api/companion/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Рабочий запрос" }),
    });
    expect(valid.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose Gemini provider error details to the client", async () => {
    const e = isolatedEnv();
    vi.stubGlobal("fetch", async () => Response.json({ error: { message: "private provider detail" } }, { status: 429 }));
    const response = await call(e, "111", "/api/companion/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Проверка" }),
    });
    expect(response.status).toBe(429);
    const body = await response.text();
    expect(body).toContain("Лимит запросов Gemini");
    expect(body).not.toContain("private provider detail");
  });
});

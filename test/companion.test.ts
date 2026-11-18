import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCompanionApi } from "../src/companion";
import type { Env } from "../src/env";
import { env as baseEnv } from "./helpers";

function isolatedEnv(): Env {
  const e = baseEnv();
  const values = new Map<string, string>();
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

async function signedInitData(botToken: string, userId: string): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: Number(userId), first_name: "Test" }),
  });
  const encoder = new TextEncoder();
  const hmac = async (keyBytes: Uint8Array, value: string) => {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  };
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

  it("sends messages to Gemini server-side and persists tenant-scoped conversation history", async () => {
    const e = isolatedEnv();
    let sentHeaders: Headers | undefined;
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/v1beta/models/gemini-3.8-flash:generateContent");
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

  it("does not expose Gemini provider error details to the client", async () => {
    const e = isolatedEnv();
    vi.stubGlobal("fetch", async () => Response.json({ error: { message: "private provider detail" } }, { status: 429 }));
    const response = await call(e, "111", "/api/companion/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Проверка" }),
    });
    expect(response.status).toBe(429);
    const body = await response.text();
    expect(body).toContain("Лимит Gemini");
    expect(body).not.toContain("private provider detail");
  });
});

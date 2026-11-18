import { createHmac } from "node:crypto";

const baseUrl = process.env.COMPANION_PREVIEW_URL;
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!baseUrl || !botToken) throw new Error("COMPANION_PREVIEW_URL and TELEGRAM_BOT_TOKEN are required.");

function signedInitData(userId, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    user: JSON.stringify({ id: Number(userId), first_name: "Preview test" }),
  });
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", botToken).update("WebAppData").digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

async function api(userId, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `tma ${signedInitData(userId)}`);
  const response = await fetch(new URL(path, baseUrl), { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Preview API returned HTTP ${response.status}: ${body.error ?? "unknown error"}`);
  }
  return body;
}

const ownerId = "987654321";
const otherUserId = "987654322";
let conversationId;
try {
  const unauthenticated = await fetch(new URL("/api/companion/conversations", baseUrl));
  if (unauthenticated.status !== 401) throw new Error("Unauthenticated request must return HTTP 401.");

  const invalidAuth = await fetch(new URL("/api/companion/conversations", baseUrl), {
    headers: { Authorization: "tma invalid-init-data" },
  });
  if (invalidAuth.status !== 401) throw new Error("Invalid Telegram initData must return HTTP 401.");

  const expiredAuth = await fetch(new URL("/api/companion/conversations", baseUrl), {
    headers: { Authorization: `tma ${signedInitData(ownerId, Math.floor(Date.now() / 1000) - 86_401)}` },
  });
  if (expiredAuth.status !== 401) throw new Error("Expired Telegram initData must return HTTP 401.");

  const emptyMessage = await api(ownerId, "/api/companion/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "   " }),
  }).catch((error) => error);
  if (!(emptyMessage instanceof Error) || !emptyMessage.message.includes("HTTP 400")) {
    throw new Error("Empty message must return HTTP 400.");
  }

  const oversizedMessage = await api(ownerId, "/api/companion/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "x".repeat(4001) }),
  }).catch((error) => error);
  if (!(oversizedMessage instanceof Error) || !oversizedMessage.message.includes("HTTP 413")) {
    throw new Error("Message over 4,000 characters must return HTTP 413.");
  }

  const invalidConversationId = await api(ownerId, "/api/companion/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Проверка", conversationId: "not-a-uuid" }),
  }).catch((error) => error);
  if (!(invalidConversationId instanceof Error) || !invalidConversationId.message.includes("HTTP 400")) {
    throw new Error("Invalid conversation ID must return HTTP 400.");
  }

  const result = await api(ownerId, "/api/companion/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Ответь одним коротким предложением: подтверждаешь ли ты, что работаешь?" }),
  });
  if (!result.ok || typeof result.answer !== "string" || !result.answer.trim() || !result.conversationId) {
    throw new Error("Gemini smoke test returned an incomplete response.");
  }
  conversationId = result.conversationId;

  const ownHistory = await api(ownerId, "/api/companion/conversations");
  if (!ownHistory.conversations?.some((item) => item.id === conversationId)) {
    throw new Error("Conversation was not persisted for the authenticated test user.");
  }
  const foreignHistory = await api(otherUserId, "/api/companion/conversations");
  if (foreignHistory.conversations?.some((item) => item.id === conversationId)) {
    throw new Error("Tenant isolation check failed: foreign conversation appeared in list.");
  }

  const foreignRead = await api(otherUserId, `/api/companion/conversations/${conversationId}`).catch((error) => error);
  if (!(foreignRead instanceof Error) || !foreignRead.message.includes("HTTP 404")) {
    throw new Error("Foreign user must not be able to read another tenant's conversation.");
  }

  await api(otherUserId, `/api/companion/conversations/${conversationId}`, { method: "DELETE" });
  const ownerReadAfterForeignDelete = await api(ownerId, `/api/companion/conversations/${conversationId}`);
  if (ownerReadAfterForeignDelete.conversation?.id !== conversationId) {
    throw new Error("Foreign tenant delete must not affect the owner's conversation.");
  }

  const clientBundle = await fetch(new URL("/kripto-guru-api.js", baseUrl)).then((response) => response.text());
  if (clientBundle.includes(botToken)) {
    throw new Error("Telegram bot token must not appear in the public client bundle.");
  }

  console.log("Gemini preview smoke test: PASS");
  console.log("Auth rejection, input validation, model response, KV persistence, cross-tenant read/delete isolation, and client secret boundary verified.");
} finally {
  if (conversationId) {
    await api(ownerId, `/api/companion/conversations/${conversationId}`, { method: "DELETE" }).catch(() => {});
  }
}

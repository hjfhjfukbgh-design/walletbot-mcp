import { createHmac } from "node:crypto";

const baseUrl = process.env.COMPANION_PREVIEW_URL;
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!baseUrl || !botToken) throw new Error("COMPANION_PREVIEW_URL and TELEGRAM_BOT_TOKEN are required.");

function signedInitData(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: Number(userId), first_name: "Preview test" }),
  });
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
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
let conversationId;
try {
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
  const foreignHistory = await api("987654322", "/api/companion/conversations");
  if (foreignHistory.conversations?.some((item) => item.id === conversationId)) {
    throw new Error("Tenant isolation check failed.");
  }

  console.log("Gemini preview smoke test: PASS");
  console.log("Authenticated request, non-empty model response, KV persistence, and tenant isolation verified.");
} finally {
  if (conversationId) {
    await api(ownerId, `/api/companion/conversations/${conversationId}`, { method: "DELETE" }).catch(() => {});
  }
}

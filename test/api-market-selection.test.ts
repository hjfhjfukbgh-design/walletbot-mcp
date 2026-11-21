import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api";
import { env } from "./helpers";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function telegramAuth(botToken: string, userId: string): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: Number(userId), first_name: "Contract test" }),
  });
  const encoder = new TextEncoder();
  const hmac = async (keyBytes: Uint8Array, value: string) => {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  };
  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const hash = [...await hmac(secret, check)].map((v) => v.toString(16).padStart(2, "0")).join("");
  params.set("hash", hash);
  return params.toString();
}

async function postMode(e: ReturnType<typeof env>, userId: string, productMode: string) {
  const auth = await telegramAuth(e.TELEGRAM_BOT_TOKEN, userId);
  return handleApi(new Request("https://w.dev/api/product-mode", {
    method: "POST",
    headers: { Authorization: `tma ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ productMode }),
  }), e, ctx);
}

describe("legacy product-mode API compatibility with canonical selection", () => {
  it("returns canonical DEMO/Manual and DEMO/AI Piper fields from GET state", async () => {
    const e = env();
    const auth = await telegramAuth(e.TELEGRAM_BOT_TOKEN, "71004");
    const read = () => handleApi(new Request("https://w.dev/api/state", {
      headers: { Authorization: `tma ${auth}` },
    }), e, ctx);
    expect(await (await read()).json()).toMatchObject({
      ok: true, marketMode: "demo", tradingMethod: "manual",
    });
    const selected = await postMode(e, "71004", "ai");
    expect(selected.status).toBe(200);
    expect(await (await read()).json()).toMatchObject({
      ok: true, marketMode: "demo", tradingMethod: "ai_piper", productMode: "ai",
    });
  });

  it("persists DEMO + AI Piper and returns both canonical fields", async () => {
    const e = env();
    const response = await postMode(e, "71001", "ai");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, marketMode: "demo", tradingMethod: "ai_piper",
      productMode: "ai", executionMode: "paper",
    });
    const state = await e.STATE.get("tenant:71001:bot:state", "json") as Record<string, unknown>;
    expect(state).toMatchObject({ marketMode: "demo", tradingMethod: "ai_piper", productMode: "ai" });
  });

  it("persists DEMO + Manual when the legacy client selects demo", async () => {
    const e = env();
    const response = await postMode(e, "71002", "demo");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, marketMode: "demo", tradingMethod: "manual", productMode: "demo",
    });
    const state = await e.STATE.get("tenant:71002:bot:state", "json") as Record<string, unknown>;
    expect(state).toMatchObject({ marketMode: "demo", tradingMethod: "manual", productMode: "demo" });
  });

  it("rejects legacy LIVE selection without persisting a LIVE state", async () => {
    const e = env();
    const response = await postMode(e, "71003", "live");
    expect(response.status).toBe(409);
    const state = await e.STATE.get("tenant:71003:bot:state", "json");
    expect(state).toBeNull();
  });
});

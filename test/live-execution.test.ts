import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "./helpers";
import { tenantEnv } from "../src/tenants";

vi.mock("../src/bot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bot")>();
  return { ...actual, connectWalt: vi.fn() };
});

import * as bot from "../src/bot";
import { handleApi } from "../src/api";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

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
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + value).join("\n");
  const hash = [...await hmac(secret, checkString)].map((value) => value.toString(16).padStart(2, "0")).join("");
  params.set("hash", hash);
  return params.toString();
}

async function callApi(e: ReturnType<typeof env>, path: string, init: RequestInit = {}, userId = "12345") {
  const authorization = "tma " + await signedInitData(e.TELEGRAM_BOT_TOKEN, userId);
  return handleApi(new Request("https://w.dev/api/" + path, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: authorization },
  }), e, ctx);
}

function installEngine(e: ReturnType<typeof env>) {
  const records = new Map<string, Record<string, any>>();
  e.ENGINE = {
    idFromName: () => "global-engine",
    get: () => ({
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === "/live/claim") {
          const body = await request.json() as Record<string, any>;
          const existing = records.get(String(body.handle));
          if (existing) return Response.json({ ok: false, claimed: false, status: existing.status }, { status: 409 });
          records.set(String(body.handle), { ...body, status: "executing", createdAt: Date.now(), updatedAt: Date.now(), result: null });
          return Response.json({ ok: true, claimed: true, status: "executing" });
        }
        if (url.pathname === "/live/finish") {
          const body = await request.json() as Record<string, any>;
          const row = records.get(String(body.handle));
          if (!row || row.userId !== String(body.userId)) return Response.json({ ok: false }, { status: 404 });
          row.status = String(body.status);
          row.result = body.result ?? null;
          row.updatedAt = Date.now();
          return Response.json({ ok: true, status: row.status });
        }
        if (url.pathname === "/live/status") {
          const userId = url.searchParams.get("userId") ?? "";
          const handle = url.searchParams.get("handle") ?? "";
          const row = records.get(handle);
          if (!row || row.userId !== userId) return Response.json({ ok: false }, { status: 404 });
          return Response.json({ ok: true, operation: row });
        }
        return Response.json({ ok: false }, { status: 404 });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return records;
}

function previewRecord() {
  const now = Date.now();
  return {
    confirmationToken: "mock-confirmation-token",
    expiresAt: now + 120_000,
    previewAt: now,
    contractId: 7,
    symbol: "BTC",
    side: "long" as const,
    leverage: 10,
    marginUsd: 25,
    notionalUsd: 250,
    priceUsd: 50_000,
  };
}

describe("LIVE execute safety", () => {
  afterEach(() => { vi.clearAllMocks(); });

  it("requires explicit confirmation and executes a claimed handle only once under concurrency", async () => {
    const e = env();
    const records = installEngine(e);
    const handle = "a".repeat(32);
    await tenantEnv(e, "12345").STATE.put("live:preview:12345:" + handle, JSON.stringify(previewRecord()), { expirationTtl: 120 });

    const client = {
      call: vi.fn(async () => ({ ok: true, orderId: "mock-order-1", status: "submitted" })),
      openPosition: vi.fn(async () => null),
    };
    vi.mocked(bot.connectWalt).mockResolvedValue(client as any);

    const noConfirm = await callApi(e, "live/execute", { method: "POST", body: JSON.stringify({ handle }) });
    expect(noConfirm.status).toBe(400);
    expect(client.call).not.toHaveBeenCalled();

    const results = await Promise.all([
      callApi(e, "live/execute", { method: "POST", body: JSON.stringify({ handle, confirm: true }) }),
      callApi(e, "live/execute", { method: "POST", body: JSON.stringify({ handle, confirm: true }) }),
    ]);
    expect(results.some((response) => response.status === 200)).toBe(true);
    expect(client.call).toHaveBeenCalledTimes(1);
    expect(client.call).toHaveBeenCalledWith("perps_execute_operation", { confirmationToken: "mock-confirmation-token" });
    expect(records.get(handle)?.status).toBe("completed");

    const duplicate = await callApi(e, "live/execute", { method: "POST", body: JSON.stringify({ handle, confirm: true }) });
    expect(duplicate.status).toBe(200);
    expect(client.call).toHaveBeenCalledTimes(1);
  });

  it("marks an uncertain Walt response UNKNOWN and never retries the execute call", async () => {
    const e = env();
    const records = installEngine(e);
    const handle = "b".repeat(32);
    await tenantEnv(e, "12345").STATE.put("live:preview:12345:" + handle, JSON.stringify(previewRecord()), { expirationTtl: 120 });

    const client = {
      call: vi.fn(async () => { throw new Error("network timeout"); }),
      openPosition: vi.fn(async () => null),
    };
    vi.mocked(bot.connectWalt).mockResolvedValue(client as any);

    const first = await callApi(e, "live/execute", { method: "POST", body: JSON.stringify({ handle, confirm: true }) });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ ok: false, status: "unknown" });
    expect(records.get(handle)?.status).toBe("unknown");

    const second = await callApi(e, "live/execute", { method: "POST", body: JSON.stringify({ handle, confirm: true }) });
    expect(second.status).toBe(200);
    expect(client.call).toHaveBeenCalledTimes(1);
  });
});

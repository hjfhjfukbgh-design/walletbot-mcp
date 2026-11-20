import { describe, expect, it, vi } from "vitest";
import { runAiPaperDecision } from "../src/ai-paper";
import type { Env } from "../src/env";
import type { ContractInfo } from "../src/strategy/grid";

const NOW = 1_800_000_000_000;
const contracts: ContractInfo[] = [
  {
    contractId: 0, name: "BTC-USDC", priceDecimals: 2, minSizeBase: 0.001,
    minSizeQuote: 10, maxSizeQuote: 10_000_000, maxLeverage: 10,
    takerFeePct: 0.00035, priceSlippage: 0.001, volume24hUsd: 50_000_000,
    fundingRateHourly: 0, price: 50_000,
  },
  {
    contractId: 1, name: "ETH-USDC", priceDecimals: 2, minSizeBase: 0.01,
    minSizeQuote: 10, maxSizeQuote: 10_000_000, maxLeverage: 10,
    takerFeePct: 0.00035, priceSlippage: 0.001, volume24hUsd: 20_000_000,
    fundingRateHourly: 0, price: 2_500,
  },
];

function makeEnv(): Env {
  return {
    GEMINI_API_KEY: "test-only-key",
    GEMINI_MODEL: "gemini-2.5-flash-lite",
    MAX_ORDER_PCT: "5",
    MAX_TOTAL_EXPOSURE_PCT: "50",
    MAX_DAILY_LOSS_PCT: "5",
    STOP_LOSS_PCT: "5",
    ALLOWED_MARKETS: "BTC,ETH",
    MIN_VOLUME_24H_USD: "1000000",
  } as unknown as Env;
}

function geminiResponse(text: string): Response {
  return Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] });
}

function claimAwareEngine(handler: (path: string, body?: Record<string, unknown>) => Promise<Response>) {
  return async (path: string, body?: Record<string, unknown>): Promise<Response> => {
    if (path.startsWith("/ai/paper/decision?")) return Response.json({ ok: false }, { status: 404 });
    if (path === "/ai/paper/decision/claim") return Response.json({ ok: true, state: "claimed", fencingToken: 1 });
    if (path === "/ai/paper/decision/external-started") return Response.json({ ok: true, state: "external_started" });
    if (path === "/ai/paper/decision/unknown") return Response.json({ ok: true, state: "external_outcome_unknown" });
    if (path === "/ai/paper/decision/release") return Response.json({ ok: true });
    return handler(path, body);
  };
}

describe("runAiPaperDecision", () => {
  it("uses server market data and strict model output, then records one tenant-scoped decision", async () => {
    const env = makeEnv();
    const recorded: Array<Record<string, unknown>> = [];
    const modelDecision = JSON.stringify({
      signal: "buy", symbol: "BTC", rationale: "Подтверждённый импульс на снимке.", confidence: 0.82,
    });
    const result = await runAiPaperDecision(env, "123456789", "manual-run-0001", {
      now: () => NOW,
      getContracts: async () => contracts,
      consumeQuota: async () => Response.json({ ok: true, allowed: true }),
      engineRequest: claimAwareEngine(async (path, body) => {
        if (path.startsWith("/ai/paper/status")) return Response.json({ status: "active", aiBalanceMicro: "100000000" });
        recorded.push(body ?? {});
        return Response.json({ ok: true, id: "decision-1", duplicate: false }, { status: 201 });
      }),
      fetcher: async (input, init) => {
        expect(String(input)).toContain("gemini-2.5-flash-lite:generateContent");
        const request = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
        expect(request.contents[0].parts[0].text).toContain("50000.00");
        return geminiResponse(modelDecision);
      },
    });

    expect(result.status).toBe(201);
    const body = await result.json() as Record<string, any>;
    expect(body).toMatchObject({ ok: true, tickId: "manual-run-0001", persisted: true, duplicate: false });
    expect(body.decision).toMatchObject({ signal: "buy", symbol: "BTC", confidence: 0.82 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      userId: "123456789", tickId: "manual-run-0001", strategyId: "gemini-paper",
      symbol: "BTC", signal: "buy", observedPrice: "50000.00", snapshotRetrievedAt: NOW,
      riskPass: true, positionId: null,
    });
    expect(recorded[0]).not.toHaveProperty("leverage");
    expect(recorded[0]).not.toHaveProperty("qtyUnits");
  });

  it("replays a completed requestId without a second quota reservation or Gemini call", async () => {
    const env = makeEnv();
    let claimed = false;
    let stored: Record<string, unknown> | null = null;
    let quotaCalls = 0;
    let modelCalls = 0;
    let statusCalls = 0;
    let recordCalls = 0;
    const engineRequest = async (path: string, body?: Record<string, unknown>): Promise<Response> => {
      if (path.startsWith("/ai/paper/decision?")) {
        return stored
          ? Response.json({ ok: true, state: "completed", decision: stored })
          : Response.json({ ok: false }, { status: 404 });
      }
      if (path === "/ai/paper/decision/claim") {
        if (stored) return Response.json({ ok: true, state: "completed", decision: stored });
        if (claimed) return Response.json({ ok: false, state: "in_progress" }, { status: 409 });
        claimed = true;
        return Response.json({ ok: true, state: "claimed", fencingToken: 1 });
      }
      if (path === "/ai/paper/decision/external-started") return Response.json({ ok: true, state: "external_started" });
      if (path === "/ai/paper/decision/unknown") return Response.json({ ok: true, state: "external_outcome_unknown" });
      if (path === "/ai/paper/decision/release") { claimed = false; return Response.json({ ok: true }); }
      if (path.startsWith("/ai/paper/status")) { statusCalls++; return Response.json({ status: "active" }); }
      if (path === "/ai/paper/decision") {
        recordCalls++;
        stored = {
          tickId: body?.tickId, marketSnapshotHash: body?.marketSnapshotHash,
          snapshotRetrievedAt: body?.snapshotRetrievedAt, symbol: body?.symbol, signal: body?.signal,
          rationale: body?.rationale, confidence: body?.confidence,
        };
        claimed = false;
        return Response.json({ ok: true, id: "decision-replayed", duplicate: false }, { status: 201 });
      }
      return Response.json({ ok: false }, { status: 404 });
    };
    let modeChecks = 0;
    const dependencies = {
      now: () => NOW,
      engineRequest,
      isAiMode: async () => { modeChecks++; return modeChecks === 1; },
      getContracts: async () => contracts,
      consumeQuota: async () => { quotaCalls++; return Response.json({ ok: true }); },
      fetcher: async () => { modelCalls++; return geminiResponse(JSON.stringify({
        signal: "buy", symbol: "BTC", rationale: "Повторяемое решение.", confidence: 0.75,
      })); },
    };
    const first = await runAiPaperDecision(env, "123456789", "stable-request-0001", dependencies);
    const second = await runAiPaperDecision(env, "123456789", "stable-request-0001", dependencies);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, tickId: "stable-request-0001", duplicate: true,
      decision: { signal: "buy", symbol: "BTC", confidence: 0.75 } });
    expect(quotaCalls).toBe(1);
    expect(modelCalls).toBe(1);
    expect(statusCalls).toBe(1);
    expect(recordCalls).toBe(1);
    expect(modeChecks).toBe(1);
  });

  it("does not repeat quota or Gemini after an ambiguous external-call failure", async () => {
    const env = makeEnv();
    let state: "new" | "external_started" | "external_outcome_unknown" = "new";
    let quotaCalls = 0;
    let modelCalls = 0;
    const engineRequest = async (path: string): Promise<Response> => {
      if (path.startsWith("/ai/paper/decision?")) {
        if (state === "external_outcome_unknown")
          return Response.json({ ok: false, state, error: "Внешний результат неизвестен." }, { status: 409 });
        return Response.json({ ok: false }, { status: 404 });
      }
      if (path === "/ai/paper/decision/claim") return Response.json({ ok: true, state: "claimed", fencingToken: 7 });
      if (path === "/ai/paper/decision/external-started") { state = "external_started"; return Response.json({ ok: true }); }
      if (path === "/ai/paper/decision/unknown") { state = "external_outcome_unknown"; return Response.json({ ok: true }); }
      if (path === "/ai/paper/status?userId=123456789") return Response.json({ status: "active" });
      return Response.json({ ok: true });
    };
    const dependencies = {
      now: () => NOW,
      engineRequest,
      getContracts: async () => contracts,
      consumeQuota: async () => { quotaCalls++; return Response.json({ ok: true }); },
      fetcher: async () => { modelCalls++; throw new Error("connection dropped after request may have reached provider"); },
    };
    const first = await runAiPaperDecision(env, "123456789", "stable-request-unknown-01", dependencies);
    const retry = await runAiPaperDecision(env, "123456789", "stable-request-unknown-01", dependencies);
    expect(first.status).toBe(503);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ state: "external_outcome_unknown" });
    expect(quotaCalls).toBe(1);
    expect(modelCalls).toBe(1);
  });

  it("blocks new AI PAPER analysis when method is not AI, without spending quota or calling Gemini", async () => {
    const quota = vi.fn(async () => Response.json({ ok: true }));
    const model = vi.fn(async () => geminiResponse("{}"));
    const engineRequest = claimAwareEngine(async () => Response.json({ status: "active" }));
    const result = await runAiPaperDecision(makeEnv(), "123456789", "stable-request-manual-01", {
      engineRequest, isAiMode: async () => false,
      consumeQuota: quota, fetcher: model,
    });
    expect(result.status).toBe(409);
    expect(quota).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it("requires a caller-supplied stable requestId before any engine, quota or model call", async () => {
    const engineRequest = vi.fn(async () => Response.json({ ok: false }, { status: 404 }));
    const quota = vi.fn(async () => Response.json({ ok: true }));
    const model = vi.fn(async () => geminiResponse("{}"));
    const result = await runAiPaperDecision(makeEnv(), "123456789", undefined, {
      engineRequest, consumeQuota: quota, fetcher: model,
    });
    expect(result.status).toBe(400);
    expect(engineRequest).not.toHaveBeenCalled();
    expect(quota).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it("does not call Gemini or record a decision when the AI PAPER session is stopped", async () => {
    let modelCalls = 0;
    let writes = 0;
    const result = await runAiPaperDecision(makeEnv(), "123456789", "manual-run-stopped", {
      now: () => NOW,
      engineRequest: claimAwareEngine(async () => Response.json({ status: "stopped" })),
      getContracts: async () => contracts,
      consumeQuota: async () => Response.json({ ok: true }),
      fetcher: async () => { modelCalls++; return geminiResponse("{}"); },
    });
    expect(result.status).toBe(409);
    expect(modelCalls).toBe(0);
    expect(writes).toBe(0);
  });

  it("rejects extra model fields and never persists model-supplied price or riskPass", async () => {
    let writes = 0;
    const result = await runAiPaperDecision(makeEnv(), "123456789", "manual-run-extra-fields", {
      now: () => NOW,
      getContracts: async () => contracts,
      consumeQuota: async () => Response.json({ ok: true }),
      engineRequest: claimAwareEngine(async (path) => {
        if (path.startsWith("/ai/paper/status")) return Response.json({ status: "active" });
        writes++;
        return Response.json({ ok: true }, { status: 201 });
      }),
      fetcher: async () => geminiResponse(JSON.stringify({
        signal: "buy", symbol: "BTC", rationale: "unsafe", confidence: 0.9,
        observedPrice: "1", riskPass: true, userId: "999999999",
      })),
    });
    expect(result.status).toBe(502);
    expect(writes).toBe(0);
  });

  it("fails before Gemini when no server-allowed market has a valid price", async () => {
    let modelCalls = 0;
    const result = await runAiPaperDecision(makeEnv(), "123456789", "manual-run-no-market", {
      now: () => NOW,
      getContracts: async () => [{ ...contracts[0], price: 0 }],
      consumeQuota: async () => Response.json({ ok: true }),
      engineRequest: claimAwareEngine(async () => Response.json({ status: "active" })),
      fetcher: async () => { modelCalls++; return geminiResponse("{}"); },
    });
    expect(result.status).toBe(503);
    expect(modelCalls).toBe(0);
  });

  it("does not call Gemini when the free-tier quota is exhausted", async () => {
    let modelCalls = 0;
    const result = await runAiPaperDecision(makeEnv(), "123456789", "manual-run-quota", {
      now: () => NOW,
      getContracts: async () => contracts,
      consumeQuota: async () => Response.json({ ok: false }, { status: 429 }),
      engineRequest: claimAwareEngine(async () => Response.json({ status: "active" })),
      fetcher: async () => { modelCalls++; return geminiResponse("{}"); },
    });
    expect(result.status).toBe(429);
    expect(modelCalls).toBe(0);
  });

  it("does not persist a decision when the market snapshot becomes older than ten minutes during inference", async () => {
    let clock = NOW;
    let writes = 0;
    const result = await runAiPaperDecision(makeEnv(), "123456789", "manual-run-stale-snapshot", {
      now: () => clock,
      getContracts: async () => contracts,
      consumeQuota: async () => Response.json({ ok: true }),
      engineRequest: claimAwareEngine(async (path) => {
        if (path.startsWith("/ai/paper/status")) return Response.json({ status: "active" });
        writes++;
        return Response.json({ ok: true }, { status: 201 });
      }),
      fetcher: async () => {
        clock = NOW + 10 * 60_000 + 1;
        return geminiResponse(JSON.stringify({ signal: "hold", symbol: "BTC", rationale: "Снимок устарел.", confidence: 0.5 }));
      },
    });
    expect(result.status).toBe(409);
    expect(writes).toBe(0);
  });

  it("fails closed on Gemini timeout and incomplete candidates without persisting", async () => {
    let writes = 0;
    const common = {
      now: () => NOW,
      getContracts: async () => contracts,
      consumeQuota: async () => Response.json({ ok: true }),
      engineRequest: claimAwareEngine(async (path: string) => {
        if (path.startsWith("/ai/paper/status")) return Response.json({ status: "active" });
        writes++;
        return Response.json({ ok: true }, { status: 201 });
      }),
    };
    const timeout = await runAiPaperDecision(makeEnv(), "123456789", "manual-run-timeout", {
      ...common,
      fetcher: async () => { throw new Error("timeout"); },
    });
    expect(timeout.status).toBe(503);
    expect(writes).toBe(0);

    const incomplete = await runAiPaperDecision(makeEnv(), "123456789", "manual-run-incomplete", {
      ...common,
      fetcher: async () => Response.json({
        candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: JSON.stringify({
          signal: "buy", symbol: "BTC", rationale: "partial", confidence: 0.8,
        }) }] } }],
      }),
    });
    expect(incomplete.status).toBe(502);
    expect(writes).toBe(0);
  });

  it("fails closed when the server risk configuration is missing", async () => {
    const env = { ...makeEnv(), MAX_DAILY_LOSS_PCT: "" } as unknown as Env;
    let modelCalls = 0;
    const result = await runAiPaperDecision(env, "123456789", "manual-run-bad-risk-config", {
      now: () => NOW,
      engineRequest: claimAwareEngine(async () => Response.json({ status: "active" })),
      getContracts: async () => contracts,
      fetcher: async () => { modelCalls++; return geminiResponse("{}"); },
    });
    expect(result.status).toBe(503);
    expect(modelCalls).toBe(0);
  });
});

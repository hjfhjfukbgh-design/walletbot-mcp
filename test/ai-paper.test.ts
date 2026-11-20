import { describe, expect, it } from "vitest";
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
      engineRequest: async (path, body) => {
        if (path.startsWith("/ai/paper/status")) return Response.json({ status: "active", aiBalanceMicro: "100000000" });
        recorded.push(body ?? {});
        return Response.json({ ok: true, id: "decision-1", duplicate: false }, { status: 201 });
      },
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
      symbol: "BTC", signal: "buy", observedPrice: "50000.00", serverObservedAt: NOW,
      riskPass: true, positionId: null,
    });
    expect(recorded[0]).not.toHaveProperty("leverage");
    expect(recorded[0]).not.toHaveProperty("qtyUnits");
  });

  it("does not call Gemini or record a decision when the AI PAPER session is stopped", async () => {
    let modelCalls = 0;
    let writes = 0;
    const result = await runAiPaperDecision(makeEnv(), "123456789", "manual-run-stopped", {
      now: () => NOW,
      engineRequest: async () => Response.json({ status: "stopped" }),
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
      engineRequest: async (path) => {
        if (path.startsWith("/ai/paper/status")) return Response.json({ status: "active" });
        writes++;
        return Response.json({ ok: true }, { status: 201 });
      },
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
      engineRequest: async () => Response.json({ status: "active" }),
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
      engineRequest: async () => Response.json({ status: "active" }),
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
      engineRequest: async (path) => {
        if (path.startsWith("/ai/paper/status")) return Response.json({ status: "active" });
        writes++;
        return Response.json({ ok: true }, { status: 201 });
      },
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
      engineRequest: async (path: string) => {
        if (path.startsWith("/ai/paper/status")) return Response.json({ status: "active" });
        writes++;
        return Response.json({ ok: true }, { status: 201 });
      },
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
      getContracts: async () => contracts,
      fetcher: async () => { modelCalls++; return geminiResponse("{}"); },
    });
    expect(result.status).toBe(503);
    expect(modelCalls).toBe(0);
  });
});

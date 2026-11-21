import { describe, expect, it } from "vitest";
import {
  defaultState,
  loadState,
  normalizeMarketSelection,
  normalizeMarketMode,
  normalizeTradingMethod,
  withProductMode,
} from "../src/state";
import { env } from "./helpers";

describe("two-level market selection contract", () => {
  it("defaults new users to DEMO + Manual", () => {
    expect(defaultState()).toMatchObject({
      marketMode: "demo",
      tradingMethod: "manual",
      productMode: "demo",
    });
  });

  it("migrates legacy AI mode to DEMO + AI Piper", () => {
    expect(normalizeMarketSelection({ productMode: "ai" })).toEqual({
      marketMode: "demo",
      tradingMethod: "ai_piper",
      productMode: "ai",
    });
  });

  it("migrates legacy DEMO to DEMO + Manual", () => {
    expect(normalizeMarketSelection({ productMode: "demo" })).toEqual({
      marketMode: "demo",
      tradingMethod: "manual",
      productMode: "demo",
    });
  });

  it("never silently migrates legacy LIVE to LIVE", () => {
    expect(normalizeMarketSelection({ productMode: "live" })).toEqual({
      marketMode: "demo",
      tradingMethod: "manual",
      productMode: "demo",
    });
  });

  it("accepts LIVE only when the new marketMode field is explicitly present", () => {
    expect(normalizeMarketSelection({ marketMode: "live", tradingMethod: "manual" })).toMatchObject({
      marketMode: "live",
      tradingMethod: "manual",
    });
  });

  it("normalizes unknown market and method values to safe defaults", () => {
    expect(normalizeMarketMode("production")).toBe("demo");
    expect(normalizeTradingMethod("ai")).toBe("manual");
    expect(normalizeMarketSelection({ marketMode: "invalid" as never, tradingMethod: "invalid" as never }))
      .toMatchObject({ marketMode: "demo", tradingMethod: "manual" });
  });

  it("loads persisted legacy AI as DEMO + AI Piper before applying defaults", async () => {
    const e = env();
    await e.STATE.put("bot:state", JSON.stringify({ productMode: "ai" }));
    await expect(loadState(e)).resolves.toMatchObject({
      marketMode: "demo", tradingMethod: "ai_piper", productMode: "ai",
    });
  });

  it("loads persisted legacy DEMO as DEMO + Manual", async () => {
    const e = env();
    await e.STATE.put("bot:state", JSON.stringify({ productMode: "demo" }));
    await expect(loadState(e)).resolves.toMatchObject({
      marketMode: "demo", tradingMethod: "manual", productMode: "demo",
    });
  });

  it("safely downgrades persisted legacy LIVE to DEMO + Manual", async () => {
    const e = env();
    await e.STATE.put("bot:state", JSON.stringify({ productMode: "live", mode: "live" }));
    await expect(loadState(e)).resolves.toMatchObject({
      marketMode: "demo", tradingMethod: "manual", productMode: "demo",
    });
  });

  it("preserves an explicitly persisted new LIVE + AI Piper selection", async () => {
    const e = env();
    await e.STATE.put("bot:state", JSON.stringify({ marketMode: "live", tradingMethod: "ai_piper" }));
    await expect(loadState(e)).resolves.toMatchObject({
      marketMode: "live", tradingMethod: "ai_piper", productMode: "ai",
    });
  });

  it("keeps the legacy product-mode adapter inside DEMO", () => {
    expect(withProductMode(defaultState(), "ai")).toMatchObject({
      marketMode: "demo",
      tradingMethod: "ai_piper",
      productMode: "ai",
    });
    expect(withProductMode(defaultState(), "live")).toMatchObject({
      marketMode: "demo",
      tradingMethod: "manual",
      productMode: "demo",
    });
  });
});

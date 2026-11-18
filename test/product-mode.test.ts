import { describe, expect, it } from "vitest";
import { defaultState, loadState, normalizeProductMode, withProductMode } from "../src/state";
import { env } from "./helpers";

describe("product mode state", () => {
  it("accepts only demo, live and ai", () => {
    expect(normalizeProductMode("demo")).toBe("demo");
    expect(normalizeProductMode("live")).toBe("live");
    expect(normalizeProductMode("ai")).toBe("ai");
    for (const value of [undefined, null, "", "paper", "LIVE", "unknown", 1, {}])
      expect(normalizeProductMode(value)).toBe("demo");
  });

  it("defaults new accounts to demo without changing the legacy execution mode", () => {
    expect(defaultState()).toMatchObject({ productMode: "demo", mode: "paper" });
  });

  it("returns a new state object and does not mutate the input", () => {
    const original = defaultState();
    const updated = withProductMode(original, "ai");
    expect(updated).not.toBe(original);
    expect(updated.productMode).toBe("ai");
    expect(original.productMode).toBe("demo");
    expect(updated.mode).toBe("paper");
  });

  it("migrates legacy stored states to demo while preserving their execution mode", async () => {
    const e = env();
    await e.STATE.put("bot:state", JSON.stringify({
      mode: "live", running: false,
      paper: { cash: 1000, startCash: 1000 },
      stats: { trades: 0, wins: 0, losses: 0, realizedPnl: 0 },
    }));
    const state = await loadState(e);
    expect(state.productMode).toBe("demo");
    expect(state.mode).toBe("live");
  });
});

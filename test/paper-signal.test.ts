import { describe, expect, it } from "vitest";
import { buildPaperSignal } from "../src/service";

describe("buildPaperSignal", () => {
  it("returns hold when there is not enough history", () => {
    expect(buildPaperSignal([1, 2, 3], 2, 4)).toMatchObject({
      signal: "hold", shortAverage: null, longAverage: null,
    });
  });

  it("returns long when the short average is above the long average", () => {
    const result = buildPaperSignal([1, 1, 1, 1, 1, 2, 3, 4, 5, 6], 2, 4);
    expect(result.signal).toBe("long");
    expect(result.shortAverage).toBe(5.5);
    expect(result.longAverage).toBe(4.5);
  });

  it("returns short when the short average is below the long average", () => {
    const result = buildPaperSignal([1, 2, 3, 4, 5, 6, 7, 8, 1, 1], 2, 4);
    expect(result.signal).toBe("short");
    expect(result.shortAverage).toBe(1);
    expect(result.longAverage).toBe(4.25);
  });

  it("returns hold when the averages are equal", () => {
    expect(buildPaperSignal(Array(20).fill(10))).toMatchObject({
      signal: "hold", shortAverage: 10, longAverage: 10,
    });
  });

  it("rejects non-finite and non-positive prices", () => {
    expect(buildPaperSignal([1, 2, 0, 4], 2, 3).signal).toBe("hold");
    expect(buildPaperSignal([1, 2, Number.NaN, 4], 2, 3).signal).toBe("hold");
    expect(buildPaperSignal([1, 2, Number.POSITIVE_INFINITY, 4], 2, 3).signal).toBe("hold");
  });

  it("rejects invalid windows", () => {
    expect(buildPaperSignal([1, 2, 3], 0, 2).signal).toBe("hold");
    expect(buildPaperSignal([1, 2, 3], 2, 2).signal).toBe("hold");
    expect(buildPaperSignal([1, 2, 3], 1.5, 3).signal).toBe("hold");
  });

  it("does not mutate the input array", () => {
    const prices = [1, 2, 3, 4];
    const before = [...prices];
    buildPaperSignal(prices, 2, 4);
    expect(prices).toEqual(before);
  });
});

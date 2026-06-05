import { computeScoreStats, statsForField, formatStat } from "@/lib/scoreStats";

describe("computeScoreStats", () => {
  it("returns empty stats for an empty list", () => {
    expect(computeScoreStats([])).toEqual({ count: 0, min: null, max: null, mean: null });
  });

  it("returns empty stats when every value is missing or non-finite", () => {
    expect(computeScoreStats([null, undefined, NaN, Infinity, -Infinity])).toEqual({
      count: 0,
      min: null,
      max: null,
      mean: null
    });
  });

  it("computes min/max/mean/count over finite numbers", () => {
    expect(computeScoreStats([10, 20, 30])).toEqual({ count: 3, min: 10, max: 30, mean: 20 });
  });

  it("ignores null/undefined/NaN/Infinity while keeping valid numbers", () => {
    expect(computeScoreStats([null, 40, undefined, 60, NaN, Infinity])).toEqual({
      count: 2,
      min: 40,
      max: 60,
      mean: 50
    });
  });

  it("handles negative numbers and a single value", () => {
    expect(computeScoreStats([-5])).toEqual({ count: 1, min: -5, max: -5, mean: -5 });
    expect(computeScoreStats([-10, 0, 10])).toEqual({ count: 3, min: -10, max: 10, mean: 0 });
  });

  it("treats zero as a real value (not missing)", () => {
    expect(computeScoreStats([0, 0, 0])).toEqual({ count: 3, min: 0, max: 0, mean: 0 });
  });

  it("produces a fractional mean", () => {
    const stats = computeScoreStats([1, 2]);
    expect(stats.mean).toBeCloseTo(1.5);
  });
});

describe("statsForField", () => {
  it("extracts a numeric field from rows and ignores missing values", () => {
    const rows = [{ total_score: 80 }, { total_score: null }, { total_score: 100 }, {}];
    expect(statsForField(rows as { total_score?: number | null }[], "total_score")).toEqual({
      count: 2,
      min: 80,
      max: 100,
      mean: 90
    });
  });
});

describe("formatStat", () => {
  it("shows a dash for null", () => {
    expect(formatStat(null)).toBe("—");
  });

  it("renders integers without decimals", () => {
    expect(formatStat(90)).toBe("90");
  });

  it("rounds fractional values to one digit by default", () => {
    expect(formatStat(78.456)).toBe("78.5");
  });

  it("respects a custom fractionDigits", () => {
    expect(formatStat(78.456, 2)).toBe("78.46");
  });
});

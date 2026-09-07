/**
 * @jest-environment node
 */

/**
 * The parsing/clamping rules behind the github-async-worker's pgmq drain tuning.
 *
 * These are the values that produced the 2026-09-07 incident (58 create_repo
 * messages, 88 minutes, 20 of 58 re-read against a 300s visibility timeout), so
 * the two properties worth locking down are: (a) the defaults still reproduce
 * the pre-change hardcoded behaviour exactly, and (b) no configured value can
 * take the worker down or silently become 0 — `n: 0` drains nothing while every
 * liveness signal stays green.
 */

import {
  resolveAsyncWorkerTuning,
  requiredVisibilityTimeoutSeconds,
  DRAIN_CONCURRENCY_ENV,
  VISIBILITY_TIMEOUT_ENV,
  DEFAULT_DRAIN_CONCURRENCY,
  DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
  MIN_DRAIN_CONCURRENCY,
  MAX_DRAIN_CONCURRENCY,
  MIN_VISIBILITY_TIMEOUT_SECONDS,
  MAX_VISIBILITY_TIMEOUT_SECONDS,
  PER_MESSAGE_VT_BUDGET_SECONDS
} from "@/supabase/functions/_shared/asyncWorkerTuning";

function env(vars: Record<string, string | undefined>) {
  return { get: (name: string) => vars[name] };
}

describe("async worker drain tuning defaults", () => {
  it("reproduces the previously hardcoded n=4 / sleep_seconds=300 when nothing is set", () => {
    const t = resolveAsyncWorkerTuning(env({}));
    expect(t.drainConcurrency).toBe(4);
    expect(t.visibilityTimeoutSeconds).toBe(300);
    expect(DEFAULT_DRAIN_CONCURRENCY).toBe(4);
    expect(DEFAULT_VISIBILITY_TIMEOUT_SECONDS).toBe(300);
  });

  it("treats an empty or whitespace value as unset rather than as zero", () => {
    for (const raw of ["", "   "]) {
      const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: raw, [VISIBILITY_TIMEOUT_ENV]: raw }));
      expect(t.drainConcurrency).toBe(DEFAULT_DRAIN_CONCURRENCY);
      expect(t.visibilityTimeoutSeconds).toBe(DEFAULT_VISIBILITY_TIMEOUT_SECONDS);
      expect(t.issues.filter((i) => i.kind !== "invariant")).toHaveLength(0);
    }
  });

  it("reports the invariant violation that the defaults themselves carry, without changing them", () => {
    // 300 < 4 x 120. This is the measured status quo, preserved deliberately, so
    // it must be a report and not a silent correction.
    const t = resolveAsyncWorkerTuning(env({}));
    const invariant = t.issues.filter((i) => i.kind === "invariant");
    expect(invariant).toHaveLength(1);
    expect(invariant[0].message).toContain("read_ct");
    expect(t.visibilityTimeoutSeconds).toBe(300);
  });
});

describe("async worker drain tuning: valid overrides", () => {
  it("accepts an in-range pair verbatim and reports nothing", () => {
    const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: "8", [VISIBILITY_TIMEOUT_ENV]: "960" }));
    expect(t.drainConcurrency).toBe(8);
    expect(t.visibilityTimeoutSeconds).toBe(960);
    expect(t.issues).toHaveLength(0);
  });

  it("tolerates surrounding whitespace from a chart/secret round-trip", () => {
    const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: " 6 ", [VISIBILITY_TIMEOUT_ENV]: "\t720\n" }));
    expect(t.drainConcurrency).toBe(6);
    expect(t.visibilityTimeoutSeconds).toBe(720);
    expect(t.issues).toHaveLength(0);
  });

  it("accepts both bounds exactly", () => {
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: String(MIN_DRAIN_CONCURRENCY),
        [VISIBILITY_TIMEOUT_ENV]: String(MAX_VISIBILITY_TIMEOUT_SECONDS)
      })
    );
    expect(t.drainConcurrency).toBe(MIN_DRAIN_CONCURRENCY);
    expect(t.visibilityTimeoutSeconds).toBe(MAX_VISIBILITY_TIMEOUT_SECONDS);
  });
});

describe("async worker drain tuning: malformed values fall back", () => {
  it.each([["four"], ["4.5"], ["1e3"], ["8kB"], ["-1"], ["NaN"], ["0x4"], ["+4"]])(
    "falls back to the default for %s and says so",
    (raw) => {
      const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: raw }));
      expect(t.drainConcurrency).toBe(DEFAULT_DRAIN_CONCURRENCY);
      const rejected = t.issues.filter((i) => i.kind === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].env).toBe(DRAIN_CONCURRENCY_ENV);
      expect(rejected[0].raw).toBe(raw);
      expect(rejected[0].effective).toBe(DEFAULT_DRAIN_CONCURRENCY);
    }
  );

  it("never yields NaN for the visibility timeout, which pgmq would reject outright", () => {
    const t = resolveAsyncWorkerTuning(env({ [VISIBILITY_TIMEOUT_ENV]: "five minutes" }));
    expect(Number.isInteger(t.visibilityTimeoutSeconds)).toBe(true);
    expect(t.visibilityTimeoutSeconds).toBe(DEFAULT_VISIBILITY_TIMEOUT_SECONDS);
  });

  it("reports each bad value independently", () => {
    const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: "lots", [VISIBILITY_TIMEOUT_ENV]: "ages" }));
    expect(
      t.issues
        .filter((i) => i.kind === "rejected")
        .map((i) => i.env)
        .sort()
    ).toEqual([DRAIN_CONCURRENCY_ENV, VISIBILITY_TIMEOUT_ENV].sort());
  });
});

describe("async worker drain tuning: clamping", () => {
  it("never lets drain concurrency become 0 — that drains nothing and looks like a hung queue", () => {
    const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: "0" }));
    expect(t.drainConcurrency).toBe(MIN_DRAIN_CONCURRENCY);
    expect(t.drainConcurrency).toBeGreaterThan(0);
    const clamped = t.issues.filter((i) => i.kind === "clamped");
    expect(clamped).toHaveLength(1);
    expect(clamped[0].message).toContain("below the minimum");
  });

  it("clamps an absurd concurrency down to the memory/quota ceiling instead of honouring it", () => {
    const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: "1000", [VISIBILITY_TIMEOUT_ENV]: "1800" }));
    expect(t.drainConcurrency).toBe(MAX_DRAIN_CONCURRENCY);
    expect(t.issues.some((i) => i.kind === "clamped" && i.env === DRAIN_CONCURRENCY_ENV)).toBe(true);
  });

  it("clamps the visibility timeout to both bounds", () => {
    const low = resolveAsyncWorkerTuning(env({ [VISIBILITY_TIMEOUT_ENV]: "1" }));
    expect(low.visibilityTimeoutSeconds).toBe(MIN_VISIBILITY_TIMEOUT_SECONDS);
    const high = resolveAsyncWorkerTuning(env({ [VISIBILITY_TIMEOUT_ENV]: "86400" }));
    expect(high.visibilityTimeoutSeconds).toBe(MAX_VISIBILITY_TIMEOUT_SECONDS);
    expect(high.issues.some((i) => i.kind === "clamped" && i.env === VISIBILITY_TIMEOUT_ENV)).toBe(true);
  });

  it("keeps every resolved value inside its documented range for arbitrary garbage", () => {
    for (const raw of ["0", "-5", "999999", "", "abc", "0.0001", "8_000"]) {
      const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: raw, [VISIBILITY_TIMEOUT_ENV]: raw }));
      expect(t.drainConcurrency).toBeGreaterThanOrEqual(MIN_DRAIN_CONCURRENCY);
      expect(t.drainConcurrency).toBeLessThanOrEqual(MAX_DRAIN_CONCURRENCY);
      expect(t.visibilityTimeoutSeconds).toBeGreaterThanOrEqual(MIN_VISIBILITY_TIMEOUT_SECONDS);
      expect(t.visibilityTimeoutSeconds).toBeLessThanOrEqual(MAX_VISIBILITY_TIMEOUT_SECONDS);
    }
  });
});

describe("the visibility-timeout-vs-concurrency invariant", () => {
  it("scales with the whole batch, not with one message", () => {
    expect(requiredVisibilityTimeoutSeconds(4)).toBe(4 * PER_MESSAGE_VT_BUDGET_SECONDS);
    expect(requiredVisibilityTimeoutSeconds(8)).toBe(960);
    // The measured batch of 4 took ~420s, so the per-message budget must not be
    // set below what was actually observed.
    expect(requiredVisibilityTimeoutSeconds(4)).toBeGreaterThanOrEqual(420);
  });

  it("flags a raised concurrency left against the old 300s timeout", () => {
    const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: "8", [VISIBILITY_TIMEOUT_ENV]: "300" }));
    const invariant = t.issues.filter((i) => i.kind === "invariant");
    expect(invariant).toHaveLength(1);
    expect(invariant[0].message).toContain("960");
  });

  it("stays silent once the timeout covers the batch", () => {
    const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: "8", [VISIBILITY_TIMEOUT_ENV]: "1200" }));
    expect(t.issues.filter((i) => i.kind === "invariant")).toHaveLength(0);
  });

  it("leaves the whole legal concurrency range satisfiable within the timeout ceiling", () => {
    // Otherwise the bounds would contradict each other: a legal `n` whose
    // required timeout is above MAX would be impossible to configure correctly.
    expect(requiredVisibilityTimeoutSeconds(MAX_DRAIN_CONCURRENCY)).toBeLessThanOrEqual(MAX_VISIBILITY_TIMEOUT_SECONDS);
  });

  it("reports the invariant against the CLAMPED concurrency, not the requested one", () => {
    // Someone asks for 64 and gets 8; the timeout advice must be the one that
    // matches what will actually run.
    const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: "64", [VISIBILITY_TIMEOUT_ENV]: "600" }));
    expect(t.drainConcurrency).toBe(8);
    const invariant = t.issues.find((i) => i.kind === "invariant");
    expect(invariant?.message).toContain("960");
  });
});

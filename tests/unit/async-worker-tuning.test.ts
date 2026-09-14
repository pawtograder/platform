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
  PER_MESSAGE_VT_BUDGET_SECONDS,
  ISOLATE_LIFETIME_ENV,
  DEFAULT_ISOLATE_LIFETIME_SECONDS,
  ORG_SLOT_GLOBAL_CAP_ENV,
  ORG_SLOT_MAX_PER_ORG_ENV,
  ORG_SLOT_LEASE_TTL_ENV,
  DEFAULT_ORG_SLOT_GLOBAL_CAP,
  MAX_ORG_SLOT_GLOBAL_CAP,
  MIN_ORG_SLOT_MAX_PER_ORG,
  MAX_ORG_SLOT_MAX_PER_ORG,
  MAX_ORG_SLOT_IN_FLIGHT_PER_ORG,
  DEFAULT_ORG_SLOT_MAX_PER_ORG,
  MIN_ORG_SLOT_LEASE_TTL_SECONDS,
  MAX_ORG_SLOT_LEASE_TTL_SECONDS,
  ORG_SLOT_CONTINUOUS_REFILL_ENV,
  DEFAULT_ORG_SLOT_CONTINUOUS_REFILL,
  MAX_ORG_SLOT_CONTINUOUS_REFILL
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
    expect(invariant).toHaveLength(2);
    expect(invariant[0].message).toContain("read_ct");
    expect(invariant[1].env).toBe(ISOLATE_LIFETIME_ENV);
    expect(t.visibilityTimeoutSeconds).toBe(300);
    expect(t.drainConcurrency).toBe(4);
  });
});

describe("async worker drain tuning: valid overrides", () => {
  it("accepts an in-range pair verbatim and reports nothing", () => {
    // The isolate lifetime has to be raised too, or the assumed 400s caps this
    // at 3 — see the isolate-lifetime describe block below.
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "8",
        [VISIBILITY_TIMEOUT_ENV]: "960",
        [ISOLATE_LIFETIME_ENV]: "960000"
      })
    );
    expect(t.drainConcurrency).toBe(8);
    expect(t.visibilityTimeoutSeconds).toBe(960);
    expect(t.issues).toHaveLength(0);
  });

  it("tolerates surrounding whitespace from a chart/secret round-trip", () => {
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: " 6 ",
        [VISIBILITY_TIMEOUT_ENV]: "\t720\n",
        [ISOLATE_LIFETIME_ENV]: " 720000 "
      })
    );
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

  // The isolate lifetime is set generously here ON PURPOSE. This test is about the
  // MAX_DRAIN_CONCURRENCY bound, so that bound has to be the binding term; without a
  // lifetime the resolver applies main.ts's 400s fallback and coherently returns 3
  // (floor(400/120)), which is correct behaviour but tests the wrong ceiling. The
  // lifetime ceiling has its own cases below.
  it("clamps an absurd concurrency down to the memory/quota ceiling instead of honouring it", () => {
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "1000",
        [VISIBILITY_TIMEOUT_ENV]: "1800",
        [ISOLATE_LIFETIME_ENV]: "1800000"
      })
    );
    expect(t.drainConcurrency).toBe(MAX_DRAIN_CONCURRENCY);
    expect(t.issues.some((i) => i.kind === "clamped" && i.env === DRAIN_CONCURRENCY_ENV)).toBe(true);
  });

  it("clamps the visibility timeout to its bounds, then to coherence", () => {
    // 1 is raised to the 60s bound, and 60 cannot cover even one message, so the
    // coherence floor raises the EFFECTIVE value to 120. Both steps are reported.
    const low = resolveAsyncWorkerTuning(env({ [VISIBILITY_TIMEOUT_ENV]: "1" }));
    expect(low.visibilityTimeoutSeconds).toBe(PER_MESSAGE_VT_BUDGET_SECONDS);
    expect(low.drainConcurrency).toBe(1);
    expect(
      low.issues.some(
        (i) => i.kind === "clamped" && i.message.includes(`below the minimum ${MIN_VISIBILITY_TIMEOUT_SECONDS}`)
      )
    ).toBe(true);
    expect(low.issues.some((i) => i.kind === "clamped" && i.message.includes("raised from 60s to 120s"))).toBe(true);

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

  it("ENFORCES a raised concurrency left against the old 300s timeout", () => {
    // 8/300 used to be handed to processBatch unchanged with a log line: a batch
    // modelled at 960s going visible at 300s. floor(300/120) = 2, so 2 is the
    // most concurrency that timeout can cover.
    const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: "8", [VISIBILITY_TIMEOUT_ENV]: "300" }));
    expect(t.drainConcurrency).toBe(2);
    expect(t.visibilityTimeoutSeconds).toBe(300);
    const clamped = t.issues.filter((i) => i.kind === "clamped");
    expect(clamped).toHaveLength(1);
    expect(clamped[0].env).toBe(DRAIN_CONCURRENCY_ENV);
    expect(clamped[0].message).toContain("reduced from 8 to 2");
    expect(clamped[0].message).toContain(VISIBILITY_TIMEOUT_ENV);
  });

  it("degrades concurrency rather than inflating the timeout", () => {
    // The timeout the operator set is what is honoured; the throughput knob is
    // what gives way. Inflating the VT could break the isolate-lifetime ceiling.
    // Lifetime raised out of the way here so the VT is the binding ceiling.
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "8",
        [VISIBILITY_TIMEOUT_ENV]: "600",
        [ISOLATE_LIFETIME_ENV]: "960000"
      })
    );
    expect(t.visibilityTimeoutSeconds).toBe(600);
    expect(t.drainConcurrency).toBe(5);
  });

  it("leaves a coherent pair completely alone", () => {
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "8",
        [VISIBILITY_TIMEOUT_ENV]: "960",
        [ISOLATE_LIFETIME_ENV]: "960000"
      })
    );
    expect([t.drainConcurrency, t.visibilityTimeoutSeconds]).toEqual([8, 960]);
    expect(t.issues).toHaveLength(0);
  });

  it("lands on n=1, NEVER 0, and raises the timeout so the floored pair is coherent", () => {
    // floor(60/120) = 0. n=0 reads nothing at all while the lease is held and
    // every heartbeat stays green, which is the worst outcome available — but
    // flooring alone used to leave n=1 against a 60s timeout, i.e. a knowingly
    // incoherent pair re-reading a multi-minute create_repo. The worker owns
    // sleep_seconds on every pgmq read, so it raises the timeout to the
    // one-message budget instead.
    const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: "8", [VISIBILITY_TIMEOUT_ENV]: "60" }));
    expect(t.drainConcurrency).toBe(1);
    expect(t.visibilityTimeoutSeconds).toBe(PER_MESSAGE_VT_BUDGET_SECONDS);
    const vtClamp = t.issues.filter((i) => i.kind === "clamped" && i.env === VISIBILITY_TIMEOUT_ENV);
    expect(vtClamp).toHaveLength(1);
    expect(vtClamp[0].message).toContain("raised from 60s to 120s");
    expect(vtClamp[0].message).toContain("floored at 1");
  });

  it("keeps the exact legacy pair 4/300 untouched, reported but not enforced", () => {
    // Enforcing here would change production behaviour on deploy, which is the
    // one thing this change promises not to do.
    const t = resolveAsyncWorkerTuning(env({ [DRAIN_CONCURRENCY_ENV]: "4", [VISIBILITY_TIMEOUT_ENV]: "300" }));
    expect([t.drainConcurrency, t.visibilityTimeoutSeconds]).toEqual([4, 300]);
    expect(t.issues.filter((i) => i.kind === "clamped")).toHaveLength(0);
    const invariant = t.issues.filter((i) => i.kind === "invariant");
    // Both ceilings are reported: 300 < 4x120, and the assumed 400s lifetime is
    // also below 480. Reported, never enforced — that is the whole exemption.
    expect(invariant).toHaveLength(2);
    expect(invariant[0].message).toContain("LEGACY PAIR");
    expect(invariant[1].env).toBe(ISOLATE_LIFETIME_ENV);
  });

  it("stays silent once the timeout covers the batch", () => {
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "8",
        [VISIBILITY_TIMEOUT_ENV]: "1200",
        [ISOLATE_LIFETIME_ENV]: "1200000"
      })
    );
    expect(t.issues).toHaveLength(0);
    expect(t.drainConcurrency).toBe(8);
  });

  it("leaves the whole legal concurrency range satisfiable within the timeout ceiling", () => {
    // Otherwise the bounds would contradict each other: a legal `n` whose
    // required timeout is above MAX would be impossible to configure correctly.
    expect(requiredVisibilityTimeoutSeconds(MAX_DRAIN_CONCURRENCY)).toBeLessThanOrEqual(MAX_VISIBILITY_TIMEOUT_SECONDS);
  });

  it("composes the bounds clamp with the coherence clamp", () => {
    // 64 is clamped to the ceiling of 8 first, then 8 is degraded to what a 600s
    // timeout can cover (5). Clamped inputs must not compose into an incoherent
    // pair, which is how 8/300 used to slip through.
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "64",
        [VISIBILITY_TIMEOUT_ENV]: "600",
        [ISOLATE_LIFETIME_ENV]: "960000"
      })
    );
    expect(t.drainConcurrency).toBe(5);
    expect(t.visibilityTimeoutSeconds).toBeGreaterThanOrEqual(t.drainConcurrency * PER_MESSAGE_VT_BUDGET_SECONDS);
    // ...and with only the assumed 400s lifetime, the lifetime binds instead.
    const noLifetime = resolveAsyncWorkerTuning(
      env({ [DRAIN_CONCURRENCY_ENV]: "64", [VISIBILITY_TIMEOUT_ENV]: "600" })
    );
    expect(noLifetime.drainConcurrency).toBe(3);
  });
});

describe("the second ceiling: isolate lifetime vs concurrency (config coherence)", () => {
  it("caps concurrency on the isolate lifetime, not just the visibility timeout", () => {
    // VT 960 would allow 8, but a 400s isolate only covers floor(400/120) = 3.
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "8",
        [VISIBILITY_TIMEOUT_ENV]: "960",
        [ISOLATE_LIFETIME_ENV]: "400000"
      })
    );
    expect(t.drainConcurrency).toBe(3);
    const clamped = t.issues.filter((i) => i.kind === "clamped");
    expect(clamped).toHaveLength(1);
    expect(clamped[0].message).toContain(ISOLATE_LIFETIME_ENV);
  });

  it("picks the LOWER of the two ceilings as the binding one", () => {
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "8",
        [VISIBILITY_TIMEOUT_ENV]: "240",
        [ISOLATE_LIFETIME_ENV]: "960000"
      })
    );
    expect(t.drainConcurrency).toBe(2);
    expect(t.issues.find((i) => i.kind === "clamped")?.message).toContain(VISIBILITY_TIMEOUT_ENV);
  });

  it("reports the legacy pair against the shipped 400s isolate lifetime without enforcing", () => {
    // A coherence check, not an observation: n x 120 budgets 480s for a batch of
    // 4 while EDGE_WORKER_TIMEOUT_MS=400000 allows 400s, so the pair cannot both
    // be right. Nothing here claims isolates are actually being truncated — that
    // claim was measured and retracted (see the module header).
    const t = resolveAsyncWorkerTuning(env({ [ISOLATE_LIFETIME_ENV]: "400000" }));
    const lifetime = t.issues.filter((i) => i.kind === "invariant" && i.env === ISOLATE_LIFETIME_ENV);
    expect(lifetime).toHaveLength(1);
    expect(lifetime[0].effective).toBe(400);
    expect(lifetime[0].message).toContain("480000");
  });

  it("stays silent once the lifetime covers the batch", () => {
    const t = resolveAsyncWorkerTuning(env({ [ISOLATE_LIFETIME_ENV]: "480000" }));
    expect(t.issues.filter((i) => i.env === ISOLATE_LIFETIME_ENV)).toHaveLength(0);
  });

  it("satisfies the visibility-timeout ceiling for EVERY combination it returns", () => {
    // The `> 1` escape hatch this assertion used to carry was load-bearing only
    // because the VT inputs never forced the floor. They do now (60, 61, 119),
    // and the floored result raises the timeout, so the ceiling holds at n=1 too
    // and the exemption is gone. The isolate-lifetime ceiling is asserted
    // separately below, because it is the one this module cannot always fix.
    for (const n of ["1", "3", "4", "8", "64", "0", "abc"]) {
      for (const vt of ["60", "61", "119", "120", "240", "300", "480", "960", "1800", "abc"]) {
        for (const life of [undefined, "60000", "400000", "480000", "960000", "abc"]) {
          const t = resolveAsyncWorkerTuning(
            env({ [DRAIN_CONCURRENCY_ENV]: n, [VISIBILITY_TIMEOUT_ENV]: vt, [ISOLATE_LIFETIME_ENV]: life })
          );
          const tag = `${n}/${vt}/${life}`;
          expect(t.drainConcurrency).toBeGreaterThanOrEqual(1);
          expect(t.drainConcurrency).toBeLessThanOrEqual(MAX_DRAIN_CONCURRENCY);
          const isLegacy = t.drainConcurrency === 4 && t.visibilityTimeoutSeconds === 300;
          if (!isLegacy) {
            // `tag` is in the failure message so a sweep failure names the input.
            expect([tag, t.visibilityTimeoutSeconds >= t.drainConcurrency * PER_MESSAGE_VT_BUDGET_SECONDS]).toEqual([
              tag,
              true
            ]);
          }
        }
      }
    }
  });

  it("satisfies the isolate-lifetime ceiling whenever the lifetime allows one message at all", () => {
    for (const n of ["1", "4", "8", "64"]) {
      for (const vt of ["60", "300", "960", "1800"]) {
        for (const life of [undefined, "400000", "480000", "960000"]) {
          const t = resolveAsyncWorkerTuning(
            env({ [DRAIN_CONCURRENCY_ENV]: n, [VISIBILITY_TIMEOUT_ENV]: vt, [ISOLATE_LIFETIME_ENV]: life })
          );
          const lifeSec = life ? Math.floor(Number(life) / 1000) : DEFAULT_ISOLATE_LIFETIME_SECONDS;
          const isLegacy = t.drainConcurrency === 4 && t.visibilityTimeoutSeconds === 300;
          if (!isLegacy && lifeSec >= PER_MESSAGE_VT_BUDGET_SECONDS) {
            expect(lifeSec).toBeGreaterThanOrEqual(t.drainConcurrency * PER_MESSAGE_VT_BUDGET_SECONDS);
          }
        }
      }
    }
  });

  it("assumes main.ts's 400s fallback rather than skipping the ceiling", () => {
    // main.ts:61 is `Number(env) || 400 * 1000`, so the runtime is not undecided
    // about an absent value and neither is this. Skipping the ceiling used to
    // green-light a 960s batch inside an isolate that really lives 400s.
    expect(DEFAULT_ISOLATE_LIFETIME_SECONDS).toBe(400);
    for (const vars of [{}, { [ISOLATE_LIFETIME_ENV]: "" }]) {
      const t = resolveAsyncWorkerTuning(
        env({ ...vars, [DRAIN_CONCURRENCY_ENV]: "8", [VISIBILITY_TIMEOUT_ENV]: "960" })
      );
      expect(t.drainConcurrency).toBe(3);
      expect(t.issues.find((i) => i.kind === "clamped")?.message).toContain(ISOLATE_LIFETIME_ENV);
    }
  });

  it("reports a malformed lifetime separately from the clamp it causes", () => {
    // "you typed garbage" and "your pair was reduced" are different facts and an
    // operator needs both.
    for (const raw of ["400s", "abc", "0", "-5"]) {
      const t = resolveAsyncWorkerTuning(
        env({ [DRAIN_CONCURRENCY_ENV]: "8", [VISIBILITY_TIMEOUT_ENV]: "960", [ISOLATE_LIFETIME_ENV]: raw })
      );
      const rejected = t.issues.filter((i) => i.kind === "rejected" && i.env === ISOLATE_LIFETIME_ENV);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].effective).toBe(DEFAULT_ISOLATE_LIFETIME_SECONDS);
      expect(t.issues.filter((i) => i.kind === "clamped")).toHaveLength(1);
      expect(t.drainConcurrency).toBe(3);
    }
  });

  it("says so, rather than pretending, when the lifetime is below even one message", () => {
    // sleep_seconds is ours to raise; the isolate lifetime is the demuxer's.
    const t = resolveAsyncWorkerTuning(
      env({ [DRAIN_CONCURRENCY_ENV]: "4", [VISIBILITY_TIMEOUT_ENV]: "480", [ISOLATE_LIFETIME_ENV]: "60000" })
    );
    expect(t.drainConcurrency).toBe(1);
    const unfixable = t.issues.filter((i) => i.kind === "invariant" && i.env === ISOLATE_LIFETIME_ENV);
    expect(unfixable).toHaveLength(1);
    expect(unfixable[0].message).toContain("cannot raise it");
  });

  it("never treats the lifetime as a knob it can change", () => {
    const t = resolveAsyncWorkerTuning(env({ [ISOLATE_LIFETIME_ENV]: "1000" }));
    // The lifetime belongs to the demuxer and must never appear in the output. Pinning the exact
    // key list is what makes that assertion durable, so a new knob has to be added here on purpose.
    expect(Object.keys(t)).toEqual(["drainConcurrency", "visibilityTimeoutSeconds", "orgSlots", "issues"]);
    expect(t.drainConcurrency).toBe(4);
    expect(t.visibilityTimeoutSeconds).toBe(300);
  });
});

/**
 * The per-org slot knobs (2026-09-13).
 *
 * Same two properties as the drain knobs above, because they are the same kind of thing: the
 * defaults must reproduce the pre-change behaviour EXACTLY — here that means per-org leasing off
 * and the single-leaseholder path still in force — and no configured value may put more work on one
 * GitHub org's rate limit than the limiter is budgeted for.
 */
describe("per-org slot tuning defaults", () => {
  it("is inert until configured: nothing set means per-org leasing is off", () => {
    const t = resolveAsyncWorkerTuning(env({}));
    expect(t.orgSlots.enabled).toBe(false);
    expect(t.orgSlots.globalCap).toBe(0);
    expect(DEFAULT_ORG_SLOT_GLOBAL_CAP).toBe(0);
  });

  it("adds no issues of its own to the shipped defaults", () => {
    // The defaults already carry two invariant reports (the legacy 4/300 pair). The per-org knobs
    // must not add a third, or every deployment would page on a feature nobody turned on.
    const t = resolveAsyncWorkerTuning(env({}));
    expect(t.issues.filter((i) => i.env.includes("ORG_SLOT"))).toHaveLength(0);
    expect(t.issues.filter((i) => i.kind === "invariant")).toHaveLength(2);
  });

  it("turns on with only the global cap set, at the most conservative per-org setting", () => {
    // Enabling should buy CROSS-org parallelism without changing how hard any single org is hit.
    const t = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "4" }));
    expect(t.orgSlots).toEqual({
      enabled: true,
      globalCap: 4,
      maxPerOrg: 1,
      leaseTtlSeconds: 60,
      continuousRefill: true
    });
    expect(t.issues.filter((i) => i.env.includes("ORG_SLOT"))).toHaveLength(0);
  });

  it("does not change the drain knobs, which are per leaseholder", () => {
    // The point of the design: concurrency comes from more isolates, so `n` and the visibility
    // timeout are untouched by enabling this.
    const off = resolveAsyncWorkerTuning(env({}));
    const on = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "8" }));
    expect(on.drainConcurrency).toBe(off.drainConcurrency);
    expect(on.visibilityTimeoutSeconds).toBe(off.visibilityTimeoutSeconds);
  });

  it("treats an explicit 0 as a supported value, not as a typo", () => {
    // Unlike `n: 0`, `globalCap: 0` selects a complete, shipped, draining worker — the old path.
    const t = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "0" }));
    expect(t.orgSlots.enabled).toBe(false);
    expect(t.issues.filter((i) => i.env === ORG_SLOT_GLOBAL_CAP_ENV)).toHaveLength(0);
  });
});

describe("per-org slot tuning: parsing and bounds", () => {
  it("falls back and reports, rather than sending garbage to the RPC", () => {
    // claim_org_slot_and_read RAISES on a null or sub-1 lease_ttl_seconds, so a NaN here would take
    // the drain down for a typo it could have ridden out.
    for (const raw of ["four", "1.5", "8kB", "-1"]) {
      const t = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: raw }));
      expect(t.orgSlots.globalCap).toBe(DEFAULT_ORG_SLOT_GLOBAL_CAP);
      const rejected = t.issues.filter((i) => i.kind === "rejected" && i.env === ORG_SLOT_GLOBAL_CAP_ENV);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].effective).toBe(DEFAULT_ORG_SLOT_GLOBAL_CAP);
    }
  });

  it("clamps an over-large global cap to maxParallelism and says so", () => {
    const t = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "64" }));
    expect(t.orgSlots.globalCap).toBe(MAX_ORG_SLOT_GLOBAL_CAP);
    const clamped = t.issues.filter((i) => i.kind === "clamped" && i.env === ORG_SLOT_GLOBAL_CAP_ENV);
    expect(clamped).toHaveLength(1);
    expect(clamped[0].effective).toBe(8);
  });

  it("clamps the per-org allowance to its measured ceiling", () => {
    const t = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "8", [ORG_SLOT_MAX_PER_ORG_ENV]: "10" }));
    expect(t.orgSlots.maxPerOrg).toBe(MAX_ORG_SLOT_MAX_PER_ORG);
    expect(t.issues.filter((i) => i.kind === "clamped" && i.env === ORG_SLOT_MAX_PER_ORG_ENV)).toHaveLength(1);
  });

  it("clamps the lease TTL to its range", () => {
    const low = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "4", [ORG_SLOT_LEASE_TTL_ENV]: "5" }));
    expect(low.orgSlots.leaseTtlSeconds).toBe(MIN_ORG_SLOT_LEASE_TTL_SECONDS);

    const high = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "4", [ORG_SLOT_LEASE_TTL_ENV]: "9000" }));
    expect(high.orgSlots.leaseTtlSeconds).toBe(MAX_ORG_SLOT_LEASE_TTL_SECONDS);
  });

  it("does NOT tie the TTL floor to the longest measured single message", () => {
    // This test asserted `MIN_ORG_SLOT_LEASE_TTL_SECONDS > 32.2` on the theory that a TTL below the
    // longest unit of work reaps slots from leaseholders that are working. Both parts were wrong
    // (2026-09-14). 32.2s was one org on one day; the real platform max across all methods on the
    // VT=480 regime is 97.7s over 2,337 messages, and 1.5% of messages already exceed the SHIPPED
    // 60s TTL. They renew through fine, because renewal is an independent setInterval at TTL/3 and
    // the handlers await on GitHub I/O — so what lapses a lease is an event-loop stall of a whole
    // TTL, not a long message.
    //
    // The floor is therefore deliberately BELOW the longest message, and pinning that inequality is
    // the point: if someone "fixes" this by raising the floor past 97.7s they have re-encoded a
    // coupling between the renewal timer and the handlers that does not exist.
    const longestMeasuredMessageSeconds = 97.7;
    expect(MIN_ORG_SLOT_LEASE_TTL_SECONDS).toBeLessThan(longestMeasuredMessageSeconds);

    // What the floor IS about: tolerating an unyielding event loop for a whole TTL, and leaving a
    // renewal interval (TTL/3) with orders of magnitude of margin over a Postgres round trip.
    const heartbeatDivisor = 3;
    expect(MIN_ORG_SLOT_LEASE_TTL_SECONDS / heartbeatDivisor).toBeGreaterThanOrEqual(15);
  });

  it("keeps the shipped lease TTL inside the range even though messages outlive it", () => {
    // Khoury prod runs orgSlotLeaseTtlSeconds: 60 against a 97.7s worst message. That combination
    // must be expressible and must not be clamped, or the chart would be refusing the configuration
    // that has run ~17h with no cap breach and no lease lapse.
    const t = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "8", [ORG_SLOT_LEASE_TTL_ENV]: "60" }));
    expect(t.orgSlots.leaseTtlSeconds).toBe(60);
    expect(t.issues.filter((i) => i.env === ORG_SLOT_LEASE_TTL_ENV)).toHaveLength(0);
    expect(MIN_ORG_SLOT_LEASE_TTL_SECONDS).toBeLessThanOrEqual(60);
  });
});

describe("per-org slot tuning: coherence with the per-org rate limit", () => {
  it("holds maxPerOrg x n at or below the content limiter's budget", () => {
    // The product ceiling is MAX_ORG_SLOT_IN_FLIGHT_PER_ORG (16), NOT MAX_DRAIN_CONCURRENCY (8):
    // that one bounds a single isolate's batch, this one bounds one org's share of a fleet-wide
    // GitHub limiter. At n=8 there is room for two leaseholders per org, and 4 is clamped to 2.
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "8",
        [VISIBILITY_TIMEOUT_ENV]: "960",
        [ISOLATE_LIFETIME_ENV]: "960000",
        [ORG_SLOT_GLOBAL_CAP_ENV]: "8",
        [ORG_SLOT_MAX_PER_ORG_ENV]: "4"
      })
    );
    expect(t.drainConcurrency).toBe(8);
    expect(t.orgSlots.maxPerOrg).toBe(2);
    expect(t.orgSlots.maxPerOrg * t.drainConcurrency).toBeLessThanOrEqual(MAX_ORG_SLOT_IN_FLIGHT_PER_ORG);

    const clamped = t.issues.filter((i) => i.kind === "clamped" && i.env === ORG_SLOT_MAX_PER_ORG_ENV);
    expect(clamped).toHaveLength(1);
    // The operator asked for more throughput; tell them where it actually comes from.
    expect(clamped[0].message).toContain(ORG_SLOT_GLOBAL_CAP_ENV);
  });

  it("permits exactly MAX_ORG_SLOT_IN_FLIGHT_PER_ORG in flight, which the old ceiling refused", () => {
    // 2 x 8 = 16 was clamped to 1 before 2026-09-14, when the product ceiling was
    // MAX_DRAIN_CONCURRENCY. Asserting only the clamp above would still pass if the ceiling had
    // never moved, so pin the newly-legal point too.
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "8",
        [VISIBILITY_TIMEOUT_ENV]: "960",
        [ISOLATE_LIFETIME_ENV]: "960000",
        [ORG_SLOT_GLOBAL_CAP_ENV]: "8",
        [ORG_SLOT_MAX_PER_ORG_ENV]: "2"
      })
    );
    expect(t.drainConcurrency).toBe(8);
    expect(t.orgSlots.maxPerOrg).toBe(2);
    expect(t.orgSlots.maxPerOrg * t.drainConcurrency).toBe(MAX_ORG_SLOT_IN_FLIGHT_PER_ORG);
    expect(t.issues.filter((i) => i.env === ORG_SLOT_MAX_PER_ORG_ENV)).toHaveLength(0);
  });

  it("clamps to the raised per-org ceiling, not to the drain-concurrency ceiling", () => {
    // The two constants used to be the same 8 and a single value could not tell them apart. At the
    // shipped n=4 the per-org ceiling is floor(16/4) = 4 and the range maximum is also 4, so an
    // operator asking for 4 gets 4 — under the OLD rule this landed on 2.
    const t = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "8", [ORG_SLOT_MAX_PER_ORG_ENV]: "4" }));
    expect(t.drainConcurrency).toBe(DEFAULT_DRAIN_CONCURRENCY);
    expect(t.orgSlots.maxPerOrg).toBe(MAX_ORG_SLOT_MAX_PER_ORG);
    expect(t.orgSlots.maxPerOrg).toBe(4);
    expect(t.issues.filter((i) => i.env === ORG_SLOT_MAX_PER_ORG_ENV)).toHaveLength(0);
    // And it is the per-org budget being spent, not the isolate's: 16 > MAX_DRAIN_CONCURRENCY.
    expect(t.orgSlots.maxPerOrg * t.drainConcurrency).toBeGreaterThan(MAX_DRAIN_CONCURRENCY);
  });

  it("names the reservoir, not just the ceiling, when it clamps", () => {
    // The clamp message is the only place an operator learns WHY the number moved. "Above 16" on
    // its own reads as an arbitrary limit; the 40-starts-per-60s reservoir is the actual reason.
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "8",
        [VISIBILITY_TIMEOUT_ENV]: "960",
        [ISOLATE_LIFETIME_ENV]: "960000",
        [ORG_SLOT_GLOBAL_CAP_ENV]: "8",
        [ORG_SLOT_MAX_PER_ORG_ENV]: "4"
      })
    );
    const clamped = t.issues.filter((i) => i.kind === "clamped" && i.env === ORG_SLOT_MAX_PER_ORG_ENV);
    expect(clamped).toHaveLength(1);
    expect(clamped[0].message).toContain("40 per minute");
    expect(clamped[0].message).toContain("reservoir");
    // 4 x 8 = 32 in flight at a 23.1s p50 is 60 x 32 / 23.1 = 83 starts/min against a 40/min refresh.
    expect(clamped[0].message).toContain("83 creations/min");
  });

  it("allows the full per-org allowance at the shipped n", () => {
    const t = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "8", [ORG_SLOT_MAX_PER_ORG_ENV]: "2" }));
    expect(t.drainConcurrency).toBe(4);
    expect(t.orgSlots.maxPerOrg).toBe(2);
    expect(t.issues.filter((i) => i.env === ORG_SLOT_MAX_PER_ORG_ENV)).toHaveLength(0);
  });

  it("checks against the EFFECTIVE n, not the configured one", () => {
    // n=8 with the timeouts left alone is degraded to 2 by the enforcement above, so an org can
    // safely take the full per-org allowance — checking the configured 8 would restrict a
    // leaseholder that is never going to run that wide.
    const t = resolveAsyncWorkerTuning(
      env({ [DRAIN_CONCURRENCY_ENV]: "8", [ORG_SLOT_GLOBAL_CAP_ENV]: "8", [ORG_SLOT_MAX_PER_ORG_ENV]: "2" })
    );
    expect(t.drainConcurrency).toBe(2);
    expect(t.orgSlots.maxPerOrg).toBe(2);
  });

  it("never lets a per-org allowance exceed the fleet-wide cap", () => {
    const t = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "1", [ORG_SLOT_MAX_PER_ORG_ENV]: "2" }));
    expect(t.orgSlots.maxPerOrg).toBe(1);
    const clamped = t.issues.filter((i) => i.kind === "clamped" && i.env === ORG_SLOT_MAX_PER_ORG_ENV);
    expect(clamped).toHaveLength(1);
    expect(clamped[0].message).toContain("can never be reached");
  });

  it("never returns a maxPerOrg of 0, whatever the arithmetic says", () => {
    // Same failure MIN_DRAIN_CONCURRENCY exists for: 0 would mean no org can ever be drained while
    // every liveness signal stays green.
    for (const n of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
      const t = resolveAsyncWorkerTuning(
        env({
          [DRAIN_CONCURRENCY_ENV]: n,
          [VISIBILITY_TIMEOUT_ENV]: "1800",
          [ISOLATE_LIFETIME_ENV]: "1800000",
          [ORG_SLOT_GLOBAL_CAP_ENV]: "8",
          [ORG_SLOT_MAX_PER_ORG_ENV]: "2"
        })
      );
      expect(t.orgSlots.maxPerOrg).toBeGreaterThanOrEqual(MIN_ORG_SLOT_MAX_PER_ORG);
    }
  });

  it("keeps the constants themselves coherent at the shipped defaults", () => {
    // The range maximum must be reachable at the shipped n, or the top of the range is unreachable
    // and the number in values.yaml is a lie about what the deploy can do.
    expect(MAX_ORG_SLOT_MAX_PER_ORG * DEFAULT_DRAIN_CONCURRENCY).toBeLessThanOrEqual(MAX_ORG_SLOT_IN_FLIGHT_PER_ORG);
    expect(MAX_ORG_SLOT_MAX_PER_ORG * DEFAULT_DRAIN_CONCURRENCY).toBe(MAX_ORG_SLOT_IN_FLIGHT_PER_ORG);
  });

  it("keeps the per-org budget a SEPARATE constant from the per-isolate one", () => {
    // These were the same 8 until 2026-09-14 and reusing one for the other was the bug: the isolate
    // ceiling is about heap and the n x 120 VT model, the per-org ceiling is about a GitHub rate
    // limit. If they ever collapse back to one number, raising either drags the other.
    expect(MAX_ORG_SLOT_IN_FLIGHT_PER_ORG).toBe(16);
    expect(MAX_DRAIN_CONCURRENCY).toBe(8);
    expect(MAX_ORG_SLOT_IN_FLIGHT_PER_ORG).not.toBe(MAX_DRAIN_CONCURRENCY);
  });

  it("raises what is EXPRESSIBLE without raising what is SHIPPED", () => {
    // The whole point of the 2026-09-14 change. orgSlotMaxPerOrg is a single global knob with no
    // per-org dimension, and the measured create_repo p50 spread across orgs on one platform is 2x
    // (23.1s neu-cs2000 -> 46.0s Khoury-CS3650). 16 in flight is 41.6 starts/min for the fast org —
    // over the 40/min reservoir — and 20.9/min for the slow one. So the ceiling moves and the
    // default does not: turning it up stays an operator decision taken against a measurement.
    expect(MAX_ORG_SLOT_MAX_PER_ORG).toBe(4);
    expect(DEFAULT_ORG_SLOT_MAX_PER_ORG).toBe(1);
    expect(resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "8" })).orgSlots.maxPerOrg).toBe(1);
    // The reservoir arithmetic the ceiling is argued from, as an assertion rather than a comment.
    const startsPerMin = (inFlight: number, p50: number) => (60 * inFlight) / p50;
    expect(startsPerMin(MAX_ORG_SLOT_IN_FLIGHT_PER_ORG, 23.1)).toBeGreaterThan(40);
    expect(startsPerMin(MAX_ORG_SLOT_IN_FLIGHT_PER_ORG, 46.0)).toBeLessThan(40);
    expect(startsPerMin(DEFAULT_ORG_SLOT_MAX_PER_ORG * DEFAULT_DRAIN_CONCURRENCY, 23.1)).toBeLessThan(40);
  });
});

describe("continuous refill kill switch", () => {
  it("ships ON, so the PR's own change is what a default deployment gets", () => {
    const t = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "8" }));
    expect(t.orgSlots.continuousRefill).toBe(true);
    expect(DEFAULT_ORG_SLOT_CONTINUOUS_REFILL).toBe(1);
    expect(t.issues.filter((i) => i.env === ORG_SLOT_CONTINUOUS_REFILL_ENV)).toHaveLength(0);
  });

  it("turns OFF without giving up per-org leaseholders", () => {
    // The entire reason the knob exists. Before it, rolling the drain shape back meant
    // globalCap: 0, which also switches the feature off and gives back the cross-org throughput
    // that is already working in production.
    const t = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "8", [ORG_SLOT_CONTINUOUS_REFILL_ENV]: "0" }));
    expect(t.orgSlots.continuousRefill).toBe(false);
    expect(t.orgSlots.enabled).toBe(true);
    expect(t.orgSlots.globalCap).toBe(8);
    expect(t.orgSlots.maxPerOrg).toBe(1);
  });

  it("does not fail OPEN on a string boolean, which is why it is an integer", () => {
    // `Boolean("false") === true`. If this knob parsed strings, "false" / "no" / "off" would all
    // mean ON and the kill switch would not switch at the one moment anyone reaches for it.
    // Through readBounded they are REJECTED and reported, and the fallback is visible.
    for (const raw of ["false", "no", "off", "true"]) {
      const t = resolveAsyncWorkerTuning(
        env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "8", [ORG_SLOT_CONTINUOUS_REFILL_ENV]: raw })
      );
      const rejected = t.issues.filter((i) => i.kind === "rejected" && i.env === ORG_SLOT_CONTINUOUS_REFILL_ENV);
      expect(rejected).toHaveLength(1);
      // It falls back to the default rather than to "whatever the string coerced to".
      expect(t.orgSlots.continuousRefill).toBe(true);
      expect(rejected[0].effective).toBe(DEFAULT_ORG_SLOT_CONTINUOUS_REFILL);
    }
  });

  it("clamps an out-of-range value instead of treating it as extra-on", () => {
    const t = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "8", [ORG_SLOT_CONTINUOUS_REFILL_ENV]: "2" }));
    expect(t.orgSlots.continuousRefill).toBe(true);
    const clamped = t.issues.filter((i) => i.kind === "clamped" && i.env === ORG_SLOT_CONTINUOUS_REFILL_ENV);
    expect(clamped).toHaveLength(1);
    expect(clamped[0].effective).toBe(MAX_ORG_SLOT_CONTINUOUS_REFILL);
  });

  it("is reported as CONFIGURED even when per-org leasing is off", () => {
    // Forcing it to false when the feature is off would conflate "an operator rolled the drain
    // shape back" with "per-org leasing is not on", and those need different responses.
    const t = resolveAsyncWorkerTuning(env({ [ORG_SLOT_CONTINUOUS_REFILL_ENV]: "0" }));
    expect(t.orgSlots.enabled).toBe(false);
    expect(t.orgSlots.continuousRefill).toBe(false);
  });

  it("adds no issues to the shipped defaults", () => {
    // Same property the other org-slot knobs hold: a feature nobody turned on must not page.
    const t = resolveAsyncWorkerTuning(env({}));
    expect(t.orgSlots.continuousRefill).toBe(true);
    expect(t.issues.filter((i) => i.env === ORG_SLOT_CONTINUOUS_REFILL_ENV)).toHaveLength(0);
  });

  it("changes nothing else: it shapes WHEN a claim happens, not how much is in flight", () => {
    // No coherence rule of its own, so switching it must not perturb any other resolved value.
    const on = resolveAsyncWorkerTuning(env({ [ORG_SLOT_GLOBAL_CAP_ENV]: "8", [ORG_SLOT_MAX_PER_ORG_ENV]: "2" }));
    const off = resolveAsyncWorkerTuning(
      env({
        [ORG_SLOT_GLOBAL_CAP_ENV]: "8",
        [ORG_SLOT_MAX_PER_ORG_ENV]: "2",
        [ORG_SLOT_CONTINUOUS_REFILL_ENV]: "0"
      })
    );
    expect({ ...off.orgSlots, continuousRefill: true }).toEqual(on.orgSlots);
    expect(off.drainConcurrency).toBe(on.drainConcurrency);
    expect(off.visibilityTimeoutSeconds).toBe(on.visibilityTimeoutSeconds);
  });
});

describe("per-org slot tuning: coherence with the timeouts", () => {
  it("never lets the TTL outlive the visibility timeout", () => {
    // A dead holder's slot must not stay pinned past the point where its own messages are
    // redeliverable: the queue would be drainable and the slot would say otherwise.
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "2",
        [VISIBILITY_TIMEOUT_ENV]: "240",
        [ORG_SLOT_GLOBAL_CAP_ENV]: "4",
        [ORG_SLOT_LEASE_TTL_ENV]: "300"
      })
    );
    expect(t.visibilityTimeoutSeconds).toBe(240);
    expect(t.orgSlots.leaseTtlSeconds).toBe(240);
    const clamped = t.issues.filter((i) => i.kind === "clamped" && i.env === ORG_SLOT_LEASE_TTL_ENV);
    expect(clamped).toHaveLength(1);
    expect(clamped[0].message).toContain(VISIBILITY_TIMEOUT_ENV);
  });

  it("never lets the TTL outlive the isolate that holds it", () => {
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "1",
        [VISIBILITY_TIMEOUT_ENV]: "600",
        [ISOLATE_LIFETIME_ENV]: "120000",
        [ORG_SLOT_GLOBAL_CAP_ENV]: "4",
        [ORG_SLOT_LEASE_TTL_ENV]: "300"
      })
    );
    expect(t.orgSlots.leaseTtlSeconds).toBe(120);
    expect(t.issues.filter((i) => i.kind === "clamped" && i.env === ORG_SLOT_LEASE_TTL_ENV)[0].message).toContain(
      ISOLATE_LIFETIME_ENV
    );
  });

  it("reports rather than clamps when the floor and the ceiling cross", () => {
    // A 30s isolate lifetime puts the ceiling below the 45s floor. Clamping to 30s would reap
    // working leaseholders, so the floor wins and the mismatch is reported as unfixable here.
    const t = resolveAsyncWorkerTuning(
      env({ [ISOLATE_LIFETIME_ENV]: "30000", [ORG_SLOT_GLOBAL_CAP_ENV]: "4", [ORG_SLOT_LEASE_TTL_ENV]: "300" })
    );
    expect(t.orgSlots.leaseTtlSeconds).toBe(MIN_ORG_SLOT_LEASE_TTL_SECONDS);
    const unfixable = t.issues.filter((i) => i.kind === "invariant" && i.env === ORG_SLOT_LEASE_TTL_ENV);
    expect(unfixable).toHaveLength(1);
    expect(unfixable[0].message).toContain("still working");
  });

  it("does not emit coherence noise about knobs that are switched off", () => {
    // maxPerOrg=2 against n=8 is incoherent, but with the feature off it is also inert, and a
    // Sentry warning about a number with no effect is noise on every deployment.
    const t = resolveAsyncWorkerTuning(
      env({
        [DRAIN_CONCURRENCY_ENV]: "8",
        [VISIBILITY_TIMEOUT_ENV]: "960",
        [ISOLATE_LIFETIME_ENV]: "960000",
        [ORG_SLOT_MAX_PER_ORG_ENV]: "2",
        [ORG_SLOT_LEASE_TTL_ENV]: "300"
      })
    );
    expect(t.orgSlots.enabled).toBe(false);
    expect(t.issues.filter((i) => i.env.includes("ORG_SLOT"))).toHaveLength(0);
  });
});

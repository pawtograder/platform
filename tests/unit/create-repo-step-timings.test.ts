/**
 * @jest-environment node
 */

/**
 * Tests for the step-timing collector added to chase the 2026-09-07 create_repo latency (58 prod
 * messages, p50 279.5s, ~275s of it unexplained — see supabase/functions/_shared/stepTimings.ts).
 *
 * The properties under test are the ones that make this instrumentation safe to ship into the hot
 * path of repo creation: it records what it claims to record, it still reports the steps that DID
 * complete when a later step throws, and it can never mask, wrap, or swallow the caller's error.
 */

import {
  bucketDurationMs,
  countStep,
  STEP_TIMINGS_DEBUG_ENV_VAR,
  STEP_TIMINGS_DEBUG_LOG_PREFIX,
  STEP_TIMINGS_LOG_PREFIX,
  StepTimings,
  type StepTimingsSnapshot,
  timeStep
} from "@/supabase/functions/_shared/stepTimings";

/** Deterministic clock: every read advances by the scripted amount. */
function fakeClock(startAt = 1_000) {
  let now = startAt;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

function harness(startAt = 1_000) {
  const clock = fakeClock(startAt);
  const lines: string[] = [];
  const timings = new StepTimings("create_repo", {
    now: clock.now,
    log: (line) => lines.push(line),
    debug: false
  });
  return { clock, lines, timings };
}

function parseSummary(lines: string[]): StepTimingsSnapshot {
  const summary = lines.filter((l) => l.startsWith(STEP_TIMINGS_LOG_PREFIX));
  expect(summary).toHaveLength(1);
  return JSON.parse(summary[0].slice(STEP_TIMINGS_LOG_PREFIX.length).trim()) as StepTimingsSnapshot;
}

describe("StepTimings.time", () => {
  it("records elapsed ms per step and returns the step's value", async () => {
    const { clock, lines, timings } = harness();

    const generated = await timings.time("template_generate", () => {
      clock.advance(4_896);
      return Promise.resolve("head-sha");
    });
    await timings.time("get_head_sha", () => {
      clock.advance(120);
      return Promise.resolve(undefined);
    });

    expect(generated).toBe("head-sha");
    timings.finish();
    const snapshot = parseSummary(lines);
    expect(snapshot.op).toBe("create_repo");
    expect(snapshot.steps).toEqual({ template_generate: 4_896, get_head_sha: 120 });
    expect(snapshot.slowest_step).toBe("template_generate");
    expect(snapshot.slowest_ms).toBe(4_896);
    expect(snapshot.failed_step).toBeNull();
  });

  it("accumulates a step that runs more than once and reports the call count", async () => {
    // The delete+regenerate repair path runs generate + wait-ready twice; the summary must show the
    // TOTAL cost of the step plus the fact that it ran twice, not a silently doubled number.
    const { clock, lines, timings } = harness();
    for (const ms of [4_000, 5_000]) {
      await timings.time("template_generate", () => {
        clock.advance(ms);
        return Promise.resolve(undefined);
      });
    }
    await timings.time("post_delete_sleep", () => {
      clock.advance(2_000);
      return Promise.resolve(undefined);
    });

    timings.finish();
    const snapshot = parseSummary(lines);
    expect(snapshot.steps.template_generate).toBe(9_000);
    expect(snapshot.repeated).toEqual({ template_generate: 2 });
    expect(snapshot.repeated.post_delete_sleep).toBeUndefined();
  });

  it("reports total, accounted and unaccounted time so gaps between steps are visible", async () => {
    const { clock, lines, timings } = harness();
    clock.advance(1_000); // time spent before any instrumented step
    await timings.time("get_octokit", () => {
      clock.advance(50);
      return Promise.resolve(undefined);
    });
    clock.advance(30_000); // an un-instrumented stretch — exactly what we are hunting

    timings.finish();
    const snapshot = parseSummary(lines);
    expect(snapshot.total_ms).toBe(31_050);
    expect(snapshot.accounted_ms).toBe(50);
    expect(snapshot.unaccounted_ms).toBe(31_000);
  });

  it("counts poll attempts separately from elapsed time", async () => {
    // waitForRepoReady is capped at 30 x 2000ms, so the attempt COUNT is what bounds how much of
    // the 4.7 minutes that loop can own — elapsed time alone cannot distinguish one slow GET from
    // 29 polls.
    const { clock, lines, timings } = harness();
    for (let attempt = 0; attempt < 3; attempt++) {
      timings.count("wait_for_repo_ready_attempts");
      await timings.time("wait_for_repo_ready_sleep", () => {
        clock.advance(2_000);
        return Promise.resolve(undefined);
      });
    }
    timings.finish();
    const snapshot = parseSummary(lines);
    expect(snapshot.counts).toEqual({ wait_for_repo_ready_attempts: 3 });
    expect(snapshot.steps.wait_for_repo_ready_sleep).toBe(6_000);
  });
});

describe("StepTimings failure behavior", () => {
  it("still reports the steps that completed when a later step throws", async () => {
    const { clock, lines, timings } = harness();
    const boom = new Error("GitHub said no");

    await timings.time("patch_repo_settings", () => {
      clock.advance(200);
      return Promise.resolve(undefined);
    });
    await expect(
      timings.time("get_head_sha", () => {
        clock.advance(93_000);
        return Promise.reject(boom);
      })
    ).rejects.toBe(boom);

    timings.finish();
    const snapshot = parseSummary(lines);
    expect(snapshot.steps).toEqual({ patch_repo_settings: 200, get_head_sha: 93_000 });
    expect(snapshot.failed_step).toBe("get_head_sha");
  });

  it("re-throws the ORIGINAL error object, unmodified", async () => {
    const { timings } = harness();

    class RepoError extends Error {
      readonly status = 422;
    }
    const original = new RepoError("Name already exists on this account");

    let caught: unknown;
    try {
      await timings.time("template_generate", () => Promise.reject(original));
    } catch (e) {
      caught = e;
    }

    // Identity, not just message equality: callers branch on `instanceof RequestError` and read
    // `.status`/`.response.data.errors`, so a wrapped or re-created error would change behavior.
    expect(caught).toBe(original);
    expect((caught as RepoError).status).toBe(422);
    expect((caught as Error).message).toBe("Name already exists on this account");
  });

  it("propagates a synchronous throw from the timed function", async () => {
    const { timings } = harness();
    const boom = new Error("sync boom");
    await expect(
      timings.time("get_octokit", () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(timings.snapshot().failed_step).toBe("get_octokit");
  });

  it("keeps the FIRST failing step when several fail", async () => {
    const { timings } = harness();
    await expect(timings.time("first", () => Promise.reject(new Error("a")))).rejects.toThrow("a");
    await expect(timings.time("second", () => Promise.reject(new Error("b")))).rejects.toThrow("b");
    expect(timings.snapshot().failed_step).toBe("first");
  });
});

describe("StepTimings cannot break the operation it measures", () => {
  it("swallows a throwing sink", () => {
    const { lines, timings } = harness();
    expect(() =>
      timings.finish(() => {
        throw new Error("sentry is down");
      })
    ).not.toThrow();
    // The summary line is still emitted even though the Sentry attachment failed.
    expect(parseSummary(lines).op).toBe("create_repo");
  });

  it("swallows a throwing logger", () => {
    const timings = new StepTimings("create_repo", {
      now: () => 0,
      log: () => {
        throw new Error("stdout is gone");
      },
      debug: false
    });
    const seen: StepTimingsSnapshot[] = [];
    expect(() => timings.finish((s) => seen.push(s))).not.toThrow();
    // The sink still ran, so Sentry gets the breakdown even when logging failed.
    expect(seen).toHaveLength(1);
  });

  it("survives a throwing clock without throwing", async () => {
    const timings = new StepTimings("create_repo", {
      now: () => {
        throw new Error("no clock");
      },
      log: () => {},
      debug: false
    });
    await expect(timings.time("get_octokit", () => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(() => timings.finish()).not.toThrow();
  });

  it("is idempotent: a second finish() does not emit a second line", () => {
    const { lines, timings } = harness();
    timings.finish();
    timings.finish();
    expect(lines.filter((l) => l.startsWith(STEP_TIMINGS_LOG_PREFIX))).toHaveLength(1);
  });

  it("ignores non-finite and negative elapsed values", () => {
    const { lines, timings } = harness();
    timings.add("weird", Number.NaN);
    timings.add("weird", -500);
    timings.count("bad", Number.POSITIVE_INFINITY);
    timings.finish();
    const snapshot = parseSummary(lines);
    expect(snapshot.steps.weird).toBe(0);
    expect(snapshot.counts.bad).toBeUndefined();
  });
});

describe("per-step debug lines", () => {
  it("emits exactly one summary line and no per-step lines by default", async () => {
    // The whole point of the single-line format: 58 repos x ~10 steps of individual lines would be
    // unreadable and expensive to ship.
    const lines: string[] = [];
    const timings = new StepTimings("create_repo", {
      now: () => 0,
      log: (line) => lines.push(line),
      readEnv: () => undefined
    });
    await timings.time("a", () => Promise.resolve(undefined));
    await timings.time("b", () => Promise.resolve(undefined));
    timings.finish();
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(STEP_TIMINGS_LOG_PREFIX)).toBe(true);
  });

  it("emits per-step lines when the debug env var is set", async () => {
    const lines: string[] = [];
    const timings = new StepTimings("create_repo", {
      now: () => 0,
      log: (line) => lines.push(line),
      readEnv: (key) => (key === STEP_TIMINGS_DEBUG_ENV_VAR ? "1" : undefined)
    });
    await timings.time("a", () => Promise.resolve(undefined));
    timings.finish();
    expect(lines.filter((l) => l.startsWith(STEP_TIMINGS_DEBUG_LOG_PREFIX))).toEqual([
      `${STEP_TIMINGS_DEBUG_LOG_PREFIX} op=create_repo step=a ms=0`
    ]);
  });
});

describe("meta and snapshot shape", () => {
  it("carries low-cardinality meta into the snapshot", () => {
    const lines: string[] = [];
    const timings = new StepTimings("create_repo", {
      now: () => 0,
      log: (line) => lines.push(line),
      debug: false,
      meta: { org: "khoury", creation_method: "template" }
    });
    timings.setMeta("repo_already_exists", true);
    timings.finish();
    expect(parseSummary(lines).meta).toEqual({
      org: "khoury",
      creation_method: "template",
      repo_already_exists: true
    });
  });

  it("serializes to a single greppable JSON line", () => {
    const { lines, timings } = harness();
    timings.finish();
    expect(lines[0]).toMatch(/^\[step-timings\] \{.*\}$/);
    expect(lines[0].includes("\n")).toBe(false);
  });
});

describe("timeStep / countStep with no collector", () => {
  it("runs the function and returns its value when timings is undefined", async () => {
    await expect(timeStep(undefined, "anything", () => Promise.resolve(7))).resolves.toBe(7);
    expect(() => countStep(undefined, "anything")).not.toThrow();
  });

  it("records through the collector when one is supplied", async () => {
    const { clock, lines, timings } = harness();
    await timeStep(timings, "ruleset_list", () => {
      clock.advance(42);
      return Promise.resolve(undefined);
    });
    countStep(timings, "collaborators_added", 3);
    timings.finish();
    const snapshot = parseSummary(lines);
    expect(snapshot.steps.ruleset_list).toBe(42);
    expect(snapshot.counts.collaborators_added).toBe(3);
  });

  it("propagates errors unchanged with no collector", async () => {
    const boom = new Error("nope");
    await expect(timeStep(undefined, "anything", () => Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe("bucketDurationMs", () => {
  it("buckets the measured incident into the 240-300s band", () => {
    // p50 279.5s, p90 294.7s: 86% of the 58 messages fell between 260s and 300s.
    expect(bucketDurationMs(279_500)).toBe("240-300s");
    expect(bucketDurationMs(294_700)).toBe("240-300s");
    expect(bucketDurationMs(304_000)).toBe("300s+");
  });

  it("buckets the fast comparators and rejects nonsense", () => {
    expect(bucketDurationMs(1_000)).toBe("1-5s"); // sync_student_team p50
    expect(bucketDurationMs(500)).toBe("0-1s"); // sync_staff_team p50
    expect(bucketDurationMs(4_900)).toBe("1-5s"); // the template generate call
    expect(bucketDurationMs(Number.NaN)).toBe("unknown");
    expect(bucketDurationMs(-1)).toBe("unknown");
  });
});

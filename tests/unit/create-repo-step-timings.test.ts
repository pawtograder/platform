// NOTE: deliberately no jest environment pragma. These are pure-logic tests — injected clock,
// logger and env reader, and a plain object standing in for a Sentry scope — so they need nothing
// the default jsdom environment lacks, and there are no jest mocking APIs in the file at all.
//
// Naming an environment is what made suites here fragile: package.json allows `jest: ^30.1.2` so an
// `npm install` drifts the runtime to 30.4.x, while package-lock.json still pins one hoisted
// `jest-mock@30.0.5`. `jest-runtime@30.4.2` calls `moduleMocker.clearMocksOnScope()`, which 30.0.5
// does not have, so a suite that pins an environment dies with
// "TypeError: this._moduleMocker.clearMocksOnScope is not a function" before running a single test.
// Staying on the default environment makes this suite immune to that drift, which matters now that
// it is a gating CI job.

/**
 * Tests for the step-timing collector added to chase the 2026-09-07 create_repo latency (58 prod
 * messages, p50 279.5s, ~275s of it unexplained — see supabase/functions/_shared/stepTimings.ts).
 *
 * The properties under test are the ones that make this instrumentation safe to ship into the hot
 * path of repo creation: it records what it claims to record, it still reports the steps that DID
 * complete when a later step throws, and it can never mask, wrap, or swallow the caller's error.
 */

import {
  attachSnapshotToScope,
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
  it("still reports the steps that completed when an error escapes the operation", async () => {
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
    timings.noteEscapingError(boom); // what createRepo's catch does before re-throwing

    timings.finish();
    const snapshot = parseSummary(lines);
    expect(snapshot.steps).toEqual({ patch_repo_settings: 200, get_head_sha: 93_000 });
    expect(snapshot.error_escaped).toBe(true);
    expect(snapshot.failed_step).toBe("get_head_sha");
  });

  it("does NOT flag a step whose error was caught and recovered from", async () => {
    // The shape of waitForRepoReady: a freshly generated repo 404s on the first polls, the loop
    // swallows those and retries, and the operation succeeds. Flagging that would label every
    // healthy create_repo as failed — which is what this instrumentation is being read to rule out.
    const { clock, lines, timings } = harness();

    for (let attempt = 0; attempt < 2; attempt++) {
      timings.count("wait_for_repo_ready_attempts");
      try {
        await timings.time("wait_for_repo_ready_requests", () => {
          clock.advance(300);
          return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
        });
      } catch {
        // caught and retried, exactly like the real poll loop
      }
    }
    timings.count("wait_for_repo_ready_attempts");
    await timings.time("wait_for_repo_ready_requests", () => {
      clock.advance(250);
      return Promise.resolve(undefined);
    });

    timings.finish();
    const snapshot = parseSummary(lines);
    expect(snapshot.error_escaped).toBe(false);
    expect(snapshot.failed_step).toBeNull();
    // The time and the attempt count are still recorded — the misses are measured, just not blamed.
    expect(snapshot.steps.wait_for_repo_ready_requests).toBe(850);
    expect(snapshot.counts.wait_for_repo_ready_attempts).toBe(3);
    expect(snapshot.repeated.wait_for_repo_ready_requests).toBe(3);
  });

  it("flags an escaping error raised outside any timed step, without attributing it", async () => {
    // waitForRepoReady's "did not become ready" UserVisibleError is thrown after its loop, not by
    // one of the timed requests inside it. It must still be flagged; it just cannot be pinned on a
    // step, and inventing one would be a lie.
    const { timings } = harness();
    await timings.time("wait_for_repo_ready_requests", () => Promise.resolve(undefined));
    timings.noteEscapingError(new Error("Repo org/repo did not become ready in time"));
    const snapshot = timings.snapshot();
    expect(snapshot.error_escaped).toBe(true);
    expect(snapshot.failed_step).toBeNull();
  });

  it("attributes an error the caller inspected and re-threw to its originating step", async () => {
    // createRepo's catch re-throws the SAME object (`throw createErr`) after classifying it.
    const { timings } = harness();
    const createErr = new Error("boom");
    await expect(timings.time("template_generate", () => Promise.reject(createErr))).rejects.toBe(createErr);
    timings.noteEscapingError(createErr);
    expect(timings.snapshot().failed_step).toBe("template_generate");
  });

  it("does not attribute an escaping error that a recovered step merely happens to precede", async () => {
    const { timings } = harness();
    const recovered = new Error("404 that was retried");
    await expect(timings.time("wait_for_repo_ready_requests", () => Promise.reject(recovered))).rejects.toBe(recovered);
    timings.noteEscapingError(new Error("something else entirely"));
    const snapshot = timings.snapshot();
    expect(snapshot.error_escaped).toBe(true);
    expect(snapshot.failed_step).toBeNull();
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
    // Not flagged yet: the caller may still recover.
    expect(timings.snapshot().failed_step).toBeNull();
    timings.noteEscapingError(boom);
    expect(timings.snapshot().failed_step).toBe("get_octokit");
  });

  it("keeps the FIRST escaping error when noteEscapingError is called more than once", async () => {
    const { timings } = harness();
    const first = new Error("a");
    const second = new Error("b");
    await expect(timings.time("first", () => Promise.reject(first))).rejects.toThrow("a");
    timings.noteEscapingError(first);
    await expect(timings.time("second", () => Promise.reject(second))).rejects.toThrow("b");
    timings.noteEscapingError(second);
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

  it("supports a partial snapshot mid-operation without disturbing the final one", async () => {
    // What a handled-failure Sentry capture attaches: Sentry applies scope data at capture time, so
    // patch_repo_settings / enable_actions / ruleset events need the breakdown as it stands then.
    const { clock, lines, timings } = harness();
    await timings.time("template_generate", () => {
      clock.advance(4_896);
      return Promise.resolve(undefined);
    });

    const partial = timings.snapshot();
    expect(partial.partial).toBe(true);
    expect(partial.steps).toEqual({ template_generate: 4_896 });
    expect(lines).toHaveLength(0); // a partial snapshot logs nothing

    await timings.time("get_head_sha", () => {
      clock.advance(390);
      return Promise.resolve(undefined);
    });
    timings.finish();

    const final = parseSummary(lines);
    expect(final.partial).toBe(false);
    // Not double-counted and not truncated by the partial read.
    expect(final.steps).toEqual({ template_generate: 4_896, get_head_sha: 390 });
    expect(final.repeated).toEqual({});
    expect(final.total_ms).toBe(5_286);
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

/**
 * Stand-in for a Sentry.Scope. `attachSnapshotToScope` takes the scope structurally precisely so
 * this is possible, which is what lets these tests assert the scope-isolation property directly
 * rather than by inspection.
 */
function fakeScope() {
  const tags: Record<string, string | number | boolean> = {};
  const contexts: Record<string, unknown> = {};
  const breadcrumbs: Record<string, unknown>[] = [];
  return {
    tags,
    contexts,
    breadcrumbs,
    setTag: (key: string, value: string | number | boolean) => {
      tags[key] = value;
    },
    setContext: (key: string, context: Record<string, unknown>) => {
      contexts[key] = context;
    },
    addBreadcrumb: (breadcrumb: Record<string, unknown>) => {
      breadcrumbs.push(breadcrumb);
    }
  };
}

describe("scope isolation between concurrent operations", () => {
  // WHY: processBatch runs drainConcurrency (default 4) envelopes concurrently under
  // Promise.allSettled and shares one Sentry.Scope across them; processEnvelope clones it per
  // envelope before any handler sees it. Timings must therefore ride on the scope OBJECT they were
  // given and never on a module-level/global sink, or one repo's breakdown lands on another repo's
  // event and we chase the wrong step.
  it("two operations running concurrently each report only their own steps and counters", async () => {
    const lines: string[] = [];
    let clockA = 1_000;
    let clockB = 500_000;
    const a = new StepTimings("create_repo", {
      now: () => clockA,
      log: (line) => lines.push(line),
      debug: false,
      meta: { repo_name: "hw2-alice" }
    });
    const b = new StepTimings("create_repo", {
      now: () => clockB,
      log: (line) => lines.push(line),
      debug: false,
      meta: { repo_name: "hw2-bob" }
    });

    // Interleaved, the way two awaited operations in one isolate actually run.
    const opA = a.time("template_generate", async () => {
      clockA += 4_896;
      await Promise.resolve();
      a.count("wait_for_repo_ready_attempts", 3);
    });
    const opB = b.time("template_generate", async () => {
      clockB += 12_000;
      await Promise.resolve();
      b.count("wait_for_repo_ready_attempts", 29);
    });
    await Promise.all([opA, opB]);

    const scopeA = fakeScope();
    const scopeB = fakeScope();
    a.finish((snapshot) => attachSnapshotToScope(snapshot, scopeA));
    b.finish((snapshot) => attachSnapshotToScope(snapshot, scopeB));

    const [snapA, snapB] = lines
      .filter((l) => l.startsWith(STEP_TIMINGS_LOG_PREFIX))
      .map((l) => JSON.parse(l.slice(STEP_TIMINGS_LOG_PREFIX.length).trim()) as StepTimingsSnapshot);
    expect(snapA.steps.template_generate).toBe(4_896);
    expect(snapB.steps.template_generate).toBe(12_000);
    expect(snapA.counts.wait_for_repo_ready_attempts).toBe(3);
    expect(snapB.counts.wait_for_repo_ready_attempts).toBe(29);
    expect(snapA.meta.repo_name).toBe("hw2-alice");
    expect(snapB.meta.repo_name).toBe("hw2-bob");

    // And nothing bled across the two scopes.
    expect(scopeA.tags["step_timings_create_repo_wait_for_repo_ready_attempts"]).toBe("3");
    expect(scopeB.tags["step_timings_create_repo_wait_for_repo_ready_attempts"]).toBe("29");
    expect((scopeA.contexts["step_timings_create_repo"] as StepTimingsSnapshot).meta.repo_name).toBe("hw2-alice");
    expect((scopeB.contexts["step_timings_create_repo"] as StepTimingsSnapshot).meta.repo_name).toBe("hw2-bob");
    expect(scopeA.breadcrumbs).toHaveLength(1);
    expect(scopeB.breadcrumbs).toHaveLength(1);
  });

  it("a failure in one operation does not stamp failed_step onto the other", async () => {
    const boom = new Error("message 3 of 4 blew up");
    const failing = new StepTimings("create_repo", { now: () => 0, log: () => {}, debug: false });
    const healthy = new StepTimings("create_repo", { now: () => 0, log: () => {}, debug: false });

    await expect(failing.time("get_head_sha", () => Promise.reject(boom))).rejects.toBe(boom);
    failing.noteEscapingError(boom);
    await healthy.time("get_head_sha", () => Promise.resolve(undefined));

    const failingScope = fakeScope();
    const healthyScope = fakeScope();
    attachSnapshotToScope(failing.snapshot(), failingScope);
    attachSnapshotToScope(healthy.snapshot(), healthyScope);

    expect(failing.snapshot().failed_step).toBe("get_head_sha");
    expect(healthy.snapshot().failed_step).toBeNull();
    expect(failingScope.tags["step_timings_create_repo_failed_step"]).toBe("get_head_sha");
    expect(failingScope.tags["step_timings_create_repo_error_escaped"]).toBe("true");
    // The healthy operation's scope must carry NO failure tag at all, not even a "false" one for
    // failed_step — an error event for a sibling message must not look like this repo failed.
    expect(healthyScope.tags["step_timings_create_repo_failed_step"]).toBeUndefined();
    expect(healthyScope.tags["step_timings_create_repo_error_escaped"]).toBe("false");
  });
});

describe("attachSnapshotToScope", () => {
  it("namespaces tags per operation so two operations on ONE scope do not overwrite each other", () => {
    // A single create_repo MESSAGE runs createRepo and then syncRepoPermissions against the same
    // envelope scope. Unprefixed tag keys meant the second one silently clobbered the first.
    const scope = fakeScope();
    const create = new StepTimings("create_repo", { now: () => 0, log: () => {}, debug: false });
    create.add("template_generate", 4_896);
    create.count("wait_for_repo_ready_attempts", 7);
    const sync = new StepTimings("sync_repo_permissions", { now: () => 0, log: () => {}, debug: false });
    sync.add("list_collaborators", 1_200);
    sync.count("collaborators_added", 1);

    attachSnapshotToScope(create.snapshot(), scope);
    attachSnapshotToScope(sync.snapshot(), scope);

    expect(scope.tags["step_timings_create_repo_slowest_step"]).toBe("template_generate");
    expect(scope.tags["step_timings_sync_repo_permissions_slowest_step"]).toBe("list_collaborators");
    expect(scope.tags["step_timings_create_repo_wait_for_repo_ready_attempts"]).toBe("7");
    expect(scope.tags["step_timings_sync_repo_permissions_collaborators_added"]).toBe("1");
    expect(Object.keys(scope.contexts).sort()).toEqual([
      "step_timings_create_repo",
      "step_timings_sync_repo_permissions"
    ]);
  });

  it("tags the coarse duration bucket and the partial flag", () => {
    const scope = fakeScope();
    const timings = new StepTimings("create_repo", { now: () => 0, log: () => {}, debug: false });
    timings.add("patch_repo_settings", 279_500);
    attachSnapshotToScope(timings.snapshot(), scope);
    expect(scope.tags["step_timings_create_repo_partial"]).toBe("true");
    timings.finish();
    attachSnapshotToScope(timings.snapshot(), scope);
    expect(scope.tags["step_timings_create_repo_partial"]).toBe("false");
  });

  it("is a no-op with no scope and swallows a throwing scope", () => {
    const timings = new StepTimings("create_repo", { now: () => 0, log: () => {}, debug: false });
    expect(() => attachSnapshotToScope(timings.snapshot(), undefined)).not.toThrow();
    expect(() =>
      attachSnapshotToScope(timings.snapshot(), {
        setTag: () => {
          throw new Error("sentry is down");
        }
      })
    ).not.toThrow();
  });
});

describe("stepForError (handled-failure attribution)", () => {
  // WHY: applyBranchProtectionRuleset wraps BOTH the rulesets list and the ruleset detail request
  // in one try/catch. Labelling that catch's Sentry tag `ruleset_list` meant a failed DETAIL
  // request was indexed as a failed LIST request, contradicting the timing context attached beside
  // it and pointing endpoint-level filtering at the wrong GitHub call.
  it("names the step that raised THIS error, not the catch's coarse label", async () => {
    const { timings } = harness();
    const detailErr = Object.assign(new Error("Internal Server Error"), { status: 500 });

    await timings.time("ruleset_list", () => Promise.resolve(["existing"]));
    await expect(timings.time("ruleset_detail", () => Promise.reject(detailErr))).rejects.toBe(detailErr);

    expect(timings.stepForError(detailErr)).toBe("ruleset_detail");
  });

  it("returns null for an error that did not come from a timed step, so callers can fall back", async () => {
    const { timings } = harness();
    await timings.time("ruleset_list", () => Promise.resolve(undefined));
    expect(timings.stepForError(new Error("raised between steps"))).toBeNull();
    expect(timings.stepForError(undefined)).toBeNull();
  });

  it("returns null when no step has thrown at all", () => {
    const { timings } = harness();
    expect(timings.stepForError(new Error("anything"))).toBeNull();
  });

  it("does not flag the operation as failed — attribution is read-only", async () => {
    // A handled failure must not turn into `failed_step`/`error_escaped`; that pair is reserved for
    // an error that escaped the whole operation.
    const { timings } = harness();
    const handled = new Error("handled and recovered");
    await expect(timings.time("ruleset_detail", () => Promise.reject(handled))).rejects.toBe(handled);
    expect(timings.stepForError(handled)).toBe("ruleset_detail");
    const snapshot = timings.snapshot();
    expect(snapshot.error_escaped).toBe(false);
    expect(snapshot.failed_step).toBeNull();
  });
});

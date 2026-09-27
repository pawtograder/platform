// NOTE: deliberately no jest environment pragma, matching create-repo-step-timings.test.ts — these
// are pure-logic tests with an injected random source and no jest mocking APIs, so they need nothing
// the default environment lacks and stay immune to the jest/jest-mock version drift documented
// there.

/**
 * Tests for the `sync_repo_permissions` "repo is not ready yet" wait.
 *
 * The defect these pin down (prod, 2026-09-16): the wait was spelled `return false`, which leaves
 * the message unarchived so the ONLY thing that makes it visible again is its visibility timeout
 * expiring — 480s in Khoury production. One message polled four times, took 1968s end to end, did 1s
 * of work on the attempt that succeeded, and fired PawtograderQueueOldestMessageAging at a queue
 * depth of ONE. Two properties have to hold for that not to recur, and they pull in opposite
 * directions:
 *
 *   1. the first wait must be far SHORTER than a visibility timeout, or nothing has changed; and
 *   2. the ladder must still be BOUNDED, because requeueing sends a new message and therefore
 *      restarts `read_ct` — the poison-pill limit that used to bound this path stops applying.
 *
 * (2) is the one that turns a fix into a leak if it is dropped, so it is tested at the boundary from
 * both sides rather than just "a ceiling exists".
 */

import {
  notReadyRequeuePatch,
  planRepoNotReadyWait,
  repoNotReadyDelaySeconds,
  repoNotReadyWorstCaseSeconds,
  REPO_NOT_READY_MAX_DELAY_SECONDS,
  REPO_NOT_READY_MAX_RETRIES,
  REPO_NOT_READY_REQUEUE_BASE_SECONDS
} from "@/supabase/functions/_shared/repoNotReadyPlan";

/** GITHUB_ASYNC_WORKER_VISIBILITY_TIMEOUT_SECONDS in Khoury production, and the old effective wait. */
const PROD_VISIBILITY_TIMEOUT_SECONDS = 480;
/** The old outer bound: PGMQ_MAX_READ_CT (10) x one visibility timeout. */
const OLD_WORST_CASE_SECONDS = 10 * PROD_VISIBILITY_TIMEOUT_SECONDS;

const noJitter = () => 0;
const maxJitter = () => 0.9999;

describe("repo-not-ready wait: the regression property", () => {
  it("first wait is an order of magnitude under one visibility timeout", () => {
    // THIS is the assertion that fails on the old code. `return false` made the first (and every)
    // wait exactly PROD_VISIBILITY_TIMEOUT_SECONDS; any fix that does not move this number has not
    // fixed anything, however much machinery it adds.
    const first = planRepoNotReadyWait(0, { random: maxJitter });
    expect(first.action).toBe("requeue");
    if (first.action !== "requeue") throw new Error("unreachable");
    expect(first.delaySeconds).toBeLessThan(PROD_VISIBILITY_TIMEOUT_SECONDS / 10);
  });

  it("stays under the 1200s alert threshold for the first three polls", () => {
    // The alert fires at oldest-message > 1200s for 10m. At 480s a poll that is 2.5 polls; the point
    // of the backoff is that a repo needing a handful of polls no longer pages anyone.
    let cumulative = 0;
    for (let i = 0; i < 3; i++) cumulative += repoNotReadyDelaySeconds(i, { random: maxJitter });
    expect(cumulative).toBeLessThan(1200);
  });
});

describe("repo-not-ready wait: the bound", () => {
  it("requeues below the ceiling and DLQs at it", () => {
    expect(planRepoNotReadyWait(REPO_NOT_READY_MAX_RETRIES - 1, { random: noJitter }).action).toBe("requeue");
    expect(planRepoNotReadyWait(REPO_NOT_READY_MAX_RETRIES, { random: noJitter }).action).toBe("dlq");
    expect(planRepoNotReadyWait(REPO_NOT_READY_MAX_RETRIES + 5, { random: noJitter }).action).toBe("dlq");
  });

  it("worst-case wall clock stays within the bound the old path allowed", () => {
    // Not "is bounded" — bounded BY A COMPARABLE AMOUNT. A ceiling of 10 retries at a 900s cap would
    // be a bound too, and would also quietly triple how long a never-ready repo lingers.
    expect(repoNotReadyWorstCaseSeconds()).toBeLessThanOrEqual(OLD_WORST_CASE_SECONDS);
  });

  it("reports the attempt against the ceiling so the log says how close it is", () => {
    const p = planRepoNotReadyWait(3, { random: noJitter });
    if (p.action !== "requeue") throw new Error("expected requeue");
    expect(p.attempt).toBe(4);
    expect(p.maxAttempts).toBe(REPO_NOT_READY_MAX_RETRIES);
  });
});

describe("repo-not-ready wait: the schedule", () => {
  it("doubles from the base and caps, without jitter", () => {
    const ladder = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => repoNotReadyDelaySeconds(n, { random: noJitter }));
    expect(ladder).toEqual([
      15,
      30,
      60,
      120,
      240,
      480,
      REPO_NOT_READY_MAX_DELAY_SECONDS,
      REPO_NOT_READY_MAX_DELAY_SECONDS
    ]);
    expect(ladder[0]).toBe(REPO_NOT_READY_REQUEUE_BASE_SECONDS);
  });

  it("is monotonically non-decreasing", () => {
    const ladder = Array.from({ length: 12 }, (_, n) => repoNotReadyDelaySeconds(n, { random: noJitter }));
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]).toBeGreaterThanOrEqual(ladder[i - 1]);
  });

  it("jitter only ever adds, and never more than a quarter", () => {
    for (let n = 0; n < 8; n++) {
      const nominal = repoNotReadyDelaySeconds(n, { random: noJitter });
      const jittered = repoNotReadyDelaySeconds(n, { random: maxJitter });
      expect(jittered).toBeGreaterThanOrEqual(nominal);
      expect(jittered).toBeLessThanOrEqual(nominal * 1.25);
    }
  });

  it("treats a missing, negative or non-finite retry_count as the first attempt", () => {
    for (const bad of [undefined, -1, NaN, Infinity] as unknown as number[]) {
      const p = planRepoNotReadyWait(bad, { random: noJitter });
      if (p.action !== "requeue") throw new Error(`expected requeue for ${bad}`);
      expect(p.delaySeconds).toBe(REPO_NOT_READY_REQUEUE_BASE_SECONDS);
    }
  });
});

describe("repo-not-ready deferral: the counters are separate (PR #999 review, P1)", () => {
  it("never returns retry_count, so a deferral cannot spend the failure budget", () => {
    // retry_count is what the circuit-breaker path DLQs on at >= 5 and what the exception paths back
    // off on. If a deferral bumped it, a repo needing five polls would hit its first real GitHub
    // error with the budget gone and be dead-lettered instead of retried. Asserting on the KEYS is
    // the point: `retry_count` must not be settable from here even by accident.
    const patch = notReadyRequeuePatch({ not_ready_count: 4 }, "2026-09-17T08:00:00.000Z");
    expect(Object.keys(patch).sort()).toEqual(["not_ready_count", "original_enqueued_at"]);
    expect(patch).not.toHaveProperty("retry_count");
  });

  it("increments the deferral counter", () => {
    expect(notReadyRequeuePatch({}, "t").not_ready_count).toBe(1);
    expect(notReadyRequeuePatch({ not_ready_count: 0 }, "t").not_ready_count).toBe(1);
    expect(notReadyRequeuePatch({ not_ready_count: 7 }, "t").not_ready_count).toBe(8);
  });

  it("pins the original enqueue time once and never re-pins it", () => {
    const first = notReadyRequeuePatch({}, "2026-09-17T08:00:00.000Z");
    expect(first.original_enqueued_at).toBe("2026-09-17T08:00:00.000Z");
    // Second hop: `currentEnqueuedAt` is the REPLACEMENT message's timestamp, eight minutes later.
    // Taking it would report only the last wait and under-report every job that ever deferred.
    const second = notReadyRequeuePatch(
      { not_ready_count: first.not_ready_count, original_enqueued_at: first.original_enqueued_at },
      "2026-09-17T08:08:00.000Z"
    );
    expect(second.original_enqueued_at).toBe("2026-09-17T08:00:00.000Z");
    expect(second.not_ready_count).toBe(2);
  });

  it("the ladder and the counter agree: the deferral count is what reaches the ceiling", () => {
    // Walk a full chain the way the handler does — plan from not_ready_count, then patch — and check
    // it terminates at the ceiling rather than one either side of it.
    let env: { not_ready_count?: number; original_enqueued_at?: string } = {};
    let hops = 0;
    for (;;) {
      const plan = planRepoNotReadyWait(env.not_ready_count ?? 0, { random: noJitter });
      if (plan.action === "dlq") break;
      env = { ...env, ...notReadyRequeuePatch(env, "2026-09-17T08:00:00.000Z") };
      hops++;
      if (hops > 50) throw new Error("ladder did not terminate");
    }
    expect(hops).toBe(REPO_NOT_READY_MAX_RETRIES);
  });
});

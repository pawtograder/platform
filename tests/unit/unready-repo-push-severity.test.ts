/**
 * The push-direct path in github-repo-webhook throws when a push arrives for a `repositories` row
 * that is not marked ready and whose recorded `synced_repo_sha` does not match the pushed head. The
 * throw is load-bearing (it is what makes EventBridge redeliver the event, which is what stops the
 * student-work case from being lost), so what these tests pin down is the SEVERITY split around it:
 *
 *   - the provisioning-in-flight case, which happens once for every repository in every release and
 *     produced 412 error-level Sentry events from a single 58-student assignment in production, must
 *     be classified as expected and reported at `info` with its own fingerprint;
 *   - a readiness-write failure — the repository exists on GitHub but nothing recorded that — must
 *     stay a plain error, because that is the case an operator has to see. Critically, it keeps
 *     redelivering the SAME branch-creation payload, so it cannot be told apart by the shape of the
 *     push; the tests below pin the independent signal (GitHub's per-repository creation time) that
 *     makes it escalate, and pin that every uncertainty escalates rather than hides.
 *
 * A regression in either direction is invisible in production until it matters, which is why the
 * classification and the report extraction are both pure and tested here.
 */

import {
  classifyUnreadyRepoPush,
  PROVISIONING_IN_FLIGHT_WINDOW_MS
} from "@/supabase/functions/_shared/unreadyRepoPush";
import { ExpectedRetryError, expectedRetryReport } from "@/supabase/functions/_shared/ExpectedRetryError";

const NULL_SHA = "0".repeat(40);
const PARENT_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

/** Fixed evaluation time, so the window is exercised without faking the clock. */
const NOW = new Date("2026-09-07T04:10:00.000Z");
/** GitHub's per-repository creation time, `secondsAgo` before NOW, in the ISO form. */
const createdSecondsAgo = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
/** The same, in the epoch-seconds form GitHub uses inside push payloads. */
const createdSecondsAgoEpoch = (secondsAgo: number) => Math.floor((NOW.getTime() - secondsAgo * 1000) / 1000);

/** A ref-creating push, i.e. the shape every provisioning push (and every retry of one) has. */
const refCreating = (repositoryCreatedAt: string | number | null | undefined) => ({
  created: true,
  before: NULL_SHA,
  repositoryCreatedAt,
  now: NOW
});

describe("classifyUnreadyRepoPush", () => {
  describe("evidence that creation is still running", () => {
    // The regression this whole block exists for: a readiness-write failure keeps redelivering the
    // SAME branch-creation payload, so `created: true` and the all-zero `before` never stop being
    // true. Classifying on the payload shape alone reported case 2 as expected indefinitely — it hid
    // the one failure the change exists to surface. The decision therefore needs a signal that moves
    // while the payload does not.
    it("escalates a ref-creating push once GitHub created the repository too long ago", () => {
      expect(classifyUnreadyRepoPush(refCreating(createdSecondsAgo(31 * 60)))).toEqual({
        kind: "readiness_write_failed",
        reason: "creation_window_exceeded",
        repoAgeMs: 31 * 60 * 1000
      });
    });

    it("treats a ref-creating push inside the window as provisioning still in flight", () => {
      expect(classifyUnreadyRepoPush(refCreating(createdSecondsAgo(120)))).toEqual({
        kind: "provisioning_in_flight",
        reason: "within_creation_window",
        repoAgeMs: 120 * 1000
      });
    });

    it("clears the worst measured per-repo unready time (~8.7 minutes, ~7 deliveries) with margin", () => {
      expect(classifyUnreadyRepoPush(refCreating(createdSecondsAgo(522))).kind).toBe("provisioning_in_flight");
      expect(PROVISIONING_IN_FLIGHT_WINDOW_MS).toBeGreaterThan(3 * 522 * 1000);
    });

    it("escalates exactly past the window boundary, not before it", () => {
      const atBoundary = PROVISIONING_IN_FLIGHT_WINDOW_MS / 1000;
      expect(classifyUnreadyRepoPush(refCreating(createdSecondsAgo(atBoundary))).kind).toBe("provisioning_in_flight");
      expect(classifyUnreadyRepoPush(refCreating(createdSecondsAgo(atBoundary + 1))).kind).toBe(
        "readiness_write_failed"
      );
    });

    it("accepts the epoch-seconds form GitHub sends inside push payloads", () => {
      expect(classifyUnreadyRepoPush({ ...refCreating(createdSecondsAgoEpoch(60)) }).kind).toBe(
        "provisioning_in_flight"
      );
      expect(classifyUnreadyRepoPush({ ...refCreating(createdSecondsAgoEpoch(3600)) }).kind).toBe(
        "readiness_write_failed"
      );
    });

    it("falls back to repository.pushed_at, which anchors the same instant on a creation push", () => {
      expect(
        classifyUnreadyRepoPush({
          created: true,
          before: NULL_SHA,
          repositoryCreatedAt: null,
          repositoryPushedAt: createdSecondsAgo(90),
          now: NOW
        })
      ).toMatchObject({ kind: "provisioning_in_flight", reason: "within_creation_window" });
    });
  });

  describe("failing safe toward the visible case", () => {
    it("escalates when no creation timestamp is present at all", () => {
      expect(classifyUnreadyRepoPush(refCreating(undefined))).toEqual({
        kind: "readiness_write_failed",
        reason: "creation_time_unknown"
      });
    });

    it("escalates when the creation timestamp is null", () => {
      expect(classifyUnreadyRepoPush(refCreating(null)).kind).toBe("readiness_write_failed");
    });

    it("escalates when the creation timestamp is garbage", () => {
      expect(classifyUnreadyRepoPush(refCreating("not-a-date"))).toEqual({
        kind: "readiness_write_failed",
        reason: "creation_time_unknown"
      });
    });

    it("escalates when the creation timestamp is implausibly in the future", () => {
      expect(classifyUnreadyRepoPush(refCreating(createdSecondsAgo(-3600))).reason).toBe("creation_time_unknown");
    });

    it("tolerates small clock skew rather than escalating on it", () => {
      expect(classifyUnreadyRepoPush(refCreating(createdSecondsAgo(-5))).kind).toBe("provisioning_in_flight");
    });
  });

  describe("the ref-creating shape as a necessary condition", () => {
    it("escalates a push onto existing history even if the repository was just created", () => {
      expect(
        classifyUnreadyRepoPush({
          created: false,
          before: PARENT_SHA,
          repositoryCreatedAt: createdSecondsAgo(30),
          now: NOW
        })
      ).toEqual({ kind: "readiness_write_failed", reason: "not_ref_creating" });
    });

    it("reads an all-zero `before` as ref-creating even when `created` is missing", () => {
      expect(
        classifyUnreadyRepoPush({ before: NULL_SHA, repositoryCreatedAt: createdSecondsAgo(30), now: NOW }).kind
      ).toBe("provisioning_in_flight");
    });

    it("accepts a sha-256 length null sha", () => {
      expect(
        classifyUnreadyRepoPush({
          created: false,
          before: "0".repeat(64),
          repositoryCreatedAt: createdSecondsAgo(30),
          now: NOW
        }).kind
      ).toBe("provisioning_in_flight");
    });

    it("does not mistake a sha that merely starts with zeros for the null sha", () => {
      expect(
        classifyUnreadyRepoPush({
          created: false,
          before: `000000${"b".repeat(34)}`,
          repositoryCreatedAt: createdSecondsAgo(30),
          now: NOW
        })
      ).toMatchObject({ kind: "readiness_write_failed", reason: "not_ref_creating" });
    });

    it("escalates an empty payload", () => {
      expect(classifyUnreadyRepoPush({}).kind).toBe("readiness_write_failed");
    });
  });
});

describe("expectedRetryReport", () => {
  const provisioningError = () =>
    new ExpectedRetryError("repo is not marked ready yet and abc123 created the default branch", {
      name: "RepoProvisioningInFlightError",
      level: "info",
      fingerprint: ["github-repo-webhook", "push-direct", "repo-provisioning-in-flight"]
    });

  it("reports an ExpectedRetryError at the level and fingerprint it was thrown with", () => {
    expect(expectedRetryReport(provisioningError())).toEqual({
      level: "info",
      fingerprint: ["github-repo-webhook", "push-direct", "repo-provisioning-in-flight"]
    });
  });

  it("keeps the thrown name so Bugsink shows a distinct exception type", () => {
    expect(provisioningError().name).toBe("RepoProvisioningInFlightError");
  });

  it("returns null for a plain error, so the readiness-write failure still alerts", () => {
    expect(expectedRetryReport(new Error("not marked ready yet, but this is student work"))).toBeNull();
  });

  it("returns null for non-error values", () => {
    expect(expectedRetryReport(undefined)).toBeNull();
    expect(expectedRetryReport("boom")).toBeNull();
    expect(expectedRetryReport({ message: "boom" })).toBeNull();
  });

  it("unwraps the AggregateError that eventHandler.receive rethrows", () => {
    // The entry-point catch never sees the original throw: @octokit/webhooks collects listener
    // failures and rethrows them as one aggregate. Without unwrapping, that second event stays at
    // error level and the downgrade accomplishes nothing.
    const aggregate = new AggregateError([provisioningError()], "webhook handler failed");
    expect(expectedRetryReport(aggregate)).toEqual({
      level: "info",
      fingerprint: ["github-repo-webhook", "push-direct", "repo-provisioning-in-flight"]
    });
  });

  it("does not downgrade an aggregate containing a genuine failure", () => {
    const aggregate = new AggregateError([provisioningError(), new Error("readiness write failed")], "failed");
    expect(expectedRetryReport(aggregate)).toBeNull();
  });

  it("takes the highest level any child asked for", () => {
    const warned = new ExpectedRetryError("slow down", { level: "warning", fingerprint: ["b"] });
    const aggregate = new AggregateError([provisioningError(), warned], "failed");
    expect(expectedRetryReport(aggregate)?.level).toBe("warning");
  });

  it("does not follow `cause`: a generic wrapper is a genuine failure", () => {
    const wrapped = new Error("could not record submission", { cause: provisioningError() });
    expect(expectedRetryReport(wrapped)).toBeNull();
  });

  it("recognizes the marker structurally, so a double-loaded module still downgrades", () => {
    // Edge functions import shared modules under more than one specifier; `instanceof` against a
    // second copy of the class fails silently and would report the expected case at error level.
    const fromAnotherCopy = Object.assign(new Error("in flight"), {
      isExpectedRetryError: true,
      sentryLevel: "info" as const,
      sentryFingerprint: ["github-repo-webhook", "push-direct", "repo-provisioning-in-flight"]
    });
    expect(expectedRetryReport(fromAnotherCopy)).toEqual({
      level: "info",
      fingerprint: ["github-repo-webhook", "push-direct", "repo-provisioning-in-flight"]
    });
  });

  it("defaults to info when no level is given", () => {
    expect(expectedRetryReport(new ExpectedRetryError("retry me", { fingerprint: ["x"] }))).toEqual({
      level: "info",
      fingerprint: ["x"]
    });
  });
});

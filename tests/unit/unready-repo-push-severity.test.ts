/**
 * The push-direct path in github-repo-webhook throws when a push arrives for a `repositories` row
 * that is not marked ready and whose recorded `synced_repo_sha` does not match the pushed head. The
 * throw is load-bearing (it is what makes EventBridge redeliver the event, which is what stops the
 * student-work case from being lost), so what these tests pin down is the SEVERITY split around it:
 *
 *   - the provisioning-in-flight case, which happens once for every repository in every release and
 *     produced 412 error-level Sentry events from a single 58-student assignment in production, must
 *     be classified as expected and reported at `info` with its own fingerprint;
 *   - a push onto existing history — the repository exists on GitHub but the readiness write failed
 *     — must stay a plain error, because that is the case an operator has to see.
 *
 * A regression in either direction is invisible in production until it matters, which is why the
 * classification and the report extraction are both pure and tested here.
 */

import { classifyUnreadyRepoPush } from "@/supabase/functions/_shared/unreadyRepoPush";
import { ExpectedRetryError, expectedRetryReport } from "@/supabase/functions/_shared/ExpectedRetryError";

const NULL_SHA = "0".repeat(40);
const PARENT_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("classifyUnreadyRepoPush", () => {
  it("treats a ref-creating push as provisioning still in flight", () => {
    expect(classifyUnreadyRepoPush({ created: true, before: NULL_SHA })).toBe("provisioning_in_flight");
  });

  it("treats an all-zero `before` as provisioning even if `created` is missing from the payload", () => {
    expect(classifyUnreadyRepoPush({ before: NULL_SHA })).toBe("provisioning_in_flight");
  });

  it("accepts a sha-256 length null sha", () => {
    expect(classifyUnreadyRepoPush({ created: false, before: "0".repeat(64) })).toBe("provisioning_in_flight");
  });

  it("treats a push onto existing history as a failed readiness write", () => {
    expect(classifyUnreadyRepoPush({ created: false, before: PARENT_SHA })).toBe("readiness_write_failed");
  });

  it("defaults to a failed readiness write when the payload carries neither marker", () => {
    expect(classifyUnreadyRepoPush({})).toBe("readiness_write_failed");
  });

  it("does not mistake a sha that merely starts with zeros for the null sha", () => {
    expect(classifyUnreadyRepoPush({ created: false, before: `000000${"b".repeat(34)}` })).toBe(
      "readiness_write_failed"
    );
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

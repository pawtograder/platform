// Pure predicate for "why is this push arriving on a repository row that is not marked ready?".
// Extracted so it can be unit-tested without a webhook payload fixture or a Supabase mock.
//
// The push-direct path in github-repo-webhook rejects (throws, so the event is redelivered) a push
// to a repository whose `is_github_ready` is still false and whose recorded `synced_repo_sha` does
// not match the pushed head. The redelivery is EventBridge's, not GitHub's — GitHub's webhook
// reaches the function through an EventBridge rule — so the retry budget behind that rejection is
// AWS configuration defined outside this repository and is not verifiable from this code.
//
// The comment at that site already notes that such a row means one of two very different things:
//
//   1. Creation is still in flight. The `repositories` row is inserted BEFORE createRepo runs, and
//      the readiness write (`synced_repo_sha` + `is_github_ready` in one update) only lands AFTER
//      GitHub returns. GitHub fires the initial push for a freshly generated repository the instant
//      it is generated — i.e. before that write. So the first delivery for every single provisioned
//      repository necessarily observes an unready row with a null sha. Expected, self-healing.
//
//   2. GitHub creation succeeded but the DATABASE readiness write failed. The repository works and
//      the student can push to it, but nothing on our side knows that. This is the case an operator
//      must see: until the reconciler repairs the flag, every push is rejected, and it is the
//      student's real work being rejected.
//
// WHAT DOES NOT WORK: the shape of the push alone.
//
// The obvious split is "did this push create the ref?" — case 1 is by construction the creation of
// the default branch, so GitHub sends `created: true` and an all-zero `before`. That is a real
// distinction, but it is NOT this one, and an earlier version of this module got it wrong. When
// GitHub created the repository and the readiness write then failed, the delivery being rejected is
// still that same branch-creation push, and a redelivery carries a byte-identical payload — so
// `created: true` never stops being true, and case 2 would be reported as expected forever. The
// exact failure this exists to surface would have been the one permanently hidden.
//
// So the ref-creating shape is kept only as a NECESSARY condition (a push onto existing history is
// definitionally not provisioning), and the actual decision rests on independent evidence that
// creation is still running: how long ago GitHub created the repository.
//
// WHY A PER-REPO CLOCK IS SOUND HERE, unlike a grace window on `repositories.created_at`.
//
// These are different in kind, and conflating them is the trap. Our row's `created_at` is stamped
// when the whole release is enqueued: on 2026-09-07 all 58 rows were inserted at 04:01 UTC and the
// async `create_repo` queue drained them on GitHub between 04:09 and 05:37, so the last row of that
// batch was legitimately unready ~96 minutes after its own insert. That window grows with the size
// of the release (a 585-student class would run for many hours), which makes any fixed threshold on
// it either useless or dangerous.
//
// `payload.repository.created_at` is GitHub's own per-repository timestamp, and GitHub creates the
// repository INSIDE our `createRepo` call. The window it measures is therefore that one repository's
// own remaining finalize time — permission sync plus the readiness write — and it does not grow with
// the batch at all: the 57 repositories queued behind it do not make its own finalize slower.
// Measured in that incident: template generation completed ~5s after creation started and the
// readiness write landed ~275s later (p50 279.5s across all 58); the worst per-repo case traced
// (`fa26-ip1-RollingRo11`, created 04:01:05, message archived 04:09:52) was ~8.7 minutes including a
// re-read, over ~7 deliveries.
//
// Hence the window below: 30 minutes, ~3.4x the worst measured per-repo unready time and ~6x the
// median, and it stays 30 minutes whether the release is 58 repositories or 585.
//
// `repository.created_at` is the right anchor for the same reasons `repository.pushed_at` is used for
// the due-date gate in github-repo-webhook: set server-side by GitHub, identical in every
// redelivery, and not student-controllable (which is what ruled out `head_commit.timestamp` there).
// It is parsed in both the epoch-number and ISO-string forms, as that call site does.
//
// FAIL SAFE IN THE VISIBLE DIRECTION. Every uncertainty resolves to `readiness_write_failed`: no
// timestamp, an unparseable one, a nonsensical one, or a push that is not ref-creating. A
// mislabelled error event costs an operator ten seconds of triage; a hidden readiness-write failure
// costs student submissions.
//
// Deliberately NOT used: the Redis-backed `attempt_count` the entry handler tracks. It does change
// across redeliveries where the payload does not, which is the property wanted, but it lives in the
// serve handler and is not plumbed into the push path, and its own `catch (redisError)` means it can
// be absent or reset — and absence must never be read as "attempt 1", which is precisely the
// direction that hides case 2. GitHub's timestamp needs no plumbing and cannot silently reset.
//
// This classification affects reporting severity ONLY. Both kinds still throw, both still get the
// redelivery that makes provisioning converge, and no push is ever dropped on the strength of it —
// so a misclassification costs a mislabelled event, never student work.

/** The two reasons a push can find its repository row unready. */
export type UnreadyRepoPushKind =
  /** Provisioning is still running: expected, self-heals, reported below `error`. */
  | "provisioning_in_flight"
  /** The repository exists on GitHub but readiness was never recorded: an operator must see this. */
  | "readiness_write_failed";

/** Which piece of evidence decided it, for tagging and post-hoc confirmation. */
export type UnreadyRepoPushReason =
  /** The push landed on existing history, so it is not a provisioning push at all. */
  | "not_ref_creating"
  /** Ref-creating, and GitHub created the repository recently enough that creation can still be running. */
  | "within_creation_window"
  /** Ref-creating, but GitHub created the repository too long ago for creation to still be running. */
  | "creation_window_exceeded"
  /** Ref-creating, but GitHub's creation timestamp is missing or unusable — fails safe to visible. */
  | "creation_time_unknown";

export interface UnreadyRepoPushVerdict {
  kind: UnreadyRepoPushKind;
  reason: UnreadyRepoPushReason;
  /** Milliseconds since GitHub created the repository, when it could be determined. For tagging. */
  repoAgeMs?: number;
}

/** The fields of a GitHub `push` payload this predicate reads. */
export interface UnreadyRepoPushFacts {
  /** `payload.created`: true when this push created the ref. */
  created?: boolean | null;
  /** `payload.before`: the ref's previous head, all zeros when the ref did not exist. */
  before?: string | null;
  /**
   * `payload.repository.created_at`: when GitHub created the repository. Epoch seconds in push
   * events, an ISO string elsewhere; both accepted.
   */
  repositoryCreatedAt?: string | number | null;
  /**
   * `payload.repository.pushed_at`, used only as a fallback anchor. On a ref-creating push — the
   * only branch that consults either field — it marks the same instant as the repository's creation,
   * because that push IS the creation. It is not equivalent on any later push, which is why it is
   * never consulted on one.
   */
  repositoryPushedAt?: string | number | null;
  /** Evaluation time. Injectable so the window is testable without faking the clock. */
  now?: Date;
}

/**
 * GitHub's "this ref had no previous head" sentinel. Matched as "all zeros, sha-length" rather than
 * exactly 40 characters so a sha-256 repository (64 zeros) reads the same.
 */
const NULL_SHA_RE = /^0{7,}$/;

/**
 * How long after GitHub creates a repository its readiness write may still be pending.
 *
 * Sized against the measurement, not intuition: worst traced per-repo unready time was ~8.7 minutes
 * (~7 deliveries), median finalize ~4.7 minutes. 30 minutes clears the worst case by ~3.4x. It is a
 * per-repository duration and does not scale with release size, so it does not need to grow when a
 * 585-student class is released.
 *
 * Raising this trades away detection latency for a genuine readiness failure; lowering it trades
 * toward noise. Neither is dangerous, because both sides still throw and still redeliver.
 */
export const PROVISIONING_IN_FLIGHT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Tolerance for clock skew between GitHub's timestamp and this runtime, so a repository that appears
 * to have been created a few seconds in the future still reads as in-flight rather than as garbage.
 * Anything further out is treated as unusable and fails safe to visible.
 */
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

/** Parse GitHub's epoch-seconds-or-ISO timestamp, or null if it is absent or unusable. */
function parseGitHubTimestamp(value: string | number | null | undefined): Date | null {
  const parsed =
    typeof value === "number" ? new Date(value * 1000) : typeof value === "string" ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

/**
 * Classify an unready-row push.
 *
 * `provisioning_in_flight` requires BOTH that the push created the ref and that GitHub created the
 * repository inside the finalize window. Everything else — including every uncertainty — is
 * `readiness_write_failed`, which is the reported-as-`error`, operator-visible side.
 */
export function classifyUnreadyRepoPush(facts: UnreadyRepoPushFacts): UnreadyRepoPushVerdict {
  const before = facts.before?.trim() ?? "";
  const isRefCreating = facts.created === true || NULL_SHA_RE.test(before);
  if (!isRefCreating) {
    return { kind: "readiness_write_failed", reason: "not_ref_creating" };
  }

  const createdAt = parseGitHubTimestamp(facts.repositoryCreatedAt) ?? parseGitHubTimestamp(facts.repositoryPushedAt);
  if (!createdAt) {
    return { kind: "readiness_write_failed", reason: "creation_time_unknown" };
  }

  const now = facts.now ?? new Date();
  const repoAgeMs = now.getTime() - createdAt.getTime();
  if (repoAgeMs < -CLOCK_SKEW_TOLERANCE_MS) {
    // Created meaningfully in the future: the timestamp cannot be trusted to bound anything.
    return { kind: "readiness_write_failed", reason: "creation_time_unknown", repoAgeMs };
  }
  if (repoAgeMs > PROVISIONING_IN_FLIGHT_WINDOW_MS) {
    return { kind: "readiness_write_failed", reason: "creation_window_exceeded", repoAgeMs };
  }
  return { kind: "provisioning_in_flight", reason: "within_creation_window", repoAgeMs };
}

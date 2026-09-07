// Pure predicate for "why is this push arriving on a repository row that is not marked ready?".
// Extracted so it can be unit-tested without a webhook payload fixture or a Supabase mock.
//
// The push-direct path in github-repo-webhook rejects (throws, so the event is redelivered) a push
// to a repository whose `is_github_ready` is still false and whose recorded `synced_repo_sha` does
// not match the pushed head. The redelivery is EventBridge's, not GitHub's — GitHub's webhook
// reaches the function through an EventBridge rule — so the retry budget behind that rejection is
// AWS configuration defined outside this repository and is not verifiable from this code. The comment at that site already notes that such a row means one of two
// very different things:
//
//   1. Creation is still in flight. The `repositories` row is inserted BEFORE createRepo runs, and
//      the readiness write (`synced_repo_sha` + `is_github_ready` in one update) only lands AFTER
//      GitHub returns. GitHub fires the initial push for a freshly generated repository the instant
//      it is generated — i.e. before that write. So the very first delivery for every single
//      provisioned repository necessarily observes an unready row with a null sha. Expected,
//      self-healing, once per repository per batch.
//
//   2. GitHub creation succeeded but the DATABASE readiness write failed. The repository works and
//      the student can push to it, but nothing on our side knows that. This is the case an operator
//      must see: until the reconciler repairs the flag, every push is rejected, and it is the
//      student's real work being rejected.
//
// Both cases are `synced_repo_sha IS NULL`, so the row cannot tell them apart. The PUSH can:
//
//   - Case 1 is by construction the creation of the default branch: GitHub sends `created: true` and
//     `before` as the all-zero sha, because the ref did not exist a moment ago.
//   - Case 2's rejected deliveries are pushes on top of history that is already there — the
//     template contents GitHub generated. They carry `created: false` and a real parent sha.
//
// That is a property of what happened, not a timing guess, which is why it is preferred here over
// the obvious alternative of a grace window on `repositories.created_at`. The production evidence
// rules the clock out: on 2026-09-07 all 58 rows for one assignment were inserted at 04:01 UTC and
// the async `create_repo` queue drained them on GitHub between 04:09 and 05:37 — so the last row of
// that batch was legitimately unready for ~96 minutes after its own insert, and the window scales
// with the size of the release (a 585-student class would run for many hours). Any fixed grace
// window is therefore either too short to cover a real batch or long enough to hide a genuine
// readiness-write failure for most of a day.
//
// This classification affects reporting severity ONLY. Both kinds still throw, both still get the
// redelivery that makes provisioning converge, and no push is ever dropped on the strength of it —
// so a misclassification costs a mislabelled event, never student work.
//
// The mapping above is an inference from how GitHub must describe the creation of a ref, not a
// measurement: the payloads retrievable from the 2026-09-07 incident are truncated, so it was never
// confirmed that those deliveries carried `created: true` / an all-zero `before`. The caller tags
// each rejection with the kind it decided, which is how to confirm the mapping on the next release.

/** The two reasons a push can find its repository row unready, as distinguished by the push itself. */
export type UnreadyRepoPushKind =
  /** The initial branch-creation push from provisioning; the readiness write has not landed yet. */
  | "provisioning_in_flight"
  /** A push onto existing history: the repository exists on GitHub, so readiness is genuinely broken. */
  | "readiness_write_failed";

/** The fields of a GitHub `push` payload this predicate reads. */
export interface UnreadyRepoPushFacts {
  /** `payload.created`: true when this push created the ref. */
  created?: boolean | null;
  /** `payload.before`: the ref's previous head, all zeros when the ref did not exist. */
  before?: string | null;
}

/**
 * GitHub's "this ref had no previous head" sentinel. Matched as "all zeros, sha-length" rather than
 * exactly 40 characters so a sha-256 repository (64 zeros) reads the same.
 */
const NULL_SHA_RE = /^0{7,}$/;

/**
 * Classify an unready-row push. Conservative by design: anything that is not recognizably the
 * branch-creation push from provisioning is treated as a real readiness failure, because that is the
 * side that must stay visible. A provisioning push that somehow lacks both markers is reported as an
 * error — noise — while the reverse would silence the case this exists to surface.
 */
export function classifyUnreadyRepoPush(facts: UnreadyRepoPushFacts): UnreadyRepoPushKind {
  if (facts.created === true) return "provisioning_in_flight";
  const before = facts.before?.trim() ?? "";
  if (NULL_SHA_RE.test(before)) return "provisioning_in_flight";
  return "readiness_write_failed";
}

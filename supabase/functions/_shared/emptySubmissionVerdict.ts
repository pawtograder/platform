// Pure decision for "what should happen to a push-direct submission given the
// empty-submission check?". Extracted so the truth table is testable — the inline
// version had no test coverage at all, because the only e2e suite that exercises
// this path takes the E2E_MOCK_GITHUB shortcut and returns before ingestion runs.
//
// That gap cost a critical bug: `isEmpty === null` means two different things, and
// conflating them made every push on a repo-only assignment with no
// `submissionFiles` get deleted and retried forever, since the default is
// `permit_empty_submissions = false`. Those are exactly the assignments the
// repo-only feature exists to serve.

export type EmptySubmissionVerdict =
  /** Keep the submission. */
  | "accept"
  /** Confirmed identical to the handout and the assignment prohibits that: delete and stop. */
  | "reject_empty"
  /** The check ran but could not conclude: delete and throw so GitHub redelivers. */
  | "retry_unknown";

export type EmptySubmissionVerdictInputs = {
  /** `assignments.permit_empty_submissions`. */
  permitEmptySubmissions: boolean;
  /**
   * Whether the check was actually requested. False when the assignment defines no
   * `submissionFiles`, so there is no comparable handout hash — a repo-only
   * assignment has no reason to maintain a `pawtograder.yml`.
   */
  canDetectEmpty: boolean;
  /**
   * Result from the ingestion core: `true`/`false` is a verdict, `null` means no
   * verdict. Null is expected when `canDetectEmpty` is false, and means the
   * handout-hash lookup failed when it is true.
   */
  isEmpty: boolean | null;
};

/**
 * Truth table:
 *
 * | permitEmpty | canDetect | isEmpty | verdict        | why                              |
 * |-------------|-----------|---------|----------------|----------------------------------|
 * | true        | any       | any     | accept         | policy allows empty submissions  |
 * | false       | false     | null    | accept         | check never ran; nothing failed  |
 * | false       | true      | false   | accept         | verified non-empty               |
 * | false       | true      | true    | reject_empty   | verified identical to handout    |
 * | false       | true      | null    | retry_unknown  | lookup failed; fail closed       |
 *
 * The `false / false / null` row is the one that broke: it must accept, not retry.
 */
export function resolveEmptySubmissionVerdict(inputs: EmptySubmissionVerdictInputs): EmptySubmissionVerdict {
  const { permitEmptySubmissions, canDetectEmpty, isEmpty } = inputs;
  if (permitEmptySubmissions) return "accept";
  // No check was requested, so there is nothing to fail closed on.
  if (!canDetectEmpty) return "accept";
  if (isEmpty === true) return "reject_empty";
  if (isEmpty === null) return "retry_unknown";
  return "accept";
}

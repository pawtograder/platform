/**
 * The line shown above an artifact when none of the review's rubric checks can be applied to it
 * (#1269). The Files page used to say "No rubric checks available for this artifact" in every such
 * case, so a paper exam with a full rubric read the same as an assignment with no rubric at all.
 *
 * Returns null when nothing should be shown:
 * - while the review or its checks are still loading (an empty list then means "not loaded");
 * - when some check does target artifacts but the popover's options aren't built yet;
 * - for anyone who isn't staff. A student in a self-review can still annotate artifacts when the
 *   rubric allows it; this line only explains why the popover is missing, which is staff guidance.
 */
export function artifactCheckMessage({
  ready,
  isStaff,
  hasRubric,
  checkCount,
  hasArtifactChecks,
  isExamArtifact
}: {
  /** The review and the rubric checks have loaded. */
  ready: boolean;
  isStaff: boolean;
  /** The review has a rubric (review.rubric_id is set). */
  hasRubric: boolean;
  /** Checks on the review's rubric. */
  checkCount: number;
  /** Some check on that rubric is an annotation check targeting artifacts. */
  hasArtifactChecks: boolean;
  /** A paper exam's exam_v1 artifact, whose checks are graded per question in the rubric panel. */
  isExamArtifact: boolean;
}): string | null {
  if (!ready || !isStaff || hasArtifactChecks) return null;
  if (!hasRubric) return "This review has no rubric.";
  if (checkCount === 0) return "This review's rubric has no checks yet.";
  // Exam checks are generated as non-annotation checks (exam_sync_rubric_from_questions), shown
  // per question in the rubric sidebar.
  if (isExamArtifact) return "Grade this exam's questions in the rubric panel.";
  return "None of this rubric's checks apply to artifacts.";
}

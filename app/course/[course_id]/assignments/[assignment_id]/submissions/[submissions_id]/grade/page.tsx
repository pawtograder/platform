"use client";

import { Container, VStack } from "@chakra-ui/react";
import { useShow } from "@refinedev/core";
import { useParams } from "next/navigation";

import { SubmissionWithGraderResultsAndErrors } from "@/utils/supabase/DatabaseTypes";
import { useSubmission, useSubmissionReviewOrGradingReview } from "@/hooks/useSubmission";
import { useAssignmentData, useRubricCriteriaByRubric } from "@/hooks/useAssignment";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useErrorPinMatches } from "@/hooks/useErrorPinMatches";
import { getDisplayedGradingTotalForStudent } from "@/lib/getDisplayedGradingTotalForStudent";
import { submissionHasGraderOutput } from "@/lib/submissionHasGraderOutput";

import GradeLedgerHeader from "@/components/grade/GradeLedgerHeader";
import AutograderSection from "@/components/grade/AutograderSection";
import HandGradingSection from "@/components/grade/HandGradingSection";
import GradeAdjustments from "@/components/grade/GradeAdjustments";
import SubmissionRegradeRequestsPanel from "@/components/regrade-requests/SubmissionRegradeRequestsPanel";

/**
 * Unified, student-facing "Grade" view for the grading review.
 *
 * Presents a single grade ledger: a headline total whose contributions (autograder,
 * hand-grading, adjustments) are broken out into sections below. Sections only render
 * when that source contributes, so the same view degrades gracefully across
 * autograder-only, hand-grading-only, and combined assignments.
 *
 * Self-review and other review rounds are intentionally out of scope here; they get a
 * specialized view elsewhere.
 */
export default function GradePage() {
  const { submissions_id } = useParams();
  const submission = useSubmission();
  const assignment = useAssignmentData();
  const { private_profile_id } = useClassProfiles();

  // Full nested autograder data (tests + outputs), matching the Autograder Detail tab's query.
  const { query } = useShow<SubmissionWithGraderResultsAndErrors>({
    resource: "submissions",
    id: Number(submissions_id),
    meta: {
      select:
        "*, assignments(*), grader_results!grader_results_submission_id_fkey(*, grader_result_tests(*, grader_result_test_output(*)), grader_result_output(*)), workflow_run_error(*)"
    }
  });
  const graderResults = query.data?.data?.grader_results ?? null;

  const gradingReview = useSubmissionReviewOrGradingReview(submission.grading_review_id ?? undefined);
  const criteria = useRubricCriteriaByRubric(gradingReview?.rubric_id);
  const { matches: errorPinMatches } = useErrorPinMatches(Number(submissions_id));

  const released = gradingReview?.released ?? false;
  const hasAutograder = submissionHasGraderOutput(graderResults);
  const hasHandGrading = (criteria?.length ?? 0) > 0;

  // Ledger numbers. The authoritative displayed grade comes from the review; the
  // contribution lines are derived so the header math is always internally consistent.
  const total = getDisplayedGradingTotalForStudent(gradingReview, private_profile_id);
  const autoEarned = released ? (gradingReview?.total_autograde_score ?? graderResults?.score ?? null) : null;
  const autoMax = graderResults?.max_score ?? null;
  const tweak = gradingReview?.tweak ?? 0;
  const handContribution = released && total !== null && hasHandGrading ? total - (autoEarned ?? 0) - tweak : null;
  const totalPossible = assignment?.total_points ?? null;

  return (
    <Container maxW="4xl" py={4}>
      <VStack align="stretch" gap={4}>
        <GradeLedgerHeader
          assignmentTitle={assignment?.title ?? "Assignment"}
          submissionOrdinal={submission.ordinal ?? null}
          submittedAt={submission.created_at ?? null}
          released={released}
          total={released ? total : null}
          totalPossible={totalPossible}
          autoEarned={autoEarned}
          autoMax={autoMax}
          handContribution={handContribution}
          tweak={tweak}
          hasAutograder={hasAutograder}
          hasHandGrading={hasHandGrading}
        />

        {hasAutograder && (
          <AutograderSection
            graderResults={graderResults}
            errorPinMatches={errorPinMatches}
            submissionId={submission.id}
            classId={submission.class_id}
            assignmentId={submission.assignment_id}
          />
        )}

        {hasHandGrading && (
          <HandGradingSection reviewId={submission.grading_review_id ?? undefined} released={released} />
        )}

        <GradeAdjustments tweak={tweak} tweakNote={gradingReview?.tweak_note ?? null} />

        <SubmissionRegradeRequestsPanel submissionId={submission.id} />
      </VStack>
    </Container>
  );
}

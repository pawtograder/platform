"use client";

import Markdown from "@/components/ui/markdown";
import RequestRegradeForCheckDialog from "@/components/ui/RequestRegradeForCheckDialog";
import RequestRegradeDialog from "@/components/ui/request-regrade-dialog";
import { isLineComment, SubmissionFileCommentLink } from "@/components/ui/rubric-sidebar";
import {
  useRegradeRequestsBySubmission,
  useRubricChecksByCriteria,
  useRubricCriteriaByRubric
} from "@/hooks/useAssignment";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useShouldShowRubricCheck } from "@/hooks/useRubricVisibility";
import { useRubricCheckInstances, useSubmission, useSubmissionReviewOrGradingReview } from "@/hooks/useSubmission";
import { maxPointsForCriterion } from "@/lib/rubric/points";
import type {
  HydratedRubricCheck,
  RegradeRequest,
  RegradeStatus,
  RubricChecks,
  RubricCriteria,
  SubmissionArtifactComment,
  SubmissionComments,
  SubmissionFileComment
} from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Heading, HStack, Text, VStack } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";

export type HandGradingSectionProps = {
  reviewId: number | undefined;
  released: boolean;
  /** Show only criteria that have applied checks (used in the Files-tab sidebar for students). */
  appliedOnly?: boolean;
};

// Mirror of statusConfig used in app/course/[course_id]/RegradeRequestsTable.tsx so the
// status badge colors stay consistent with the rest of the regrade UIs.
const statusConfig: Record<RegradeStatus, { colorPalette: string; label: string }> = {
  draft: { colorPalette: "gray", label: "Draft" },
  opened: { colorPalette: "orange", label: "Pending" },
  resolved: { colorPalette: "blue", label: "Resolved" },
  escalated: { colorPalette: "red", label: "Escalated" },
  closed: { colorPalette: "gray", label: "Closed" }
};

// A comment as returned by useRubricCheckInstances: a union of the three comment shapes,
// all of which carry these fields. (File comments additionally carry `line` / `submission_file_id`.)
type CheckComment = {
  id: number;
  points: number | null;
  comment: string;
  rubric_check_id: number | null;
  released: boolean;
  regrade_request_id?: number | null;
  target_student_profile_id?: string | null;
};

// What a CheckRow reports up to its CriterionBlock.
type CheckResolution = { visible: boolean; appliedSum: number };
// What a CriterionBlock reports up to the section.
type CriterionResolution = { visible: boolean; earned: number; max: number };

/**
 * Renders one applied check instance (a grader's comment): the check name, signed points, the
 * comment body, a deep link to the annotated code when it's a file comment, and either a regrade
 * affordance or an existing-request status badge.
 */
function AppliedCheckRow({
  check,
  comment,
  isAdditive,
  existingRequest
}: {
  check: RubricChecks;
  comment: CheckComment;
  isAdditive: boolean;
  existingRequest?: RegradeRequest;
}) {
  const isGrader = useIsGraderOrInstructor();

  // Points are stored as positive magnitudes; render the sign from the criterion's mode.
  // Use a true minus sign (−) for deductions.
  const points = comment.points ?? 0;
  const signedPoints = points === 0 ? "0" : isAdditive ? `+${points}` : `−${points}`;

  // A student can open a regrade request only on a released, point-bearing applied check that
  // doesn't already have a request. Mirrors `canCreateRegradeRequest` in rubric-sidebar.tsx.
  const canRequestRegrade =
    !isGrader && comment.points !== null && comment.released && !comment.regrade_request_id && !existingRequest;

  const existingStatus = existingRequest ? statusConfig[existingRequest.status as RegradeStatus] : undefined;
  const fileComment = comment as unknown as SubmissionFileComment;

  return (
    <Box borderWidth="1px" borderColor="border.info" borderRadius="md" p={2} w="100%" fontSize="sm">
      <HStack justify="space-between" align="start" gap={2} flexWrap="wrap">
        <Text fontWeight="semibold" color="fg.default" wordBreak="break-word">
          {check.name}
        </Text>
        <Text fontWeight="semibold" color={isAdditive ? "green.600" : "red.600"} flexShrink={0}>
          {signedPoints}
        </Text>
      </HStack>
      {check.description && (
        <Box color="fg.subtle" fontSize="xs" mt={1}>
          <Markdown>{check.description}</Markdown>
        </Box>
      )}
      <Box color="fg.muted" mt={1}>
        <Markdown>{comment.comment}</Markdown>
      </Box>
      <HStack justify="space-between" align="center" gap={2} mt={1} flexWrap="wrap">
        <Box fontSize="xs">{isLineComment(fileComment) && <SubmissionFileCommentLink comment={fileComment} />}</Box>
        {existingStatus ? (
          <Badge colorPalette={existingStatus.colorPalette} size="sm">
            {existingStatus.label}
          </Badge>
        ) : canRequestRegrade ? (
          <RequestRegradeDialog
            comment={comment as unknown as SubmissionFileComment | SubmissionComments | SubmissionArtifactComment}
            compact
          />
        ) : null}
      </HStack>
    </Box>
  );
}

/**
 * Renders an available rubric check that the student is allowed to see but that was NOT applied to
 * their submission. Shows what the check assesses (description) and what it was worth, so the
 * grading summary conveys the full rubric — not just the checks that happened to be applied. Also
 * carries the un-applied regrade affordance (or a status badge if a request already exists).
 */
function UnappliedCheckRow({
  check,
  reviewId,
  isAdditive,
  existingRequest
}: {
  check: RubricChecks;
  reviewId: number;
  isAdditive: boolean;
  existingRequest?: RegradeRequest;
}) {
  const isGrader = useIsGraderOrInstructor();
  const existingStatus = existingRequest ? statusConfig[existingRequest.status as RegradeStatus] : undefined;

  // What this check would be worth if applied: additive checks add points; deduction checks would
  // subtract them (so "not applied" is good news for the student).
  const points = check.points ?? 0;
  const potentialLabel = points === 0 ? null : isAdditive ? `+${points} available` : `−${points} if applied`;

  return (
    <Box borderWidth="1px" borderColor="border.muted" borderRadius="md" p={2} w="100%" fontSize="sm" bg="bg.subtle">
      <HStack justify="space-between" align="start" gap={2} flexWrap="wrap">
        <VStack align="start" gap={0} minW="0">
          <HStack gap={2} flexWrap="wrap">
            <Text fontWeight="semibold" color="fg.default" wordBreak="break-word">
              {check.name}
            </Text>
            <Badge size="sm" variant="surface" colorPalette="gray">
              Not applied
            </Badge>
          </HStack>
          {check.description && (
            <Box color="fg.muted" fontSize="xs" mt={1}>
              <Markdown>{check.description}</Markdown>
            </Box>
          )}
        </VStack>
        <VStack align="end" gap={1} flexShrink={0}>
          {potentialLabel && (
            <Text fontSize="xs" color="fg.subtle">
              {potentialLabel}
            </Text>
          )}
          {existingStatus ? (
            <Badge colorPalette={existingStatus.colorPalette} size="sm">
              {existingStatus.label}
            </Badge>
          ) : !isGrader ? (
            <RequestRegradeForCheckDialog submissionReviewId={reviewId} rubricCheckId={check.id} compact />
          ) : null}
        </VStack>
      </HStack>
    </Box>
  );
}

/**
 * One check within a criterion. Resolves its applied comment instances (scoped to the current
 * student via target_student_profile_id), applies the visibility rules, and renders either an
 * applied row per comment or a single un-applied row. Reports its visibility and applied-point
 * sum up to the criterion so it can roll up the score and decide whether it has anything to show.
 */
function CheckRow({
  check,
  criteria,
  reviewId,
  targetStudentProfileId,
  requestsByCheckId,
  appliedOnly,
  onResolved
}: {
  check: RubricChecks;
  criteria: RubricCriteria;
  reviewId: number;
  targetStudentProfileId?: string | null;
  requestsByCheckId: Map<number, RegradeRequest>;
  appliedOnly?: boolean;
  onResolved: (checkId: number, resolution: CheckResolution) => void;
}) {
  const review = useSubmissionReviewOrGradingReview(reviewId);
  // Don't filter by student in the hook: whole-submission comments carry a null
  // target_student_profile_id and would be dropped. Instead include comments that apply to
  // everyone (null target) OR are targeted at this student (split/group per-student grading).
  const allComments = useRubricCheckInstances(check, reviewId) as unknown as CheckComment[];
  const comments = useMemo(
    () =>
      allComments.filter(
        (c) => c.target_student_profile_id == null || c.target_student_profile_id === targetStudentProfileId
      ),
    [allComments, targetStudentProfileId]
  );
  const isGrader = useIsGraderOrInstructor();

  const baseVisible = useShouldShowRubricCheck({
    check: check as HydratedRubricCheck,
    rubricCheckComments: comments,
    reviewForThisRubric: review,
    isGrader,
    isPreviewMode: false
  });
  // In applied-only mode (the Files-tab sidebar for students) hide un-applied checks entirely,
  // so empty criteria drop out too.
  const visible = baseVisible && (!appliedOnly || comments.length > 0);

  const appliedSum = useMemo(() => comments.reduce((acc, c) => acc + (c.points ?? 0), 0), [comments]);

  // Report up to the criterion whenever our visibility / applied points change.
  useEffect(() => {
    onResolved(check.id, { visible, appliedSum });
  }, [check.id, visible, appliedSum, onResolved]);

  if (!visible) {
    return null;
  }

  const existingRequest = requestsByCheckId.get(check.id);

  if (comments.length > 0) {
    return (
      <VStack align="stretch" gap={1} w="100%">
        {comments.map((comment) => (
          <AppliedCheckRow
            key={comment.id}
            check={check}
            comment={comment}
            isAdditive={!!criteria.is_additive}
            existingRequest={existingRequest}
          />
        ))}
      </VStack>
    );
  }

  return (
    <UnappliedCheckRow
      check={check}
      reviewId={reviewId}
      isAdditive={!!criteria.is_additive}
      existingRequest={existingRequest}
    />
  );
}

/**
 * One criterion block: header with name and earned/max, then a row per check. Earned points are
 * rolled up from the applied points across the criterion's checks, mirroring the recompute logic
 * in 20250522235254_fix-compute-grades-negative-score.sql:
 *   - additive:     min(sum of applied points, total_points)
 *   - non-additive: max(total_points - sum of applied deductions, 0)
 * Renders nothing (but keeps child hooks mounted) when no checks are visible to the current user.
 */
function CriterionBlock({
  criteria,
  reviewId,
  targetStudentProfileId,
  requestsByCheckId,
  appliedOnly,
  onResolved
}: {
  criteria: RubricCriteria;
  reviewId: number;
  targetStudentProfileId?: string | null;
  requestsByCheckId: Map<number, RegradeRequest>;
  appliedOnly?: boolean;
  onResolved: (criterionId: number, resolution: CriterionResolution) => void;
}) {
  const checks = useRubricChecksByCriteria(criteria.id);
  const [checkState, setCheckState] = useState<Record<number, CheckResolution>>({});

  const handleCheckResolved = useMemo(
    () => (checkId: number, resolution: CheckResolution) => {
      setCheckState((prev) => {
        const existing = prev[checkId];
        if (existing && existing.visible === resolution.visible && existing.appliedSum === resolution.appliedSum) {
          return prev;
        }
        return { ...prev, [checkId]: resolution };
      });
    },
    []
  );

  const totalPoints = criteria.total_points ?? 0;
  const max = useMemo(
    () =>
      maxPointsForCriterion({
        is_additive: criteria.is_additive,
        is_deduction_only: criteria.is_deduction_only,
        total_points: criteria.total_points,
        // maxPointsForCriterion only consults check points in the additive branch.
        rubric_checks: (checks ?? []).map((c) => ({ points: c.points }))
      }),
    [criteria.is_additive, criteria.is_deduction_only, criteria.total_points, checks]
  );

  const appliedTotal = useMemo(() => Object.values(checkState).reduce((acc, s) => acc + s.appliedSum, 0), [checkState]);
  const anyVisible = useMemo(() => Object.values(checkState).some((s) => s.visible), [checkState]);

  // Earned: additive caps the sum at total_points; non-additive / deduction-only subtracts the
  // applied deductions from total_points, floored at 0.
  const earned = criteria.is_additive ? Math.min(appliedTotal, totalPoints) : Math.max(totalPoints - appliedTotal, 0);

  // Bubble criterion-level visibility + score up to the section header / emptiness check.
  useEffect(() => {
    onResolved(criteria.id, { visible: anyVisible, earned, max });
  }, [criteria.id, anyVisible, earned, max, onResolved]);

  const checkRows = (checks ?? []).map((check) => (
    <CheckRow
      key={check.id}
      check={check}
      criteria={criteria}
      reviewId={reviewId}
      targetStudentProfileId={targetStudentProfileId}
      requestsByCheckId={requestsByCheckId}
      appliedOnly={appliedOnly}
      onResolved={handleCheckResolved}
    />
  ));

  // Keep a STABLE tree regardless of visibility — toggle `display`, never swap the structure.
  // Swapping the returned shape would unmount/remount the check rows, resetting their state and
  // causing an infinite visibility-report loop.
  return (
    <Box
      display={anyVisible ? "block" : "none"}
      borderWidth="1px"
      borderColor="border.subtle"
      borderRadius="md"
      p={3}
      w="100%"
    >
      <HStack justify="space-between" align="start" gap={2} flexWrap="wrap" mb={2}>
        <VStack align="start" gap={0} minW="0">
          <Text fontWeight="semibold" color="fg.default" wordBreak="break-word">
            {criteria.name}
          </Text>
        </VStack>
        <Text fontWeight="semibold" flexShrink={0}>
          {earned} / {max}
        </Text>
      </HStack>
      {criteria.description && (
        <Box color="fg.muted" fontSize="xs" mb={2}>
          <Markdown>{criteria.description}</Markdown>
        </Box>
      )}
      <VStack align="stretch" gap={2}>
        {checkRows}
      </VStack>
    </Box>
  );
}

/**
 * Student-facing, read-oriented hand-grading breakdown for a single grading review. Lists each
 * rubric criterion (ordered by ordinal) with its earned/max and the applied + visible-unapplied
 * checks, plus regrade affordances. Visibility (including release gating) is delegated to
 * useShouldShowRubricCheck; if nothing is visible after filtering, renders null.
 */
export default function HandGradingSection({ reviewId, appliedOnly }: HandGradingSectionProps) {
  const review = useSubmissionReviewOrGradingReview(reviewId);
  const submission = useSubmission();
  const { private_profile_id } = useClassProfiles();
  const criteriaList = useRubricCriteriaByRubric(review?.rubric_id);
  const regradeRequests = useRegradeRequestsBySubmission(submission?.id);

  const [criterionState, setCriterionState] = useState<Record<number, CriterionResolution>>({});
  const handleCriterionResolved = useMemo(
    () => (criterionId: number, resolution: CriterionResolution) => {
      setCriterionState((prev) => {
        const existing = prev[criterionId];
        if (
          existing &&
          existing.visible === resolution.visible &&
          existing.earned === resolution.earned &&
          existing.max === resolution.max
        ) {
          return prev;
        }
        return { ...prev, [criterionId]: resolution };
      });
    },
    []
  );

  // Index existing regrade requests for THIS review by the check they reference, so a check can
  // show its request's status badge instead of a fresh request button.
  const requestsByCheckId = useMemo(() => {
    const map = new Map<number, RegradeRequest>();
    for (const req of regradeRequests ?? []) {
      if (req.submission_review_id === reviewId && req.rubric_check_id != null) {
        map.set(req.rubric_check_id, req);
      }
    }
    return map;
  }, [regradeRequests, reviewId]);

  const sortedCriteria = useMemo(
    () => [...(criteriaList ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)),
    [criteriaList]
  );

  const { totalEarned, totalMax, anyVisible } = useMemo(() => {
    let te = 0;
    let tm = 0;
    let any = false;
    for (const c of sortedCriteria) {
      const state = criterionState[c.id];
      if (state?.visible) {
        any = true;
        te += state.earned;
        tm += state.max;
      }
    }
    return { totalEarned: te, totalMax: tm, anyVisible: any };
  }, [sortedCriteria, criterionState]);

  if (!reviewId || !review) {
    return null;
  }

  const criterionBlocks = sortedCriteria.map((criteria) => (
    <CriterionBlock
      key={criteria.id}
      criteria={criteria}
      reviewId={reviewId}
      targetStudentProfileId={private_profile_id}
      requestsByCheckId={requestsByCheckId}
      appliedOnly={appliedOnly}
      onResolved={handleCriterionResolved}
    />
  ));

  // Stable tree regardless of visibility — toggle `display` only. Swapping the returned shape
  // when `anyVisible` flips would unmount/remount the criterion blocks (and their check rows),
  // resetting their state and triggering an infinite visibility-report loop.
  return (
    <Box display={anyVisible ? "block" : "none"} borderWidth="1px" borderRadius="md" p={4} w="100%">
      <HStack justify="space-between" align="center" mb={3} flexWrap="wrap" gap={2}>
        <Heading as="h2" size="sm">
          Hand grading
        </Heading>
        <Text fontWeight="semibold">
          {totalEarned} / {totalMax}
        </Text>
      </HStack>
      <VStack align="stretch" gap={3}>
        {criterionBlocks}
      </VStack>
    </Box>
  );
}

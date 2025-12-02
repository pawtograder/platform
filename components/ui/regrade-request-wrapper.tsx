import {
  DialogActionTrigger,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { PopoverArrow, PopoverBody, PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import { useAssignmentController, useRegradeRequest, useRubricCheck, useRubricCriteria } from "@/hooks/useAssignment";
import { useClassProfiles, useIsGraderOrInstructor, useIsInstructor } from "@/hooks/useClassProfiles";
import { useProfileRole } from "@/hooks/useCourseController";
import {
  useSubmission,
  useSubmissionArtifactComment,
  useSubmissionComment,
  useSubmissionController,
  useSubmissionFileComment,
  useSubmissionRegradeRequestComments
} from "@/hooks/useSubmission";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { createClient } from "@/utils/supabase/client";
import type {
  RegradeRequestComment as RegradeRequestCommentType,
  RegradeStatus,
  RubricCheck,
  RubricCriteria,
  SubmissionRegradeRequest
} from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Heading, HStack, Icon, Input, Tag, Text, VStack } from "@chakra-ui/react";
import { useUpdate } from "@refinedev/core";
import { format, formatRelative } from "date-fns";
import type { LucideIcon } from "lucide-react";
import { ArrowUp, CheckCircle, Clock, XCircle } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import Markdown from "./markdown";
import MessageInput from "./message-input";
import PersonAvatar from "./person-avatar";
import { Skeleton } from "./skeleton";
import { toaster } from "./toaster";

const statusConfig: Record<
  RegradeStatus,
  {
    bgColor: string;
    borderColor: string;
    icon: LucideIcon;
    label: string;
    description: string;
  }
> = {
  draft: {
    bgColor: "bg.warning",
    borderColor: "border.warning",
    icon: Clock,
    label: "Draft",
    description: "Regrade request being prepared"
  },
  opened: {
    bgColor: "bg.info",
    borderColor: "border.info",
    icon: Clock,
    label: "Pending",
    description: "Regrade request submitted, awaiting grader review"
  },
  resolved: {
    bgColor: "bg.subtle",
    borderColor: "border.subtle",
    icon: CheckCircle,
    label: "Resolved",
    description: "Grader has reviewed and responded to regrade request"
  },
  escalated: {
    bgColor: "bg.warning",
    borderColor: "border.warning",
    icon: ArrowUp,
    label: "Escalated",
    description: "Student escalated to instructor for final review"
  },
  closed: {
    bgColor: "bg.emphasized",
    borderColor: "border.emphasized",
    icon: XCircle,
    label: "Closed",
    description: "Regrade request has been finalized"
  }
};

/**
 * Displays a single comment within a regrade request, including author information, role tags, and comment content.
 *
 * Supports inline editing of the comment by its author. Shows a loading skeleton if the author's profile is not yet loaded.
 */
function RegradeRequestComment({ comment }: { comment: RegradeRequestCommentType }) {
  const authorProfile = useUserProfile(comment.author);
  const authorRole = useProfileRole(comment.author);
  const [isEditing, setIsEditing] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const { mutateAsync: updateComment } = useUpdate({
    resource: "submission_regrade_request_comments"
  });

  if (!authorProfile) {
    return <Skeleton height="60px" width="100%" />;
  }

  return (
    <Box key={comment.id} m={0} pb={1} w="100%">
      <HStack spaceX={0} mb={0} alignItems="flex-start" w="100%">
        <PersonAvatar size="2xs" uid={comment.author} />
        <VStack
          alignItems="flex-start"
          spaceY={0}
          gap={1}
          w="100%"
          border="1px solid"
          borderColor="border.subtle"
          borderRadius="md"
          borderLeft="3px solid"
          borderLeftColor="border.subtle"
          bg="bg.subtle"
        >
          <HStack
            w="100%"
            justifyContent="space-between"
            bg="bg.muted"
            p={0}
            borderTopRadius="md"
            borderBottom="1px solid"
            borderColor="border.muted"
          >
            <HStack gap={1} fontSize="sm" color="fg.muted" ml={1}>
              <Text fontWeight="bold">{authorProfile?.name}</Text>
              <Text data-visual-test="blackout">commented on {format(comment.created_at, "MMM d, yyyy")}</Text>
            </HStack>
            <HStack>
              {authorRole === "grader" || authorRole === "instructor" || authorProfile?.flair ? (
                <Tag.Root
                  size="md"
                  colorPalette={
                    authorRole === "grader" || authorRole === "instructor" ? "blue" : authorProfile?.flair_color
                  }
                  variant="surface"
                >
                  <Tag.Label>
                    {authorRole === "grader"
                      ? "Grader"
                      : authorRole === "instructor"
                        ? "Instructor"
                        : authorProfile?.flair}
                  </Tag.Label>
                </Tag.Root>
              ) : (
                <></>
              )}
            </HStack>
          </HStack>
          <Box pl={2}>
            {isEditing ? (
              <MessageInput
                textAreaRef={messageInputRef}
                defaultSingleLine={true}
                value={comment.comment}
                closeButtonText="Cancel"
                onClose={() => {
                  setIsEditing(false);
                }}
                sendMessage={async (message) => {
                  await updateComment({ id: comment.id, values: { comment: message } });
                  setIsEditing(false);
                }}
              />
            ) : (
              <Box borderRadius="sm" p={1} m={-1}>
                <Markdown>{comment.comment}</Markdown>
              </Box>
            )}
          </Box>
        </VStack>
      </HStack>
    </Box>
  );
}

/**
 * Displays a list of comments for a specific regrade request.
 *
 * Fetches and renders all comments associated with the given regrade request ID.
 *
 * @param regradeRequestId - The unique identifier of the regrade request whose comments are displayed.
 */
export function RegradeRequestComments({ regradeRequestId }: { regradeRequestId: number }) {
  const comments = useSubmissionRegradeRequestComments({ submission_regrade_request_id: regradeRequestId });
  return (
    <VStack px={2}>{comments?.map((comment) => <RegradeRequestComment key={comment.id} comment={comment} />)}</VStack>
  );
}

/**
 * Popover component for resolving a regrade request with warning for significant score changes
 */
const ResolveRequestPopover = memo(function ResolveRequestPopover({
  initialPoints,
  regradeRequestId,
  privateProfileId,
  rubricCriteria
}: {
  initialPoints: number | null;
  regradeRequestId: number;
  privateProfileId: string;
  rubricCriteria: RubricCriteria | null | undefined;
  rubricCheck?: RubricCheck | null | undefined;
}) {
  const [pointsAdjustment, setPointsAdjustment] = useState<string>("0");
  const [isOpen, setIsOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const { regradeRequests } = useAssignmentController();

  // Reset adjustment to 0 when popover opens
  useEffect(() => {
    if (isOpen) {
      setPointsAdjustment("0");
    }
  }, [isOpen]);

  const isAdditive = rubricCriteria?.is_additive ?? true;
  const changeDescription = isAdditive ? "points awarded" : "deduction";

  // Calculate the final score based on adjustment
  const pointsAdjustmentNum = parseFloat(pointsAdjustment) || 0;
  // Adjustment represents GRADE IMPACT: +5 = improve grade, -5 = worsen grade
  // For additive: +5 = add 5 points earned = better
  // For deductive: +5 = subtract 5 from deduction = better
  const finalScore = isAdditive
    ? (initialPoints || 0) + pointsAdjustmentNum
    : (initialPoints || 0) - pointsAdjustmentNum;
  const hasChange = pointsAdjustmentNum !== 0;

  // Check if the adjustment would result in a negative score
  const wouldBeNegative = finalScore < 0;
  const maxPositiveAdjustment = isAdditive ? Infinity : initialPoints || 0;
  const maxNegativeAdjustment = isAdditive ? -(initialPoints || 0) : -Infinity;

  // Helper function to check if the score change is significant (>50%)
  const isSignificantChange = useCallback((newScore: number | null, originalScore: number | null): boolean => {
    if (newScore === null || originalScore === null || originalScore === 0) {
      return false;
    }
    const changePercent = Math.abs((newScore - originalScore) / originalScore);
    return changePercent > 0.5;
  }, []);

  const handleResolve = useCallback(async () => {
    setIsUpdating(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("update_regrade_request_status", {
        regrade_request_id: regradeRequestId,
        new_status: "resolved",
        profile_id: privateProfileId,
        resolved_points: finalScore
      });

      if (error) throw error;

      setIsOpen(false);
      await regradeRequests.invalidate(regradeRequestId);

      toaster.create({
        title: "Request Resolved",
        description:
          pointsAdjustmentNum === 0
            ? "Request resolved with no change to the score."
            : `Request resolved. Score adjusted by ${pointsAdjustmentNum > 0 ? "+" : ""}${pointsAdjustmentNum} points.`,
        type: "success"
      });
    } catch {
      toaster.create({
        title: "Error",
        description: "Failed to resolve request. Please try again.",
        type: "error"
      });
    } finally {
      setIsUpdating(false);
    }
  }, [finalScore, pointsAdjustmentNum, regradeRequestId, privateProfileId, regradeRequests]);

  return (
    <PopoverRoot
      open={isOpen}
      onOpenChange={(e) => {
        setIsOpen(e.open);
      }}
    >
      <PopoverTrigger asChild>
        <Button colorPalette="blue" size="sm" loading={isUpdating}>
          Resolve Request
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <PopoverArrow />
        <PopoverBody>
          <VStack gap={3} align="start">
            <Text fontWeight="semibold">Resolve Regrade Request</Text>

            {/* Current score display */}
            <Box w="100%">
              <Text fontSize="sm" color="fg.muted">
                Current {changeDescription}:{" "}
                <Text as="span" fontWeight="bold">
                  {initialPoints || 0} {isAdditive ? "pts" : "pts deducted"}
                </Text>
              </Text>
            </Box>

            {/* Input for points adjustment */}
            <VStack gap={2} align="start" w="100%">
              <VStack gap={1} align="start" w="100%">
                <Text fontSize="sm" fontWeight="medium" id="resolve-grade-adjustment-label">
                  Grade Adjustment:
                </Text>
                <Text fontSize="xs" color="fg.muted" id="resolve-grade-adjustment-description">
                  Enter +/- points to adjust grade (e.g., +5 to improve, -2 to worsen, 0 for no change)
                </Text>
              </VStack>
              <Box
                bg={isSignificantChange(finalScore, initialPoints) ? "bg.warning" : undefined}
                p={isSignificantChange(finalScore, initialPoints) ? 2 : 0}
                borderRadius={isSignificantChange(finalScore, initialPoints) ? "md" : undefined}
                w="100%"
              >
                <Input
                  type="text"
                  inputMode="numeric"
                  value={pointsAdjustment}
                  onChange={(e) => {
                    e.stopPropagation();
                    const inputValue = e.target.value;

                    // Allow empty string (treated as 0)
                    if (inputValue === "") {
                      setPointsAdjustment("");
                      return;
                    }

                    // Allow intermediate states: "-", "+", ".", "-.", "+.", and valid numbers
                    // This matches: optional +/-, optional digits, optional decimal, optional more digits
                    if (/^[+-]?\d*\.?\d*$/.test(inputValue) && inputValue !== ".") {
                      setPointsAdjustment(inputValue);
                    }
                  }}
                  onFocus={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    e.stopPropagation();
                    // On blur, clean up the value
                    const numValue = parseFloat(pointsAdjustment);
                    if (
                      isNaN(numValue) ||
                      pointsAdjustment === "" ||
                      pointsAdjustment === "-" ||
                      pointsAdjustment === "+"
                    ) {
                      setPointsAdjustment("0");
                    } else {
                      // Clean up trailing dots or unnecessary decimals
                      setPointsAdjustment(numValue.toString());
                    }
                  }}
                  placeholder="0"
                  size="sm"
                  w="100%"
                  aria-label="Grade adjustment points"
                  aria-labelledby="resolve-grade-adjustment-label"
                  aria-describedby={`resolve-grade-adjustment-description${wouldBeNegative ? " resolve-negative-score-warning" : ""}`}
                  aria-invalid={wouldBeNegative}
                  aria-required="false"
                />

                {/* Change indicator */}
                {hasChange && (
                  <Box mt={2} p={2} bg={pointsAdjustmentNum > 0 ? "green.50" : "red.50"} borderRadius="md">
                    <VStack align="start" gap={1}>
                      <Text fontSize="sm" fontWeight="medium" color={pointsAdjustmentNum > 0 ? "green.700" : "red.700"}>
                        {pointsAdjustmentNum > 0 ? "+" : ""}
                        {pointsAdjustmentNum} pts adjustment
                        {pointsAdjustmentNum > 0 ? " (grade increases)" : " (grade decreases)"}
                      </Text>
                      <Text fontSize="xs" fontWeight="semibold">
                        New {changeDescription}: {finalScore} {isAdditive ? "pts awarded" : "pts deducted"}
                      </Text>
                    </VStack>
                  </Box>
                )}

                {isSignificantChange(finalScore, initialPoints) && (
                  <Text fontSize="xs" color="fg.warning" mt={1} fontWeight="medium">
                    ⚠️ This is a significant change ({">"}50%) from the original score
                  </Text>
                )}

                {wouldBeNegative && (
                  <Box
                    mt={2}
                    p={2}
                    bg="red.50"
                    borderRadius="md"
                    borderWidth="1px"
                    borderColor="red.200"
                    id="resolve-negative-score-warning"
                    role="alert"
                    aria-live="polite"
                  >
                    <Text fontSize="xs" color="red.700" fontWeight="medium">
                      ⚠️ Warning: This adjustment would result in a negative score ({finalScore}).
                      {isAdditive
                        ? ` Maximum negative adjustment is ${maxNegativeAdjustment}.`
                        : ` Maximum positive adjustment is +${maxPositiveAdjustment}.`}
                    </Text>
                  </Box>
                )}
              </Box>
            </VStack>

            <Button
              colorPalette="blue"
              size="sm"
              onClick={handleResolve}
              loading={isUpdating}
              w="100%"
              disabled={wouldBeNegative}
              aria-label={wouldBeNegative ? "Cannot resolve with negative score" : "Resolve regrade request"}
            >
              {hasChange
                ? `Apply ${pointsAdjustmentNum > 0 ? "+" : ""}${pointsAdjustmentNum} pts and Resolve`
                : "Resolve with No Change"}
            </Button>
          </VStack>
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
});

/**
 * Dialog component for escalating a regrade request to an instructor
 */
function EscalateRequestDialog({
  isOpen,
  onOpenChange,
  onEscalate,
  isUpdating
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onEscalate: () => Promise<void>;
  isUpdating: boolean;
}) {
  return (
    <DialogRoot open={isOpen} onOpenChange={(e) => onOpenChange(e.open)}>
      <DialogTrigger asChild>
        <Button colorPalette="orange" size="sm" loading={isUpdating}>
          Escalate to Instructor
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Escalate Regrade Request</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <VStack gap={4} align="start">
            <Text>You can escalate this regrade request to an instructor for final review.</Text>
            <Box bg="bg.info" p={3} borderRadius="md" w="100%">
              <Text fontWeight="semibold" mb={2}>
                ⚠️ Important Guidelines
              </Text>
              <VStack gap={1} align="start">
                <Text fontSize="sm">• Only escalate if you have a substantive concern about the grading decision</Text>
                <Text fontSize="sm">
                  • Provide clear reasoning for why you believe the decision should be reconsidered
                </Text>
                <Text fontSize="sm">• The instructor&apos;s decision will be final</Text>
                <Text fontSize="sm">• Frivolous escalations may affect future regrade requests</Text>
              </VStack>
            </Box>
          </VStack>
        </DialogBody>
        <DialogFooter>
          <DialogActionTrigger asChild>
            <Button variant="outline">Cancel</Button>
          </DialogActionTrigger>
          <Button colorPalette="orange" onClick={onEscalate} loading={isUpdating}>
            Escalate Request
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

/**
 * Popover component for closing (deciding on) an escalated regrade request with warning for significant score changes
 */
const CloseRequestPopover = memo(function CloseRequestPopover({
  initialPoints,
  resolvedPoints,
  regradeRequestId,
  privateProfileId,
  rubricCriteria
}: {
  initialPoints: number | null;
  resolvedPoints: number | null;
  regradeRequestId: number;
  privateProfileId: string;
  rubricCriteria: RubricCriteria | null | undefined;
  rubricCheck?: RubricCheck | null | undefined;
}) {
  const [pointsAdjustment, setPointsAdjustment] = useState<string>("0");
  const [isOpen, setIsOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  const { regradeRequests } = useAssignmentController();

  // Reset adjustment to 0 when popover opens
  useEffect(() => {
    if (isOpen) {
      setPointsAdjustment("0");
    }
  }, [isOpen]);

  const isAdditive = rubricCriteria?.is_additive ?? true;
  const changeDescription = isAdditive ? "points awarded" : "deduction";

  // Calculate the final score based on adjustment from grader's resolved score
  const pointsAdjustmentNum = parseFloat(pointsAdjustment) || 0;
  // Adjustment represents GRADE IMPACT: +5 = improve grade, -5 = worsen grade
  // For additive: +5 = add 5 points earned = better
  // For deductive: +5 = subtract 5 from deduction = better
  const finalScore = isAdditive
    ? (resolvedPoints || 0) + pointsAdjustmentNum
    : (resolvedPoints || 0) - pointsAdjustmentNum;
  const changeFromInitial = isAdditive ? finalScore - (initialPoints || 0) : (initialPoints || 0) - finalScore; // For deductive, compare deduction amounts
  const hasChange = pointsAdjustmentNum !== 0;

  // Check if the adjustment would result in a negative score
  const wouldBeNegative = finalScore < 0;
  const maxPositiveAdjustment = isAdditive ? Infinity : resolvedPoints || 0;
  const maxNegativeAdjustment = isAdditive ? -(resolvedPoints || 0) : -Infinity;

  // Helper function to check if the score change is significant (>50%)
  const isSignificantChange = useCallback((newScore: number | null, originalScore: number | null): boolean => {
    if (newScore === null || originalScore === null || originalScore === 0) {
      return false;
    }
    const changePercent = Math.abs((newScore - originalScore) / originalScore);
    return changePercent > 0.5;
  }, []);

  const handleClose = useCallback(async () => {
    setIsUpdating(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("update_regrade_request_status", {
        regrade_request_id: regradeRequestId,
        new_status: "closed",
        profile_id: privateProfileId,
        closed_points: finalScore
      });

      if (error) throw error;

      setIsOpen(false);
      await regradeRequests.invalidate(regradeRequestId);

      toaster.create({
        title: "Request Closed",
        description:
          pointsAdjustmentNum === 0
            ? "Request closed. Grader's decision upheld."
            : `Request closed. Adjusted by ${pointsAdjustmentNum > 0 ? "+" : ""}${pointsAdjustmentNum} pts from grader's decision.`,
        type: "success"
      });
    } catch {
      toaster.create({
        title: "Error",
        description: "Failed to close request. Please try again.",
        type: "error"
      });
    } finally {
      setIsUpdating(false);
    }
  }, [finalScore, pointsAdjustmentNum, regradeRequestId, privateProfileId, regradeRequests]);

  return (
    <PopoverRoot open={isOpen} onOpenChange={(e) => setIsOpen(e.open)}>
      <PopoverTrigger asChild>
        <Button colorPalette="orange" variant="solid" size="sm">
          Decide Escalation
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <PopoverArrow />
        <PopoverBody>
          <VStack gap={3} align="start">
            <Text fontWeight="semibold">Decide Escalation</Text>

            {/* Score history */}
            <Box w="100%" bg="bg.subtle" p={2} borderRadius="md">
              <VStack align="start" gap={1}>
                <Text fontSize="xs" fontWeight="semibold" color="fg.muted">
                  SCORE HISTORY:
                </Text>
                <HStack justify="space-between" w="100%">
                  <Text fontSize="sm">Original {changeDescription}:</Text>
                  <Text fontSize="sm" fontWeight="bold">
                    {initialPoints || 0} {isAdditive ? "pts" : "pts deducted"}
                  </Text>
                </HStack>
                <HStack justify="space-between" w="100%">
                  <Text fontSize="sm">Grader&apos;s revised {changeDescription}:</Text>
                  <Text fontSize="sm" fontWeight="bold">
                    {resolvedPoints || 0} {isAdditive ? "pts" : "pts deducted"}
                  </Text>
                </HStack>
              </VStack>
            </Box>

            {/* Input for adjustment from grader's decision */}
            <VStack gap={2} align="start" w="100%">
              <VStack gap={1} align="start" w="100%">
                <Text fontSize="sm" fontWeight="medium" id="close-grade-adjustment-label">
                  Grade Adjustment from Grader&apos;s Decision:
                </Text>
                <Text fontSize="xs" color="fg.muted" id="close-grade-adjustment-description">
                  Enter +/- points to adjust grade or 0 to uphold grader&apos;s decision
                </Text>
              </VStack>
              <Box
                bg={isSignificantChange(finalScore, initialPoints) ? "bg.warning" : undefined}
                p={isSignificantChange(finalScore, initialPoints) ? 2 : 0}
                borderRadius={isSignificantChange(finalScore, initialPoints) ? "md" : undefined}
                w="100%"
              >
                <Input
                  type="text"
                  inputMode="numeric"
                  value={pointsAdjustment}
                  onChange={(e) => {
                    e.stopPropagation();
                    const inputValue = e.target.value;

                    // Allow empty string (treated as 0)
                    if (inputValue === "") {
                      setPointsAdjustment("");
                      return;
                    }

                    // Allow intermediate states: "-", "+", ".", "-.", "+.", and valid numbers
                    // This matches: optional +/-, optional digits, optional decimal, optional more digits
                    if (/^[+-]?\d*\.?\d*$/.test(inputValue) && inputValue !== ".") {
                      setPointsAdjustment(inputValue);
                    }
                  }}
                  onFocus={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    e.stopPropagation();
                    // On blur, clean up the value
                    const numValue = parseFloat(pointsAdjustment);
                    if (
                      isNaN(numValue) ||
                      pointsAdjustment === "" ||
                      pointsAdjustment === "-" ||
                      pointsAdjustment === "+"
                    ) {
                      setPointsAdjustment("0");
                    } else {
                      // Clean up trailing dots or unnecessary decimals
                      setPointsAdjustment(numValue.toString());
                    }
                  }}
                  placeholder="0"
                  size="sm"
                  w="100%"
                  aria-label="Instructor grade adjustment from grader decision"
                  aria-labelledby="close-grade-adjustment-label"
                  aria-describedby={`close-grade-adjustment-description${wouldBeNegative ? " close-negative-score-warning" : ""}`}
                  aria-invalid={wouldBeNegative}
                  aria-required="false"
                />

                {/* Change indicators */}
                {hasChange && (
                  <Box mt={2} p={2} bg="purple.50" borderRadius="md">
                    <VStack align="start" gap={1}>
                      <Text fontSize="sm" fontWeight="medium" color="purple.700">
                        {pointsAdjustmentNum > 0 ? "+" : ""}
                        {pointsAdjustmentNum} pts from grader&apos;s decision
                      </Text>
                      <Text fontSize="xs" fontWeight="semibold">
                        Final {changeDescription}: {finalScore} {isAdditive ? "pts awarded" : "pts deducted"}
                      </Text>
                      <Text
                        fontSize="xs"
                        fontWeight="medium"
                        color={changeFromInitial > 0 ? "green.700" : changeFromInitial < 0 ? "red.700" : "fg.muted"}
                      >
                        Overall change from original: {changeFromInitial > 0 ? "+" : ""}
                        {changeFromInitial} pts
                        {changeFromInitial !== 0 &&
                          (changeFromInitial > 0 ? " (grade increases)" : " (grade decreases)")}
                      </Text>
                    </VStack>
                  </Box>
                )}

                {isSignificantChange(finalScore, initialPoints) && (
                  <Text fontSize="xs" color="fg.warning" mt={1} fontWeight="medium">
                    ⚠️ This is a significant change ({">"}50%) from the original score
                  </Text>
                )}

                {wouldBeNegative && (
                  <Box
                    mt={2}
                    p={2}
                    bg="red.50"
                    borderRadius="md"
                    borderWidth="1px"
                    borderColor="red.200"
                    id="close-negative-score-warning"
                    role="alert"
                    aria-live="polite"
                  >
                    <Text fontSize="xs" color="red.700" fontWeight="medium">
                      ⚠️ Warning: This adjustment would result in a negative score ({finalScore}).
                      {isAdditive
                        ? ` Maximum negative adjustment is ${maxNegativeAdjustment}.`
                        : ` Maximum positive adjustment is +${maxPositiveAdjustment}.`}
                    </Text>
                  </Box>
                )}
              </Box>
            </VStack>

            <VStack gap={2} w="100%">
              {!hasChange && (
                <Box bg="bg.info" p={2} borderRadius="md" w="100%">
                  <Text fontSize="xs">ℹ️ You&apos;re upholding the grader&apos;s decision</Text>
                </Box>
              )}
              <Button
                colorPalette="green"
                variant="surface"
                size="sm"
                onClick={handleClose}
                loading={isUpdating}
                w="100%"
                disabled={wouldBeNegative}
                aria-label={wouldBeNegative ? "Cannot close with negative score" : "Close regrade request"}
              >
                {hasChange
                  ? `Apply ${pointsAdjustmentNum > 0 ? "+" : ""}${pointsAdjustmentNum} pts and Close`
                  : "Uphold Grader's Decision"}
              </Button>
            </VStack>
          </VStack>
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
});

/**
 * Inline editable points component for instructors
 */
function EditablePoints({
  points,
  regradeRequestId,
  type,
  privateProfileId,
  isAdditive
}: {
  points: number | null;
  regradeRequestId: number;
  type: "resolved" | "closed";
  privateProfileId: string;
  isAdditive: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState<string>(points?.toString() || "");
  const [isUpdating, setIsUpdating] = useState(false);
  const { regradeRequests } = useAssignmentController();

  // Update editValue when points prop changes (e.g., after successful save)
  useEffect(() => {
    if (!isEditing) {
      setEditValue(points?.toString() || "");
    }
  }, [points, isEditing]);

  const handleSave = useCallback(async () => {
    setIsUpdating(true);
    try {
      const supabase = createClient();

      // Convert empty string to 0, otherwise parse the number
      const numericValue = editValue === "" ? 0 : Math.round(parseFloat(editValue) || 0);

      const rpcParams = {
        regrade_request_id: regradeRequestId,
        profile_id: privateProfileId,
        ...(type === "resolved" ? { resolved_points: numericValue } : { closed_points: numericValue })
      };

      const { error } = await supabase.rpc("update_regrade_request_points", rpcParams);

      if (error) throw error;

      await regradeRequests.invalidate(regradeRequestId);
      setIsEditing(false);
      toaster.create({
        title: "Points Updated",
        description: `${type === "resolved" ? "Resolved" : "Final"} points have been updated.`,
        type: "success"
      });
    } catch {
      toaster.create({
        title: "Error",
        description: "Failed to update points. Please try again.",
        type: "error"
      });
    } finally {
      setIsUpdating(false);
    }
  }, [editValue, regradeRequestId, privateProfileId, type, regradeRequests]);

  const handleCancel = useCallback(() => {
    setEditValue(points?.toString() || "");
    setIsEditing(false);
  }, [points]);

  if (isEditing) {
    return (
      <HStack gap={1} alignItems="center">
        {isAdditive ? "+" : "-"}
        <Input
          type="number"
          value={editValue}
          onChange={(e) => {
            const inputValue = e.target.value;

            // Allow empty string or valid number strings (including negative and decimal)
            if (inputValue === "" || inputValue === "-" || /^-?\d*\.?\d*$/.test(inputValue)) {
              setEditValue(inputValue);
            }
          }}
          size="xs"
          width="60px"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleSave();
            } else if (e.key === "Escape") {
              handleCancel();
            }
          }}
        />
        <Button size="xs" colorPalette="blue" onClick={handleSave} loading={isUpdating}>
          Save
        </Button>
        <Button size="xs" variant="ghost" onClick={handleCancel} disabled={isUpdating}>
          Cancel
        </Button>
      </HStack>
    );
  }

  return (
    <Text
      as="button"
      textDecoration="underline"
      textDecorationStyle="dotted"
      cursor="pointer"
      color="blue.600"
      _hover={{ color: "blue.800", textDecorationStyle: "solid" }}
      onClick={() => setIsEditing(true)}
      title="Click to edit points"
    >
      {points === null || points === undefined ? 0 : points}
    </Text>
  );
}
function useRegradeRequestRubricCheck(regradeRequest: SubmissionRegradeRequest | undefined | null) {
  // Retrieve the submission comment OR the submission artifact comment OR the submission file comment
  const submissionComment = useSubmissionComment(regradeRequest?.submission_comment_id);
  const submissionArtifactComment = useSubmissionArtifactComment(regradeRequest?.submission_artifact_comment_id);
  const submissionFileComment = useSubmissionFileComment(regradeRequest?.submission_file_comment_id);
  return useRubricCheck(
    submissionComment?.rubric_check_id ||
      submissionArtifactComment?.rubric_check_id ||
      submissionFileComment?.rubric_check_id
  );
}

/**
 * Displays and manages a regrade request, including its status, metadata, available actions, and associated comments.
 *
 * Renders the regrade request's current status, assignment and user details, and provides context-sensitive actions such as resolving, escalating, or closing the request based on user role and request state. Includes a comment section for discussion and supports adding new comments unless the request is closed. Children content is rendered within the request panel.
 *
 * @param regradeRequestId - The ID of the regrade request to display and manage
 * @param children - Content to render within the regrade request panel
 */
export default function RegradeRequestWrapper({
  regradeRequestId,
  children
}: {
  regradeRequestId: number | null | undefined;
  children: React.ReactNode;
}) {
  const regradeRequest = useRegradeRequest(regradeRequestId);
  const { private_profile_id } = useClassProfiles();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const isInstructor = useIsInstructor();
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [isEscalateDialogOpen, setIsEscalateDialogOpen] = useState(false);
  const isGroupAssignment = useSubmission().assignment_group_id !== null;
  const { submission_regrade_request_comments } = useSubmissionController();
  const { regradeRequests } = useAssignmentController();

  const assignee = useUserProfile(regradeRequest?.assignee);
  const resolver = useUserProfile(regradeRequest?.resolved_by);
  const escalator = useUserProfile(regradeRequest?.escalated_by);
  const closer = useUserProfile(regradeRequest?.closed_by);

  const rubricCheck = useRegradeRequestRubricCheck(regradeRequest);
  const rubricCriteria = useRubricCriteria(rubricCheck?.rubric_criteria_id);

  // Early return if no regrade request
  if (!regradeRequest) {
    return <>{children}</>;
  }

  const config = statusConfig[regradeRequest.status as RegradeStatus];
  const StatusIcon = config.icon;

  // Show comment form for active states (opened, escalated)
  const showCommentForm = regradeRequest.status !== "closed";

  const handleSubmitComment = async (commentText: string) => {
    if (!regradeRequest?.id) return;
    if (!commentText.trim()) {
      toaster.create({
        title: "Empty comment",
        description: "Please enter a comment before submitting",
        type: "error"
      });
      return;
    }

    setIsSubmittingComment(true);
    const supabase = createClient();
    try {
      if (regradeRequest.status === "draft") {
        const { error } = await supabase.rpc("update_regrade_request_status", {
          regrade_request_id: regradeRequest.id,
          new_status: "opened",
          profile_id: private_profile_id
        });

        if (error) {
          throw new Error(`Failed to open regrade request: ${error.message}`);
        }

        await regradeRequests.invalidate(regradeRequest.id);
      }
      const values = {
        comment: commentText.trim(),
        submission_id: regradeRequest.submission_id,
        assignment_id: regradeRequest.assignment_id,
        submission_regrade_request_id: regradeRequest.id,
        class_id: regradeRequest.class_id,
        author: private_profile_id
      };
      await submission_regrade_request_comments.create(values);
    } catch (error) {
      toaster.create({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to add comment. Please try again.",
        type: "error"
      });
    } finally {
      setIsSubmittingComment(false);
    }
  };

  const handleEscalateRequest = async () => {
    if (!regradeRequest?.id) return;
    setIsUpdatingStatus(true);
    const supabase = createClient();
    try {
      const { error } = await supabase.rpc("update_regrade_request_status", {
        regrade_request_id: regradeRequest.id,
        new_status: "escalated",
        profile_id: private_profile_id
      });

      if (error) {
        throw new Error(`Failed to escalate regrade request: ${error.message}`);
      }

      await regradeRequests.invalidate(regradeRequest.id);

      setIsEscalateDialogOpen(false);
      toaster.create({
        title: "Request Escalated",
        description: "Your regrade request has been escalated to an instructor.",
        type: "success"
      });
    } catch (error) {
      toaster.create({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to escalate request. Please try again.",
        type: "error"
      });
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  return (
    <>
      <Box width="100%" borderLeft="4px solid" borderBottom="3px solid" borderColor={config.borderColor} mb={4}>
        <Box
          position="relative"
          _before={{
            content: '""',
            position: "absolute",
            top: 0,
            left: "-4px",
            right: 0,
            bottom: 0,
            borderRadius: "md",
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0,
            border: "1px solid",
            borderColor: config.borderColor,
            borderLeft: "none",
            opacity: 0.3,
            pointerEvents: "none"
          }}
        >
          {/* Status Badge */}
          <Box w="100%" bg={config.bgColor} p={1} borderBottom="1px solid" borderColor={config.borderColor}>
            <HStack alignItems="flex-start">
              <Icon as={StatusIcon} boxSize={3} />
              <VStack align="flex-start" gap={0} flexGrow={10}>
                <Heading size="sm">Regrade {config.label}</Heading>
                {regradeRequest.opened_at && (
                  <Text fontSize="xs" color="fg.muted" data-visual-test="blackout">
                    Opened {formatRelative(regradeRequest.opened_at, new Date())}, initial score:{" "}
                    <Text as="span" fontWeight="semibold">
                      {regradeRequest.initial_points || 0}
                      {rubricCriteria && (
                        <Text as="span" fontWeight="normal">
                          {" "}
                          {rubricCriteria.is_additive ? "pts awarded" : "pts deducted"}
                        </Text>
                      )}
                    </Text>
                  </Text>
                )}
                {regradeRequest.status === "draft" && (
                  <Text fontSize="xs" fontWeight="bold">
                    Draft regrade request, awaiting student comment
                  </Text>
                )}
                {regradeRequest.assignee && regradeRequest.status !== "draft" && (
                  <Text fontSize="xs" color="fg.muted">
                    Assigned to {assignee?.name}
                  </Text>
                )}
                {regradeRequest.resolved_at && (
                  <Text fontSize="xs" color="fg.muted" data-visual-test="blackout">
                    Resolved {formatRelative(regradeRequest.resolved_at, new Date())} by {resolver?.name}, new score:{" "}
                    {isInstructor ? (
                      <EditablePoints
                        points={regradeRequest.resolved_points}
                        regradeRequestId={regradeRequest.id}
                        type="resolved"
                        privateProfileId={private_profile_id}
                        isAdditive={rubricCriteria?.is_additive ?? true}
                      />
                    ) : (
                      regradeRequest.resolved_points || 0
                    )}
                    {rubricCriteria?.is_additive ? " pts awarded" : " pts deducted"}
                    {(() => {
                      const change = (regradeRequest.resolved_points || 0) - (regradeRequest.initial_points || 0);
                      // For additive: higher is better (green). For deductive: higher is worse (red)
                      const isPositiveChange = (rubricCriteria?.is_additive ?? true) ? change > 0 : change < 0;
                      if (change === 0) return " (no change)";
                      return (
                        <Text as="span" fontWeight="semibold" color={isPositiveChange ? "green.600" : "red.600"}>
                          {" "}
                          ({isPositiveChange ? "+" : "-"}
                          {Math.abs(change)})
                        </Text>
                      );
                    })()}
                  </Text>
                )}
                {regradeRequest.escalated_at && (
                  <Text fontSize="xs" color="fg.muted" data-visual-test="blackout">
                    Escalated {formatRelative(regradeRequest.escalated_at, new Date())} by {escalator?.name}
                  </Text>
                )}
                {regradeRequest.closed_at && (
                  <Text fontSize="xs" color="fg.muted" data-visual-test="blackout">
                    Closed {formatRelative(regradeRequest.closed_at, new Date())} by {closer?.name}, final score:{" "}
                    {isInstructor ? (
                      <EditablePoints
                        points={regradeRequest.closed_points}
                        isAdditive={rubricCriteria?.is_additive ?? true}
                        regradeRequestId={regradeRequest.id}
                        type="closed"
                        privateProfileId={private_profile_id}
                      />
                    ) : (
                      regradeRequest.closed_points || 0
                    )}
                    {(() => {
                      const changeFromResolved =
                        (regradeRequest.closed_points || 0) - (regradeRequest.resolved_points || 0);
                      const changeFromInitial =
                        (regradeRequest.closed_points || 0) - (regradeRequest.initial_points || 0);
                      const isAdditive = rubricCriteria?.is_additive ?? true;
                      // For additive: higher is better (green). For deductive: higher is worse (red)
                      const isPositiveChangeFromResolved = isAdditive ? changeFromResolved > 0 : changeFromResolved < 0;
                      const isPositiveChangeFromInitial = isAdditive ? changeFromInitial > 0 : changeFromInitial < 0;

                      if (changeFromResolved !== 0) {
                        return (
                          <>
                            <Text
                              as="span"
                              fontWeight="semibold"
                              color={isPositiveChangeFromResolved ? "green.600" : "red.600"}
                            >
                              {" "}
                              ({changeFromResolved > 0 ? "+" : ""}
                              {changeFromResolved} from grader
                            </Text>
                            <Text
                              as="span"
                              fontWeight="semibold"
                              color={isPositiveChangeFromInitial ? "green.600" : "red.600"}
                            >
                              , {changeFromInitial > 0 ? "+" : ""}
                              {changeFromInitial} overall)
                            </Text>
                          </>
                        );
                      } else if (changeFromInitial !== 0) {
                        return (
                          <Text
                            as="span"
                            fontWeight="semibold"
                            color={isPositiveChangeFromInitial ? "green.600" : "red.600"}
                          >
                            {" "}
                            ({changeFromInitial > 0 ? "+" : ""}
                            {changeFromInitial} overall)
                          </Text>
                        );
                      }
                      return null;
                    })()}
                  </Text>
                )}
              </VStack>
              {/* Resolve Button for opened status + grader/instructor */}
              {regradeRequest.status === "opened" && isGraderOrInstructor && (
                <ResolveRequestPopover
                  initialPoints={regradeRequest.initial_points}
                  regradeRequestId={regradeRequest.id}
                  privateProfileId={private_profile_id}
                  rubricCriteria={rubricCriteria}
                  rubricCheck={rubricCheck}
                />
              )}

              {/* Escalate Button for resolved status + student */}
              {regradeRequest.status === "resolved" && !isGraderOrInstructor && (
                <EscalateRequestDialog
                  isOpen={isEscalateDialogOpen}
                  onOpenChange={setIsEscalateDialogOpen}
                  onEscalate={handleEscalateRequest}
                  isUpdating={isUpdatingStatus}
                />
              )}

              {/* Close Button for escalated status + instructor */}
              {regradeRequest.status === "escalated" && isInstructor && (
                <CloseRequestPopover
                  initialPoints={regradeRequest.initial_points}
                  resolvedPoints={regradeRequest.resolved_points}
                  regradeRequestId={regradeRequest.id}
                  privateProfileId={private_profile_id}
                  rubricCriteria={rubricCriteria}
                  rubricCheck={rubricCheck}
                />
              )}
            </HStack>
          </Box>
          {/* Content with subtle padding to account for border */}
          <Box pl={2} pr={2} py={1}>
            {children}
          </Box>
          <RegradeRequestComments regradeRequestId={regradeRequest.id} />

          {/* Regrade Comment Form */}
          {showCommentForm && (
            <Box mx={2} mb={2} position="relative">
              <VStack p={2} gap={0} align="start">
                {isSubmittingComment && (
                  <Box bg="bg.info" p={2} borderRadius="md" w="100%">
                    <Text fontSize="sm" color="fg.muted">
                      ⏳ Submitting your comment...
                    </Text>
                  </Box>
                )}

                <Box w="100%">
                  <MessageInput
                    textAreaRef={commentInputRef}
                    placeholder={
                      regradeRequest.status === "draft"
                        ? "Add a comment to open this regrade request"
                        : "Add a comment to continue the discussion about this regrade request"
                    }
                    allowEmptyMessage={false}
                    defaultSingleLine={true}
                    sendButtonText={regradeRequest.status === "draft" ? "Open Request" : "Add Comment"}
                    sendMessage={async (message) => {
                      await handleSubmitComment(message);
                    }}
                  />
                </Box>

                <Text fontSize="xs" color="fg.muted">
                  This comment will be visible to{" "}
                  {isGroupAssignment
                    ? "your groupmates and the entire course staff."
                    : "the entire course staff and the author of the submission."}
                </Text>
              </VStack>
            </Box>
          )}
        </Box>
      </Box>
    </>
  );
}

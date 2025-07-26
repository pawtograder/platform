import { Box, Icon, VStack, Text, HStack, Tag, Heading, Button, Input } from "@chakra-ui/react";
import { useRegradeRequest } from "@/hooks/useAssignment";
import { Clock, CheckCircle, ArrowUp, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useCreate, useInvalidate, useUpdate } from "@refinedev/core";
import {
  useClassProfiles,
  useIsGraderOrInstructor,
  useIsInstructor,
  useRoleByPrivateProfileId
} from "@/hooks/useClassProfiles";
import MessageInput from "./message-input";
import { toaster } from "./toaster";
import { useSubmission, useSubmissionRegradeRequestComments } from "@/hooks/useSubmission";
import type { RegradeRequestComment as RegradeRequestCommentType, RegradeStatus } from "@/utils/supabase/DatabaseTypes";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { format, formatRelative } from "date-fns";
import Markdown from "./markdown";
import PersonAvatar from "./person-avatar";
import { Skeleton } from "./skeleton";
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
    label: "Appealed",
    description: "Student appealed to instructor for final review"
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
  const authorRole = useRoleByPrivateProfileId(comment.author);
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
              <Text>commented on {format(comment.created_at, "MMM d, yyyy")}</Text>
            </HStack>
            <HStack>
              {authorRole?.role === "grader" || authorRole?.role === "instructor" || authorProfile?.flair ? (
                <Tag.Root
                  size="md"
                  colorPalette={
                    authorRole?.role === "grader" || authorRole?.role === "instructor"
                      ? "blue"
                      : authorProfile?.flair_color
                  }
                  variant="surface"
                >
                  <Tag.Label>
                    {authorRole?.role === "grader"
                      ? "Grader"
                      : authorRole?.role === "instructor"
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
              <Markdown>{comment.comment}</Markdown>
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
  const [resolveScore, setResolveScore] = useState<number>();
  const [closeScore, setCloseScore] = useState<number>();
  const [isEscalateDialogOpen, setIsEscalateDialogOpen] = useState(false);
  const isGroupAssignment = useSubmission().assignment_group_id !== null;
  const { mutateAsync: updateRegradeStatus } = useCreate({
    resource: "rpc/update_regrade_request_status"
  });
  const { mutateAsync: createComment } = useCreate<RegradeRequestCommentType>({
    resource: "submission_regrade_request_comments"
  });
  const invalidate = useInvalidate();
  const assignee = useUserProfile(regradeRequest?.assignee);
  const resolver = useUserProfile(regradeRequest?.resolved_by);
  const escalator = useUserProfile(regradeRequest?.escalated_by);
  const closer = useUserProfile(regradeRequest?.closed_by);

  if (!regradeRequest) {
    return <>{children}</>;
  }

  const config = statusConfig[regradeRequest.status as RegradeStatus];
  const StatusIcon = config.icon;

  // Show comment form for active states (opened, escalated)
  const showCommentForm = regradeRequest.status !== "closed";

  const handleSubmitComment = async (commentText: string) => {
    if (!commentText.trim()) {
      toaster.create({
        title: "Empty comment",
        description: "Please enter a comment before submitting",
        type: "error"
      });
      return;
    }

    setIsSubmittingComment(true);
    try {
      if (regradeRequest.status === "draft") {
        await updateRegradeStatus({
          values: {
            new_status: "opened",
            profile_id: private_profile_id,
            regrade_request_id: regradeRequest.id
          }
        });
        await invalidate({
          resource: "submission_regrade_requests",
          id: regradeRequest.id,
          invalidates: ["all"]
        });
      }
      const values = {
        comment: commentText.trim(),
        submission_id: regradeRequest.submission_id,
        assignment_id: regradeRequest.assignment_id,
        submission_regrade_request_id: regradeRequest.id,
        class_id: regradeRequest.class_id,
        author: private_profile_id
      };
      await createComment({
        values: values
      });

      toaster.create({
        title: "Comment added",
        description: "Your comment has been added to the regrade request",
        type: "success"
      });
    } catch (error) {
      console.error("Error creating comment:", error);
      toaster.create({
        title: "Error",
        description: "Failed to add comment. Please try again.",
        type: "error"
      });
    } finally {
      setIsSubmittingComment(false);
    }
  };

  const handleResolveRequest = async () => {
    setIsUpdatingStatus(true);
    try {
      await updateRegradeStatus({
        values: {
          regrade_request_id: regradeRequest.id,
          new_status: "resolved",
          profile_id: private_profile_id,
          resolved_points: resolveScore
        }
      });
      await invalidate({
        resource: "submission_regrade_requests",
        id: regradeRequest.id,
        invalidates: ["all"]
      });
      toaster.create({
        title: "Request Resolved",
        description: "The regrade request has been resolved.",
        type: "success"
      });
    } catch (error) {
      console.error("Error resolving request:", error);
      toaster.create({
        title: "Error",
        description: "Failed to resolve request. Please try again.",
        type: "error"
      });
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const handleEscalateRequest = async () => {
    setIsUpdatingStatus(true);
    try {
      await updateRegradeStatus({
        values: {
          regrade_request_id: regradeRequest.id,
          new_status: "escalated",
          profile_id: private_profile_id
        }
      });
      await invalidate({
        resource: "submission_regrade_requests",
        id: regradeRequest.id,
        invalidates: ["all"]
      });
      setIsEscalateDialogOpen(false);
      toaster.create({
        title: "Request Escalated",
        description: "Your regrade request has been escalated to an instructor.",
        type: "success"
      });
    } catch (error) {
      console.error("Error escalating request:", error);
      toaster.create({
        title: "Error",
        description: "Failed to escalate request. Please try again.",
        type: "error"
      });
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const handleCloseRequest = async () => {
    setIsUpdatingStatus(true);
    try {
      await updateRegradeStatus({
        values: {
          regrade_request_id: regradeRequest.id,
          new_status: "closed",
          profile_id: private_profile_id,
          closed_points: closeScore
        }
      });
      await invalidate({
        resource: "submission_regrade_requests",
        id: regradeRequest.id,
        invalidates: ["all"]
      });
      toaster.create({
        title: "Request Closed",
        description: "The regrade request has been closed.",
        type: "success"
      });
    } catch (error) {
      console.error("Error closing request:", error);
      toaster.create({
        title: "Error",
        description: "Failed to close request. Please try again.",
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
                  <Text fontSize="xs" color="fg.muted">
                    Opened {formatRelative(regradeRequest.opened_at, new Date())}, initial score:{" "}
                    {regradeRequest.initial_points || 0}
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
                  <Text fontSize="xs" color="fg.muted">
                    Resolved {formatRelative(regradeRequest.resolved_at, new Date())} by {resolver?.name}, new score:{" "}
                    {regradeRequest.resolved_points || 0}
                  </Text>
                )}
                {regradeRequest.escalated_at && (
                  <Text fontSize="xs" color="fg.muted">
                    Appealed {formatRelative(regradeRequest.escalated_at, new Date())} by {escalator?.name}
                  </Text>
                )}
                {regradeRequest.closed_at && (
                  <Text fontSize="xs" color="fg.muted">
                    Closed {formatRelative(regradeRequest.closed_at, new Date())} by {closer?.name}, final score:{" "}
                    {regradeRequest.closed_points || 0}
                  </Text>
                )}
              </VStack>
              {/* Resolve Button for opened status + grader/instructor */}
              {regradeRequest.status === "opened" && isGraderOrInstructor && (
                <PopoverRoot>
                  <PopoverTrigger asChild>
                    <Button colorPalette="blue" size="sm" loading={isUpdatingStatus}>
                      Resolve Request
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent>
                    <PopoverArrow />
                    <PopoverBody>
                      <VStack gap={3} align="start">
                        <Text fontWeight="semibold">Resolve Regrade Request</Text>
                        <Text fontSize="sm">
                          The initial score for this regrade request is {regradeRequest.initial_points || 0}.
                        </Text>
                        <Text fontSize="sm">
                          Enter the final score for this comment after reviewing the regrade request. It will overwrite
                          the score for the comment.
                        </Text>
                        <VStack gap={2} align="start" w="100%">
                          <Text fontSize="sm" fontWeight="medium">
                            Final Points:
                          </Text>
                          <Input
                            type="number"
                            value={resolveScore?.toString() ?? ""}
                            onChange={(e) => {
                              const inputValue = e.target.value;

                              // Allow clearing the field
                              if (inputValue === "" || inputValue === "-") {
                                setResolveScore(undefined);
                                return;
                              }

                              // Parse as float to handle decimal input, then convert to int
                              const value = parseFloat(inputValue);
                              if (!isNaN(value)) {
                                setResolveScore(Math.round(value));
                              }
                            }}
                            placeholder="Enter points..."
                            size="sm"
                            w="100px"
                          />
                        </VStack>
                        <Button
                          colorPalette="blue"
                          size="sm"
                          onClick={handleResolveRequest}
                          loading={isUpdatingStatus}
                          w="100%"
                        >
                          Resolve
                        </Button>
                      </VStack>
                    </PopoverBody>
                  </PopoverContent>
                </PopoverRoot>
              )}

              {/* Escalate Button for resolved status + student */}
              {regradeRequest.status === "resolved" && !isGraderOrInstructor && (
                <DialogRoot open={isEscalateDialogOpen} onOpenChange={(e) => setIsEscalateDialogOpen(e.open)}>
                  <DialogTrigger asChild>
                    <Button colorPalette="orange" size="sm" loading={isUpdatingStatus}>
                      Appeal to Instructor
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Escalate Regrade Request</DialogTitle>
                    </DialogHeader>
                    <DialogBody>
                      <VStack gap={4} align="start">
                        <Text>You can appeal this regrade request to an instructor for final review.</Text>
                        <Box bg="bg.info" p={3} borderRadius="md" w="100%">
                          <Text fontWeight="semibold" mb={2}>
                            ⚠️ Important Guidelines
                          </Text>
                          <VStack gap={1} align="start">
                            <Text fontSize="sm">
                              • Only appeal if you believe the rubric is not being fairly applied
                            </Text>
                            <Text fontSize="sm">• Don&apos;t appeal simply because you disagree with the grade</Text>
                            <Text fontSize="sm">• The instructor&apos;s decision will be final</Text>
                            <Text fontSize="sm">• Frivolous appeals may affect future regrade requests</Text>
                          </VStack>
                        </Box>
                      </VStack>
                    </DialogBody>
                    <DialogFooter>
                      <DialogActionTrigger asChild>
                        <Button variant="outline">Cancel</Button>
                      </DialogActionTrigger>
                      <Button colorPalette="orange" onClick={handleEscalateRequest} loading={isUpdatingStatus}>
                        Escalate Request
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </DialogRoot>
              )}

              {/* Close Button for escalated status + instructor */}
              {regradeRequest.status === "escalated" && isInstructor && (
                <PopoverRoot>
                  <PopoverTrigger asChild>
                    <Button colorPalette="orange" variant="solid" size="sm" loading={isUpdatingStatus}>
                      Decide Appeal
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent>
                    <PopoverArrow />
                    <PopoverBody>
                      <VStack gap={3} align="start">
                        <Text fontWeight="semibold">Decide Appeal</Text>
                        <Text fontSize="sm">Enter the final decision for this appealed regrade request.</Text>
                        <Text fontSize="sm">Initial score: {regradeRequest.initial_points}.</Text>
                        <Text fontSize="sm">Revised score: {regradeRequest.resolved_points}.</Text>
                        <VStack gap={2} align="start" w="100%">
                          <Text fontSize="sm" fontWeight="medium">
                            Final Points:
                          </Text>
                          <Input
                            type="number"
                            value={closeScore?.toString() ?? ""}
                            onChange={(e) => {
                              const inputValue = e.target.value;

                              // Allow clearing the field
                              if (inputValue === "" || inputValue === "-") {
                                setCloseScore(undefined);
                                return;
                              }

                              // Parse as float to handle decimal input, then convert to int
                              const value = parseFloat(inputValue);
                              if (!isNaN(value)) {
                                setCloseScore(Math.round(value));
                              }
                            }}
                            placeholder="Enter points..."
                            size="sm"
                            w="100px"
                          />
                        </VStack>
                        <Button
                          colorPalette="green"
                          variant="surface"
                          size="sm"
                          onClick={handleCloseRequest}
                          loading={isUpdatingStatus}
                          w="100%"
                        >
                          Decide Appeal
                        </Button>
                      </VStack>
                    </PopoverBody>
                  </PopoverContent>
                </PopoverRoot>
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

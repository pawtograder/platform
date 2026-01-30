"use client";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { toaster } from "@/components/ui/toaster";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { Box, HStack, Icon, IconButton, Input, Text, Textarea, VStack } from "@chakra-ui/react";
import { useCallback, useMemo, useState } from "react";
import { BsRobot, BsCopy, BsX } from "react-icons/bs";
import { LuThumbsUp, LuThumbsDown } from "react-icons/lu";

/**
 * Props for the AIHelpButton component
 */
interface AIHelpButtonProps {
  /** Type of context to provide */
  contextType: "help_request" | "discussion_thread";
  /** ID of the help request or discussion thread */
  resourceId: number;
  /** Class ID for authorization */
  classId: number;
  /** Optional assignment ID for additional context */
  assignmentId?: number;
  /** Optional submission ID for additional context */
  submissionId?: number;
  /** Button size variant */
  size?: "xs" | "sm" | "md";
  /** Button style variant */
  variant?: "solid" | "outline" | "ghost";
}

/**
 * Generates MCP context data for AI assistants
 */
function generateMCPContext(props: AIHelpButtonProps): object {
  const baseContext = {
    mcp_server: "pawtograder",
    version: "0.1.0",
    context_type: props.contextType,
    resource_id: props.resourceId,
    class_id: props.classId
  };

  if (props.contextType === "help_request") {
    return {
      ...baseContext,
      tool: "get_help_request",
      params: {
        help_request_id: props.resourceId,
        class_id: props.classId
      },
      // Include additional fetch suggestions
      suggested_tools: [
        ...(props.submissionId
          ? [
              {
                tool: "get_submission",
                params: {
                  submission_id: props.submissionId,
                  class_id: props.classId,
                  include_test_output: true
                }
              }
            ]
          : []),
        ...(props.assignmentId
          ? [
              {
                tool: "get_assignment",
                params: {
                  assignment_id: props.assignmentId,
                  class_id: props.classId
                }
              }
            ]
          : [])
      ]
    };
  }

  // Discussion thread context
  return {
    ...baseContext,
    tool: "get_discussion_thread",
    params: {
      thread_id: props.resourceId,
      class_id: props.classId,
      include_replies: true
    },
    suggested_tools: [
      ...(props.assignmentId
        ? [
            {
              tool: "get_assignment",
              params: {
                assignment_id: props.assignmentId,
                class_id: props.classId
              }
            }
          ]
        : []),
      {
        tool: "search_discussion_threads",
        params: {
          class_id: props.classId,
          ...(props.assignmentId ? { assignment_id: props.assignmentId } : {}),
          is_question: true,
          limit: 10
        },
        description: "Find related discussion threads"
      }
    ]
  };
}

/**
 * Generates a formatted prompt for AI assistants with the MCP context
 */
function generateAIPrompt(props: AIHelpButtonProps): string {
  const context = generateMCPContext(props);

  const systemPrompt = `You are helping a TA support a student who is struggling with their programming assignment.

Use the following MCP context to fetch the relevant data:

\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`

First, use the ${props.contextType === "help_request" ? "get_help_request" : "get_discussion_thread"} tool to understand the student's question and situation.

If the context includes a submission, also use get_submission to understand what errors they're encountering.

If an assignment is linked, use get_assignment to get the handout URL and assignment details.

Provide helpful guidance that:
1. Addresses the specific issue the student is facing
2. Explains concepts without giving away the full solution
3. Suggests debugging strategies
4. Points to relevant documentation or resources from the handout`;

  return systemPrompt;
}

/**
 * Submit feedback to the API
 */
async function submitFeedback(
  classId: number,
  contextType: "help_request" | "discussion_thread",
  resourceId: number,
  rating: "thumbs_up" | "thumbs_down",
  comment?: string
): Promise<boolean> {
  try {
    const response = await fetch("/api/ai-help-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        class_id: classId,
        context_type: contextType,
        resource_id: resourceId,
        rating,
        comment: comment || undefined
      })
    });

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Feedback component shown after copying AI context
 */
function FeedbackPanel({
  classId,
  contextType,
  resourceId,
  onClose
}: {
  classId: number;
  contextType: "help_request" | "discussion_thread";
  resourceId: number;
  onClose: () => void;
}) {
  const [rating, setRating] = useState<"thumbs_up" | "thumbs_down" | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (!rating) return;

    setSubmitting(true);
    const success = await submitFeedback(classId, contextType, resourceId, rating, comment);
    setSubmitting(false);

    if (success) {
      setSubmitted(true);
      toaster.success({
        title: "Thanks for your feedback!",
        description: "Your feedback helps us improve the AI assistance feature."
      });
    } else {
      toaster.error({
        title: "Failed to submit feedback",
        description: "Please try again later."
      });
    }
  };

  if (submitted) {
    return (
      <Box p={3} borderWidth="1px" borderRadius="md" bg="green.subtle" maxW="400px">
        <HStack justify="space-between">
          <Text fontSize="sm" fontWeight="medium" color="green.fg">
            Thank you for your feedback!
          </Text>
          <IconButton aria-label="Close" size="xs" variant="ghost" onClick={onClose}>
            <Icon as={BsX} />
          </IconButton>
        </HStack>
      </Box>
    );
  }

  return (
    <Box p={3} borderWidth="1px" borderRadius="md" bg="bg.subtle" maxW="400px">
      <HStack justify="space-between" mb={2}>
        <Text fontSize="sm" fontWeight="medium">
          How was the AI assistance?
        </Text>
        <IconButton aria-label="Close" size="xs" variant="ghost" onClick={onClose}>
          <Icon as={BsX} />
        </IconButton>
      </HStack>

      <VStack gap={3} align="stretch">
        <HStack gap={2} justify="center">
          <IconButton
            aria-label="Thumbs up"
            size="lg"
            variant={rating === "thumbs_up" ? "solid" : "outline"}
            colorPalette={rating === "thumbs_up" ? "green" : "gray"}
            onClick={() => setRating("thumbs_up")}
          >
            <Icon as={LuThumbsUp} boxSize={5} />
          </IconButton>
          <IconButton
            aria-label="Thumbs down"
            size="lg"
            variant={rating === "thumbs_down" ? "solid" : "outline"}
            colorPalette={rating === "thumbs_down" ? "red" : "gray"}
            onClick={() => setRating("thumbs_down")}
          >
            <Icon as={LuThumbsDown} boxSize={5} />
          </IconButton>
        </HStack>

        <Textarea
          placeholder="Any additional feedback? (optional)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          fontSize="sm"
          rows={2}
          maxLength={2000}
        />

        <HStack gap={2}>
          <Button size="sm" variant="ghost" onClick={onClose} flex={1}>
            Skip
          </Button>
          <Button
            size="sm"
            colorPalette="purple"
            onClick={handleSubmit}
            disabled={!rating || submitting}
            loading={submitting}
            flex={1}
          >
            Submit
          </Button>
        </HStack>
      </VStack>
    </Box>
  );
}

/**
 * AIHelpButton component for launching AI assistance context
 *
 * This component provides a button that instructors and graders can use
 * to get AI assistance when helping students. It generates MCP context
 * that can be used with any MCP-compatible AI assistant.
 */
export function AIHelpButton({
  contextType,
  resourceId,
  classId,
  assignmentId,
  submissionId,
  size = "sm",
  variant = "outline"
}: AIHelpButtonProps) {
  const isInstructorOrGrader = useIsGraderOrInstructor();
  const [showContext, setShowContext] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);

  const prompt = useMemo(
    () =>
      generateAIPrompt({
        contextType,
        resourceId,
        classId,
        assignmentId,
        submissionId
      }),
    [contextType, resourceId, classId, assignmentId, submissionId]
  );

  const handleCopyContext = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      toaster.success({
        title: "Copied AI context",
        description: "The AI help prompt has been copied to your clipboard."
      });
      // Show feedback panel after copying
      setShowContext(false);
      setShowFeedback(true);
    } catch {
      toaster.error({
        title: "Failed to copy",
        description: "Could not copy to clipboard. Please try again."
      });
    }
  }, [prompt]);

  const handleClose = useCallback(() => {
    setShowContext(false);
    setShowFeedback(false);
  }, []);

  // Only show for instructors/graders
  if (!isInstructorOrGrader) {
    return null;
  }

  if (showFeedback) {
    return <FeedbackPanel classId={classId} contextType={contextType} resourceId={resourceId} onClose={handleClose} />;
  }

  if (showContext) {
    return (
      <Box p={3} borderWidth="1px" borderRadius="md" bg="bg.subtle" maxW="400px">
        <HStack justify="space-between" mb={2}>
          <HStack gap={1}>
            <Icon as={BsRobot} color="purple.500" />
            <Text fontSize="sm" fontWeight="medium">
              AI Help Context
            </Text>
          </HStack>
          <IconButton aria-label="Close" size="xs" variant="ghost" onClick={handleClose}>
            <Icon as={BsX} />
          </IconButton>
        </HStack>
        <Text fontSize="xs" color="fg.muted" mb={2}>
          Copy this prompt to use with Claude, ChatGPT, or any MCP-compatible AI assistant:
        </Text>
        <HStack gap={2}>
          <Input
            readOnly
            value={`AI Help: ${contextType === "help_request" ? "Help Request" : "Discussion"} #${resourceId}`}
            fontSize="xs"
            flex={1}
          />
          <IconButton aria-label="Copy" size="sm" variant="outline" onClick={handleCopyContext}>
            <Icon as={BsCopy} />
          </IconButton>
        </HStack>
        <Button size="xs" variant="solid" colorPalette="purple" mt={2} w="full" onClick={handleCopyContext}>
          <Icon as={BsCopy} mr={1} />
          Copy Full Prompt
        </Button>
      </Box>
    );
  }

  return (
    <Tooltip content="Get AI assistance for helping this student" showArrow>
      <Button size={size} variant={variant} colorPalette="purple" onClick={() => setShowContext(true)}>
        <Icon as={BsRobot} />
        AI Help
      </Button>
    </Tooltip>
  );
}

/**
 * Compact icon-only version of the AI Help button
 */
export function AIHelpIconButton({
  contextType,
  resourceId,
  classId,
  assignmentId,
  submissionId
}: Omit<AIHelpButtonProps, "size" | "variant">) {
  const isInstructorOrGrader = useIsGraderOrInstructor();
  const [showFeedback, setShowFeedback] = useState(false);

  const prompt = useMemo(
    () =>
      generateAIPrompt({
        contextType,
        resourceId,
        classId,
        assignmentId,
        submissionId
      }),
    [contextType, resourceId, classId, assignmentId, submissionId]
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      toaster.success({
        title: "Copied AI context",
        description: "Paste this prompt into your AI assistant to get help."
      });
      // Show feedback after copying
      setShowFeedback(true);
    } catch {
      toaster.error({
        title: "Failed to copy",
        description: "Could not copy to clipboard."
      });
    }
  }, [prompt]);

  // Only show for instructors/graders
  if (!isInstructorOrGrader) {
    return null;
  }

  if (showFeedback) {
    return (
      <FeedbackPanel
        classId={classId}
        contextType={contextType}
        resourceId={resourceId}
        onClose={() => setShowFeedback(false)}
      />
    );
  }

  return (
    <Tooltip content="Copy AI help context" showArrow>
      <IconButton aria-label="Get AI help" size="xs" variant="ghost" colorPalette="purple" onClick={handleCopy}>
        <Icon as={BsRobot} boxSize={3} />
      </IconButton>
    </Tooltip>
  );
}

export default AIHelpButton;

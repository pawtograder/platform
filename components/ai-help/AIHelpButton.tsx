"use client";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { toaster } from "@/components/ui/toaster";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import {
  Box,
  HStack,
  Icon,
  IconButton,
  Text,
  ClipboardRoot,
  ClipboardIconButton,
  ClipboardInput,
} from "@chakra-ui/react";
import { useCallback, useMemo, useState } from "react";
import { BsRobot, BsCopy, BsX } from "react-icons/bs";

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
    class_id: props.classId,
  };

  if (props.contextType === "help_request") {
    return {
      ...baseContext,
      tool: "get_help_request",
      params: {
        help_request_id: props.resourceId,
        class_id: props.classId,
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
                  include_test_output: true,
                },
              },
            ]
          : []),
        ...(props.assignmentId
          ? [
              {
                tool: "get_assignment",
                params: {
                  assignment_id: props.assignmentId,
                  class_id: props.classId,
                },
              },
            ]
          : []),
      ],
    };
  }

  // Discussion thread context
  return {
    ...baseContext,
    tool: "get_discussion_thread",
    params: {
      thread_id: props.resourceId,
      class_id: props.classId,
      include_replies: true,
    },
    suggested_tools: [
      ...(props.assignmentId
        ? [
            {
              tool: "get_assignment",
              params: {
                assignment_id: props.assignmentId,
                class_id: props.classId,
              },
            },
          ]
        : []),
      {
        tool: "search_discussion_threads",
        params: {
          class_id: props.classId,
          ...(props.assignmentId ? { assignment_id: props.assignmentId } : {}),
          is_question: true,
          limit: 10,
        },
        description: "Find related discussion threads",
      },
    ],
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
  variant = "outline",
}: AIHelpButtonProps) {
  const isInstructorOrGrader = useIsGraderOrInstructor();
  const [showContext, setShowContext] = useState(false);

  // Only show for instructors/graders
  if (!isInstructorOrGrader) {
    return null;
  }

  const prompt = useMemo(
    () =>
      generateAIPrompt({
        contextType,
        resourceId,
        classId,
        assignmentId,
        submissionId,
      }),
    [contextType, resourceId, classId, assignmentId, submissionId]
  );

  const handleCopyContext = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      toaster.success({
        title: "Copied AI context",
        description: "The AI help prompt has been copied to your clipboard.",
      });
    } catch {
      toaster.error({
        title: "Failed to copy",
        description: "Could not copy to clipboard. Please try again.",
      });
    }
  }, [prompt]);

  if (showContext) {
    return (
      <Box
        p={3}
        borderWidth="1px"
        borderRadius="md"
        bg="bg.subtle"
        maxW="400px"
      >
        <HStack justify="space-between" mb={2}>
          <HStack gap={1}>
            <Icon as={BsRobot} color="purple.500" />
            <Text fontSize="sm" fontWeight="medium">
              AI Help Context
            </Text>
          </HStack>
          <IconButton
            aria-label="Close"
            size="xs"
            variant="ghost"
            onClick={() => setShowContext(false)}
          >
            <Icon as={BsX} />
          </IconButton>
        </HStack>
        <Text fontSize="xs" color="fg.muted" mb={2}>
          Copy this prompt to use with Claude, ChatGPT, or any MCP-compatible AI assistant:
        </Text>
        <ClipboardRoot value={prompt}>
          <HStack gap={2}>
            <ClipboardInput
              readOnly
              value={`AI Help: ${contextType === "help_request" ? "Help Request" : "Discussion"} #${resourceId}`}
              fontSize="xs"
              flex={1}
            />
            <ClipboardIconButton size="sm" onClick={handleCopyContext} />
          </HStack>
        </ClipboardRoot>
        <Button
          size="xs"
          variant="solid"
          colorPalette="purple"
          mt={2}
          w="full"
          onClick={handleCopyContext}
        >
          <Icon as={BsCopy} mr={1} />
          Copy Full Prompt
        </Button>
      </Box>
    );
  }

  return (
    <Tooltip content="Get AI assistance for helping this student" showArrow>
      <Button
        size={size}
        variant={variant}
        colorPalette="purple"
        onClick={() => setShowContext(true)}
      >
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
  submissionId,
}: Omit<AIHelpButtonProps, "size" | "variant">) {
  const isInstructorOrGrader = useIsGraderOrInstructor();

  // Only show for instructors/graders
  if (!isInstructorOrGrader) {
    return null;
  }

  const prompt = useMemo(
    () =>
      generateAIPrompt({
        contextType,
        resourceId,
        classId,
        assignmentId,
        submissionId,
      }),
    [contextType, resourceId, classId, assignmentId, submissionId]
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      toaster.success({
        title: "Copied AI context",
        description: "Paste this prompt into your AI assistant to get help.",
      });
    } catch {
      toaster.error({
        title: "Failed to copy",
        description: "Could not copy to clipboard.",
      });
    }
  }, [prompt]);

  return (
    <Tooltip content="Copy AI help context" showArrow>
      <IconButton
        aria-label="Get AI help"
        size="xs"
        variant="ghost"
        colorPalette="purple"
        onClick={handleCopy}
      >
        <Icon as={BsRobot} boxSize={3} />
      </IconButton>
    </Tooltip>
  );
}

export default AIHelpButton;

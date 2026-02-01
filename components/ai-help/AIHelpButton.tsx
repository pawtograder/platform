"use client";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { toaster } from "@/components/ui/toaster";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { mcpTokensList } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Box, Dialog, HStack, Icon, IconButton, Input, Link, List, Portal, Text, VStack } from "@chakra-ui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BsRobot, BsCopy, BsX } from "react-icons/bs";
import { LuExternalLink, LuKey, LuDownload, LuSettings } from "react-icons/lu";
import { AIHelpFeedbackPanel } from "./AIHelpFeedbackPanel";

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
 * Setup dialog shown when user has no MCP tokens configured
 */
function MCPSetupDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const mcpServerUrl =
    typeof window !== "undefined" ? `${window.location.origin}/functions/v1/mcp-server` : "/functions/v1/mcp-server";

  return (
    <Dialog.Root open={isOpen} onOpenChange={(e) => !e.open && onClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="600px" maxH="80vh" overflowY="auto">
            <Dialog.Header>
              <Dialog.Title>
                <HStack gap={2}>
                  <Icon as={BsRobot} color="purple.500" />
                  <Text>Set Up AI Help with Claude Desktop</Text>
                </HStack>
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack gap={5} align="stretch">
                <Text color="fg.muted">
                  AI Help uses Claude Desktop with the Pawtograder MCP server to provide intelligent assistance. Follow
                  these steps to get started:
                </Text>

                {/* Step 1 */}
                <Box>
                  <HStack gap={2} mb={2}>
                    <Box
                      bg="purple.500"
                      color="white"
                      borderRadius="full"
                      w={6}
                      h={6}
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      fontSize="sm"
                      fontWeight="bold"
                    >
                      1
                    </Box>
                    <Text fontWeight="semibold">Install Claude Desktop</Text>
                  </HStack>
                  <Box pl={8}>
                    <Text fontSize="sm" color="fg.muted" mb={2}>
                      Download and install Claude Desktop from Anthropic:
                    </Text>
                    <Link
                      href="https://claude.ai/download"
                      target="_blank"
                      rel="noopener noreferrer"
                      color="purple.500"
                      fontSize="sm"
                    >
                      <HStack gap={1}>
                        <Icon as={LuDownload} />
                        <Text>claude.ai/download</Text>
                        <Icon as={LuExternalLink} boxSize={3} />
                      </HStack>
                    </Link>
                  </Box>
                </Box>

                {/* Step 2 */}
                <Box>
                  <HStack gap={2} mb={2}>
                    <Box
                      bg="purple.500"
                      color="white"
                      borderRadius="full"
                      w={6}
                      h={6}
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      fontSize="sm"
                      fontWeight="bold"
                    >
                      2
                    </Box>
                    <Text fontWeight="semibold">Install the MCP Proxy</Text>
                  </HStack>
                  <Box pl={8}>
                    <Text fontSize="sm" color="fg.muted" mb={2}>
                      Claude Desktop currently only supports stdio-based MCP servers. Install the proxy to connect to
                      Pawtograder:
                    </Text>
                    <Box bg="bg.emphasized" p={3} borderRadius="md" fontFamily="mono" fontSize="xs">
                      npx @anthropic-ai/mcp-proxy@latest
                    </Box>
                  </Box>
                </Box>

                {/* Step 3 */}
                <Box>
                  <HStack gap={2} mb={2}>
                    <Box
                      bg="purple.500"
                      color="white"
                      borderRadius="full"
                      w={6}
                      h={6}
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      fontSize="sm"
                      fontWeight="bold"
                    >
                      3
                    </Box>
                    <Text fontWeight="semibold">Create an API Token</Text>
                  </HStack>
                  <Box pl={8}>
                    <Text fontSize="sm" color="fg.muted" mb={2}>
                      Go to Settings → API Tokens in Pawtograder and create a new token. Copy the token - you will need
                      it for the next step.
                    </Text>
                    <HStack gap={2}>
                      <Icon as={LuKey} color="fg.muted" />
                      <Text fontSize="sm" color="fg.muted">
                        Settings → API Tokens → Create New Token
                      </Text>
                    </HStack>
                  </Box>
                </Box>

                {/* Step 4 */}
                <Box>
                  <HStack gap={2} mb={2}>
                    <Box
                      bg="purple.500"
                      color="white"
                      borderRadius="full"
                      w={6}
                      h={6}
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      fontSize="sm"
                      fontWeight="bold"
                    >
                      4
                    </Box>
                    <Text fontWeight="semibold">Configure Claude Desktop</Text>
                  </HStack>
                  <Box pl={8}>
                    <Text fontSize="sm" color="fg.muted" mb={2}>
                      Open Claude Desktop settings and add this MCP server configuration:
                    </Text>
                    <List.Root fontSize="sm" color="fg.muted" mb={2} gap={1}>
                      <List.Item>
                        <strong>macOS:</strong> ~/Library/Application Support/Claude/claude_desktop_config.json
                      </List.Item>
                      <List.Item>
                        <strong>Windows:</strong> %APPDATA%\Claude\claude_desktop_config.json
                      </List.Item>
                    </List.Root>
                    <Box bg="bg.emphasized" p={3} borderRadius="md" fontFamily="mono" fontSize="xs" overflowX="auto">
                      <pre style={{ margin: 0 }}>
                        {JSON.stringify(
                          {
                            mcpServers: {
                              pawtograder: {
                                command: "npx",
                                args: ["-y", "@anthropic-ai/mcp-proxy@latest", mcpServerUrl],
                                env: {
                                  MCP_HEADERS: JSON.stringify({
                                    Authorization: "Bearer YOUR_TOKEN_HERE"
                                  })
                                }
                              }
                            }
                          },
                          null,
                          2
                        )}
                      </pre>
                    </Box>
                    <Text fontSize="xs" color="fg.muted" mt={2}>
                      Replace YOUR_TOKEN_HERE with the token you created in step 3.
                    </Text>
                  </Box>
                </Box>

                {/* Step 5 */}
                <Box>
                  <HStack gap={2} mb={2}>
                    <Box
                      bg="purple.500"
                      color="white"
                      borderRadius="full"
                      w={6}
                      h={6}
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      fontSize="sm"
                      fontWeight="bold"
                    >
                      5
                    </Box>
                    <Text fontWeight="semibold">Restart Claude Desktop</Text>
                  </HStack>
                  <Box pl={8}>
                    <Text fontSize="sm" color="fg.muted">
                      Quit and reopen Claude Desktop. You should see &quot;pawtograder&quot; listed as an available MCP
                      server in the tools menu.
                    </Text>
                  </Box>
                </Box>

                <Box bg="blue.subtle" p={3} borderRadius="md">
                  <HStack gap={2}>
                    <Icon as={LuSettings} color="blue.500" />
                    <Text fontSize="sm" color="blue.fg">
                      Once configured, click the AI Help button again to copy context that Claude can use with the
                      Pawtograder tools.
                    </Text>
                  </HStack>
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
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
  const [showSetupDialog, setShowSetupDialog] = useState(false);
  const [hasTokens, setHasTokens] = useState<boolean | null>(null); // null = not checked yet

  // Check if user has any active MCP tokens
  useEffect(() => {
    if (!isInstructorOrGrader) return;

    async function checkTokens() {
      try {
        const supabase = createClient();
        const { tokens } = await mcpTokensList(supabase);
        // Check for at least one non-revoked, non-expired token
        const now = new Date();
        const hasActiveToken = tokens?.some((t) => !t.revoked_at && new Date(t.expires_at) > now);
        setHasTokens(hasActiveToken ?? false);
      } catch {
        // If we can't check, assume they might have tokens
        setHasTokens(true);
      }
    }

    checkTokens();
  }, [isInstructorOrGrader]);

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
    setShowSetupDialog(false);
  }, []);

  const handleButtonClick = useCallback(() => {
    if (hasTokens === false) {
      setShowSetupDialog(true);
    } else {
      setShowContext(true);
    }
  }, [hasTokens]);

  // Only show for instructors/graders
  if (!isInstructorOrGrader) {
    return null;
  }

  if (showSetupDialog) {
    return <MCPSetupDialog isOpen={showSetupDialog} onClose={handleClose} />;
  }

  if (showFeedback) {
    return (
      <AIHelpFeedbackPanel classId={classId} contextType={contextType} resourceId={resourceId} onClose={handleClose} />
    );
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
      <Button size={size} variant={variant} colorPalette="purple" onClick={handleButtonClick}>
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
  const [showSetupDialog, setShowSetupDialog] = useState(false);
  const [hasTokens, setHasTokens] = useState<boolean | null>(null);

  // Check if user has any active MCP tokens
  useEffect(() => {
    if (!isInstructorOrGrader) return;

    async function checkTokens() {
      try {
        const supabase = createClient();
        const { tokens } = await mcpTokensList(supabase);
        const now = new Date();
        const hasActiveToken = tokens?.some((t) => !t.revoked_at && new Date(t.expires_at) > now);
        setHasTokens(hasActiveToken ?? false);
      } catch {
        setHasTokens(true);
      }
    }

    checkTokens();
  }, [isInstructorOrGrader]);

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

  const handleClick = useCallback(async () => {
    // Show setup dialog if no tokens
    if (hasTokens === false) {
      setShowSetupDialog(true);
      return;
    }

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
  }, [prompt, hasTokens]);

  const handleClose = useCallback(() => {
    setShowFeedback(false);
    setShowSetupDialog(false);
  }, []);

  // Only show for instructors/graders
  if (!isInstructorOrGrader) {
    return null;
  }

  if (showSetupDialog) {
    return <MCPSetupDialog isOpen={showSetupDialog} onClose={handleClose} />;
  }

  if (showFeedback) {
    return (
      <AIHelpFeedbackPanel classId={classId} contextType={contextType} resourceId={resourceId} onClose={handleClose} />
    );
  }

  return (
    <Tooltip content="Copy AI help context" showArrow>
      <IconButton aria-label="Get AI help" size="xs" variant="ghost" colorPalette="purple" onClick={handleClick}>
        <Icon as={BsRobot} boxSize={3} />
      </IconButton>
    </Tooltip>
  );
}

export default AIHelpButton;

"use client";

import { useWorkspaceStatus } from "@/hooks/useWorkspaceStatus";
import { WORKSPACE_STEPS, WorkspaceClient, WorkspaceState, workspaceStepLabel } from "@/lib/workspaceStatus";
import { Alert, Box, Button, Heading, HStack, Icon, Skeleton, Spinner, Text, VStack } from "@chakra-ui/react";
import { LuCheck, LuCircle, LuCodeXml, LuRotateCcw, LuX } from "react-icons/lu";

type StepMark = "done" | "running" | "failed" | "pending";

function stepMark(state: WorkspaceState, index: number): StepMark {
  if (state.status === "ready") return "done";
  if (state.status === "not_started") return "pending";
  const current = WORKSPACE_STEPS.findIndex((s) => s.id === state.step);
  if (index < current) return "done";
  if (index > current) return "pending";
  return state.status === "failed" ? "failed" : "running";
}

function StepList({ state }: { state: WorkspaceState }) {
  return (
    <VStack as="ol" align="stretch" gap={1} listStyleType="none" m={0} p={0}>
      {WORKSPACE_STEPS.map((step, index) => {
        const mark = stepMark(state, index);
        return (
          <HStack as="li" key={step.id} gap={2} data-step={step.id} data-mark={mark}>
            {mark === "running" ? (
              <Spinner size="xs" />
            ) : (
              <Icon
                as={mark === "done" ? LuCheck : mark === "failed" ? LuX : LuCircle}
                aria-hidden
                color={mark === "done" ? "fg.success" : mark === "failed" ? "fg.error" : "fg.subtle"}
                boxSize={3.5}
              />
            )}
            <Text fontSize="sm" color={mark === "pending" ? "fg.muted" : undefined}>
              {step.label}
              <Text as="span" srOnly>
                {mark === "done"
                  ? " (done)"
                  : mark === "running"
                    ? " (in progress)"
                    : mark === "failed"
                      ? " (failed)"
                      : ""}
              </Text>
            </Text>
          </HStack>
        );
      })}
    </VStack>
  );
}

function statusText(state: WorkspaceState): string {
  switch (state.status) {
    case "not_started":
      return "Your workspace is not running.";
    case "starting":
      return `Starting your workspace: ${workspaceStepLabel(state.step)}…`;
    case "ready":
      return "Your workspace is ready.";
    case "failed":
      return `Workspace not ready: ${workspaceStepLabel(state.step)} failed.`;
  }
}

/**
 * The student's Coder workspace for one assignment: open it, watch it start step by step, and only
 * get the editor link once every step has passed.
 */
export function WorkspaceStatus({ assignmentId, client }: { assignmentId: number; client: WorkspaceClient }) {
  const { state, error, open } = useWorkspaceStatus(client, assignmentId);

  return (
    <Box borderWidth={1} borderColor="bg.emphasized" borderRadius={4} p={4} bg="bg.subtle" maxW="4xl">
      <VStack align="stretch" gap={3}>
        <Heading size="md">Your workspace</Heading>
        {!state ? (
          <Skeleton height="80px" />
        ) : (
          <>
            <Text fontSize="sm" role="status" aria-live="polite" data-testid="workspace-status">
              {statusText(state)}
            </Text>
            {state.status !== "not_started" && <StepList state={state} />}
            {state.status === "failed" && (
              <Alert.Root status="error">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>{workspaceStepLabel(state.step)} failed</Alert.Title>
                  <Alert.Description>
                    {state.message} Try again, and if it keeps failing, ask your course staff for help.
                  </Alert.Description>
                </Alert.Content>
              </Alert.Root>
            )}
            <HStack>
              {state.status === "not_started" && (
                <Button size="sm" colorPalette="blue" onClick={open}>
                  <LuCodeXml />
                  Open workspace
                </Button>
              )}
              {state.status === "starting" && (
                <Button size="sm" colorPalette="blue" disabled>
                  <LuCodeXml />
                  Starting…
                </Button>
              )}
              {state.status === "ready" && (
                <Button size="sm" colorPalette="green" asChild>
                  <a href={state.url} target="_blank" rel="noopener noreferrer">
                    <LuCodeXml />
                    Open in VS Code
                  </a>
                </Button>
              )}
              {state.status === "failed" && (
                <Button size="sm" colorPalette="blue" variant="outline" onClick={open}>
                  <LuRotateCcw />
                  Retry
                </Button>
              )}
            </HStack>
          </>
        )}
        {error && (
          <Text fontSize="sm" color="fg.error" role="alert">
            Could not reach your workspace: {error}
          </Text>
        )}
      </VStack>
    </Box>
  );
}

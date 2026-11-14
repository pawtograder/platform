"use client";

import { useWorkspaceStatus } from "@/hooks/useWorkspaceStatus";
import { WORKSPACE_STEPS, WorkspaceClient, WorkspaceState, workspaceStepLabel } from "@/lib/workspaceStatus";
import { Alert, Box, Button, Heading, HStack, Icon, Skeleton, Spinner, Text, VStack } from "@chakra-ui/react";
import { useCallback, useEffect, useRef } from "react";
import { LuCheck, LuCircle, LuCodeXml, LuLink, LuRotateCcw, LuX } from "react-icons/lu";

type StepMark = "done" | "running" | "failed" | "pending";

type StepState = Extract<WorkspaceState, { status: "starting" | "ready" | "failed" }>;

function showsSteps(state: WorkspaceState): state is StepState {
  return state.status === "starting" || state.status === "ready" || state.status === "failed";
}

function stepMark(state: StepState, index: number): StepMark {
  if (state.status === "ready") return "done";
  const current = WORKSPACE_STEPS.findIndex((s) => s.id === state.step);
  if (index < current) return "done";
  if (index > current) return "pending";
  return state.status === "failed" ? "failed" : "running";
}

function StepList({ state }: { state: StepState }) {
  return (
    // role="list" keeps list semantics in Safari/VoiceOver, which drops them for `list-style: none`.
    <VStack as="ol" role="list" align="stretch" gap={1} listStyleType="none" m={0} p={0}>
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
      return state.restarting
        ? "Restarting your workspace…"
        : `Starting your workspace: ${workspaceStepLabel(state.step)}…`;
    case "ready":
      return "Your workspace is ready.";
    case "failed":
      return `Workspace not ready: ${workspaceStepLabel(state.step)} failed.`;
    case "needs_linking":
      return "Link your Forgejo account to open your workspace.";
    case "account_conflict":
      return "Your workspace can't be opened.";
  }
}

/**
 * The student's Coder workspace for one assignment: open it, watch it start step by step, and only
 * get the editor link once every step has passed.
 */
export function WorkspaceStatus({ assignmentId, client }: { assignmentId: number; client: WorkspaceClient }) {
  const { state, error, pending, open, reload } = useWorkspaceStatus(client, assignmentId);
  const cardRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Each state renders a different button, so the one the student pressed unmounts. Move focus to
  // the status line so the next Tab reaches the new button or link instead of the page header. The
  // ready link is never focused on its own, because that change comes from a poll, not the student.
  const restoreFocus = useRef(false);
  const runAndKeepFocus = useCallback((action: () => Promise<void>) => {
    restoreFocus.current = true;
    void action();
  }, []);
  useEffect(() => {
    if (pending || !restoreFocus.current) return;
    restoreFocus.current = false;
    const card = cardRef.current;
    if (card && !card.contains(document.activeElement)) {
      // Before the first status loads there is no status line, only the error.
      (statusRef.current ?? errorRef.current)?.focus();
    }
  }, [pending, state, error]);

  return (
    <Box ref={cardRef} borderWidth={1} borderColor="bg.emphasized" borderRadius={4} p={4} bg="bg.subtle" maxW="4xl">
      <VStack align="stretch" gap={3}>
        <Heading size="md">Your workspace</Heading>
        {!state ? (
          error ? (
            <HStack>
              <Button
                size="sm"
                colorPalette="blue"
                variant="outline"
                loading={pending}
                onClick={() => runAndKeepFocus(reload)}
              >
                <LuRotateCcw />
                Try again
              </Button>
            </HStack>
          ) : (
            <Skeleton height="80px" />
          )
        ) : (
          <>
            <Text
              ref={statusRef}
              tabIndex={-1}
              fontSize="sm"
              role="status"
              aria-live="polite"
              data-testid="workspace-status"
            >
              {statusText(state)}
              {"message" in state && (
                // The reason is in the Alert below, which is not a live region, so it is repeated
                // here for screen readers. Otherwise they hear what went wrong but not why.
                <Text as="span" srOnly>
                  {" "}
                  {state.message}
                </Text>
              )}
            </Text>
            {showsSteps(state) && <StepList state={state} />}
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
            {state.status === "needs_linking" && (
              <Alert.Root status="info">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>One-time step</Alert.Title>
                  <Alert.Description>
                    {state.message} Coder needs it to clone your repository and push your work.
                  </Alert.Description>
                </Alert.Content>
              </Alert.Root>
            )}
            {state.status === "account_conflict" && (
              <Alert.Root status="error">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>Ask your course staff</Alert.Title>
                  <Alert.Description>{state.message}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
            )}
            <HStack>
              {state.status === "not_started" && (
                <Button size="sm" colorPalette="blue" loading={pending} onClick={() => runAndKeepFocus(open)}>
                  <LuCodeXml />
                  Open in Coder
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
                    <Text as="span" srOnly>
                      {" "}
                      (opens in a new tab)
                    </Text>
                  </a>
                </Button>
              )}
              {state.status === "needs_linking" && (
                // A link the student clicks, not a window opened after an await, so no popup
                // blocker gets in the way. The card checks again when the student comes back to
                // this tab.
                <Button size="sm" colorPalette="blue" asChild>
                  <a href={state.url} target="_blank" rel="noopener noreferrer">
                    <LuLink />
                    Link Forgejo account
                    <Text as="span" srOnly>
                      {" "}
                      (opens in a new tab)
                    </Text>
                  </a>
                </Button>
              )}
              {state.status === "failed" && (
                <Button
                  size="sm"
                  colorPalette="blue"
                  variant="outline"
                  loading={pending}
                  onClick={() => runAndKeepFocus(open)}
                >
                  <LuRotateCcw />
                  Retry
                </Button>
              )}
            </HStack>
          </>
        )}
        {error && (
          <Text ref={errorRef} tabIndex={-1} fontSize="sm" color="fg.error" role="alert">
            Could not reach your workspace: {error}
          </Text>
        )}
      </VStack>
    </Box>
  );
}

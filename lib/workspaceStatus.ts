// Readiness of a student's Coder workspace (CW-22). A workspace only counts as ready once every
// startup step has passed, so a failed clone shows up here instead of as an empty editor.
//
// The UI talks to a WorkspaceClient. For now that is a simulated client; the real one will call a
// `workspace-open` edge function that reads the Coder agent's lifecycle state (`starting`, `ready`,
// `start_error`, `start_timeout`) and maps it onto these states.

export const WORKSPACE_STEPS = [
  { id: "git_setup", label: "Sign in to the course git server" },
  { id: "clone", label: "Clone your repository" },
  { id: "editor", label: "Start VS Code" }
] as const;

export type WorkspaceStepId = (typeof WORKSPACE_STEPS)[number]["id"];

export type WorkspaceState =
  | { status: "not_started" }
  | { status: "starting"; step: WorkspaceStepId }
  | { status: "ready"; url: string }
  | { status: "failed"; step: WorkspaceStepId; message: string };

export interface WorkspaceClient {
  getStatus(assignmentId: number): Promise<WorkspaceState>;
  open(assignmentId: number): Promise<WorkspaceState>;
}

export function workspaceStepLabel(step: WorkspaceStepId): string {
  return WORKSPACE_STEPS.find((s) => s.id === step)?.label ?? step;
}

const SIMULATED_FAILURE_MESSAGES: Record<WorkspaceStepId, string> = {
  git_setup: "The course git server did not accept the workspace's sign-in.",
  clone: "Your repository could not be cloned. It may not have been created yet.",
  editor: "VS Code did not start in the workspace."
};

/**
 * A stand-in for Coder: each step takes `stepMs`, and with `failAt` set the workspace stops at that
 * step. State is kept per assignment so polling sees progress, and `open` restarts it, which is
 * what Retry does.
 */
export function createSimulatedWorkspaceClient({
  failAt,
  stepMs = 1500,
  editorUrl = "about:blank"
}: { failAt?: WorkspaceStepId; stepMs?: number; editorUrl?: string } = {}): WorkspaceClient {
  const startedAt = new Map<number, number>();

  const stateAt = (assignmentId: number): WorkspaceState => {
    const start = startedAt.get(assignmentId);
    if (start === undefined) {
      return { status: "not_started" };
    }
    const stepIndex = Math.floor((Date.now() - start) / stepMs);
    const failIndex = failAt ? WORKSPACE_STEPS.findIndex((s) => s.id === failAt) : -1;
    if (failIndex !== -1 && stepIndex >= failIndex) {
      return { status: "failed", step: failAt!, message: SIMULATED_FAILURE_MESSAGES[failAt!] };
    }
    if (stepIndex >= WORKSPACE_STEPS.length) {
      return { status: "ready", url: editorUrl };
    }
    return { status: "starting", step: WORKSPACE_STEPS[stepIndex].id };
  };

  return {
    async getStatus(assignmentId) {
      return stateAt(assignmentId);
    },
    async open(assignmentId) {
      startedAt.set(assignmentId, Date.now());
      return stateAt(assignmentId);
    }
  };
}

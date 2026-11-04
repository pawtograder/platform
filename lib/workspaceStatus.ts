// Readiness of a student's Coder workspace (CW-22). A workspace only counts as ready once every
// startup step has passed, so a failed clone shows up here instead of as an empty editor.
//
// The UI talks to a WorkspaceClient. For now that is a simulated client; the real one will call a
// `workspace-open` edge function and map Coder's state onto these steps:
// - `build`: the workspace build, from creation until the agent connects (pod scheduling, image
//   pull). A build failure such as quota or an unschedulable pod fails here.
// - `git_setup` and `clone`: one `coder_script` each, so a failure names the script that broke.
//   The agent's `lifecycle_state` is one value for the whole agent and can't tell them apart.
// - `editor`: the code-server `coder_app` health check, not the agent reaching `ready`, which only
//   means the startup scripts finished.
// A stopped workspace (for example after the idle timeout) maps onto `not_started`.

export const WORKSPACE_STEPS = [
  { id: "build", label: "Prepare the workspace" },
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
  build: "The workspace could not be created. The course may have reached its workspace limit.",
  git_setup: "The course git server did not accept the workspace's sign-in.",
  clone: "Your repository could not be cloned. It may not have been created yet.",
  editor: "VS Code did not start in the workspace."
};

export const DEFAULT_SIMULATED_STEP_MS = 1500;

/**
 * A stand-in for Coder: each step takes `stepMs`, and with `failAt` set the workspace stops at that
 * step. State is kept per assignment so polling sees progress, and `open` restarts it, which is
 * what Retry does. A `stepMs` that is not a positive finite number falls back to the default.
 */
export function createSimulatedWorkspaceClient({
  failAt,
  stepMs,
  editorUrl = "about:blank"
}: { failAt?: WorkspaceStepId; stepMs?: number; editorUrl?: string } = {}): WorkspaceClient {
  const step = stepMs !== undefined && Number.isFinite(stepMs) && stepMs > 0 ? stepMs : DEFAULT_SIMULATED_STEP_MS;
  const startedAt = new Map<number, number>();

  const stateAt = (assignmentId: number): WorkspaceState => {
    const start = startedAt.get(assignmentId);
    if (start === undefined) {
      return { status: "not_started" };
    }
    // Clamped so a clock that moves backwards can't produce a negative index.
    const stepIndex = Math.max(0, Math.floor((Date.now() - start) / step));
    const failIndex = failAt ? WORKSPACE_STEPS.findIndex((s) => s.id === failAt) : -1;
    if (failAt && failIndex !== -1 && stepIndex >= failIndex) {
      return { status: "failed", step: failAt, message: SIMULATED_FAILURE_MESSAGES[failAt] };
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

// Readiness of a student's Coder workspace (CW-17 #1095, from CW-22). A workspace only counts as
// ready once every startup step has passed, so a failed clone shows up here instead of as an empty
// editor.
//
// The card talks to a WorkspaceClient. The real one calls `workspace-open` and `workspace-status`
// (#1222), which map Coder's state onto these steps:
// - `build`: the workspace build, from creation until the agent connects (pod scheduling, image
//   pull, quota). A lost or timed-out agent also fails here.
// - `clone`: the template's "Git Clone" script.
// - `editor`: the template's startup script (git identity and code-server) plus code-server's
//   health check.

import { workspaceOpen, workspaceStatus } from "@/lib/edgeFunctions";
import type { WorkspaceOpenResponse } from "@/supabase/functions/_shared/FunctionTypes.js";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { SupabaseClient } from "@supabase/supabase-js";

export const WORKSPACE_STEPS = [
  { id: "build", label: "Prepare the workspace" },
  { id: "clone", label: "Clone your repository" },
  { id: "editor", label: "Start VS Code" }
] as const;

export type WorkspaceStepId = (typeof WORKSPACE_STEPS)[number]["id"];

export type WorkspaceState =
  | { status: "not_started" }
  // `restarting`: workspace-open is stopping a broken workspace to start it again.
  | { status: "starting"; step: WorkspaceStepId; restarting?: boolean }
  | { status: "ready"; url: string }
  | { status: "failed"; step: WorkspaceStepId; message: string }
  // The student has to link their Forgejo account in Coder once, at `url`, before the clone can run.
  | { status: "needs_linking"; url: string; message: string }
  // The student's Coder account isn't bound to their Pawtograder login; only staff can fix it.
  | { status: "account_conflict"; message: string };

export interface WorkspaceClient {
  getStatus(assignmentId: number): Promise<WorkspaceState>;
  open(assignmentId: number): Promise<WorkspaceState>;
}

export function workspaceStepLabel(step: WorkspaceStepId): string {
  return WORKSPACE_STEPS.find((s) => s.id === step)?.label ?? step;
}

function isStepId(value: unknown): value is WorkspaceStepId {
  return WORKSPACE_STEPS.some((s) => s.id === value);
}

/**
 * Maps a `workspace-open` or `workspace-status` reply onto the card's states. Throws when a reply
 * lacks what the card needs (a ready workspace with no editor link), so the card shows "Could not
 * reach your workspace" instead of a dead button.
 */
export function toWorkspaceState(res: WorkspaceOpenResponse): WorkspaceState {
  const step = isStepId(res.step) ? res.step : "build";
  switch (res.status) {
    case "not_started":
      return { status: "not_started" };
    case "starting":
      return { status: "starting", step };
    case "restarting":
      return { status: "starting", step, restarting: true };
    case "ready":
      if (!res.redirect_url) throw new Error("The workspace is ready but has no editor link.");
      return { status: "ready", url: res.redirect_url };
    case "failed":
      return { status: "failed", step, message: res.message || "The workspace could not start." };
    case "needs_linking": {
      const url = res.authenticate_url ?? res.redirect_url;
      if (!url) throw new Error("The workspace needs your Forgejo account linked, but sent no link.");
      return {
        status: "needs_linking",
        url,
        message: res.message || "Link your Forgejo account in Coder, then open the workspace again."
      };
    }
    case "account_conflict":
      return {
        status: "account_conflict",
        message: res.message || "Your Coder account can't be signed in to. Ask course staff for help."
      };
    default:
      throw new Error(`Unexpected workspace status: ${String((res as { status: unknown }).status)}`);
  }
}

/** The real client: Pawtograder's edge functions, which call Coder with the server's token. */
export function createWorkspaceClient(supabase: SupabaseClient<Database>): WorkspaceClient {
  return {
    async getStatus(assignmentId) {
      return toWorkspaceState(await workspaceStatus({ assignment_id: assignmentId }, supabase));
    },
    async open(assignmentId) {
      return toWorkspaceState(await workspaceOpen({ assignment_id: assignmentId }, supabase));
    }
  };
}

// Not in COURSE_FEATURES yet: CW-10 (#1128) owns adding it. Like its SQL check and
// `courseFeatureEffectiveEnabled`, the first matching entry decides, and only a boolean true counts
// as on.
export const CLOUD_WORKSPACES_FLAG = "cloud-workspaces";

export function cloudWorkspacesEnabled(features: unknown): boolean {
  if (!Array.isArray(features)) return false;
  const entry = features.find((f) => (f as { name?: unknown } | null)?.name === CLOUD_WORKSPACES_FLAG) as
    | { enabled?: unknown }
    | undefined;
  return entry?.enabled === true;
}

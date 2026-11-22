import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { changeFiles, type ForgejoConfig, type ForgejoFileChange, readFileEntry } from "../_shared/ForgejoWrapper.ts";
import { forgejoGradeWorkflow } from "../_shared/forgejoGradeWorkflow.ts";
import { UserVisibleError } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";

export const FORGEJO_GRADE_WORKFLOW_PATH = ".github/workflows/grade.yml";
/** Forgejo, like GitHub, only runs `.github/workflows/*.yml`, so the suffix stops the workflow and keeps its content. */
export const FORGEJO_DISABLED_GRADE_WORKFLOW_PATH = `${FORGEJO_GRADE_WORKFLOW_PATH}.disabled`;

export type ForgejoWorkflowOps = { read: typeof readFileEntry; change: typeof changeFiles };

export type ForgejoWorkflowChange = {
  /** The commit that changed the handout, or null when it already agreed with the flag. */
  commitSha: string | null;
  /** grade.yml's content once the change is made, or null when the handout has none. */
  liveWorkflow: string | null;
};

/**
 * Brings the Forgejo handout's grade.yml in line with the flag, in one commit, as the GitHub path does.
 *
 * Enabling keeps a live grade.yml, otherwise restores the parked copy, otherwise adds the stock workflow.
 * Restoring first keeps an instructor's edits (runner labels, extra steps) across an off/on cycle.
 * Disabling renames grade.yml to grade.yml.disabled, replacing an older parked copy. Each change names
 * the blob it read, so a file someone pushed in between fails the commit instead of being overwritten.
 */
export async function syncForgejoGradeWorkflow(
  config: ForgejoConfig,
  templateRepo: string,
  hasAutograder: boolean,
  gradingServer: string,
  ops: ForgejoWorkflowOps = { read: readFileEntry, change: changeFiles }
): Promise<ForgejoWorkflowChange> {
  const live = await ops.read(config, templateRepo, FORGEJO_GRADE_WORKFLOW_PATH);
  if (hasAutograder) {
    if (live) return { commitSha: null, liveWorkflow: live.content };
    const parked = await ops.read(config, templateRepo, FORGEJO_DISABLED_GRADE_WORKFLOW_PATH);
    const content = parked?.content ?? forgejoGradeWorkflow(gradingServer);
    const change: ForgejoFileChange = parked
      ? {
          operation: "update",
          path: FORGEJO_GRADE_WORKFLOW_PATH,
          fromPath: FORGEJO_DISABLED_GRADE_WORKFLOW_PATH,
          sha: parked.sha,
          content
        }
      : { operation: "create", path: FORGEJO_GRADE_WORKFLOW_PATH, content };
    const commitSha = await ops.change(
      config,
      templateRepo,
      [change],
      "Enable autograder workflow: this assignment has an autograder"
    );
    return { commitSha, liveWorkflow: content };
  }

  if (!live) return { commitSha: null, liveWorkflow: null };
  const parked = await ops.read(config, templateRepo, FORGEJO_DISABLED_GRADE_WORKFLOW_PATH);
  const changes: ForgejoFileChange[] = parked
    ? [
        { operation: "update", path: FORGEJO_DISABLED_GRADE_WORKFLOW_PATH, sha: parked.sha, content: live.content },
        { operation: "delete", path: FORGEJO_GRADE_WORKFLOW_PATH, sha: live.sha }
      ]
    : [
        {
          operation: "update",
          path: FORGEJO_DISABLED_GRADE_WORKFLOW_PATH,
          fromPath: FORGEJO_GRADE_WORKFLOW_PATH,
          sha: live.sha,
          content: live.content
        }
      ];
  const commitSha = await ops.change(
    config,
    templateRepo,
    changes,
    "Disable autograder workflow: this assignment has no autograder"
  );
  return { commitSha, liveWorkflow: null };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type ForgejoSyncAssignment = {
  id: number;
  class_id: number;
  template_repo: string;
  forgejo_org: string | null;
  class_slug: string;
};

export type ForgejoSyncResult = {
  action: "added" | "removed" | "unchanged";
  has_autograder: boolean;
  template_repo: string;
};

/**
 * The Forgejo side of assignment-sync-autograder-workflow. The handout must be in the class's own org,
 * since the admin credential can write any repo on the instance. Another assignment pointing at the same
 * handout with the other setting is refused: unlike GitHub's sharers, Forgejo handouts are made one per
 * assignment, so a shared one is a hand-edited template_repo, and changing it would change grading
 * for an assignment the instructor didn't open.
 *
 * Existing student repos keep their copy of grade.yml: nothing syncs a Forgejo handout into them yet.
 */
export async function syncForgejoAssignmentWorkflow(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  assignment: ForgejoSyncAssignment,
  hasAutograder: boolean,
  gradingServer: string,
  ops?: ForgejoWorkflowOps
): Promise<ForgejoSyncResult> {
  const org = (assignment.forgejo_org || assignment.class_slug).toLowerCase();
  const owner = assignment.template_repo.split("/")[0]?.toLowerCase();
  if (owner !== org) {
    throw new UserVisibleError("This assignment's handout isn't in the class's Forgejo org.", 400);
  }

  const { data: sharers, error: sharersError } = await supabase
    .from("assignments")
    .select("id, has_autograder, submission_mode, repo_mode")
    .eq("template_repo", assignment.template_repo)
    .neq("id", assignment.id);
  if (sharersError) throw sharersError;
  const effective = (a: { has_autograder: boolean | null; submission_mode: string | null; repo_mode: string }) =>
    a.submission_mode !== "pr" &&
    a.repo_mode !== "none" &&
    a.repo_mode !== "no_submission" &&
    a.has_autograder !== false;
  const disagreeing = (sharers ?? []).filter((a) => effective(a) !== hasAutograder);
  if (disagreeing.length > 0) {
    throw new UserVisibleError(
      `The handout ${assignment.template_repo} is also used by ${disagreeing.length} other assignment` +
        `${disagreeing.length === 1 ? "" : "s"} with a different autograder setting, so it can't be changed ` +
        `from here. Give this assignment its own handout repository first.`,
      409
    );
  }

  let change: ForgejoWorkflowChange;
  try {
    change = await syncForgejoGradeWorkflow(config, assignment.template_repo, hasAutograder, gradingServer, ops);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new UserVisibleError(
      `Could not ${hasAutograder ? "add" : "park"} ${FORGEJO_GRADE_WORKFLOW_PATH} in ${assignment.template_repo}. ` +
        `Please try again: ${msg}`,
      502
    );
  }

  const ids = [assignment.id, ...(sharers ?? []).map((a) => a.id)];
  if (change.commitSha) {
    // Like the handout's creation: the advertised head is the commit just made.
    const { error } = await supabase
      .from("assignments")
      .update({ latest_template_sha: change.commitSha })
      .in("id", ids)
      .eq("template_repo", assignment.template_repo);
    if (error) throw error;
  }
  if (hasAutograder && change.liveWorkflow !== null) {
    // Grading rejects a grade.yml whose hash differs from workflow_sha. Set it when this call wrote the file,
    // or when none is stored yet. A grade.yml that was already live keeps its stored hash, which may be what
    // students' repos were made with, as the forgejo-reconciler does.
    const workflowSha = await sha256Hex(change.liveWorkflow);
    let update = supabase.from("autograder").update({ workflow_sha: workflowSha }).in("id", ids);
    if (!change.commitSha) update = update.is("workflow_sha", null);
    const { error } = await update;
    if (error) throw error;
  }

  return {
    action: change.commitSha ? (hasAutograder ? "added" : "removed") : "unchanged",
    has_autograder: hasAutograder,
    template_repo: assignment.template_repo
  };
}

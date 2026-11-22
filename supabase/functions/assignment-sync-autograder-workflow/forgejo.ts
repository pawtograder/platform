import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  changeFiles,
  type ForgejoConfig,
  type ForgejoFileChange,
  getCommit,
  readFileEntry
} from "../_shared/ForgejoWrapper.ts";
import { forgejoGradeWorkflow } from "../_shared/forgejoGradeWorkflow.ts";
import { UserVisibleError } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";

export const FORGEJO_GRADE_WORKFLOW_PATH = ".github/workflows/grade.yml";
/** Forgejo only runs .github/workflows/*.yml, so the suffix parks the workflow. */
export const FORGEJO_DISABLED_GRADE_WORKFLOW_PATH = `${FORGEJO_GRADE_WORKFLOW_PATH}.disabled`;

export type ForgejoWorkflowOps = { read: typeof readFileEntry; change: typeof changeFiles; head: typeof getCommit };

export type ForgejoWorkflowChange = {
  commitSha: string | null;
  liveWorkflow: string | null;
  headSha: string | null;
  headIsToggleCommit: boolean;
};

const ENABLE_COMMIT_MESSAGE = "Enable autograder workflow: this assignment has an autograder";
const DISABLE_COMMIT_MESSAGE = "Disable autograder workflow: this assignment has no autograder";

/** Reads both files at the resolved head, so the content and returned revision match under concurrent pushes. */
export async function syncForgejoGradeWorkflow(
  config: ForgejoConfig,
  templateRepo: string,
  hasAutograder: boolean,
  gradingServer: string,
  ops: ForgejoWorkflowOps = { read: readFileEntry, change: changeFiles, head: getCommit }
): Promise<ForgejoWorkflowChange> {
  const message = hasAutograder ? ENABLE_COMMIT_MESSAGE : DISABLE_COMMIT_MESSAGE;
  let head: { sha: string; message: string } | null = null;
  try {
    const commit = await ops.head(config, templateRepo, "main");
    head = { sha: commit.sha, message: commit.commit?.message ?? "" };
  } catch {
    // Empty handout or failed lookup: read at the default branch and pin nothing.
  }
  const unchanged = (liveWorkflow: string | null): ForgejoWorkflowChange => ({
    commitSha: null,
    liveWorkflow,
    headSha: head?.sha ?? null,
    headIsToggleCommit: head !== null && head.message.trim() === message
  });
  const read = (path: string) => ops.read(config, templateRepo, path, head?.sha);

  const live = await read(FORGEJO_GRADE_WORKFLOW_PATH);
  if (hasAutograder) {
    if (live) return unchanged(live.content);
    const parked = await read(FORGEJO_DISABLED_GRADE_WORKFLOW_PATH);
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
    const commitSha = await ops.change(config, templateRepo, [change], message);
    return { commitSha, liveWorkflow: content, headSha: commitSha, headIsToggleCommit: true };
  }

  if (!live) return unchanged(null);
  const parked = await read(FORGEJO_DISABLED_GRADE_WORKFLOW_PATH);
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
  const commitSha = await ops.change(config, templateRepo, changes, message);
  return { commitSha, liveWorkflow: null, headSha: commitSha, headIsToggleCommit: true };
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
  latest_template_sha: string | null;
};

export type ForgejoSyncResult = {
  action: "added" | "removed" | "unchanged";
  has_autograder: boolean;
  template_repo: string;
  existing_repositories_unchanged: number;
};

/** The handout must be in the class's org: the admin credential can write any repo on the instance. */
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

  // Forgejo names are case-insensitive, and ilike's `_` is a wildcard, so rows are re-filtered below.
  const sameRepo = assignment.template_repo.toLowerCase();
  const { data: sharerRows, error: sharersError } = await supabase
    .from("assignments")
    .select("id, has_autograder, submission_mode, repo_mode, template_repo")
    .eq("git_provider", "forgejo")
    .ilike("template_repo", assignment.template_repo)
    .neq("id", assignment.id);
  if (sharersError) throw sharersError;
  const sharers = (sharerRows ?? []).filter((a) => a.template_repo?.toLowerCase() === sameRepo);
  const effective = (a: { has_autograder: boolean | null; submission_mode: string | null; repo_mode: string }) =>
    a.submission_mode !== "pr" &&
    a.repo_mode !== "none" &&
    a.repo_mode !== "no_submission" &&
    a.has_autograder !== false;
  const disagreeing = sharers.filter((a) => effective(a) !== hasAutograder);
  if (disagreeing.length > 0) {
    throw new UserVisibleError(
      `The handout ${assignment.template_repo} is also used by ${disagreeing.length} other assignment` +
        `${disagreeing.length === 1 ? "" : "s"} with a different autograder setting, so it can't be changed ` +
        `from here. Give this assignment its own handout repository first.`,
      409
    );
  }

  const ids = [assignment.id, ...sharers.map((a) => a.id)];
  // Counted before any write: counted after, a retry saw the handout already changed and reported nothing.
  const { count: existingRepos, error: repoCountError } = await supabase
    .from("repositories")
    .select("id", { count: "exact", head: true })
    .in("assignment_id", ids)
    .eq("git_provider", "forgejo");
  if (repoCountError) throw repoCountError;

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

  // Pin the revision LAST: a stale pin on a toggle commit is how a retry detects an unfinished attempt.
  const headSha = change.headSha;
  const wrote = change.commitSha !== null;
  const unfinished =
    !wrote && change.headIsToggleCommit && headSha !== null && assignment.latest_template_sha !== headSha;
  if (hasAutograder && change.liveWorkflow !== null) {
    // Grading checks grade.yml against workflow_sha; a file that was already live keeps its stored hash.
    const workflowSha = await sha256Hex(change.liveWorkflow);
    let update = supabase.from("autograder").update({ workflow_sha: workflowSha }).in("id", ids);
    if (!wrote && !unfinished) update = update.is("workflow_sha", null);
    const { error } = await update;
    if (error) throw error;
  }
  if (headSha !== null && (wrote || unfinished)) {
    const { error } = await supabase
      .from("assignments")
      .update({ latest_template_sha: headSha })
      .in("id", ids)
      .eq("git_provider", "forgejo");
    if (error) throw error;
  }

  return {
    action: change.commitSha ? (hasAutograder ? "added" : "removed") : "unchanged",
    has_autograder: hasAutograder,
    template_repo: assignment.template_repo,
    existing_repositories_unchanged: wrote || unfinished ? (existingRepos ?? 0) : 0
  };
}

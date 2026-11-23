import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  changeFiles,
  classForgejoOrg,
  type ForgejoConfig,
  type ForgejoFileChange,
  getCommit,
  readFileEntry
} from "../_shared/ForgejoWrapper.ts";
import { forgejoGradeWorkflow, gradeWorkflowSha } from "../_shared/forgejoGradeWorkflow.ts";
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
};

/**
 * Why a Forgejo assignment can't turn its autograder off. handleForgejoPush records check rows only,
 * so a push becomes a submission through a grading run and nothing else. Lift this once push-direct
 * submissions exist on Forgejo.
 */
export const FORGEJO_AUTOGRADER_REQUIRED_MESSAGE =
  "The autograder can't be turned off on a Forgejo assignment yet. On Forgejo a push only becomes a " +
  "submission through a grading run, so students would have no way to submit.";

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
  let head: { sha: string } | null = null;
  try {
    const commit = await ops.head(config, templateRepo, "main");
    head = { sha: commit.sha };
  } catch {
    // Empty handout or failed lookup: read at the default branch and pin nothing.
  }
  const unchanged = (liveWorkflow: string | null): ForgejoWorkflowChange => ({
    commitSha: null,
    liveWorkflow,
    headSha: head?.sha ?? null
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
    return { commitSha, liveWorkflow: content, headSha: commitSha };
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
  return { commitSha, liveWorkflow: null, headSha: commitSha };
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
  action: "added" | "unchanged";
  has_autograder: true;
  template_repo: string;
  existing_repositories_unchanged: number;
  /** The handout already holds the workflow, but recording its hash or revision failed; a re-sync repairs it. */
  record_error?: string;
};

/**
 * Turns the autograder on for a Forgejo handout. Turning it off is refused (FORGEJO_AUTOGRADER_REQUIRED_MESSAGE).
 * The handout must be in the class's org: the admin credential can write any repo on the instance.
 */
export async function syncForgejoAssignmentWorkflow(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig,
  assignment: ForgejoSyncAssignment,
  hasAutograder: boolean,
  gradingServer: string,
  ops?: ForgejoWorkflowOps
): Promise<ForgejoSyncResult> {
  if (!hasAutograder) throw new UserVisibleError(FORGEJO_AUTOGRADER_REQUIRED_MESSAGE, 409);
  const org = classForgejoOrg({ forgejo_org: assignment.forgejo_org, slug: assignment.class_slug });
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
  const disagreeing = sharers.filter((a) => !effective(a));
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

  const attempt = () => syncForgejoGradeWorkflow(config, assignment.template_repo, true, gradingServer, ops);
  let change: ForgejoWorkflowChange;
  try {
    change = await attempt();
  } catch (first) {
    // Two enables can both read grade.yml as absent, and Forgejo rejects the second commit. Reading
    // again lets the loser find the winner's file instead of failing, which the caller would answer
    // by putting the flag back to off while grade.yml is live.
    try {
      change = await attempt();
    } catch {
      const msg = first instanceof Error ? first.message : String(first);
      throw new UserVisibleError(
        `Could not add ${FORGEJO_GRADE_WORKFLOW_PATH} to ${assignment.template_repo}. Please try again: ${msg}`,
        502
      );
    }
  }

  // Past this point the handout holds the workflow, so a failed write is returned rather than
  // thrown: a thrown error would make the caller restore the old flag.
  const wrote = change.commitSha !== null;
  let hashRepaired = false;
  let recordError: string | undefined;
  try {
    // A concurrent disable request saves false before it is refused. Setting the flag back here,
    // after the commit, means the saved flag can't end up off while grade.yml is live.
    const { error: flagError } = await supabase
      .from("assignments")
      .update({ has_autograder: true })
      .in("id", ids)
      .eq("git_provider", "forgejo")
      .eq("has_autograder", false);
    if (flagError) throw flagError;
    if (change.liveWorkflow !== null) {
      // Grading checks grade.yml against workflow_sha. Compared with the live file rather than
      // inferred from the head commit: a hash write that failed after an earlier commit, or a
      // parked copy edited while parked, leaves it stale however many commits land on top.
      const workflowSha = await gradeWorkflowSha(change.liveWorkflow);
      const { data: repaired, error } = await supabase
        .from("autograder")
        .update({ workflow_sha: workflowSha })
        .in("id", ids)
        .or(`workflow_sha.is.null,workflow_sha.neq.${workflowSha}`)
        .select("id");
      if (error) throw error;
      hashRepaired = (repaired ?? []).length > 0;
    }
    // Pinned last and whenever it differs from the head, so a retry repairs a pin that failed
    // even after other commits landed on the handout.
    if (change.headSha !== null && (wrote || assignment.latest_template_sha !== change.headSha)) {
      const { error } = await supabase
        .from("assignments")
        .update({ latest_template_sha: change.headSha })
        .in("id", ids)
        .eq("git_provider", "forgejo");
      if (error) throw error;
    }
  } catch (e) {
    recordError = e instanceof Error ? e.message : ((e as { message?: string })?.message ?? String(e));
  }

  return {
    action: wrote ? "added" : "unchanged",
    has_autograder: true,
    template_repo: assignment.template_repo,
    // A repaired hash means an earlier attempt committed the workflow, so the same repos lack it.
    existing_repositories_unchanged: wrote || hashRepaired ? (existingRepos ?? 0) : 0,
    ...(recordError !== undefined ? { record_error: recordError } : {})
  };
}

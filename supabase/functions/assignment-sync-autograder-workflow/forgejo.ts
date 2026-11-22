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
/** Forgejo, like GitHub, only runs `.github/workflows/*.yml`, so the suffix stops the workflow and keeps its content. */
export const FORGEJO_DISABLED_GRADE_WORKFLOW_PATH = `${FORGEJO_GRADE_WORKFLOW_PATH}.disabled`;

export type ForgejoWorkflowOps = { read: typeof readFileEntry; change: typeof changeFiles; head: typeof getCommit };

export type ForgejoWorkflowChange = {
  /** The commit that changed the handout, or null when it already agreed with the flag. */
  commitSha: string | null;
  /** grade.yml's content once the change is made, or null when the handout has none. */
  liveWorkflow: string | null;
  /**
   * The handout's head once this call is done: the commit it made, or the head it read when it made none.
   * Null only when the head could not be read (an empty handout, or a failed lookup) — the caller then has
   * nothing to pin and leaves the stored revision alone.
   */
  headSha: string | null;
  /**
   * Whether `headSha` is a commit this function makes for the requested direction: the commit just made,
   * or one an earlier attempt made. An instructor's own push to the handout is not, which is how the
   * caller tells an unfinished toggle from an ordinary handout change.
   */
  headIsToggleCommit: boolean;
};

const ENABLE_COMMIT_MESSAGE = "Enable autograder workflow: this assignment has an autograder";
const DISABLE_COMMIT_MESSAGE = "Disable autograder workflow: this assignment has no autograder";

/**
 * Brings the Forgejo handout's grade.yml in line with the flag, in one commit, as the GitHub path does.
 *
 * Enabling keeps a live grade.yml, otherwise restores the parked copy, otherwise adds the stock workflow.
 * Restoring first keeps an instructor's edits (runner labels, extra steps) across an off/on cycle.
 * Disabling renames grade.yml to grade.yml.disabled, replacing an older parked copy. Each change names
 * the blob it read, so a file someone pushed in between fails the commit instead of being overwritten.
 *
 * The head is resolved first and both files are read at it, so the content and the revision returned
 * describe the same commit even when someone pushes to the handout during the call.
 */
export async function syncForgejoGradeWorkflow(
  config: ForgejoConfig,
  templateRepo: string,
  hasAutograder: boolean,
  gradingServer: string,
  ops: ForgejoWorkflowOps = { read: readFileEntry, change: changeFiles, head: getCommit }
): Promise<ForgejoWorkflowChange> {
  const message = hasAutograder ? ENABLE_COMMIT_MESSAGE : DISABLE_COMMIT_MESSAGE;
  // The branch changeFiles commits to, so the head read here is the head those commits move.
  let head: { sha: string; message: string } | null = null;
  try {
    const commit = await ops.head(config, templateRepo, "main");
    head = { sha: commit.sha, message: commit.commit?.message ?? "" };
  } catch {
    // An empty handout has no head, and a lookup that fails leaves the caller with nothing to pin.
    // Neither is a reason to fail a workflow change; the files are then read at the default branch.
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
  /** The revision the row advertises, which tells a retry whether the previous attempt finished. */
  latest_template_sha: string | null;
};

export type ForgejoSyncResult = {
  action: "added" | "removed" | "unchanged";
  has_autograder: boolean;
  template_repo: string;
  /**
   * What this change does NOT reach, for the caller to show the instructor. Student repositories made
   * before the change keep their own grade.yml: Forgejo has no handout sync yet, so only repositories
   * created after it are generated from the handout this call just wrote.
   */
  existing_repositories_unchanged: number;
};

/**
 * The Forgejo side of assignment-sync-autograder-workflow. The handout must be in the class's own org,
 * since the admin credential can write any repo on the instance. Another assignment pointing at the same
 * handout with the other setting is refused: unlike GitHub's sharers, Forgejo handouts are made one per
 * assignment, so a shared one is a hand-edited template_repo, and changing it would change grading
 * for an assignment the instructor didn't open.
 *
 * Existing student repos keep their copy of grade.yml: nothing syncs a Forgejo handout into them yet, so
 * the result counts them and the caller tells the instructor. GitHub queues those repositories instead
 * (queueHandoutSyncsForAssignments in index.ts); the Forgejo equivalent needs a handout sync engine that
 * speaks to Forgejo and push-direct ingestion (#1110), neither of which exists yet.
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

  // Scoped to Forgejo. `owner/name` is only unique per host — repository names are keyed by provider
  // (CW-13) precisely because a class can have the same name on both — so an unscoped lookup collected
  // GitHub assignments too, and the writes below would then have given a GitHub assignment a Forgejo
  // template revision and workflow hash.
  //
  // Matched case-insensitively, because Forgejo treats owner and repository names that way and a
  // hand-entered template_repo may differ in case from the one stored here. `ilike` with no wildcards
  // is case-insensitive equality except that `_` still matches any single character, so the result is
  // narrowed to exact (lowercased) matches below rather than trusted as it comes back.
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
  // What this change cannot reach, counted before anything is written. A failed count then fails the
  // request while a retry is still clean. Counted afterwards, a retry found the handout already changed
  // and reported nothing, though those repositories still had the old setup.
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

  // The handout is written before these two rows, and the two rows cannot be written together: the
  // revision is on `assignments` and the hash on `autograder`. A previous attempt that committed and
  // then failed here leaves the handout ahead of the revision this row advertises, and that gap is what
  // the retry recognises — so the revision is pinned LAST, after the hash, and stays stale until both
  // have been written. Without it, the retry saw a handout that already agreed with the flag, made no
  // commit, and skipped both writes, leaving the pin and the hash wrong for good.
  //
  // Only a head this function committed counts as that gap. Nothing advances the pin when an instructor
  // pushes to a Forgejo handout, so a stale pin alone does not mean an attempt failed. Treating it that
  // way would replace a hash that existing student repositories still match.
  const headSha = change.headSha;
  const wrote = change.commitSha !== null;
  const unfinished =
    !wrote && change.headIsToggleCommit && headSha !== null && assignment.latest_template_sha !== headSha;
  if (hasAutograder && change.liveWorkflow !== null) {
    // Grading rejects a grade.yml whose hash differs from workflow_sha. Set it when this call wrote the file,
    // or when an earlier attempt did and did not get this far. Any other grade.yml that was already live
    // keeps its stored hash, which may be what students' repos were made with, as the forgejo-reconciler does.
    const workflowSha = await sha256Hex(change.liveWorkflow);
    let update = supabase.from("autograder").update({ workflow_sha: workflowSha }).in("id", ids);
    if (!wrote && !unfinished) update = update.is("workflow_sha", null);
    const { error } = await update;
    if (error) throw error;
  }
  if (headSha !== null && (wrote || unfinished)) {
    // Like the handout's creation: the advertised head is the commit just made, or the head an earlier
    // attempt made and never recorded.
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
    // Reported when this call moved the handout, or finished an earlier attempt that did: either way the
    // repositories made before that commit still have the old setup.
    existing_repositories_unchanged: wrote || unfinished ? (existingRepos ?? 0) : 0
  };
}

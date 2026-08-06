/**
 * TODO: Get rid of this: refactor it so that we don't manually create webhooks and just use the app-levelhook that gets delivered.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getFileFromRepo, updateAutograderWorkflowHash, getDefaultBranchHeadSha } from "../_shared/GitHubWrapper.ts";
import { UserVisibleError, SecurityError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { parse } from "jsr:@std/yaml";
import { PawtograderConfig } from "../_shared/PawtograderYml.d.ts";
import { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.d.ts";
import * as Sentry from "npm:@sentry/deno";
import { seedHandoutFileHashes } from "../_shared/handoutFileHashes.ts";

/**
 * Webhook events the Pawtograder GitHub App must subscribe to.
 *
 * NOTE: the App-level webhook subscription is configured in the GitHub App
 * settings (GitHub UI / app manifest), not by this function — this function
 * only fetches/validates per-repo autograder config. We keep the authoritative
 * list here (the file the docs point at for "subscribed events") so the set is
 * discoverable in code and reviewed alongside the handlers in
 * `github-repo-webhook/index.ts`. When you add a handler there, add the event
 * here and update the GitHub App subscription to match.
 *
 * `deployment_status` (added for PR-submission-mode Phase 4) feeds the
 * `github_deployments` ingestion in the webhook handler. It carries the full
 * deployment object in its payload, so we don't separately subscribe to the
 * bare `deployment` event (there is no handler for it — keep this list in sync
 * with the registered `eventHandler.on(...)` handlers to avoid drift).
 */
export const GITHUB_APP_WEBHOOK_EVENTS = [
  "push",
  "pull_request",
  "check_run",
  "workflow_run",
  "membership",
  "organization",
  "deployment_status"
] as const;
type RequestBody = {
  new_repo: string;
  assignment_id: number;
  watch_type: "grader_solution" | "template_repo";
};
async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { assignment_id, new_repo, watch_type }: RequestBody = await req.json();
  scope?.setTag("function", "github-repo-configure-webhook");
  scope?.setTag("assignment_id", assignment_id.toString());
  scope?.setTag("new_repo", new_repo);
  scope?.setTag("watch_type", watch_type);
  //Validate that the user is an instructor
  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: req.headers.get("Authorization")! }
    }
  });

  const token = req.headers.get("Authorization")!.replace("Bearer ", "");
  const {
    data: { user },
    error
  } = await supabase.auth.getUser(token);
  if (error) {
    console.error(error);
  }
  if (!user) {
    throw new SecurityError("User not found");
  }

  // Fetch from supabase
  const { data: autograder, error: autograder_error } = await supabase
    .from("autograder")
    .select("*,assignments(*)")
    .eq("id", assignment_id)
    .single();
  if (autograder_error) {
    console.error(autograder_error);
    throw new UserVisibleError("Autograder not found");
  }
  //Make sure that we are an instructor in this class
  const { data: roles } = await supabase
    .from("user_roles")
    .select("*")
    .eq("role", "instructor")
    .eq("class_id", autograder.assignments.class_id!)
    .eq("user_id", user.id)
    .single();
  if (!roles) {
    throw new SecurityError("Unauthorized");
  }
  if (watch_type === "template_repo" && autograder.assignments.has_autograder === false) {
    // No autograder means the handout has no grade.yml to hash (it is stripped at
    // creation) and nothing reads workflow_sha. Hashing would 404; the catch below
    // would swallow it, but skipping says why.
    console.log(`Skipping autograder workflow hash for ${new_repo}: assignment ${assignment_id} has no autograder`);
    // Seed the handout's file hashes for this repository. Nothing else will: there is no
    // grade.yml to rename, so the workflow sync makes no commit and no push webhook fires — the
    // one path that otherwise records these rows. Without them the empty-submission check has
    // nothing to compare against and an untouched copy of the replacement handout is accepted as
    // student work, on exactly the assignments where every push is a submission.
    const adminForSeed = createClient<Database>(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: adoptedHandout } = await adminForSeed
      .from("assignments")
      .select("class_id")
      .eq("id", assignment_id)
      .maybeSingle();
    if (adoptedHandout) {
      // Resolve `new_repo`'s OWN head rather than reading latest_template_sha. The edit page calls
      // this function BEFORE the workflow sync re-pins that column, so on a handout replacement it
      // still names a commit in the OLD repository — seedHandoutFileHashes would then ask GitHub
      // for a sha the replacement does not contain, catch the failure, and seed nothing. The
      // repository being attached is the one whose hashes are wanted, so ask it directly.
      const adoptedHeadSha = await getDefaultBranchHeadSha(new_repo, scope).catch((headErr) => {
        scope?.setTag("adopted_handout_head_lookup_failed", "true");
        Sentry.captureException(headErr, scope);
        return undefined;
      });
      const seedResult = await seedHandoutFileHashes({
        adminSupabase: adminForSeed,
        assignmentId: assignment_id,
        classId: adoptedHandout.class_id,
        templateRepo: new_repo,
        commitSha: adoptedHeadSha,
        scope
      });
      if (!seedResult.seeded) {
        console.log(`Not seeding handout file hashes for repo-only assignment ${assignment_id}: ${seedResult.reason}`);
      }
    }
  } else if (watch_type === "template_repo") {
    try {
      await updateAutograderWorkflowHash(new_repo);
    } catch (e) {
      console.error(e);
      if (e instanceof Error && e.message.includes("Not Found")) {
        return {
          message: "Repository not found"
        };
      } else {
        throw e;
      }
    }
  } else if (watch_type === "grader_solution") {
    // Pull the autograder config from the repo, store to supabase
    console.log("Getting autograder config from repo", new_repo);
    const graderConfig = await getFileFromRepo(new_repo, "pawtograder.yml");
    const asObj = (await parse(graderConfig.content)) as Json;
    const { error } = await supabase
      .from("autograder")
      .update({
        config: asObj
      })
      .eq("id", autograder.id)
      .single();
    if (error) {
      return {
        message: "Error updating autograder config"
      };
    }
    // The config that just landed is what names `submissionFiles`, so this is the first moment
    // the handout's file hashes CAN be computed for a new assignment —
    // assignment-create-handout-repo runs before it and finds no globs to hash. Without these
    // rows the ingestion path has nothing to compare against and reads an untouched starter
    // repo as real work, which on a repo-only assignment makes the student's first unchanged
    // push their active submission. Idempotent on (assignment_id, sha), and reports rather
    // than throwing: the rows are re-derivable and the next handout push recomputes them.
    const { data: handoutTarget } = await supabase
      .from("assignments")
      .select("template_repo, latest_template_sha, class_id")
      .eq("id", assignment_id)
      .maybeSingle();
    if (handoutTarget?.template_repo) {
      // SERVICE ROLE, not the JWT-scoped client above. assignment_handout_file_hashes has only
      // an "instructors read" policy (20260114180000), so an authenticated upsert is rejected
      // by RLS — and seedHandoutFileHashes reports rather than throwing, so that rejection
      // turned into a silent `{ seeded: false }`. The hashes then stayed on the OLD globs after
      // an instructor edited submissionFiles, which is exactly when they need recomputing.
      const adminSupabase = createClient<Database>(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      // Recompute EVERY recorded revision, not just the current head. The empty-submission check
      // compares a pushed tree against the stored hash for the revision that repository is on, and
      // student repositories sit on older handout revisions all the time. Reseeding only the latest
      // left those rows hashed with the OLD globs while the incoming tree is filtered with the new
      // ones — a comparison between two different file sets, which accepts an untouched starter tree
      // as real work.
      const { data: recordedRevisions } = await adminSupabase
        .from("assignment_handout_file_hashes")
        .select("sha")
        .eq("assignment_id", assignment_id);
      const revisionsToHash = [
        ...new Set([
          ...(recordedRevisions ?? []).map((r) => r.sha),
          ...(handoutTarget.latest_template_sha ? [handoutTarget.latest_template_sha] : [])
        ])
      ];
      for (const revisionSha of revisionsToHash) {
        const revisionResult = await seedHandoutFileHashes({
          adminSupabase,
          assignmentId: assignment_id,
          classId: handoutTarget.class_id,
          templateRepo: handoutTarget.template_repo,
          commitSha: revisionSha,
          scope
        });
        if (!revisionResult.seeded) {
          console.log(
            `Not rehashing handout revision ${revisionSha} for assignment ${assignment_id} after the grader config: ` +
              `${revisionResult.reason}`
          );
        }
      }
    }
  } else {
    return {
      message: "Webhook already configured"
    };
  }
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});

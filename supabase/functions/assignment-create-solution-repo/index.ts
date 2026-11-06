import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { AssignmentCreateSolutionRepoRequest } from "../_shared/FunctionTypes.d.ts";
import { assertUserIsInstructorOrServiceRole, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  AssignmentSetupBusyError,
  AssignmentSetupConfigError,
  runAssignmentRepoSetup
} from "../_shared/assignmentRepoSetup.ts";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "../_shared/requestScopedAuthOptions.ts";

/**
 * Create an assignment's solution (grader) repository synchronously.
 *
 * The web app no longer calls this: inserting an assignment queues the same work on
 * github-async-worker (see public.enqueue_assignment_repo_setup), which retries it. This stays for
 * the callers that need the repository before they continue -- the CLI's assignment copy, the
 * seeding scripts and the e2e tests. The work itself lives in _shared/assignmentRepoSetup.ts and
 * reports to public.assignment_repo_setup either way.
 */
async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { assignment_id, class_id } = (await req.json()) as AssignmentCreateSolutionRepoRequest;
  scope?.setTag("function", "assignment-create-solution-repo");
  scope?.setTag("assignment_id", assignment_id.toString());
  scope?.setTag("class_id", class_id.toString());

  // Allow both instructor users and service role (for admin scripts)
  await assertUserIsInstructorOrServiceRole(class_id, req.headers.get("Authorization"));

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: REQUEST_SCOPED_AUTH_OPTIONS }
  );

  try {
    const result = await runAssignmentRepoSetup("solution", {
      adminSupabase,
      assignmentId: assignment_id,
      classId: class_id,
      scope
    });
    if (result.skip_reason === "assignment_not_found") {
      throw new UserVisibleError("Assignment not found", 400);
    }
    return result.response;
  } catch (e) {
    if (e instanceof AssignmentSetupConfigError) throw new UserVisibleError(e.message, 400);
    if (e instanceof AssignmentSetupBusyError) throw new UserVisibleError(e.message, 409);
    throw e;
  }
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});

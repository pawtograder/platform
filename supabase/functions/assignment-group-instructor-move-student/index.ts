import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { AssignmentGroupInstructorMoveStudentRequest } from "../_shared/FunctionTypes.d.ts";
import { assertUserIsInstructor, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { enqueueGithubArchiveRepo, enqueueSyncRepoPermissions } from "../_shared/GitHubWrapper.ts";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "../_shared/requestScopedAuthOptions.ts";
import { moveStudentBetweenGroups } from "./moveStudent.ts";

async function handleAssignmentGroupInstructorMoveStudent(req: Request, scope: Sentry.Scope): Promise<void> {
  const { new_assignment_group_id, old_assignment_group_id, profile_id, class_id } =
    (await req.json()) as AssignmentGroupInstructorMoveStudentRequest;
  scope?.setTag("function", "assignment-group-instructor-move-student");
  scope?.setTag("new_assignment_group_id", new_assignment_group_id?.toString() || "(null)");
  scope?.setTag("old_assignment_group_id", old_assignment_group_id?.toString() || "(null)");
  scope?.setTag("profile_id", profile_id.toString());
  scope?.setTag("class_id", class_id.toString());
  const { supabase, enrollment } = await assertUserIsInstructor(class_id, req.headers.get("Authorization")!);

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: REQUEST_SCOPED_AUTH_OPTIONS }
  );

  await moveStudentBetweenGroups(
    { new_assignment_group_id, old_assignment_group_id, profile_id, class_id },
    {
      supabase,
      adminSupabase,
      addedBy: enrollment.private_profile_id,
      enqueueGithubArchiveRepo,
      enqueueSyncRepoPermissions,
      reportError: (error) => {
        console.error(error);
        Sentry.captureException(error, scope);
      }
    }
  );
}
Deno.serve(async (req) => {
  return wrapRequestHandler(req, handleAssignmentGroupInstructorMoveStudent);
});

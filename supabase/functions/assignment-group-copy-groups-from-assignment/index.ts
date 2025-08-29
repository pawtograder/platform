import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import type { AssignmentGroupCopyGroupsFromAssignmentRequest } from "../_shared/FunctionTypes.d.ts";
import { IllegalArgumentError, assertUserIsInstructor, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";

async function copyGroupsFromAssignment(req: Request, scope: Sentry.Scope): Promise<void> {
  const { source_assignment_id, class_id, target_assignment_id } =
    (await req.json()) as AssignmentGroupCopyGroupsFromAssignmentRequest;
  scope?.setTag("function", "assignment-group-copy-groups-from-assignment");
  scope?.setTag("source_assignment_id", source_assignment_id.toString());
  scope?.setTag("class_id", class_id.toString());
  scope?.setTag("target_assignment_id", target_assignment_id.toString());
  const { supabase, enrollment } = await assertUserIsInstructor(class_id, req.headers.get("Authorization")!);
  const { data: sourceAssignmentGroups } = await supabase
    .from("assignment_groups")
    .select("*, assignment_groups_members(*)")
    .eq("class_id", class_id)
    .eq("assignment_id", source_assignment_id);
  if (!sourceAssignmentGroups || !sourceAssignmentGroups.length) {
    throw new IllegalArgumentError("Source assignment groups not found");
  }
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const newGroups = await adminSupabase
    .from("assignment_groups")
    .insert(
      sourceAssignmentGroups.map((group) => ({
        assignment_id: target_assignment_id,
        name: group.name,
        class_id: class_id
      }))
    )
    .select();
  if (newGroups.error) {
    console.error(newGroups.error);
    throw new IllegalArgumentError("Failed to create new groups");
  }
  const newMemberships = sourceAssignmentGroups.flatMap((group) =>
    group.assignment_groups_members.map((member) => ({
      assignment_group_id: newGroups.data.find((g) => g.name === group.name)?.id || 0,
      profile_id: member.profile_id,
      class_id: class_id,
      assignment_id: target_assignment_id,
      added_by: enrollment.private_profile_id
    }))
  );
  const { error } = await adminSupabase.from("assignment_groups_members").insert(newMemberships);
  if (error) {
    throw new IllegalArgumentError("Failed to create new memberships");
  }
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, copyGroupsFromAssignment);
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/assignment-group-copy-groups-from-assignment' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/

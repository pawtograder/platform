import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { AssignmentGroupCopyGroupsFromAssignmentRequest } from "../_shared/FunctionTypes.d.ts";
import { IllegalArgumentError, assertUserIsInstructor, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

async function copyGroupsFromAssignment(req: Request, scope: Sentry.Scope): Promise<void> {
  const { source_assignment_id, class_id, target_assignment_id } =
    (await req.json()) as AssignmentGroupCopyGroupsFromAssignmentRequest;
  scope?.setTag("function", "assignment-group-copy-groups-from-assignment");
  scope?.setTag("source_assignment_id", source_assignment_id.toString());
  scope?.setTag("class_id", class_id.toString());
  scope?.setTag("target_assignment_id", target_assignment_id.toString());
  const { supabase, enrollment } = await assertUserIsInstructor(class_id, req.headers.get("Authorization")!);
  
  // Fetch source groups with their members
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
  
  // Fetch existing groups in target assignment
  const { data: existingGroups } = await adminSupabase
    .from("assignment_groups")
    .select("*, assignment_groups_members(*)")
    .eq("class_id", class_id)
    .eq("assignment_id", target_assignment_id).limit(1000);
  
  const existingGroupsByName = new Map(
    (existingGroups || []).map((g) => [g.name, g])
  );
  
  // Process each source group
  for (const sourceGroup of sourceAssignmentGroups) {
    const existingGroup = existingGroupsByName.get(sourceGroup.name);
    let targetGroupId: number;
    
    if (existingGroup) {
      // Group already exists, use it
      targetGroupId = existingGroup.id;
      console.log(`Group "${sourceGroup.name}" already exists with id ${targetGroupId}`);
    } else {
      // Create new group
      const { data: newGroup, error: createError } = await adminSupabase
        .from("assignment_groups")
        .insert({
          assignment_id: target_assignment_id,
          name: sourceGroup.name,
          class_id: class_id
        })
        .select()
        .single();
      
      if (createError || !newGroup) {
        console.error("Failed to create group:", createError);
        throw new IllegalArgumentError(`Failed to create group "${sourceGroup.name}"`);
      }
      
      targetGroupId = newGroup.id;
      console.log(`Created new group "${sourceGroup.name}" with id ${targetGroupId}`);
    }
    
    // Get existing members in target group
    const existingMemberIds = new Set(
      existingGroup?.assignment_groups_members?.map((m) => m.profile_id) || []
    );
    
    // Process each member from source group
    for (const sourceMember of sourceGroup.assignment_groups_members) {
      if (existingMemberIds.has(sourceMember.profile_id)) {
        // Member already in this group, skip
        console.log(`Member ${sourceMember.profile_id} already in group "${sourceGroup.name}"`);
        continue;
      }
      
      // Check if member is in a different group for this assignment (need to move them)
      const { data: existingMembership } = await adminSupabase
        .from("assignment_groups_members")
        .select("id, assignment_group_id")
        .eq("assignment_id", target_assignment_id)
        .eq("profile_id", sourceMember.profile_id)
        .single();
      
      if (existingMembership) {
        // Move member from old group to new group
        console.log(`Moving member ${sourceMember.profile_id} to group "${sourceGroup.name}"`);
        await adminSupabase
          .from("assignment_groups_members")
          .update({
            assignment_group_id: targetGroupId,
            added_by: enrollment.private_profile_id
          })
          .eq("id", existingMembership.id);
      } else {
        // Add new member to group
        console.log(`Adding member ${sourceMember.profile_id} to group "${sourceGroup.name}"`);
        const { error: insertError } = await adminSupabase
          .from("assignment_groups_members")
          .insert({
            assignment_group_id: targetGroupId,
            profile_id: sourceMember.profile_id,
            class_id: class_id,
            assignment_id: target_assignment_id,
            added_by: enrollment.private_profile_id
          });
        
        if (insertError) {
          console.error("Failed to add member:", insertError);
          throw new IllegalArgumentError(`Failed to add member to group "${sourceGroup.name}"`);
        }
      }
    }
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

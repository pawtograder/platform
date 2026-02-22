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

  // Process each source group
  for (const sourceGroup of sourceAssignmentGroups) {
    // Upsert group (create if doesn't exist, or return existing if conflict on assignment_id,name)
    // Copy mentor_profile_id from source group
    const { data: targetGroup, error: upsertError } = await adminSupabase
      .from("assignment_groups")
      .upsert(
        {
          assignment_id: target_assignment_id,
          name: sourceGroup.name,
          class_id: class_id,
          mentor_profile_id: sourceGroup.mentor_profile_id
        },
        { onConflict: "assignment_id,name" }
      )
      .select()
      .single();

    if (upsertError || !targetGroup) {
      console.error("Failed to upsert group:", upsertError);
      throw new IllegalArgumentError(
        `Failed to create or retrieve group "${sourceGroup.name}": ${upsertError?.message || "No data returned"}`
      );
    }

    const targetGroupId = targetGroup.id;
    console.log(`Group "${sourceGroup.name}" ready with id ${targetGroupId}`);

    // Fetch current members in target group
    const { data: currentMembers } = await adminSupabase
      .from("assignment_groups_members")
      .select("profile_id")
      .eq("assignment_group_id", targetGroupId);

    const existingMemberIds = new Set((currentMembers || []).map((m) => m.profile_id));

    // Process each member from source group
    for (const sourceMember of sourceGroup.assignment_groups_members) {
      if (existingMemberIds.has(sourceMember.profile_id)) {
        // Member already in this group, skip
        console.log(`Member ${sourceMember.profile_id} already in group "${sourceGroup.name}"`);
        continue;
      }

      // Upsert member (insert if new, or update to move from old group to this group)
      console.log(`Upserting member ${sourceMember.profile_id} into group "${sourceGroup.name}"`);
      const { error: upsertError } = await adminSupabase.from("assignment_groups_members").upsert(
        {
          assignment_id: target_assignment_id,
          profile_id: sourceMember.profile_id,
          assignment_group_id: targetGroupId,
          class_id: class_id,
          added_by: enrollment.private_profile_id
        },
        { onConflict: "assignment_id,profile_id" }
      );

      if (upsertError) {
        console.error("Failed to upsert member:", upsertError);
        throw new IllegalArgumentError(
          `Failed to add/move member ${sourceMember.profile_id} to group "${sourceGroup.name}": ${upsertError.message}`
        );
      }
    }
  }
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, copyGroupsFromAssignment);
});

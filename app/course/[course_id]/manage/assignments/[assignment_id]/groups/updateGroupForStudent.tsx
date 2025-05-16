import { assignmentGroupInstructorMoveStudent } from "@/lib/edgeFunctions";
import { AssignmentGroupWithMembersInvitationsAndJoinRequests } from "@/utils/supabase/DatabaseTypes";
import { RolesWithProfilesAndGroupMemberships } from "./page";
import { useInvalidate } from "@refinedev/core";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";
import { toaster } from "@/components/ui/toaster";

export async function updateGroupForStudent(
  group: AssignmentGroupWithMembersInvitationsAndJoinRequests | undefined,
  student: RolesWithProfilesAndGroupMemberships
) {
  const supabase = createClient();
  const invalidate = useInvalidate();
  const { course_id } = useParams();

  try {
    await assignmentGroupInstructorMoveStudent(
      {
        new_assignment_group_id: group?.id || null,
        old_assignment_group_id:
          student.profiles.assignment_groups_members.length > 0
            ? student.profiles.assignment_groups_members[0].assignment_group_id
            : null,
        profile_id: student.private_profile_id,
        class_id: Number(course_id)
      },
      supabase
    );
    toaster.create({ title: "Student moved", description: "", type: "success" });
  } catch (e) {
    console.error(e);
    toaster.create({
      title: "Error moving student",
      description: e instanceof Error ? e.message : "Unknown error",
      type: "error"
    });
  }
  invalidate({ resource: "assignment_groups", invalidates: ["all", "list"] });
  invalidate({ resource: "user_roles", invalidates: ["all", "list"] });
  invalidate({ resource: "assignment_groups_members", invalidates: ["all", "list"] });
  invalidate({ resource: "assignment_group_invitations", invalidates: ["all", "list"] });
}

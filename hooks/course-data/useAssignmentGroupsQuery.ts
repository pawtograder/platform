"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type AssignmentGroupRow = Database["public"]["Tables"]["assignment_groups"]["Row"];
type AssignmentGroupMemberRow = Database["public"]["Tables"]["assignment_groups_members"]["Row"];

export type AssignmentGroupWithMembers = AssignmentGroupRow & {
  assignment_groups_members: AssignmentGroupMemberRow[];
  mentor: { name: string | null } | null;
};

const ASSIGNMENT_GROUPS_SELECT =
  "*, assignment_groups_members(*), mentor:profiles!assignment_groups_mentor_profile_id_fkey(name)";

/**
 * Fetches assignment groups with nested members and mentor for the current course.
 *
 * Uses `selectForRefetch` so realtime ID-only events trigger a joined refetch.
 * Replaces: CourseController.assignmentGroupsWithMembers
 */
export function useAssignmentGroupsQuery() {
  const { courseId, supabase, classRtc } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"assignment_groups", AssignmentGroupWithMembers>({
    queryKey: ["course", courseId, "assignment_groups"],
    table: "assignment_groups",
    queryFn: () => supabase.from("assignment_groups").select(ASSIGNMENT_GROUPS_SELECT).eq("class_id", courseId),
    classRtc,
    supabase,
    selectForRefetch: ASSIGNMENT_GROUPS_SELECT,
    scope: "class"
  });
}

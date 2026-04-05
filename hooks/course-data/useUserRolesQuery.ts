"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { UserRoleWithPrivateProfileAndUser } from "@/utils/supabase/DatabaseTypes";

export type { UserRoleWithPrivateProfileAndUser };

const USER_ROLES_SELECT = "*, profiles!private_profile_id(*), users(*)";

/**
 * Fetches user roles with joined profiles and users for the current course.
 *
 * - Staff: all user roles in the class.
 * - Students: only their own role.
 *
 * Uses `selectForRefetch` so realtime ID-only events trigger a joined refetch.
 * Replaces: CourseController.userRolesWithProfiles
 */
export function useUserRolesQuery() {
  const { courseId, userId, supabase, classRtc, isStaff, initialData } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"user_roles", UserRoleWithPrivateProfileAndUser>({
    queryKey: ["course", courseId, "user_roles", isStaff ? "all" : userId],
    table: "user_roles",
    queryFn: () => {
      let query = supabase.from("user_roles").select(USER_ROLES_SELECT).eq("class_id", courseId);
      if (!isStaff) {
        query = query.eq("user_id", userId);
      }
      return query;
    },
    classRtc,
    supabase,
    selectForRefetch: USER_ROLES_SELECT,
    scope: "class",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initialData: initialData?.userRolesWithProfiles as any
  });
}

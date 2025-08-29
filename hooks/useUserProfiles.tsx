import { useFindTableControllerValue, useTableControllerValueById } from "@/lib/TableController";
import type { UserProfile, UserRoleWithPrivateProfileAndUser } from "@/utils/supabase/DatabaseTypes";
import { useCallback, useMemo } from "react";
import { useCourseController } from "./useCourseController";

export function getUserProfile(
  allProfiles: UserProfile[],
  id: string
): { badge?: string; badge_color?: string; id: string; name: string; avatar_url: string } | undefined {
  const profile = allProfiles.find((user) => user.id === id);
  if (!profile || !profile.name) {
    return undefined;
  }
  return {
    id: profile.id,
    name: profile.name,
    avatar_url: profile.avatar_url || `https://api.dicebear.com/9.x/identicon/svg?seed=${profile.id}`,
    badge: profile.flair || undefined,
    badge_color: profile.flair_color || undefined
  };
}

export function useUserProfile(
  id: string | null | undefined
):
  | { flair?: string; flair_color?: string; id: string; name: string; avatar_url: string; real_name?: string }
  | undefined {
  const controller = useCourseController();
  const findFunction = useCallback(
    (row: UserRoleWithPrivateProfileAndUser) => {
      return row.private_profile_id === id || row.public_profile_id === id;
    },
    [id]
  );
  const userRole = useFindTableControllerValue(controller.userRolesWithProfiles, findFunction);
  const profile = useTableControllerValueById(controller.profiles, id);

  const ret = useMemo(() => {
    if (!profile) {
      return undefined;
    }
    return {
      id: profile.id,
      name: profile.name || "",
      avatar_url: profile.avatar_url || `https://api.dicebear.com/9.x/identicon/svg?seed=${profile.id}`,
      flair: profile.flair || "",
      flair_color: profile.flair_color || "",
      real_name: userRole?.profiles.name && profile.id !== userRole.private_profile_id ? userRole.profiles.name : ""
    };
  }, [profile, userRole]);
  return ret;
}

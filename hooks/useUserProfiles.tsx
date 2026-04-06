import { useProfilesQuery, useUserRolesQuery } from "@/hooks/course-data";
import { UserProfile } from "@/utils/supabase/DatabaseTypes";
import { useMemo } from "react";

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

export function useUserProfile(id: string | null | undefined):
  | {
      flair?: string;
      flair_color?: string;
      id: string;
      name: string;
      avatar_url: string;
      real_name?: string;
      private_profile_id?: string;
      discussion_karma?: number;
    }
  | undefined {
  const { data: userRoles = [] } = useUserRolesQuery();
  const { data: profiles = [] } = useProfilesQuery();

  const ret = useMemo(() => {
    if (!id || !profiles) return undefined;

    const userRole = userRoles?.find((r) => r.private_profile_id === id || r.public_profile_id === id);
    const profile = profiles.find((p) => p.id === id);

    if (!profile) {
      return undefined;
    }
    return {
      id: profile.id,
      name: profile.name || "",
      avatar_url: profile.avatar_url || `https://api.dicebear.com/9.x/identicon/svg?seed=${profile.id}`,
      flair: profile.flair || "",
      flair_color: profile.flair_color || "",
      real_name: userRole?.profiles.name && profile.id !== userRole.private_profile_id ? userRole.profiles.name : "",
      private_profile_id: userRole?.private_profile_id,
      discussion_karma: profile.discussion_karma
    };
  }, [id, profiles, userRoles]);
  return ret;
}

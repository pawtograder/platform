import type { UserProfile } from "@/utils/supabase/DatabaseTypes";
import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useCourseController, type UserProfileWithPrivateProfile } from "./useCourseController";

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
    avatar_url: profile.avatar_url || `https://api.dicebear.com/9.x/identicon/svg?seed=${profile.name}`,
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
  const [profile, setProfile] = useState<UserProfileWithPrivateProfile | undefined>(
    id ? controller.getUserProfile(id).data : undefined
  );
  useEffect(() => {
    if (id) {
      const { data, unsubscribe } = controller.getUserProfile(id, (data) => {
        setProfile(data);
      });
      setProfile(data);
      return unsubscribe;
    }
  }, [id, controller]);
  const ret = useMemo(() => {
    if (!profile) {
      return undefined;
    }
    return {
      id: profile.id,
      name: profile.name!,
      avatar_url: profile.avatar_url || `https://api.dicebear.com/9.x/identicon/svg?seed=${profile.name}`,
      flair: profile.flair || undefined,
      flair_color: profile.flair_color || undefined,
      real_name: profile.private_profile?.name || undefined
    };
  }, [profile]);
  return ret;
}
export default function useUserProfiles(): {
  users: UserProfile[];
} {
  const { course_id } = useParams();
  const { data: userProfiles, isLoading: userProfilesLoading } = useList<UserProfile>({
    resource: "profiles",
    queryOptions: {
      staleTime: Infinity
    },
    pagination: {
      pageSize: 1000
    },
    filters: [{ field: "class_id", operator: "eq", value: Number(course_id as string) }],
    liveMode: "auto"
  });
  if (userProfilesLoading) {
    return {
      users: []
    };
  }
  return {
    users: userProfiles?.data || []
  };
}

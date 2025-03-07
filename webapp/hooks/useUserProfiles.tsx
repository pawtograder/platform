import { useList } from "@refinedev/core";
import { UserProfile } from "@/utils/supabase/DatabaseTypes";
import { useParams } from "next/navigation";


export function getUserProfile(allProfiles: UserProfile[], id: string): { badge?: string, badge_color?: string, id: string, name: string, avatar_url: string } | undefined {
    const profile = allProfiles.find((user) => user.id === id);
    if (!profile || !profile.name) {
        return undefined;
    }
    return {
        id: profile.id,
        name: profile.name,
        avatar_url: profile.avatar_url || `https://api.dicebear.com/9.x/identicon/svg?seed=${profile.name}`,
        badge: profile.flair || undefined,
        badge_color: profile.flair_color || undefined,
    };
}


export function useUserProfile(id: string | null): { flair?: string, flair_color?: string, id: string, name: string, avatar_url: string } | undefined {
    const allProfiles = useUserProfiles();
    if (id == null) {
        return undefined;
    }

    const profile = allProfiles.users.find((user) => user.id === id);
    if (!profile || !profile.name) {
        return undefined;
    }

    //TODO resolve public profiles for instructors
    return {
        id: profile.id,
        name: profile.name,
        avatar_url: profile.avatar_url || `https://api.dicebear.com/9.x/identicon/svg?seed=${profile.name}`,
        flair: profile.flair || undefined,
        flair_color: profile.flair_color || undefined,
    };
}
export default function useUserProfiles(): {
    users: UserProfile[]
} {
    const { course_id } = useParams();
    const { data: userProfiles, isLoading: userProfilesLoading } = useList<UserProfile>({
        resource: "profiles",
        queryOptions: {
            staleTime: Infinity,
        },
        pagination: {
            pageSize: 1000,
        },
        filters: [
            { field: "class_id", operator: "eq", value: Number(course_id as string) }
        ]
    });
    if (userProfilesLoading) {
        return {
            users: [],
        }
    }
    return {
        users: userProfiles?.data || [],
    }
}
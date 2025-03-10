import { useList, useOne } from "@refinedev/core";
import { UserProfile } from "@/utils/supabase/DatabaseTypes";
import { useParams } from "next/navigation";
import { useClassProfiles } from "./useClassProfiles";


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


export function useUserProfile(id: string | null): { flair?: string, flair_color?: string, id: string, name: string, avatar_url: string, real_name?: string } | undefined {
    const { allVisibleRoles } = useClassProfiles();
    if (!id) {
        return undefined;
    }
    const role = allVisibleRoles.find((role) => role.public_profile_id === id);
    let real_name: string | undefined = undefined;
    if (role) {
        // This is an anonymous post, but we also have the real user
        const { data: profile } = useOne<UserProfile>({
            resource: "profiles",
            id: role.private_profile_id,
            queryOptions: {
                cacheTime: Infinity,
                staleTime: Infinity,
            }
        });
        real_name = profile?.data.name!;
    }
    const { data: profile, isLoading } = useOne<UserProfile>({
        resource: "profiles",
        id,
        queryOptions: {
            cacheTime: Infinity,
            staleTime: Infinity,
        }
    });
    if (isLoading) {
        return undefined;
    }
    if (!profile || !profile.data?.name) {
        console.log("User profile not found", id);
        return undefined;
    }

    return {
        id: profile.data.id,
        name: profile.data.name,
        avatar_url: profile.data.avatar_url || `https://api.dicebear.com/9.x/identicon/svg?seed=${profile.data.name}`,
        flair: profile.data.flair || undefined,
        flair_color: profile.data.flair_color || undefined,
        real_name: real_name,
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
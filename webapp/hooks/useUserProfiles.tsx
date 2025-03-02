import { useList } from "@refinedev/core";
import { PublicProfile, UserProfile } from "@/utils/supabase/DatabaseTypes";


export function getUserProfile(allProfiles: (PublicProfile | UserProfile)[], id: string): { badge?: string, badge_color?: string, id: string, name: string, avatar_url: string } | undefined {
    const profile = allProfiles.find((user) => user.id === id);
    if (!profile || !profile.name) {
        return undefined;
    }
    if ('avatar' in profile) {
        return {
            id: profile.id,
            name: profile.name,
            badge: profile.is_instructor ? 'Instructor' : undefined,
            badge_color: profile.is_instructor ? 'blue' : undefined,
            avatar_url: profile.avatar == 'identicon' || !profile.avatar ? `https://api.dicebear.com/9.x/identicon/svg?seed=${profile.name}` : profile.avatar        };
    }
    else if ('avatar_url' in profile) {
        return {
            id: profile.id,
            name: profile.name,
            avatar_url: profile.avatar_url || `https://api.dicebear.com/9.x/identicon/svg?seed=${profile.name}`,
        };
    }
    throw new Error("Invalid profile type");
}


export function useUserProfile(id: string | null): { is_instructor: boolean, id: string, name: string, avatar_url: string } | undefined {
    const allProfiles = useUserProfiles();
    if(id == null) {
        return undefined;
    }
    const profile = allProfiles.users.find((user) => user.id === id);
    if (!profile || !profile.name) {
        return undefined;
    }
    if ('avatar' in profile) {
        return {
            is_instructor: profile.is_instructor,
            id: profile.id,
            name: profile.name,
            avatar_url: profile.avatar == 'identicon' || !profile.avatar ? `https://api.dicebear.com/9.x/identicon/svg?seed=${profile.name}` : profile.avatar
        };
    }
    else if ('avatar_url' in profile) {
        return {
            is_instructor: true, // TODO actually have a flag, use singular profiles
            id: profile.id,
            name: profile.name,
            avatar_url: profile.avatar_url || `https://api.dicebear.com/9.x/identicon/svg?seed=${profile.name}`,
        };
    }
    throw new Error("Invalid profile type");
}
export default function useUserProfiles(): {
    users: (PublicProfile | UserProfile)[]
} {
    const { data: userProfiles, isLoading: userProfilesLoading } = useList<UserProfile>({
        resource: "profiles",
        queryOptions: {
            staleTime: Infinity,
        },
        pagination: {
            pageSize: 1000,
        },
    });
    const { data: publicProfiles, isLoading: publicProfilesLoading } = useList<PublicProfile>({
        resource: "public_profiles",
        queryOptions: {
            staleTime: Infinity,
        },
        pagination: {
            pageSize: 1000,
        },
    });
    if (userProfilesLoading || publicProfilesLoading) {
        return {
            users: [],
        }
    }
    if (userProfiles?.total && userProfiles.total <= 1) {
        //We are a student, so we need to get the public profiles
        const ret: (PublicProfile | UserProfile)[] = userProfiles?.data || [];
        ret.push(...(publicProfiles?.data.filter(p => !userProfiles.data.find(o => o.id === p.id)) || []));
        return {
            users: ret,
        }
    }
    else {
        return {
            users: userProfiles?.data || [],
        }
    }
}
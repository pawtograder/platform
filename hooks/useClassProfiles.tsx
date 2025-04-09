'use client'
import { UserRole, UserProfile, UserRoleWithCourse } from "@/utils/supabase/DatabaseTypes";
import { createContext, useContext } from "react";
import { useList, CrudFilter } from "@refinedev/core";
import { useParams } from "next/navigation";
import useAuthState from "./useAuthState";
import { Skeleton } from "@/components/ui/skeleton";
import NotFound from "@/components/ui/not-found";
type ClassProfileContextType = {
    role: UserRoleWithCourse;
    allVisibleRoles: UserRole[];
    profiles: UserProfile[];
    private_profile_id: string;
    public_profile_id: string;
}

const ClassProfileContext = createContext<ClassProfileContextType | undefined>(undefined)

export function useClassProfiles() {
    const context = useContext(ClassProfileContext);
    if (!context) {
        throw new Error("useClassProfiles must be used within a ClassProfileProvider");
    }
    return context;
}

export function useIsGraderOrInstructor() {
    const {role} = useClassProfiles();
    return role.role === "grader" || role.role === "instructor";
}

export function ClassProfileProvider({ children }: { children: React.ReactNode }) {
    const { course_id } = useParams();
    const { user, roles: myRoles } = useAuthState();
    const filters: CrudFilter[] = course_id ? [{ field: "class_id", operator: "eq", value: Number(course_id as string) }] : [];
    const { data: profiles } = useList<UserProfile>({
        resource: "profiles",
        queryOptions: {
            cacheTime: Infinity,
            staleTime: Infinity,
        },
        pagination: {
            pageSize: 1000,
        },
        filters
    });
    const { data: roles } = useList<UserRole>({
        resource: "user_roles",
        meta: {
            select: "*"
        },
        queryOptions: {
            cacheTime: Infinity,
            staleTime: Infinity,
        },
        filters
    });

    if (!profiles?.data || !roles?.data) {
        return <Skeleton height="100px" width="100%" />
    }
    const myRole = myRoles?.find(r => r.user_id === user?.id && (!course_id || r.class_id === Number(course_id as string)));
    if (!myRole) {
        return <NotFound />
    }

    return (
        <ClassProfileContext.Provider value={{
            role: myRole,
            private_profile_id: myRole.private_profile_id,
            public_profile_id: myRole.public_profile_id,
            allVisibleRoles: roles.data,
            profiles: profiles.data
        }}>
            {children}
        </ClassProfileContext.Provider>
    )
}
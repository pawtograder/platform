"use client";
import NotFound from "@/components/ui/not-found";
import { Skeleton } from "@/components/ui/skeleton";
import type { CourseWithFeatures, UserProfile, UserRole, UserRoleWithCourse } from "@/utils/supabase/DatabaseTypes";
import type { CrudFilter } from "@refinedev/core";
import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { createContext, useContext, useMemo } from "react";
import useAuthState from "./useAuthState";
type ClassProfileContextType = {
  role: UserRoleWithCourse;
  allVisibleRoles: UserRole[];
  profiles: UserProfile[];
  private_profile_id: string;
  public_profile_id: string;
  private_profile: UserProfile;
  public_profile: UserProfile;
};

const ClassProfileContext = createContext<ClassProfileContextType | undefined>(undefined);

export function useGradersAndInstructors() {
  const profiles = useClassProfiles();
  const staffRoster = useMemo(() => {
    const staff = profiles.allVisibleRoles
      .filter((r) => r.role === "grader" || r.role === "instructor")
      .map((r) => r.private_profile_id);
    return profiles.profiles.filter((p) => staff.includes(p.id));
  }, [profiles]);
  return staffRoster;
}

export function useStudentRoster() {
  const profiles = useClassProfiles();
  const studentRoster = useMemo(() => {
    const users = profiles.allVisibleRoles.filter((r) => r.role === "student").map((r) => r.private_profile_id);
    return profiles.profiles.filter((p) => users.includes(p.id));
  }, [profiles]);
  return studentRoster;
}
export function useClassProfiles() {
  const context = useContext(ClassProfileContext);
  if (!context) {
    throw new Error("useClassProfiles must be used within a ClassProfileProvider");
  }
  return context;
}

export function useFeatureEnabled(feature: string) {
  const { role } = useClassProfiles();
  const course = role.classes as CourseWithFeatures;
  return course.features?.find((f) => f.name === feature)?.enabled;
}

export function useIsGrader() {
  const { role } = useClassProfiles();
  return role.role === "grader";
}

export function useIsGraderOrInstructor() {
  const { role } = useClassProfiles();
  return role.role === "grader" || role.role === "instructor";
}

export function ClassProfileProvider({ children }: { children: React.ReactNode }) {
  const { course_id } = useParams();
  const { user, roles: myRoles } = useAuthState();
  const filters: CrudFilter[] = course_id
    ? [{ field: "class_id", operator: "eq", value: Number(course_id as string) }]
    : [];
  const { data: profiles } = useList<UserProfile>({
    resource: "profiles",
    queryOptions: {
      cacheTime: Infinity,
      staleTime: Infinity
    },
    pagination: {
      pageSize: 1000
    },
    filters
  });
  const { data: roles } = useList<UserRole>({
    resource: "user_roles",
    meta: {
      select: "*"
    },
    pagination: {
      pageSize: 1000
    },
    queryOptions: {
      cacheTime: Infinity,
      staleTime: Infinity
    },
    filters
  });

  if (!profiles?.data || !roles?.data) {
    return <Skeleton height="100px" width="100%" />;
  }
  const myRole = myRoles?.find(
    (r) => r.user_id === user?.id && (!course_id || r.class_id === Number(course_id as string))
  );
  if (!myRole) {
    return <NotFound />;
  }

  return (
    <ClassProfileContext.Provider
      value={{
        role: myRole,
        private_profile_id: myRole.private_profile_id,
        public_profile_id: myRole.public_profile_id,
        allVisibleRoles: roles.data,
        profiles: profiles.data,
        private_profile: profiles.data.find((p) => p.id === myRole.private_profile_id)!,
        public_profile: profiles.data.find((p) => p.id === myRole.public_profile_id)!
      }}
    >
      {children}
    </ClassProfileContext.Provider>
  );
}

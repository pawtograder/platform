"use client";
import { signOutAction } from "@/app/actions";
import Logo from "@/components/ui/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/utils/supabase/client";
import type { CourseFeatureName } from "@/lib/courseFeatures";
import { CourseWithFeatures, UserProfile, UserRoleWithCourseAndUser } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Button, Card, Container, Heading, Stack, Text, VStack } from "@chakra-ui/react";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { useParams } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import useAuthState from "./useAuthState";
type ClassProfileContextType = {
  role: UserRoleWithCourseAndUser;
  allOfMyRoles: UserRoleWithCourseAndUser[];
  private_profile_id: string;
  public_profile_id: string;
  private_profile: UserProfile;
  public_profile: UserProfile;
};

const ClassProfileContext = createContext<ClassProfileContextType | undefined>(undefined);

export function useClassProfiles() {
  const context = useContext(ClassProfileContext);
  if (!context) {
    throw new Error("useClassProfiles must be used within a ClassProfileProvider");
  }
  return context;
}

export function useFeatureEnabled(feature: CourseFeatureName) {
  const { role } = useClassProfiles();
  const course = role.classes as CourseWithFeatures;
  const featureFlag = course.features?.find((f) => f.name === feature);
  // Default to true if feature flag doesn't exist
  return featureFlag?.enabled ?? true;
}

export function useIsGrader() {
  const { role } = useClassProfiles();
  return role.role === "grader";
}

export function useIsInstructor() {
  const { role } = useClassProfiles();
  return role.role === "instructor";
}

/**
 * Returns whether the current user's role is either "grader" or "instructor" in the class context.
 *
 * @returns `true` if the user is a grader or instructor; otherwise, `false`.
 */
export function useIsGraderOrInstructor() {
  const { role } = useClassProfiles();
  return role.role === "grader" || role.role === "instructor";
}

export function useIsStudent() {
  const { role } = useClassProfiles();
  return role.role === "student";
}

type UserRoleWithClassAndUser = GetResult<
  Database["public"],
  Database["public"]["Tables"]["user_roles"]["Row"],
  "user_roles",
  Database["public"]["Tables"]["user_roles"]["Relationships"],
  "*, privateProfile:profiles!private_profile_id(*), publicProfile:profiles!public_profile_id(*), classes(*), users(*)"
>;
/**
 * Provides user role and profile context for the current course to its child components.
 *
 * Fetches user profiles and roles associated with the current course, determines the current user's role, and supplies this information via React context. Renders a loading skeleton while data is loading and a not-found component if the user's role is not found for the course.
 *
 * @param children - React child components that will have access to the class profile context
 */
export function ClassProfileProvider({ children }: { children: React.ReactNode }) {
  const { course_id } = useParams();
  const { user } = useAuthState();
  const userId = user?.id;
  const [roles, setRoles] = useState<UserRoleWithClassAndUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  useEffect(() => {
    if (!userId) {
      setIsLoading(false);
      setLoadError(null);
      return;
    }

    let cleanedUp = false;
    async function fetchRolesWithRetry() {
      if (!userId) {
        return;
      }
      const supabase = createClient();
      // Retry transient errors (e.g. 503 from PostgREST under load, brief auth/RLS
      // races right after login). Without this, a single hiccup can produce a
      // misleading "You don't have access to any courses" screen even when the
      // user is correctly enrolled.
      const maxAttempts = 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (cleanedUp) return;
        try {
          const { data, error } = await supabase
            .from("user_roles")
            .select(
              "*, privateProfile:profiles!private_profile_id(*), publicProfile:profiles!public_profile_id(*), classes!inner(*), users(*)"
            )
            .eq("user_id", userId)
            .eq("disabled", false)
            .eq("classes.archived", false);
          if (error) {
            throw error;
          }
          if (cleanedUp) return;
          setRoles(data || []);
          setLoadError(null);
          setIsLoading(false);
          return;
        } catch (error) {
          if (cleanedUp) return;
          const message = error instanceof Error ? error.message : String(error);
          if (attempt === maxAttempts) {
            console.error("Error fetching user roles:", error);
            setLoadError(message);
            setIsLoading(false);
            return;
          }
          const baseDelayMs = 250 * 2 ** (attempt - 1);
          const jitterMs = Math.random() * 100;
          await new Promise((resolve) => setTimeout(resolve, baseDelayMs + jitterMs));
        }
      }
    }
    setIsLoading(true);
    setLoadError(null);
    fetchRolesWithRetry();
    return () => {
      cleanedUp = true;
    };
  }, [userId, retryNonce]);

  if (isLoading) {
    return <Skeleton height="100px" width="100%" />;
  }
  if (loadError) {
    return (
      <Container maxW="md" py={{ base: "12", md: "24" }}>
        <Stack gap="6">
          <VStack gap="2" textAlign="center" mt="4">
            <Logo width={100} />
            <Heading size="3xl">Pawtograder</Heading>
            <Text color="fg.muted">Your pawsome course companion</Text>
          </VStack>
          <Card.Root p="4" colorPalette="orange" variant="subtle">
            <Card.Body>
              <Card.Title>We couldn&apos;t load your courses</Card.Title>
              <Card.Description>
                Something went wrong while fetching your enrollments. This is usually temporary. Please try again.
              </Card.Description>
            </Card.Body>
          </Card.Root>
          <Button onClick={() => setRetryNonce((n) => n + 1)} variant="solid" width="100%">
            Retry
          </Button>
          <Button onClick={signOutAction} variant="outline" width="100%">
            Sign out
          </Button>
        </Stack>
      </Container>
    );
  }
  const myRole = roles.find(
    (r) => r.user_id === user?.id && (!course_id || r.class_id === Number(course_id as string))
  );
  if (!myRole) {
    const hasAnyRoles = roles.length > 0;
    return (
      <Container maxW="md" py={{ base: "12", md: "24" }}>
        <Stack gap="6">
          <VStack gap="2" textAlign="center" mt="4">
            <Logo width={100} />
            <Heading size="3xl">Pawtograder</Heading>
            <Text color="fg.muted">Your pawsome course companion</Text>
          </VStack>

          <Card.Root p="4" colorPalette="red" variant="subtle">
            <Card.Body>
              <Card.Title>
                {hasAnyRoles
                  ? "You don\u2019t have access to this course"
                  : "You don\u2019t have access to any courses"}
              </Card.Title>
              <Card.Description>
                {hasAnyRoles
                  ? "You do not currently have access to this course on Pawtograder. Please check with your instructor if you think you should have access to this course."
                  : "You do not currently have access to any courses on Pawtograder. Please check with your instructor if you think you should have access to a course."}
              </Card.Description>
            </Card.Body>
          </Card.Root>

          <Button onClick={signOutAction} variant="outline" width="100%">
            Sign out
          </Button>
        </Stack>
      </Container>
    );
  }

  return (
    <ClassProfileContext.Provider
      value={{
        role: myRole,
        private_profile_id: myRole.private_profile_id,
        public_profile_id: myRole.public_profile_id,
        allOfMyRoles: roles,
        private_profile: myRole.privateProfile,
        public_profile: myRole.publicProfile
      }}
    >
      {children}
    </ClassProfileContext.Provider>
  );
}

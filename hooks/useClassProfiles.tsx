"use client";
import { signOutAction } from "@/app/actions";
import Logo from "@/components/ui/logo";
import { Skeleton } from "@/components/ui/skeleton";
import TableController from "@/lib/TableController";
import { CourseWithFeatures, UserProfile, UserRoleWithCourseAndUser } from "@/utils/supabase/DatabaseTypes";
import { Button, Card, Container, Heading, Stack, Text, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import useAuthState from "./useAuthState";
import { createClient } from "@/utils/supabase/client";

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

export function useFeatureEnabled(feature: string) {
  const { role } = useClassProfiles();
  const course = role.classes as CourseWithFeatures;
  return course.features?.find((f) => f.name === feature)?.enabled;
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
  const [ready, setReady] = useState(false);
  const myProfilesController = useMemo(() => {
    if (!userId) {
      return null;
    }
    const supabase = createClient();
    return new TableController({
      client: supabase,
      table: "user_roles",
      query: supabase
        .from("user_roles")
        .select(
          "*, privateProfile:profiles!private_profile_id(*), publicProfile:profiles!public_profile_id(*), classes(*), users(*)"
        )
        .eq("user_id", userId)
    });
  }, [userId]);
  useEffect(() => {
    if (myProfilesController) {
      myProfilesController.readyPromise.then(() => {
        setReady(true);
      });
    }
  }, [myProfilesController]);

  if (!ready || !myProfilesController) {
    return <Skeleton height="100px" width="100%" />;
  }
  const myRole = myProfilesController.rows.find(
    (r) => r.user_id === user?.id && (!course_id || r.class_id === Number(course_id as string))
  );
  if (myProfilesController.rows.length === 0) {
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
              <Card.Title>You don&apos;t have access to any courses</Card.Title>
              <Card.Description>
                You do not currently have access to any courses on Pawtograder. Please check with your instructor if you
                think you should have access to a course.
              </Card.Description>
            </Card.Body>
          </Card.Root>

          <Button onClick={signOutAction} variant="outline" width="100%">
            Sign out
          </Button>
        </Stack>
      </Container>
    );
  } else if (!myRole) {
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
              <Card.Title>You don&apos;t have access to this course</Card.Title>
              <Card.Description>
                You do not currently have access to this course on Pawtograder. Please check with your instructor if you
                think you should have access to this course.
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
        allOfMyRoles: myProfilesController.rows,
        private_profile: myRole.privateProfile,
        public_profile: myRole.publicProfile
      }}
    >
      {children}
    </ClassProfileContext.Provider>
  );
}

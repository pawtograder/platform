"use client";
import { signOutAction } from "@/app/actions";
import Logo from "@/components/ui/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/utils/supabase/client";
import { UserProfile, UserRoleWithCourseAndUser } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Button, Card, Container, Heading, Stack, Text, VStack } from "@chakra-ui/react";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { useParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import useAuthState from "./useAuthState";
import { clearViewAsCookie, getViewAsCookie, setViewAsCookie } from "@/lib/viewAs";
type ClassProfileContextType = {
  role: UserRoleWithCourseAndUser;
  allOfMyRoles: UserRoleWithCourseAndUser[];
  private_profile_id: string;
  public_profile_id: string;
  private_profile: UserProfile;
  public_profile: UserProfile;
  /** True when real staff are viewing the course as a student (read-only). */
  isViewingAsStudent: boolean;
  /** Convenience alias for `isViewingAsStudent` — gate write surfaces on this. */
  isReadOnly: boolean;
  /** The viewer's actual role in the course, unaffected by view-as. */
  realRole: Database["public"]["Enums"]["app_role"];
  /** The viewer's actual private profile id, unaffected by view-as. */
  realPrivateProfileId: string;
  /** Display name of the student being viewed, when viewing as. */
  viewAsProfileName?: string;
  /** Staff-only: enter read-only view as the given private profile id. */
  enterViewAs: (studentPrivateProfileId: string, redirectTo?: string) => void;
  /** Exit read-only student view and return to the instructor view. */
  exitViewAs: () => void;
};

const ClassProfileContext = createContext<ClassProfileContextType | undefined>(undefined);

export function useClassProfiles() {
  const context = useContext(ClassProfileContext);
  if (!context) {
    throw new Error("useClassProfiles must be used within a ClassProfileProvider");
  }
  return context;
}

/**
 * Whether the viewer is a grader in the **effective** course identity. When an instructor
 * is viewing as a student, this returns `false` (same as a real student). Use `realRole`
 * from {@link useClassProfiles} when you need the viewer's actual enrollment.
 */
export function useIsGrader() {
  const { role } = useClassProfiles();
  return role.role === "grader";
}

/**
 * Whether the viewer is an instructor in the **effective** course identity. When an
 * instructor is viewing as a student, this returns `false`. Use `realRole` from
 * {@link useClassProfiles} for staff-only affordances that must stay visible regardless
 * of view-as (e.g. the enrollments "View as this student" action).
 */
export function useIsInstructor() {
  const { role } = useClassProfiles();
  return role.role === "instructor";
}

/**
 * Whether the viewer is grader or instructor in the **effective** course identity.
 * Returns `false` while an instructor is masquerading as a student.
 */
export function useIsGraderOrInstructor() {
  const { role } = useClassProfiles();
  return role.role === "grader" || role.role === "instructor";
}

/** Whether the viewer is a student in the **effective** course identity (including view-as). */
export function useIsStudent() {
  const { role } = useClassProfiles();
  return role.role === "student";
}

/**
 * Returns whether the current view is read-only because an instructor is viewing the
 * course as a student. Gate student write surfaces (submit, comment, post, etc.) on this.
 */
export function useIsReadOnly() {
  const { isReadOnly } = useClassProfiles();
  return isReadOnly;
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
  // Initialize the per-course view-as cookie synchronously so the very first render
  // already knows whether a view-as session is active. Without this the provider
  // would briefly publish the real instructor identity on the first paint before the
  // effect ran and re-rendered with the student override.
  const [viewAsProfileId, setViewAsProfileId] = useState<string | null>(() =>
    typeof course_id === "string" ? getViewAsCookie(course_id) : null
  );
  const [viewAsRole, setViewAsRole] = useState<UserRoleWithClassAndUser | null>(null);
  // True while the (instructor, viewAsProfileId) → student role lookup is in flight.
  // We must not publish the real instructor identity during that window, or read-only
  // gates would briefly re-enable instructor write UI. Initialized to true when a
  // cookie target is present on mount so the very first render already blocks.
  const [isResolvingViewAs, setIsResolvingViewAs] = useState<boolean>(() => !!viewAsProfileId);
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

  // Real (non-overridden) role for the current course.
  const realMyRole = roles.find(
    (r) => r.user_id === user?.id && (!course_id || r.class_id === Number(course_id as string))
  );

  // Re-read the per-course view-as cookie if course_id changes (e.g. navigating
  // between courses inside this provider).
  useEffect(() => {
    if (!course_id) {
      setViewAsProfileId(null);
      return;
    }
    setViewAsProfileId(getViewAsCookie(course_id as string));
  }, [course_id]);

  // When staff have an active view-as target, resolve the effective student role + profiles.
  // Until the lookup resolves we MUST keep the provider in a loading state — see
  // isResolvingViewAs below — otherwise consumers briefly see the real staff role.
  useEffect(() => {
    const isStaff = realMyRole?.role === "instructor" || realMyRole?.role === "grader";
    if (!isStaff || !viewAsProfileId || !course_id) {
      setViewAsRole(null);
      setIsResolvingViewAs(false);
      return;
    }
    if (viewAsProfileId === realMyRole.private_profile_id) {
      setViewAsRole({ ...realMyRole, role: "student" } as UserRoleWithClassAndUser);
      setIsResolvingViewAs(false);
      return;
    }
    if (realMyRole.role !== "instructor") {
      setViewAsRole(null);
      setIsResolvingViewAs(false);
      return;
    }
    let cancelled = false;
    const supabase = createClient();
    setIsResolvingViewAs(true);
    (async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select(
          "*, privateProfile:profiles!private_profile_id(*), publicProfile:profiles!public_profile_id(*), classes!inner(*), users(*)"
        )
        .eq("class_id", Number(course_id as string))
        .eq("private_profile_id", viewAsProfileId)
        .eq("role", "student")
        .eq("disabled", false)
        .single();
      if (cancelled) return;
      setViewAsRole(error || !data ? null : (data as UserRoleWithClassAndUser));
      setIsResolvingViewAs(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [realMyRole, viewAsProfileId, course_id]);

  const enterViewAs = useCallback(
    (studentPrivateProfileId: string, redirectTo?: string) => {
      if (!course_id) return;
      setViewAsCookie(course_id as string, studentPrivateProfileId);
      // Do a full document navigation rather than a soft client transition. The server
      // recomputes the effective identity from the cookie and every course/realtime
      // controller is rebuilt cleanly under the student identity. A soft transition
      // (router.push + refresh) flips the client identity while the existing controllers
      // are still being torn down, which surfaces stale-reference crashes such as
      // "TableController for table 'discussion_threads' is closed. Cannot call getById(...)".
      window.location.assign(redirectTo ?? `/course/${course_id}`);
    },
    [course_id]
  );

  const exitViewAs = useCallback(() => {
    if (!course_id) return;
    clearViewAsCookie(course_id as string);
    // Full reload for the same reason as enterViewAs: rebuild all controllers under the
    // restored staff identity instead of racing a soft teardown/rebuild.
    window.location.assign(`${window.location.pathname}${window.location.search}${window.location.hash}`);
  }, [course_id]);

  if (isLoading || isResolvingViewAs) {
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
  const myRole = realMyRole;
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

  const isViewingAsStudent = (myRole.role === "instructor" || myRole.role === "grader") && !!viewAsRole;
  const effectiveRole = isViewingAsStudent ? viewAsRole : myRole;

  return (
    <ClassProfileContext.Provider
      value={{
        role: effectiveRole,
        private_profile_id: effectiveRole.private_profile_id,
        public_profile_id: effectiveRole.public_profile_id,
        allOfMyRoles: roles,
        private_profile: effectiveRole.privateProfile,
        public_profile: effectiveRole.publicProfile,
        isViewingAsStudent,
        isReadOnly: isViewingAsStudent,
        realRole: myRole.role,
        realPrivateProfileId: myRole.private_profile_id,
        viewAsProfileName: isViewingAsStudent ? (viewAsRole.privateProfile?.name ?? undefined) : undefined,
        enterViewAs,
        exitViewAs
      }}
    >
      {children}
    </ClassProfileContext.Provider>
  );
}

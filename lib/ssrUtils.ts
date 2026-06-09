import "server-only";

import { Database } from "@/utils/supabase/SupabaseTypes";
import { viewAsCookieName } from "@/lib/viewAs";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type {
  Assignment,
  AssignmentDueDateException,
  AssignmentGroup,
  ClassSection,
  DiscussionThread,
  DiscussionTopic,
  LabSection,
  LabSectionMeeting,
  RegradeRequest,
  Rubric,
  RubricCheck,
  RubricCheckReference,
  RubricCriteria,
  RubricPart,
  StudentDeadlineExtension,
  Submission,
  Tag,
  UserProfile,
  UserRoleWithPrivateProfileGroupMembershipsAndUser
} from "@/utils/supabase/DatabaseTypes";

type UserRoleData = Pick<
  Database["public"]["Tables"]["user_roles"]["Row"],
  "role" | "class_id" | "public_profile_id" | "private_profile_id"
>;

/**
 * Pre-loaded data structure for CourseController
 * This contains all the data needed to hydrate a CourseController without client-side fetches
 */
export type CourseControllerInitialData = {
  profiles?: UserProfile[];
  userRolesWithProfiles?: UserRoleWithPrivateProfileGroupMembershipsAndUser[];
  discussionThreadTeasers?: DiscussionThread[];
  tags?: Tag[];
  labSections?: LabSection[];
  labSectionMeetings?: LabSectionMeeting[];
  classSections?: ClassSection[];
  studentDeadlineExtensions?: StudentDeadlineExtension[];
  assignmentDueDateExceptions?: AssignmentDueDateException[];
  assignments?: Assignment[];
  assignmentGroupsWithMembers?: Array<
    Database["public"]["Tables"]["assignment_groups"]["Row"] & {
      assignment_groups_members: Database["public"]["Tables"]["assignment_groups_members"]["Row"][];
      mentor: { name: string | null } | null;
    }
  >;
  discussionTopics?: DiscussionTopic[];
  repositories?: Database["public"]["Tables"]["repositories"]["Row"][];
  gradebookColumns?: Database["public"]["Tables"]["gradebook_columns"]["Row"][];
  discordChannels?: Database["public"]["Tables"]["discord_channels"]["Row"][];
  discordMessages?: Database["public"]["Tables"]["discord_messages"]["Row"][];
  surveys?: Database["public"]["Tables"]["surveys"]["Row"][];
  labSectionLeaders?: Database["public"]["Tables"]["lab_section_leaders"]["Row"][];
};

/**
 * Pre-loaded data structure for AssignmentController
 * This contains all the data needed to hydrate an AssignmentController without client-side fetches
 */
export type AssignmentControllerInitialData = {
  submissions?: Submission[];
  assignmentGroups?: AssignmentGroup[];
  reviewAssignments?: Database["public"]["Tables"]["review_assignments"]["Row"][];
  regradeRequests?: RegradeRequest[];
  rubrics?: Rubric[];
  rubricParts?: RubricPart[];
  rubricCriteria?: RubricCriteria[];
  rubricChecks?: RubricCheck[];
  rubricCheckReferences?: RubricCheckReference[];
};

export const createFetch =
  (options: Pick<RequestInit, "next" | "cache">) => (url: RequestInfo | URL, init?: RequestInit) => {
    return fetch(url, {
      ...init,
      ...options
    });
  };
export async function createClientWithCaching({ revalidate, tags }: { revalidate?: number; tags?: string[] } = {}) {
  if (revalidate === 0) {
    if (tags) {
      throw new Error("Cannot create client with no caching and tags");
    }
    // If revalidate is 0, we do NO caching
    return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  }
  const client = await createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      global: {
        fetch: createFetch({
          next: {
            // Use longer TTL as fallback since triggers handle invalidation automatically
            // 3600s = 1 hour fallback ensures stale data doesn't persist indefinitely
            revalidate: revalidate || 3600,
            tags: tags || ["supabase"]
          }
        })
      }
    }
  );
  return client;
}
export async function getUserRolesForCourse(course_id: number, user_id: string): Promise<UserRoleData | undefined> {
  const client = await createClientWithCaching({ revalidate: 60, tags: [`user_roles:${course_id}:${user_id}`] });

  const { data: userRoles } = await client
    .from("user_roles")
    .select("role, class_id, public_profile_id, private_profile_id")
    .eq("class_id", course_id)
    .eq("user_id", user_id)
    .eq("disabled", false);

  if (!userRoles || userRoles.length === 0) {
    return undefined;
  }

  // A user may hold more than one non-disabled role in a class — the unique index is on
  // (user_id, role, class_id), not (user_id, class_id), so e.g. student + grader can coexist.
  // Resolve to the highest-privilege role (matching the enrollment upgrade logic) instead of
  // calling `.single()`, which 406s on >1 (and on 0) rows and would lock the user out of a
  // course they belong to.
  const roleHierarchy: ReadonlyArray<UserRoleData["role"]> = ["instructor", "grader", "student"];
  const rank = (role: UserRoleData["role"]) => {
    const idx = roleHierarchy.indexOf(role);
    return idx === -1 ? roleHierarchy.length : idx;
  };
  return [...userRoles].sort((a, b) => rank(a.role) - rank(b.role))[0];
}

export type EffectiveCourseIdentity = UserRoleData & {
  /** True when a real instructor is viewing the course as a student. */
  isViewingAs: boolean;
  /** The viewer's actual role in the course (unchanged by view-as). */
  realRole: Database["public"]["Enums"]["app_role"];
  /** The target student's private profile id when viewing as, otherwise null. */
  viewAsProfileId: string | null;
};

/**
 * Resolve the "effective" identity for a course, accounting for the instructor
 * "view as student" cookie. When the real user is an instructor for the course and the
 * `view_as_<course_id>` cookie names a non-disabled student in that course, the returned
 * role/profile ids are the student's (so server-branching pages render the student view
 * scoped to that student). Otherwise the viewer's real identity is returned unchanged.
 *
 * Auth/RLS identity is unaffected — the override is purely presentation/scoping. RLS is
 * the backstop that prevents the instructor from writing as the student.
 */
export async function getEffectiveCourseIdentity(
  course_id: number,
  user_id: string
): Promise<EffectiveCourseIdentity | undefined> {
  const realRole = await getUserRolesForCourse(course_id, user_id);
  if (!realRole) {
    return undefined;
  }

  const base: EffectiveCourseIdentity = {
    ...realRole,
    isViewingAs: false,
    realRole: realRole.role,
    viewAsProfileId: null
  };

  if (realRole.role !== "instructor") {
    return base;
  }

  const cookieStore = await cookies();
  const targetProfileId = cookieStore.get(viewAsCookieName(course_id))?.value;
  if (!targetProfileId) {
    return base;
  }

  const client = await createClientWithCaching({
    revalidate: 60,
    tags: [`user_roles:${course_id}:view_as`]
  });
  const { data: targetRole } = await client
    .from("user_roles")
    .select("role, class_id, public_profile_id, private_profile_id")
    .eq("class_id", course_id)
    .eq("private_profile_id", targetProfileId)
    .eq("role", "student")
    .eq("disabled", false)
    .single();

  if (!targetRole) {
    return base;
  }

  return {
    role: "student",
    class_id: targetRole.class_id,
    public_profile_id: targetRole.public_profile_id,
    private_profile_id: targetRole.private_profile_id,
    isViewingAs: true,
    realRole: "instructor",
    viewAsProfileId: targetRole.private_profile_id
  };
}

export async function getCourse(course_id: number) {
  const client = await createClientWithCaching({ tags: [`course:${course_id}`] });
  const course = await client.from("classes").select("*").eq("id", course_id).eq("archived", false).single();
  return course.data;
}

/**
 * Helper function to fetch all pages of data in chunks of 1000
 * Accepts any PostgREST query builder that has a range() method
 */
async function fetchAllPages<T>(
  queryBuilder: {
    range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown | null }>;
    order: (column: string, options?: { ascending?: boolean }) => typeof queryBuilder;
  },
  pageSize: number = 1000
): Promise<T[]> {
  const results: T[] = [];
  let page = 0;

  // Always add ORDER BY id to ensure deterministic pagination
  // This prevents rows from being skipped or duplicated across page boundaries
  // when the database returns results in non-deterministic order
  const orderedQuery = queryBuilder.order("id", { ascending: true });

  while (true) {
    const rangeStart = page * pageSize;
    const rangeEnd = (page + 1) * pageSize - 1;

    const { data, error } = await orderedQuery.range(rangeStart, rangeEnd);

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      break;
    }

    results.push(...data);

    if (data.length < pageSize) {
      break;
    }

    page++;
  }

  return results;
}

/**
 * Pre-fetch all data needed by CourseController for server-side rendering
 * This leverages Next.js caching and prevents client-side fetch waterfalls
 * Fetches all pages in chunks of 1000 to handle large datasets
 *
 * @param course_id The course ID to fetch data for
 * @param user_id Optional user ID for user-specific data (notifications, etc)
 * @returns CourseControllerInitialData object with all pre-loaded data
 */
export async function fetchCourseControllerData(
  course_id: number,
  role: "instructor" | "student" | "grader" | "admin"
): Promise<CourseControllerInitialData> {
  const isStaff = role === "instructor" || role === "grader" || role === "admin";
  const roleKey = isStaff ? "staff" : "student";

  // Create individual clients for each table to match trigger invalidation tags
  const profilesClient = await createClientWithCaching({
    tags: [`profiles:${course_id}:${roleKey}`]
    // Cache invalidation handled by triggers
  });
  const userRolesClient = await createClientWithCaching({
    tags: [`user_roles:${course_id}:${roleKey}`, `profiles:${course_id}:${roleKey}`]
    // Cache invalidation handled by triggers - includes both user_roles and profiles tags
    // since the query joins profiles data
  });
  const discussionThreadsClient = await createClientWithCaching({
    tags: [`discussion_threads:${course_id}:${roleKey}`]
    // Cache invalidation handled by triggers
  });
  const tagsClient = await createClientWithCaching({
    tags: [`tags:${course_id}:${roleKey}`]
    // Cache invalidation handled by triggers
  });
  const labSectionsClient = await createClientWithCaching({
    tags: [`lab_sections:${course_id}:${roleKey}`]
    // Cache invalidation handled by triggers
  });
  const labSectionMeetingsClient = await createClientWithCaching({
    tags: [`lab_section_meetings:${course_id}:${roleKey}`]
    // Cache invalidation handled by triggers
  });
  const classSectionsClient = await createClientWithCaching({
    tags: [`class_sections:${course_id}:${roleKey}`]
    // Cache invalidation handled by triggers
  });
  const studentDeadlineExtensionsClient = await createClientWithCaching({
    tags: [`student_deadline_extensions:${course_id}:${isStaff ? "staff" : "student"}`]
    // Cache invalidation handled by triggers
  });
  const assignmentDueDateExceptionsClient = await createClientWithCaching({
    tags: [`assignment_due_date_exceptions:${course_id}:${isStaff ? "staff" : "student"}`]
    // Cache invalidation handled by triggers
  });
  const assignmentsClient = await createClientWithCaching({
    tags: [`assignments:${course_id}:${isStaff ? "staff" : "student"}`]
    // Cache invalidation handled by triggers
  });
  const assignmentGroupsClient = await createClientWithCaching({
    tags: [`assignment_groups:${course_id}:${isStaff ? "staff" : "student"}`]
    // Cache invalidation handled by triggers
  });
  const discussionTopicsClient = await createClientWithCaching({
    tags: [`discussion_topics:${course_id}:${isStaff ? "staff" : "student"}`]
    // Cache invalidation handled by triggers
  });
  const repositoriesClient = await createClientWithCaching({
    tags: [`repositories:${course_id}:${isStaff ? "staff" : "student"}`]
    // Cache invalidation handled by triggers
  });
  const gradebookColumnsClient = await createClientWithCaching({
    tags: [`gradebook_columns:${course_id}:${isStaff ? "staff" : "student"}`]
    // Cache invalidation handled by triggers
  });
  const discordChannelsClient = await createClientWithCaching({
    tags: [`discord_channels:${course_id}:${isStaff ? "staff" : "student"}`]
    // Cache invalidation handled by triggers
  });
  const discordMessagesClient = await createClientWithCaching({
    tags: [`discord_messages:${course_id}:${isStaff ? "staff" : "student"}`]
    // Cache invalidation handled by triggers
  });
  const surveysClient = await createClientWithCaching({
    tags: [`surveys:${course_id}:${isStaff ? "staff" : "student"}`]
    // Cache invalidation handled by triggers
  });
  const labSectionLeadersClient = await createClientWithCaching({
    tags: [`lab_section_leaders:${course_id}:${isStaff ? "staff" : "student"}`]
    // Cache invalidation handled by triggers
  });

  // Fetch all data in parallel for maximum performance
  const [
    profiles,
    userRolesWithProfiles,
    discussionThreadTeasers,
    tags,
    labSections,
    labSectionMeetings,
    classSections,
    studentDeadlineExtensions,
    assignmentDueDateExceptions,
    assignments,
    assignmentGroupsWithMembers,
    discussionTopics,
    repositories,
    gradebookColumns,
    discordChannels,
    discordMessages,
    surveys,
    labSectionLeaders
  ] = await Promise.all([
    // Profiles
    fetchAllPages<UserProfile>(profilesClient.from("profiles").select("*").eq("class_id", course_id)),

    // User roles with profiles and users
    isStaff
      ? fetchAllPages<UserRoleWithPrivateProfileGroupMembershipsAndUser>(
          userRolesClient
            .from("user_roles")
            .select(
              "*, profiles!private_profile_id(*, assignment_groups_members!assignment_groups_members_profile_id_fkey(*)), users(*)"
            )
            .eq("class_id", course_id)
        )
      : Promise.resolve(undefined),

    // Discussion thread teasers (root threads + previously-root duplicate-marked
    // threads; the latter are kept so the client-side controller can observe the
    // root→reply transition and the display layer can hide them — see
    // discussionThreadTeasers in useCourseController for details).
    isStaff
      ? fetchAllPages<DiscussionThread>(
          discussionThreadsClient
            .from("discussion_threads")
            .select("*")
            .eq("class_id", course_id)
            .or(`root_class_id.eq.${course_id},duplicate_marked_at.not.is.null`)
        )
      : Promise.resolve(undefined),

    // Tags
    fetchAllPages<Tag>(tagsClient.from("tags").select("*").eq("class_id", course_id)),

    // Lab sections
    fetchAllPages<LabSection>(labSectionsClient.from("lab_sections").select("*").eq("class_id", course_id)),

    // Lab section meetings
    fetchAllPages<LabSectionMeeting>(
      labSectionMeetingsClient.from("lab_section_meetings").select("*").eq("class_id", course_id)
    ),

    // Class sections
    fetchAllPages<ClassSection>(classSectionsClient.from("class_sections").select("*").eq("class_id", course_id)),

    // Student deadline extensions
    isStaff
      ? fetchAllPages<StudentDeadlineExtension>(
          studentDeadlineExtensionsClient.from("student_deadline_extensions").select("*").eq("class_id", course_id)
        )
      : Promise.resolve(undefined),

    // Assignment due date exceptions
    isStaff
      ? fetchAllPages<AssignmentDueDateException>(
          assignmentDueDateExceptionsClient.from("assignment_due_date_exceptions").select("*").eq("class_id", course_id)
        )
      : Promise.resolve(undefined),

    // Assignments (with ordering)
    fetchAllPages<Assignment>(
      assignmentsClient.from("assignments").select("*").eq("class_id", course_id).order("due_date", { ascending: true })
    ),

    // Assignment groups with members
    fetchAllPages<
      Database["public"]["Tables"]["assignment_groups"]["Row"] & {
        assignment_groups_members: Database["public"]["Tables"]["assignment_groups_members"]["Row"][];
        mentor: { name: string | null } | null;
      }
    >(
      assignmentGroupsClient
        .from("assignment_groups")
        .select("*, assignment_groups_members(*), mentor:profiles!assignment_groups_mentor_profile_id_fkey(name)")
        .eq("class_id", course_id)
    ),

    // Discussion topics
    fetchAllPages<DiscussionTopic>(
      discussionTopicsClient.from("discussion_topics").select("*").eq("class_id", course_id)
    ),

    // Repositories
    isStaff
      ? fetchAllPages<Database["public"]["Tables"]["repositories"]["Row"]>(
          repositoriesClient.from("repositories").select("*").eq("class_id", course_id)
        )
      : Promise.resolve(undefined),

    // Gradebook columns
    fetchAllPages<Database["public"]["Tables"]["gradebook_columns"]["Row"]>(
      gradebookColumnsClient.from("gradebook_columns").select("*").eq("class_id", course_id)
    ),

    // Discord channels (staff only - RLS enforces this)
    isStaff
      ? fetchAllPages<Database["public"]["Tables"]["discord_channels"]["Row"]>(
          discordChannelsClient.from("discord_channels").select("*").eq("class_id", course_id)
        )
      : Promise.resolve(undefined),

    // Discord messages (staff only - RLS enforces this)
    isStaff
      ? fetchAllPages<Database["public"]["Tables"]["discord_messages"]["Row"]>(
          discordMessagesClient.from("discord_messages").select("*").eq("class_id", course_id)
        )
      : Promise.resolve(undefined),

    // Surveys (staff-only for management)
    isStaff
      ? fetchAllPages<Database["public"]["Tables"]["surveys"]["Row"]>(
          surveysClient.from("surveys").select("*").eq("class_id", course_id).is("deleted_at", null)
        )
      : Promise.resolve(undefined),

    // Lab section leaders (filtered by class_id directly)
    fetchAllPages<Database["public"]["Tables"]["lab_section_leaders"]["Row"]>(
      labSectionLeadersClient.from("lab_section_leaders").select("*").eq("class_id", course_id)
    )
  ]);

  return {
    profiles,
    userRolesWithProfiles,
    discussionThreadTeasers,
    tags,
    labSections,
    labSectionMeetings,
    classSections,
    studentDeadlineExtensions,
    assignmentDueDateExceptions,
    assignments,
    assignmentGroupsWithMembers,
    discussionTopics,
    repositories,
    gradebookColumns,
    discordChannels,
    discordMessages,
    surveys,
    labSectionLeaders
  };
}

/**
 * Pre-fetch all data needed by AssignmentController for server-side rendering
 * This leverages Next.js caching and prevents client-side fetch waterfalls
 * Fetches all pages in chunks of 1000 to handle large datasets
 *
 * @param assignment_id The assignment ID to fetch data for
 * @returns AssignmentControllerInitialData object with all pre-loaded data
 */
export async function fetchAssignmentControllerData(
  assignment_id: number,
  isStaff: boolean
): Promise<AssignmentControllerInitialData> {
  const roleKey = isStaff ? "staff" : "student";

  // Create individual clients for each table to match trigger invalidation tags
  const rubricsClient = await createClientWithCaching({
    tags: [`rubrics:${assignment_id}:${roleKey}`]
    // Cache invalidation handled by triggers
  });
  const rubricPartsClient = await createClientWithCaching({
    tags: [`rubric_parts:${assignment_id}:${roleKey}`]
    // Cache invalidation handled by triggers
  });
  const rubricCriteriaClient = await createClientWithCaching({
    tags: [`rubric_criteria:${assignment_id}:${roleKey}`]
    // Cache invalidation handled by triggers
  });
  const rubricChecksClient = await createClientWithCaching({
    tags: [`rubric_checks:${assignment_id}:${roleKey}`]
    // Cache invalidation handled by triggers
  });
  const rubricCheckReferencesClient = await createClientWithCaching({
    tags: [`rubric_check_references:${assignment_id}:${roleKey}`]
    // Cache invalidation handled by triggers
  });
  const regradeRequestsClient = await createClientWithCaching({
    tags: [`regrade_requests:${assignment_id}:${roleKey}`]
    // Cache invalidation handled by triggers
  });
  const assignmentGroupsClient = await createClientWithCaching({
    tags: [`assignment_groups:${assignment_id}:${roleKey}`]
    // Cache invalidation handled by triggers
  });
  // Submissions are not cached - always fetch fresh data
  const submissionsClient = await createClientWithCaching({ revalidate: 0 });

  // Fetch all data in parallel for maximum performance
  const [
    submissions,
    assignmentGroups,
    regradeRequests,
    rubrics,
    rubricParts,
    rubricCriteria,
    rubricChecks,
    rubricCheckReferences
  ] = await Promise.all([
    // Submissions (active only)
    isStaff
      ? fetchAllPages<Submission>(
          submissionsClient.from("submissions").select("*").eq("assignment_id", assignment_id).eq("is_active", true)
        )
      : Promise.resolve(undefined),

    // Assignment groups
    fetchAllPages<AssignmentGroup>(
      assignmentGroupsClient.from("assignment_groups").select("*").eq("assignment_id", assignment_id)
    ),

    // Regrade requests
    isStaff
      ? fetchAllPages<RegradeRequest>(
          regradeRequestsClient.from("submission_regrade_requests").select("*").eq("assignment_id", assignment_id)
        )
      : Promise.resolve(undefined),

    // Rubrics
    fetchAllPages<Rubric>(rubricsClient.from("rubrics").select("*").eq("assignment_id", assignment_id)),

    // Rubric parts
    fetchAllPages<RubricPart>(rubricPartsClient.from("rubric_parts").select("*").eq("assignment_id", assignment_id)),

    // Rubric criteria
    fetchAllPages<RubricCriteria>(
      rubricCriteriaClient.from("rubric_criteria").select("*").eq("assignment_id", assignment_id)
    ),

    // Rubric checks
    fetchAllPages<RubricCheck>(rubricChecksClient.from("rubric_checks").select("*").eq("assignment_id", assignment_id)),

    // Rubric check references
    fetchAllPages<RubricCheckReference>(
      rubricCheckReferencesClient.from("rubric_check_references").select("*").eq("assignment_id", assignment_id)
    )
  ]);

  return {
    submissions,
    assignmentGroups,
    regradeRequests,
    rubrics,
    rubricParts,
    rubricCriteria,
    rubricChecks,
    rubricCheckReferences
  };
}

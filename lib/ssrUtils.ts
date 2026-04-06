import "server-only";

import { Database } from "@/utils/supabase/SupabaseTypes";
import { createClient } from "@supabase/supabase-js";
import { QueryClient, dehydrate, type DehydratedState } from "@tanstack/react-query";
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
  UserRoleWithPrivateProfileAndUser
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
  userRolesWithProfiles?: UserRoleWithPrivateProfileAndUser[];
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

  const { data: userRole } = await client
    .from("user_roles")
    .select("role, class_id, public_profile_id, private_profile_id")
    .eq("class_id", course_id)
    .eq("user_id", user_id)
    .eq("disabled", false)
    .single();

  return userRole || undefined;
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
      ? fetchAllPages<UserRoleWithPrivateProfileAndUser>(
          userRolesClient
            .from("user_roles")
            .select("*, profiles!private_profile_id(*), users(*)")
            .eq("class_id", course_id)
        )
      : Promise.resolve(undefined),

    // Discussion thread teasers (only root-level threads, right now only for staff b/c permissions)
    isStaff
      ? fetchAllPages<DiscussionThread>(
          discussionThreadsClient.from("discussion_threads").select("*").eq("root_class_id", course_id)
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

/**
 * Pre-fetch all course-level data and return a dehydrated QueryClient
 * for use with TanStack Query's HydrationBoundary.
 *
 * Uses the same query keys as the client-side hooks in hooks/course-data/.
 */
export async function prefetchCourseData(
  course_id: number,
  role: "instructor" | "student" | "grader" | "admin",
  userId: string,
  profileId: string
): Promise<DehydratedState> {
  const queryClient = new QueryClient();
  const data = await fetchCourseControllerData(course_id, role);
  const isStaff = role === "instructor" || role === "grader" || role === "admin";

  // Set data using the EXACT same query keys that the client-side hooks use.
  // Simple keys (no dynamic suffix)
  if (data.profiles) {
    queryClient.setQueryData(["course", course_id, "profiles"], data.profiles);
  }
  if (data.tags) {
    queryClient.setQueryData(["course", course_id, "tags"], data.tags);
  }
  if (data.assignments) {
    queryClient.setQueryData(["course", course_id, "assignments"], data.assignments);
  }
  if (data.labSections) {
    queryClient.setQueryData(["course", course_id, "lab_sections"], data.labSections);
  }
  if (data.labSectionMeetings) {
    queryClient.setQueryData(["course", course_id, "lab_section_meetings"], data.labSectionMeetings);
  }
  if (data.classSections) {
    queryClient.setQueryData(["course", course_id, "class_sections"], data.classSections);
  }
  if (data.assignmentGroupsWithMembers) {
    queryClient.setQueryData(["course", course_id, "assignment_groups"], data.assignmentGroupsWithMembers);
  }
  if (data.discussionTopics) {
    queryClient.setQueryData(["course", course_id, "discussion_topics"], data.discussionTopics);
  }
  if (data.gradebookColumns) {
    queryClient.setQueryData(["course", course_id, "gradebook_columns"], data.gradebookColumns);
  }
  if (data.labSectionLeaders) {
    queryClient.setQueryData(["course", course_id, "lab_section_leaders"], data.labSectionLeaders);
  }

  // Keys with dynamic suffix that depends on role/user
  // useUserRolesQuery: ["course", courseId, "user_roles", isStaff ? "all" : userId]
  if (data.userRolesWithProfiles) {
    queryClient.setQueryData(["course", course_id, "user_roles", isStaff ? "all" : userId], data.userRolesWithProfiles);
  }

  // useDiscussionThreadTeasersQuery: ["course", courseId, "discussion_thread_teasers"]
  if (data.discussionThreadTeasers) {
    queryClient.setQueryData(["course", course_id, "discussion_thread_teasers"], data.discussionThreadTeasers);
  }

  // useStudentDeadlineExtensionsQuery: ["course", courseId, "student_deadline_extensions", isStaff ? "staff" : profileId]
  if (data.studentDeadlineExtensions) {
    queryClient.setQueryData(
      ["course", course_id, "student_deadline_extensions", isStaff ? "staff" : profileId],
      data.studentDeadlineExtensions
    );
  }

  // useAssignmentDueDateExceptionsQuery: ["course", courseId, "assignment_due_date_exceptions", isStaff ? "staff" : profileId]
  if (data.assignmentDueDateExceptions) {
    queryClient.setQueryData(
      ["course", course_id, "assignment_due_date_exceptions", isStaff ? "staff" : profileId],
      data.assignmentDueDateExceptions
    );
  }

  // useRepositoriesQuery: ["course", courseId, "repositories", isStaff ? "staff" : profileId]
  if (data.repositories) {
    queryClient.setQueryData(["course", course_id, "repositories", isStaff ? "staff" : profileId], data.repositories);
  }

  // Staff-only tables with simple keys
  if (data.discordChannels) {
    queryClient.setQueryData(["course", course_id, "discord_channels"], data.discordChannels);
  }
  if (data.discordMessages) {
    queryClient.setQueryData(["course", course_id, "discord_messages"], data.discordMessages);
  }
  if (data.surveys) {
    queryClient.setQueryData(["course", course_id, "surveys"], data.surveys);
  }

  return dehydrate(queryClient);
}

/**
 * Pre-fetch all assignment-level data and return a dehydrated QueryClient
 * for use with TanStack Query's HydrationBoundary.
 *
 * Uses the same query keys as the client-side hooks in hooks/assignment-data/.
 */
export async function prefetchAssignmentData(
  course_id: number,
  assignment_id: number,
  isStaff: boolean
): Promise<DehydratedState> {
  const queryClient = new QueryClient();
  const data = await fetchAssignmentControllerData(assignment_id, isStaff);

  // Set data using the EXACT same query keys that the client-side hooks use.
  if (data.submissions) {
    queryClient.setQueryData(["course", course_id, "assignment", assignment_id, "submissions"], data.submissions);
  }
  if (data.assignmentGroups) {
    queryClient.setQueryData(
      ["course", course_id, "assignment", assignment_id, "assignment_groups"],
      data.assignmentGroups
    );
  }
  if (data.regradeRequests) {
    queryClient.setQueryData(
      ["course", course_id, "assignment", assignment_id, "regrade_requests"],
      data.regradeRequests
    );
  }
  if (data.rubrics) {
    queryClient.setQueryData(["course", course_id, "assignment", assignment_id, "rubrics"], data.rubrics);
  }
  if (data.rubricParts) {
    queryClient.setQueryData(["course", course_id, "assignment", assignment_id, "rubric_parts"], data.rubricParts);
  }
  if (data.rubricCriteria) {
    queryClient.setQueryData(
      ["course", course_id, "assignment", assignment_id, "rubric_criteria"],
      data.rubricCriteria
    );
  }
  if (data.rubricChecks) {
    queryClient.setQueryData(["course", course_id, "assignment", assignment_id, "rubric_checks"], data.rubricChecks);
  }
  if (data.rubricCheckReferences) {
    queryClient.setQueryData(
      ["course", course_id, "assignment", assignment_id, "rubric_check_references"],
      data.rubricCheckReferences
    );
  }

  return dehydrate(queryClient);
}

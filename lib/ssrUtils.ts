import "server-only";

import { Database } from "@/utils/supabase/SupabaseTypes";
import { createClient } from "@supabase/supabase-js";
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
    }
  >;
  discussionTopics?: DiscussionTopic[];
  repositories?: Database["public"]["Tables"]["repositories"]["Row"][];
  gradebookColumns?: Database["public"]["Tables"]["gradebook_columns"]["Row"][];
  discordChannels?: Database["public"]["Tables"]["discord_channels"]["Row"][];
  discordMessages?: Database["public"]["Tables"]["discord_messages"]["Row"][];
  surveys?: Database["public"]["Tables"]["surveys"]["Row"][];
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
            revalidate: revalidate || 300,
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
  const client = await createClientWithCaching({
    tags: [`course_controller:${course_id}:${isStaff ? "staff" : "student"}`]
  });
  const studentDeadlineExtensionsClient = await createClientWithCaching({
    tags: [`student_deadline_extensions:${course_id}:${isStaff ? "staff" : "student"}`],
    revalidate: 30 // fast expiration for data that is updated frequently, TODO make this get auto-invalidated
  });
  const assignmentDueDateExceptionsClient = await createClientWithCaching({
    tags: [`assignment_due_date_exceptions:${course_id}:${isStaff ? "staff" : "student"}`],
    revalidate: 10 // fast expiration for data that is updated frequently, TODO make this get auto-invalidated
  });
  const assignmentsClient = await createClientWithCaching({
    tags: [`assignments:${course_id}:${isStaff ? "staff" : "student"}`],
    revalidate: 10 // fast expiration for data that is updated frequently, TODO make this get auto-invalidated
  });
  const assignmentGroupsClient = await createClientWithCaching({
    tags: [`assignment_groups:${course_id}:${isStaff ? "staff" : "student"}`],
    revalidate: 5 // fast expiration for data that is updated frequently, TODO make this get auto-invalidated
  });
  const discussionTopicsClient = await createClientWithCaching({
    tags: [`discussion_topics:${course_id}:${isStaff ? "staff" : "student"}`],
    revalidate: 30 // fast expiration for data that is updated frequently, TODO make this get auto-invalidated
  });
  const repositoriesClient = await createClientWithCaching({
    tags: [`repositories:${course_id}:${isStaff ? "staff" : "student"}`],
    revalidate: 30 // fast expiration for data that is updated frequently, TODO make this get auto-invalidated
  });
  const gradebookColumnsClient = await createClientWithCaching({
    tags: [`gradebook_columns:${course_id}:${isStaff ? "staff" : "student"}`],
    revalidate: 30 // fast expiration for data that is updated frequently, TODO make this get auto-invalidated
  });
  const discordChannelsClient = await createClientWithCaching({
    tags: [`discord_channels:${course_id}:${isStaff ? "staff" : "student"}`],
    revalidate: 60 // discord channels don't change often
  });
  const discordMessagesClient = await createClientWithCaching({
    tags: [`discord_messages:${course_id}:${isStaff ? "staff" : "student"}`],
    revalidate: 30 // discord messages are created dynamically but don't change after
  });
  const surveysClient = await createClientWithCaching({
    tags: [`surveys:${course_id}:${isStaff ? "staff" : "student"}`],
    revalidate: 30 // fast expiration for data that is updated frequently, TODO make this get auto-invalidated
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
    surveys
  ] = await Promise.all([
    // Profiles
    fetchAllPages<UserProfile>(client.from("profiles").select("*").eq("class_id", course_id)),

    // User roles with profiles and users
    isStaff
      ? fetchAllPages<UserRoleWithPrivateProfileAndUser>(
          client.from("user_roles").select("*, profiles!private_profile_id(*), users(*)").eq("class_id", course_id)
        )
      : Promise.resolve(undefined),

    // Discussion thread teasers (only root-level threads, right now only for staff b/c permissions)
    isStaff
      ? fetchAllPages<DiscussionThread>(client.from("discussion_threads").select("*").eq("root_class_id", course_id))
      : Promise.resolve(undefined),

    // Tags
    fetchAllPages<Tag>(client.from("tags").select("*").eq("class_id", course_id)),

    // Lab sections
    fetchAllPages<LabSection>(client.from("lab_sections").select("*").eq("class_id", course_id)),

    // Lab section meetings
    fetchAllPages<LabSectionMeeting>(client.from("lab_section_meetings").select("*").eq("class_id", course_id)),

    // Class sections
    fetchAllPages<ClassSection>(client.from("class_sections").select("*").eq("class_id", course_id)),

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
      }
    >(
      assignmentGroupsClient
        .from("assignment_groups")
        .select("*, assignment_groups_members(*)")
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
      : Promise.resolve(undefined)
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
    surveys
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
  const client = await createClientWithCaching({ tags: [`assignment_controller:${assignment_id}:${roleKey}`] });
  const regradeRequestsClient = await createClientWithCaching({
    tags: [`regrade_requests:${assignment_id}:${roleKey}`],
    revalidate: 10 // regrade requests are updated somewhat frequently, a good candidate for using invalidation
  });
  const assignmentGroupsClient = await createClientWithCaching({
    tags: [`assignment_groups:${assignment_id}:${roleKey}`],
    revalidate: 10 // assignment groups are updated somewhat frequently, a good candidate for using invalidation
  });
  const submissionsClient = await createClientWithCaching({
    tags: [`submissions:${assignment_id}:${roleKey}`],
    revalidate: 10 // submissions are updated somewhat frequently, a good candidate for using invalidation
  });

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
    fetchAllPages<Rubric>(client.from("rubrics").select("*").eq("assignment_id", assignment_id)),

    // Rubric parts
    fetchAllPages<RubricPart>(client.from("rubric_parts").select("*").eq("assignment_id", assignment_id)),

    // Rubric criteria
    fetchAllPages<RubricCriteria>(client.from("rubric_criteria").select("*").eq("assignment_id", assignment_id)),

    // Rubric checks
    fetchAllPages<RubricCheck>(client.from("rubric_checks").select("*").eq("assignment_id", assignment_id)),

    // Rubric check references
    fetchAllPages<RubricCheckReference>(
      client.from("rubric_check_references").select("*").eq("assignment_id", assignment_id)
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

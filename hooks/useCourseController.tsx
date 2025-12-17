"use client";

import { toaster } from "@/components/ui/toaster";
import { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import TableController, {
  PossiblyTentativeResult,
  useFindTableControllerValue,
  useIsTableControllerReady,
  useListTableControllerValues,
  useTableControllerTableValues,
  useTableControllerValueById
} from "@/lib/TableController";
import type { CourseControllerInitialData } from "@/lib/ssrUtils";
import { createClient } from "@/utils/supabase/client";
import {
  Assignment,
  AssignmentDueDateException,
  ClassSection,
  Course,
  DiscussionThread,
  DiscussionThreadReadStatus,
  DiscussionThreadWatcher,
  DiscussionTopic,
  HelpRequestWatcher,
  LabSection,
  LabSectionMeeting,
  Notification,
  Tag,
  UserProfile,
  UserRoleWithUser,
  UserRole,
  UserRoleWithPrivateProfileAndUser,
  StudentDeadlineExtension
} from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Spinner } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { LiveEvent, useList } from "@refinedev/core";
import { SupabaseClient } from "@supabase/supabase-js";
import { addHours, addMinutes } from "date-fns";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import useAuthState from "./useAuthState";
import { useClassProfiles } from "./useClassProfiles";
import { DiscussionThreadReadWithAllDescendants } from "./useDiscussionThreadRootController";

export function useAssignmentGroupWithMembers({
  assignment_group_id
}: {
  assignment_group_id: number | null | undefined;
}) {
  const { assignmentGroupsWithMembers } = useCourseController();
  const assignmentGroup = useTableControllerValueById(assignmentGroupsWithMembers, assignment_group_id);
  return assignmentGroup;
}
export function useAssignmentGroupForUser({ assignment_id }: { assignment_id: number }) {
  const { assignmentGroupsWithMembers } = useCourseController();
  const { private_profile_id } = useClassProfiles();

  type AssignmentGroupWithMembers = (typeof assignmentGroupsWithMembers.rows)[number];
  const assignmentGroupFilter = useCallback(
    (ag: AssignmentGroupWithMembers) => {
      return (
        ag.assignment_id === assignment_id &&
        ag.assignment_groups_members.some((agm) => agm.profile_id === private_profile_id)
      );
    },
    [assignment_id, private_profile_id]
  );
  return useFindTableControllerValue(assignmentGroupsWithMembers, assignmentGroupFilter);
}

export function useAllProfilesForClass() {
  const { profiles } = useCourseController();
  return useTableControllerTableValues(profiles);
}

/**
 * Hook to get all student profiles filtered by having the 'student' tag
 */
export function useAllStudentProfiles() {
  const allProfiles = useAllProfilesForClass();
  const allTags = useTags();

  return useMemo(() => {
    if (!allProfiles || !allTags) {
      return [];
    }

    // Get all staff tags (case-insensitive)
    const staffTags = allTags.filter(
      (tag) => tag.name.toLowerCase() === "instructor" || tag.name.toLowerCase() === "grader"
    );
    const staffProfileIds = new Set(staffTags.map((tag) => tag.profile_id));

    // Filter profiles to only include those without staff tags
    const ret = allProfiles.filter((profile) => !staffProfileIds.has(profile.id) && profile.is_private_profile);
    ret.sort((a, b) => a.name?.localeCompare(b.name || "") || 0);
    return ret;
  }, [allProfiles, allTags]);
}
export function useGradersAndInstructors() {
  const { userRolesWithProfiles: controller } = useCourseController();
  const filter = useCallback(
    (r: UserRoleWithPrivateProfileAndUser) => r.role === "grader" || r.role === "instructor",
    []
  );
  const roles = useListTableControllerValues(controller, filter);
  const profiles = useMemo(() => roles.map((r) => r.profiles), [roles]);
  return profiles;
}

export function useIsDroppedStudent(private_profile_id: string | undefined | null) {
  const { userRolesWithProfiles: controller } = useCourseController();
  const matcher = useCallback(
    (r: UserRoleWithPrivateProfileAndUser) => r.private_profile_id === private_profile_id,
    [private_profile_id]
  );
  const role = useFindTableControllerValue(controller, matcher);
  return role?.disabled;
}
export function useAllStudentRoles() {
  const { userRolesWithProfiles: controller } = useCourseController();
  const [roles, setRoles] = useState<UserRoleWithPrivateProfileAndUser[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.list((data) => {
      const students = data.filter((r) => r.role === "student" && !r.disabled);
      setRoles((old) => {
        if (old && old.length == students.length) {
          if (old.every((r) => students.some((s) => s.id === r.id))) {
            return old;
          }
        }
        return students;
      });
    });
    setRoles(data.filter((r) => r.role === "student" && !r.disabled));
    return unsubscribe;
  }, [controller]);
  return roles;
}
export function useStudentRoster() {
  const { userRolesWithProfiles: controller } = useCourseController();
  const predicate = useCallback((r: UserRole) => r.role === "student", []);
  const studentRoles = useListTableControllerValues(controller, predicate);
  const [roster, setRoster] = useState<UserProfile[] | undefined>(() => studentRoles.map((r) => r.profiles));
  useEffect(() => {
    setRoster(studentRoles.map((r) => r.profiles));
  }, [studentRoles]);
  return roster;
}
export function useProfiles() {
  const { profiles: controller } = useCourseController();
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.list((data) => {
      setProfiles(data);
    });
    setProfiles(data);
    return unsubscribe;
  }, [controller]);
  return profiles;
}
/**
 * Hook to update a discussion thread using TableController
 * @returns A function to update a thread by ID
 */
export function useUpdateThreadTeaser() {
  const controller = useCourseController();
  return useCallback(
    async ({ id, values }: { id: number; old: DiscussionThreadTeaser; values: Partial<DiscussionThreadTeaser> }) => {
      try {
        await controller.discussionThreadTeasers.update(id, values);
      } catch {
        toaster.error({
          title: "Error updating thread",
          description: "Please try again later."
        });
      }
    },
    [controller]
  );
}
export function useRootDiscussionThreadReadStatuses(threadId: number) {
  const controller = useCourseController();
  const rootPredicate = useMemo(
    () => (data: PossiblyTentativeResult<DiscussionThreadReadStatus>) => data.discussion_thread_root_id === threadId,
    [threadId]
  );
  const readStatuses = useListTableControllerValues(controller.discussionThreadReadStatus, rootPredicate);
  return readStatuses;
}
/**
 * Returns a hook that returns the read status of a thread.
 * @param threadId The id of the thread to get the read status of.
 * @returns A tuple of the read status and a function to set the read status.
 * Null indicates that the thread is not read
 * Undefined indicates that the thread is not yet loaded
 */
export function useDiscussionThreadReadStatus(threadId: number) {
  const controller = useCourseController();
  const { user } = useAuthState();
  const predicate = useMemo(
    () => (data: PossiblyTentativeResult<DiscussionThreadReadStatus>) =>
      data.discussion_thread_id === threadId && data.user_id === user?.id,
    [threadId, user?.id]
  );
  const readStatus = useFindTableControllerValue(controller.discussionThreadReadStatus, predicate);

  const setUnread = useCallback(
    async (root_threadId: number, threadId: number, isUnread: boolean) => {
      if (readStatus === undefined) {
        return;
      }
      await controller.discussionThreadReadStatus.readyPromise;
      if (readStatus) {
        if (isUnread && readStatus.read_at) {
          controller.discussionThreadReadStatus.update(readStatus.id, {
            read_at: null
          });
        } else if (!isUnread && !readStatus.read_at) {
          controller.discussionThreadReadStatus.update(readStatus.id, {
            read_at: new Date().toISOString()
          });
        }
      } else {
        // There is a Postgres trigger that creates a read status for every user for every thread. So, if we don't have one, we just haven't fetched it yet!
        if (!user?.id) {
          return;
        }
        const readStatus = await controller.discussionThreadReadStatus.getOneByFilters([
          {
            column: "discussion_thread_id",
            operator: "eq",
            value: threadId
          },
          {
            column: "user_id",
            operator: "eq",
            value: user.id
          }
        ]);
        if (readStatus) {
          controller.discussionThreadReadStatus.update(readStatus.id, {
            read_at: isUnread ? null : new Date().toISOString()
          });
        }
      }
    },
    [user?.id, controller, readStatus]
  );
  return { readStatus, setUnread };
}
type DiscussionThreadTeaser = Pick<
  DiscussionThread,
  | "id"
  | "subject"
  | "created_at"
  | "author"
  | "children_count"
  | "instructors_only"
  | "is_question"
  | "likes_count"
  | "topic_id"
  | "draft"
  | "class_id"
  | "body"
  | "ordinal"
  | "answer"
  | "pinned"
>;

export function useDiscussionThreadTeasers() {
  const controller = useCourseController();
  const [teasers, setTeasers] = useState<DiscussionThreadTeaser[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.discussionThreadTeasers.list((data) => {
      setTeasers(data as DiscussionThreadTeaser[]);
    });
    setTeasers(data as DiscussionThreadTeaser[]);
    return unsubscribe;
  }, [controller]);
  return teasers;
}
type DiscussionThreadFields = keyof DiscussionThreadTeaser;
export function useDiscussionThreadTeaser(id: number | undefined, watchFields?: DiscussionThreadFields[]) {
  const controller = useCourseController();
  const [teaser, setTeaser] = useState<DiscussionThreadTeaser | undefined>(() => {
    if (id === undefined) {
      return undefined;
    }
    return controller.discussionThreadTeasers.getById(id).data;
  });
  useEffect(() => {
    if (id === undefined) {
      setTeaser(undefined);
      return;
    }
    let unmounted = false;
    const { unsubscribe, data } = controller.discussionThreadTeasers.getById(id, (data) => {
      if (unmounted) {
        return;
      }
      if (watchFields) {
        setTeaser((oldTeaser) => {
          if (!oldTeaser) {
            return data as DiscussionThreadTeaser;
          }
          const hasAnyChanges = watchFields.some(
            (field) => oldTeaser[field] !== (data as DiscussionThreadTeaser)?.[field]
          );
          if (hasAnyChanges) {
            return data as DiscussionThreadTeaser;
          }
          return oldTeaser;
        });
      } else {
        setTeaser(data as DiscussionThreadTeaser);
      }
    });
    setTeaser(data as DiscussionThreadTeaser);
    return () => {
      unmounted = true;
      unsubscribe();
    };
  }, [controller, id, watchFields]);
  return teaser;
}

export function useLabSections() {
  const controller = useCourseController();
  const [labSections, setLabSections] = useState<LabSection[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.labSections.list((data) => {
      setLabSections(data);
    });
    setLabSections(data);
    return unsubscribe;
  }, [controller]);
  return labSections;
}

export function useClassSections() {
  const controller = useCourseController();
  const [classSections, setClassSections] = useState<ClassSection[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.classSections.list((data) => {
      setClassSections(data);
    });
    setClassSections(data);
    return unsubscribe;
  }, [controller]);
  return classSections;
}

export type UpdateCallback<T> = (data: T) => void;
export type Unsubscribe = () => void;
export type UserProfileWithPrivateProfile = UserProfile & {
  private_profile?: UserProfile;
};

/**
 * This class is responsible for managing realtime course data.
 */
export class CourseController {
  private _isObfuscatedGrades: boolean = false;
  private _onlyShowGradesFor: string = "";
  private isObfuscatedGradesListeners: ((val: boolean) => void)[] = [];
  private onlyShowGradesForListeners: ((val: string) => void)[] = [];
  private _classRealTimeController: ClassRealTimeController | null = null;
  readonly client: SupabaseClient<Database>;
  private _userId: string;

  // Lazily created TableController instances to avoid realtime subscription bursts
  private _discussionThreadTeasers?: TableController<"discussion_threads">;
  private _discussionThreadReadStatus?: TableController<"discussion_thread_read_status">;
  private _discussionThreadWatchers?: TableController<"discussion_thread_watchers">;
  private _tags?: TableController<"tags">;
  private _labSections?: TableController<"lab_sections">;
  private _labSectionMeetings?: TableController<"lab_section_meetings">;
  private _labSectionLeaders?: TableController<"lab_section_leaders">;
  private _classSections?: TableController<"class_sections">;
  private _profiles?: TableController<"profiles">;
  private _userRolesWithProfiles?: TableController<"user_roles", "*, profiles!private_profile_id(*), users(*)">;
  private _studentDeadlineExtensions?: TableController<"student_deadline_extensions">;
  private _assignmentDueDateExceptions?: TableController<"assignment_due_date_exceptions">;
  private _assignments?: TableController<"assignments">;
  private _assignmentGroupsWithMembers?: TableController<"assignment_groups", "*, assignment_groups_members(*)">;
  private _repositories?: TableController<"repositories">;
  private _notifications?: TableController<"notifications">;
  private _gradebookColumns?: TableController<"gradebook_columns">;
  private _discussionThreadLikes?: TableController<"discussion_thread_likes">;
  private _discussionTopics?: TableController<"discussion_topics">;
  private _calendarEvents?: TableController<"calendar_events">;
  private _classStaffSettings?: TableController<"class_staff_settings">;
  private _discordChannels?: TableController<"discord_channels">;
  private _discordMessages?: TableController<"discord_messages">;
  private _livePolls?: TableController<"live_polls">;
  private _surveys?: TableController<"surveys">;

  private _initialData?: CourseControllerInitialData;

  constructor(
    public role: Database["public"]["Enums"]["app_role"],
    public courseId: number,
    client: SupabaseClient<Database>,
    classRealTimeController: ClassRealTimeController,
    userId: string,
    initialData?: CourseControllerInitialData
  ) {
    this._classRealTimeController = classRealTimeController;
    this.client = client as SupabaseClient<Database>;
    this._userId = userId;
    this._initialData = initialData;
  }

  get userId() {
    return this._userId;
  }
  /**
   * Initialize critical TableControllers immediately after construction
   * This creates them eagerly but in a controlled manner after ClassRealTimeController is stable
   */
  initializeEagerControllers() {
    // Create profiles and userRolesWithProfiles immediately
    // These are accessed frequently and should be ready
    void this.profiles; // Triggers lazy creation
    if (this.isStaff) {
      void this.userRolesWithProfiles; // Triggers lazy creation
    }
    // Eagerly initialize due-date related controllers to ensure realtime subscriptions are active
    void this.assignmentDueDateExceptions; // Triggers lazy creation
    void this.studentDeadlineExtensions; // Triggers lazy creation
    void this.assignments; // Triggers lazy creation
    void this.assignmentGroupsWithMembers; // Triggers lazy creation
    void this.notifications; // Triggers lazy creation
    void this.discussionThreadTeasers; // Triggers lazy creation
    void this.tags; // Triggers lazy creation
    void this.labSections; // Triggers lazy creation
    void this.labSectionMeetings; // Triggers lazy creation
    void this.labSectionLeaders; // Triggers lazy creation
    void this.classSections; // Triggers lazy creation
    void this.discussionTopics; // Triggers lazy creation
    void this.repositories; // Triggers lazy creation
    void this.gradebookColumns; // Triggers lazy creation
    if (this.isStaff) {
      void this.discordChannels; // Triggers lazy creation (staff only)
      void this.discordMessages; // Triggers lazy creation (staff only)
    }
    void this.livePolls; // Triggers lazy creation
    void this.surveys; // Triggers lazy creation

    // Clear initialData to free memory after all eager controllers are initialized
    this._initialData = undefined;
  }

  get classRealTimeController(): ClassRealTimeController {
    if (!this._classRealTimeController) {
      throw new Error("ClassRealTimeController not initialized.");
    }
    return this._classRealTimeController;
  }

  // Lazy getters

  get discussionThreadReadStatus(): TableController<"discussion_thread_read_status"> {
    if (!this._discussionThreadReadStatus) {
      this._discussionThreadReadStatus = new TableController({
        client: this.client,
        table: "discussion_thread_read_status",
        query: this.client.from("discussion_thread_read_status").select("*").eq("user_id", this._userId),
        classRealTimeController: this.classRealTimeController
      });
    }
    return this._discussionThreadReadStatus;
  }

  get discussionThreadWatchers(): TableController<"discussion_thread_watchers"> {
    if (!this._discussionThreadWatchers) {
      this._discussionThreadWatchers = new TableController({
        client: this.client,
        table: "discussion_thread_watchers",
        query: this.client
          .from("discussion_thread_watchers")
          .select("*")
          .eq("user_id", this._userId)
          .eq("class_id", this.courseId),
        realtimeFilter: { user_id: this._userId, class_id: this.courseId },
        classRealTimeController: this.classRealTimeController
      });
    }
    return this._discussionThreadWatchers;
  }

  get notifications(): TableController<"notifications"> {
    if (!this._notifications) {
      this._notifications = new TableController({
        client: this.client,
        table: "notifications",
        query: this.client.from("notifications").select("*").eq("class_id", this.courseId).eq("user_id", this._userId),
        classRealTimeController: this.classRealTimeController
      });
    }
    return this._notifications;
  }

  get profiles(): TableController<"profiles"> {
    if (!this._profiles) {
      this._profiles = new TableController({
        client: this.client,
        table: "profiles",
        query: this.client.from("profiles").select("*").eq("class_id", this.courseId),
        classRealTimeController: this.classRealTimeController,
        initialData: this._initialData?.profiles
      });
    }
    return this._profiles;
  }

  get discussionThreadTeasers(): TableController<"discussion_threads"> {
    if (!this._discussionThreadTeasers) {
      this._discussionThreadTeasers = new TableController({
        client: this.client,
        table: "discussion_threads",
        query: this.client.from("discussion_threads").select("*").eq("root_class_id", this.courseId),
        classRealTimeController: this.classRealTimeController,
        realtimeFilter: { root_class_id: this.courseId },
        initialData: this._initialData?.discussionThreadTeasers
      });
    }
    return this._discussionThreadTeasers;
  }

  get tags(): TableController<"tags"> {
    if (!this._tags) {
      this._tags = new TableController({
        client: this.client,
        table: "tags",
        query: this.client.from("tags").select("*").eq("class_id", this.courseId),
        classRealTimeController: this.classRealTimeController,
        initialData: this._initialData?.tags
      });
    }
    return this._tags;
  }

  get labSections(): TableController<"lab_sections"> {
    if (!this._labSections) {
      this._labSections = new TableController({
        client: this.client,
        table: "lab_sections",
        query: this.client.from("lab_sections").select("*").eq("class_id", this.courseId),
        classRealTimeController: this.classRealTimeController,
        initialData: this._initialData?.labSections
      });
    }
    return this._labSections;
  }

  get labSectionMeetings(): TableController<"lab_section_meetings"> {
    if (!this._labSectionMeetings) {
      this._labSectionMeetings = new TableController({
        client: this.client,
        table: "lab_section_meetings",
        query: this.client.from("lab_section_meetings").select("*").eq("class_id", this.courseId),
        classRealTimeController: this.classRealTimeController,
        initialData: this._initialData?.labSectionMeetings
      });
    }
    return this._labSectionMeetings;
  }

  get labSectionLeaders(): TableController<"lab_section_leaders"> {
    if (!this._labSectionLeaders) {
      this._labSectionLeaders = new TableController({
        client: this.client,
        table: "lab_section_leaders",
        query: this.client.from("lab_section_leaders").select("*").eq("class_id", this.courseId),
        classRealTimeController: this.classRealTimeController,
        realtimeFilter: { class_id: this.courseId },
        initialData: this._initialData?.labSectionLeaders
      });
    }
    return this._labSectionLeaders;
  }

  get classSections(): TableController<"class_sections"> {
    if (!this._classSections) {
      this._classSections = new TableController({
        client: this.client,
        table: "class_sections",
        query: this.client.from("class_sections").select("*").eq("class_id", this.courseId),
        classRealTimeController: this.classRealTimeController,
        initialData: this._initialData?.classSections
      });
    }
    return this._classSections;
  }

  get userRolesWithProfiles(): TableController<"user_roles", "*, profiles!private_profile_id(*), users(*)"> {
    if (!this._userRolesWithProfiles) {
      let query = this.client
        .from("user_roles")
        .select("*, profiles!private_profile_id(*), users(*)")
        .eq("class_id", this.courseId);
      if (!this.isStaff) {
        query = query.eq("user_id", this._userId);
      }
      this._userRolesWithProfiles = new TableController({
        client: this.client,
        table: "user_roles",
        query,
        selectForSingleRow: "*, profiles!private_profile_id(*), users(*)",
        classRealTimeController: this.classRealTimeController,
        initialData: this._initialData?.userRolesWithProfiles,
        autoFetchMissingRows: this.isStaff
      });
    }
    return this._userRolesWithProfiles;
  }

  get studentDeadlineExtensions(): TableController<"student_deadline_extensions"> {
    if (!this._studentDeadlineExtensions) {
      let query = this.client.from("student_deadline_extensions").select("*").eq("class_id", this.courseId);
      if (!this.isStaff) {
        const profileId = this.classRealTimeController.profileId;
        if (profileId) {
          query = query.or(`student_id.eq.${profileId}`);
        }
      }
      this._studentDeadlineExtensions = new TableController({
        client: this.client,
        table: "student_deadline_extensions",
        query,
        classRealTimeController: this.classRealTimeController,
        initialData: this._initialData?.studentDeadlineExtensions
      });
    }
    return this._studentDeadlineExtensions;
  }

  get assignmentDueDateExceptions(): TableController<"assignment_due_date_exceptions"> {
    if (!this._assignmentDueDateExceptions) {
      let query = this.client.from("assignment_due_date_exceptions").select("*").eq("class_id", this.courseId);
      if (!this.isStaff) {
        // For students, filter to only their exceptions by joining with user_roles
        // Match: student_id matches their private_profile_id OR assignment_group_id for a group they're in
        const profileId = this.classRealTimeController.profileId;
        if (profileId) {
          // Filter by student_id matching profile OR assignment_group_id (RLS will filter groups)
          query = query.or(`student_id.eq.${profileId},assignment_group_id.not.is.null`);
        }
      }
      this._assignmentDueDateExceptions = new TableController({
        client: this.client,
        table: "assignment_due_date_exceptions",
        query,
        classRealTimeController: this.classRealTimeController,
        initialData: this._initialData?.assignmentDueDateExceptions
      });
    }
    return this._assignmentDueDateExceptions;
  }

  get assignments(): TableController<"assignments"> {
    if (!this._assignments) {
      this._assignments = new TableController({
        client: this.client,
        table: "assignments",
        query: this.client
          .from("assignments")
          .select("*")
          .eq("class_id", this.courseId)
          .order("due_date", { ascending: true })
          .order("id", { ascending: true }),
        classRealTimeController: this.classRealTimeController,
        initialData: this._initialData?.assignments
      });
    }
    return this._assignments;
  }

  get assignmentGroupsWithMembers(): TableController<"assignment_groups", "*, assignment_groups_members(*)"> {
    if (!this._assignmentGroupsWithMembers) {
      this._assignmentGroupsWithMembers = new TableController({
        client: this.client,
        table: "assignment_groups",
        query: this.client
          .from("assignment_groups")
          .select("*, assignment_groups_members(*)")
          .eq("class_id", this.courseId),
        selectForSingleRow: "*, assignment_groups_members(*)",
        classRealTimeController: this.classRealTimeController,
        initialData: this._initialData?.assignmentGroupsWithMembers
      });
    }
    return this._assignmentGroupsWithMembers;
  }

  get repositories(): TableController<"repositories"> {
    if (!this._repositories) {
      let query = this.client.from("repositories").select("*");

      if (this.isStaff) {
        // Staff can see all repositories for the class
        query = query.eq("class_id", this.courseId);
      } else {
        // Students: apply RLS restrictions to reduce data transfer
        // RLS allows viewing repos where:
        // 1. profile_id matches student's private_profile_id or public_profile_id
        // 2. OR assignment_group_id is set and student is a member
        // We filter by class_id and profile_id for individual repos,
        // and include assignment_group_id not null for group repos.
        const profileId = this.classRealTimeController.profileId;
        if (profileId) {
          query = query.eq("class_id", this.courseId).or(`profile_id.eq.${profileId},assignment_group_id.not.is.null`);
        } else {
          // Fallback: just filter by class_id if profileId is not available
          query = query.eq("class_id", this.courseId);
        }
      }

      this._repositories = new TableController({
        client: this.client,
        table: "repositories",
        query,
        classRealTimeController: this.classRealTimeController,
        initialData: this._initialData?.repositories
      });
    }
    return this._repositories;
  }

  get gradebookColumns(): TableController<"gradebook_columns"> {
    if (!this._gradebookColumns) {
      this._gradebookColumns = new TableController({
        client: this.client,
        table: "gradebook_columns",
        query: this.client.from("gradebook_columns").select("*").eq("class_id", this.courseId),
        classRealTimeController: this.classRealTimeController,
        initialData: this._initialData?.gradebookColumns
      });
    }
    return this._gradebookColumns;
  }

  get discussionThreadLikes(): TableController<"discussion_thread_likes"> {
    if (!this._discussionThreadLikes) {
      this._discussionThreadLikes = new TableController({
        client: this.client,
        table: "discussion_thread_likes",
        query: this.client
          .from("discussion_thread_likes")
          .select("*")
          .eq("creator", this.classRealTimeController.profileId),
        classRealTimeController: this.classRealTimeController,
        realtimeFilter: { creator: this.classRealTimeController.profileId }
      });
    }
    return this._discussionThreadLikes;
  }

  get discussionTopics(): TableController<"discussion_topics"> {
    if (!this._discussionTopics) {
      this._discussionTopics = new TableController({
        client: this.client,
        table: "discussion_topics",
        query: this.client.from("discussion_topics").select("*").eq("class_id", this.courseId),
        classRealTimeController: this.classRealTimeController,
        realtimeFilter: { class_id: this.courseId },
        initialData: this._initialData?.discussionTopics
      });
    }
    return this._discussionTopics;
  }

  /**
   * Calendar events for this class.
   * Students can only see office_hours events, staff can see all.
   */
  get calendarEvents(): TableController<"calendar_events"> {
    if (!this._calendarEvents) {
      let query = this.client.from("calendar_events").select("*").eq("class_id", this.courseId);

      // Students can only see office_hours events (enforced by RLS, but filter here too for efficiency)
      if (!this.isStaff) {
        query = query.eq("calendar_type", "office_hours");
      }

      query = query.order("start_time", { ascending: true }).limit(1000);

      // Realtime filter must match query constraints to prevent students from receiving
      // calendar events they shouldn't see (e.g., non-office_hours events)
      const realtimeFilter = !this.isStaff
        ? { class_id: this.courseId, calendar_type: "office_hours" }
        : { class_id: this.courseId };

      this._calendarEvents = new TableController({
        client: this.client,
        table: "calendar_events",
        query,
        classRealTimeController: this.classRealTimeController,
        realtimeFilter
      });
    }
    return this._calendarEvents;
  }

  /**
   * Staff-only settings for this class.
   * Only visible to staff (enforced by RLS).
   */
  get classStaffSettings(): TableController<"class_staff_settings"> {
    if (!this._classStaffSettings) {
      const query = this.client.from("class_staff_settings").select("*").eq("class_id", this.courseId);

      this._classStaffSettings = new TableController({
        client: this.client,
        table: "class_staff_settings",
        query,
        classRealTimeController: this.classRealTimeController,
        realtimeFilter: { class_id: this.courseId }
      });
    }
    return this._classStaffSettings;
  }

  /**
   * Discord channels for this class.
   * Only visible to staff (enforced by RLS).
   */
  get discordChannels(): TableController<"discord_channels"> {
    if (!this._discordChannels) {
      const query = this.client.from("discord_channels").select("*").eq("class_id", this.courseId);

      this._discordChannels = new TableController({
        client: this.client,
        table: "discord_channels",
        query,
        classRealTimeController: this.classRealTimeController,
        realtimeFilter: { class_id: this.courseId },
        initialData: this._initialData?.discordChannels
      });
    }
    return this._discordChannels;
  }

  /**
   * Discord messages for this class (tracks which Discord messages correspond to help requests, regrade requests, etc).
   * Only visible to staff (enforced by RLS).
   */
  get discordMessages(): TableController<"discord_messages"> {
    if (!this._discordMessages) {
      const query = this.client.from("discord_messages").select("*").eq("class_id", this.courseId);

      this._discordMessages = new TableController({
        client: this.client,
        table: "discord_messages",
        query,
        classRealTimeController: this.classRealTimeController,
        realtimeFilter: { class_id: this.courseId },
        initialData: this._initialData?.discordMessages
      });
    }
    return this._discordMessages;
  }

  get livePolls(): TableController<"live_polls"> {
    if (!this._livePolls) {
      this._livePolls = new TableController({
        client: this.client,
        table: "live_polls",
        query: this.client
          .from("live_polls")
          .select("*")
          .eq("class_id", this.courseId)
          .order("created_at", { ascending: false }),
        classRealTimeController: this.classRealTimeController,
        realtimeFilter: { class_id: this.courseId }
      });
    }
    return this._livePolls;
  }

  get surveys(): TableController<"surveys"> {
    if (!this._surveys) {
      this._surveys = new TableController({
        client: this.client,
        table: "surveys",
        query: this.client
          .from("surveys")
          .select("*")
          .eq("class_id", this.courseId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false }),
        classRealTimeController: this.classRealTimeController,
        realtimeFilter: { class_id: this.courseId },
        initialData: this._initialData?.surveys
      });
    }
    return this._surveys;
  }

  private genericDataSubscribers: { [key in string]: Map<number, UpdateCallback<unknown>[]> } = {};
  private genericData: { [key in string]: Map<number, unknown> } = {};
  private genericDataListSubscribers: { [key in string]: UpdateCallback<unknown>[] } = {};
  private genericDataTypeToId: { [key in string]: (item: unknown) => number } = {};
  private _course: Course | undefined;

  set course(course: Course) {
    this._course = course;
  }
  get course() {
    if (this._course === undefined) {
      throw new Error("Course not loaded");
    }
    return this._course;
  }

  registerGenericDataType(typeName: string, idGetter: (item: never) => number) {
    if (!this.genericDataTypeToId[typeName]) {
      this.genericDataTypeToId[typeName] = idGetter as (item: unknown) => number;
      this.genericDataSubscribers[typeName] = new Map();
      this.genericDataListSubscribers[typeName] = [];
    }
  }

  setGeneric(typeName: string, data: unknown[]) {
    if (!this.genericData[typeName]) {
      this.genericData[typeName] = new Map();
    }
    const idGetter = this.genericDataTypeToId[typeName];
    for (const item of data) {
      const id = idGetter(item);
      this.genericData[typeName].set(id, item);
      const itemSubscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
      itemSubscribers.forEach((cb) => cb(item));
    }
    const listSubscribers = this.genericDataListSubscribers[typeName] || [];
    listSubscribers.forEach((cb) => cb(Array.from(this.genericData[typeName].values())));
  }
  listGenericData<T>(typeName: string, callback?: UpdateCallback<T[]>): { unsubscribe: Unsubscribe; data: T[] } {
    const subscribers = this.genericDataListSubscribers[typeName] || [];
    if (callback) {
      subscribers.push(callback as UpdateCallback<unknown>);
      this.genericDataListSubscribers[typeName] = subscribers;
    }
    const currentData = this.genericData[typeName]?.values() || [];
    return {
      unsubscribe: () => {
        this.genericDataListSubscribers[typeName] =
          this.genericDataListSubscribers[typeName]?.filter((cb) => cb !== callback) || [];
      },
      data: Array.from(currentData) as T[]
    };
  }
  getValueWithSubscription<T>(
    typeName: string,
    id: number | ((item: T) => boolean),
    callback?: UpdateCallback<T>
  ): { unsubscribe: Unsubscribe; data: T | undefined } {
    if (!this.genericDataTypeToId[typeName]) {
      throw new Error(`No id getter for type ${typeName}`);
    }
    if (typeof id === "function") {
      const relevantIds = Array.from(this.genericData[typeName]?.keys() || []).filter((_id) =>
        id(this.genericData[typeName]?.get(_id) as T)
      );
      if (relevantIds.length == 0) {
        return {
          unsubscribe: () => {},
          data: undefined
        };
      } else if (relevantIds.length == 1) {
        const id = relevantIds[0];
        const subscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
        if (callback) {
          this.genericDataSubscribers[typeName]?.set(id, [...subscribers, callback as UpdateCallback<unknown>]);
        }
        return {
          unsubscribe: () => {
            this.genericDataSubscribers[typeName]?.set(
              id,
              subscribers.filter((cb) => cb !== callback)
            );
          },
          data: this.genericData[typeName]?.get(id) as T | undefined
        };
      } else {
        throw new Error(`Multiple ids found for type ${typeName}`);
      }
    } else if (typeof id === "number") {
      const subscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
      if (callback) {
        this.genericDataSubscribers[typeName]?.set(id, [...subscribers, callback as UpdateCallback<unknown>]);
      }
      return {
        unsubscribe: () => {
          this.genericDataSubscribers[typeName]?.set(
            id,
            subscribers.filter((cb) => cb !== callback)
          );
        },
        data: this.genericData[typeName]?.get(id) as T | undefined
      };
    } else {
      throw new Error(`Invalid id type ${typeof id}`);
    }
  }
  handleGenericDataEvent(typeName: string, event: LiveEvent) {
    const body = event.payload;
    const idGetter = this.genericDataTypeToId[typeName];
    const id = idGetter(body);
    if (event.type === "created") {
      this.genericData[typeName].set(id, body);
      this.genericDataSubscribers[typeName]?.get(id)?.forEach((cb) => cb(body));
      this.genericDataListSubscribers[typeName]?.forEach((cb) => cb(Array.from(this.genericData[typeName].values())));
    } else if (event.type === "updated") {
      this.genericData[typeName].set(id, body);
      this.genericDataSubscribers[typeName]?.get(id)?.forEach((cb) => cb(body));
      this.genericDataListSubscribers[typeName]?.forEach((cb) => cb(Array.from(this.genericData[typeName].values())));
    } else if (event.type === "deleted") {
      this.genericData[typeName].delete(id);
      this.genericDataSubscribers[typeName]?.get(id)?.forEach((cb) => cb(undefined));
      this.genericDataListSubscribers[typeName]?.forEach((cb) => cb(Array.from(this.genericData[typeName].values())));
    }
  }

  getDiscussionThreadTeaser(
    id: number,
    callback?: UpdateCallback<DiscussionThreadTeaser>
  ): { unsubscribe: Unsubscribe; data: DiscussionThreadTeaser | undefined } {
    if (callback) {
      return this.discussionThreadTeasers.getById(id, (data) => {
        if (data) callback(data as DiscussionThreadTeaser);
      });
    }
    return this.discussionThreadTeasers.getById(id);
  }

  listDiscussionThreadTeasers(callback?: UpdateCallback<DiscussionThreadTeaser[]>): {
    unsubscribe: Unsubscribe;
    data: DiscussionThreadTeaser[];
  } {
    if (callback) {
      return this.discussionThreadTeasers.list((data) => {
        callback(data as DiscussionThreadTeaser[]);
      });
    }
    const result = this.discussionThreadTeasers.list();
    return {
      unsubscribe: result.unsubscribe,
      data: result.data as DiscussionThreadTeaser[]
    };
  }

  getDiscussionThreadReadStatus(
    threadId: number,
    callback?: UpdateCallback<DiscussionThreadReadWithAllDescendants>
  ): { unsubscribe: Unsubscribe; data: DiscussionThreadReadWithAllDescendants | undefined | null } {
    // For now, return simple read status - complex computation can be added later if needed
    if (callback) {
      const result = this.discussionThreadReadStatus.getById(threadId, (data) => {
        if (data) {
          const converted = {
            ...data,
            numReadDescendants: 0,
            current_children_count: 0
          } as DiscussionThreadReadWithAllDescendants;
          callback(converted);
        } else {
          // Handle the case where data is undefined - the callback is optional so we can skip it
          return;
        }
      });
      return {
        unsubscribe: result.unsubscribe,
        data: result.data
          ? ({
              ...result.data,
              numReadDescendants: 0,
              current_children_count: 0
            } as DiscussionThreadReadWithAllDescendants)
          : null
      };
    }
    const result = this.discussionThreadReadStatus.getById(threadId);
    const convertedData = result.data
      ? ({ ...result.data, numReadDescendants: 0, current_children_count: 0 } as DiscussionThreadReadWithAllDescendants)
      : null;
    return {
      unsubscribe: result.unsubscribe,
      data: convertedData
    };
  }

  get isStaff() {
    return this.role === "instructor" || this.role === "grader";
  }

  getUserRole(user_id: string) {
    const result = this.userRolesWithProfiles.list();
    return result.data.find((role) => role.user_id === user_id);
  }

  getUserRoleByPrivateProfileId(private_profile_id: string) {
    const result = this.userRolesWithProfiles.list();
    return result.data.find((role) => role.private_profile_id === private_profile_id);
  }

  getTagsForProfile(
    profile_id: string,
    callback?: UpdateCallback<Tag[]>
  ): { unsubscribe: Unsubscribe; data: Tag[] | undefined } {
    const result = this.tags.list((data) => {
      const filtered = data.filter((t) => t.profile_id === profile_id);
      if (callback) callback(filtered);
    });
    return {
      unsubscribe: result.unsubscribe,
      data: result.data.filter((t) => t.profile_id === profile_id)
    };
  }

  listTags(callback?: UpdateCallback<Tag[]>): { unsubscribe: Unsubscribe; data: Tag[] } {
    return this.tags.list(callback);
  }
  getRoster() {
    const result = this.userRolesWithProfiles.list();
    return result.data.filter((role) => role.role === "student");
  }

  getRosterWithUserInfo(callback?: UpdateCallback<UserRoleWithUser[]>): {
    unsubscribe: Unsubscribe;
    data: UserRoleWithUser[];
  } {
    const mapToStudentUserRoles = (data: unknown[]): UserRoleWithUser[] =>
      (data as UserRoleWithPrivateProfileAndUser[]).filter((role) => role.role === "student").map((role) => role);

    if (callback) {
      const result = this.userRolesWithProfiles.list((data) => {
        callback(mapToStudentUserRoles(data));
      });
      return {
        unsubscribe: result.unsubscribe,
        data: mapToStudentUserRoles(result.data)
      };
    }

    const result = this.userRolesWithProfiles.list();
    return {
      unsubscribe: result.unsubscribe,
      data: mapToStudentUserRoles(result.data)
    };
  }

  getProfileBySisId(sis_id: number) {
    const userRoles = this.userRolesWithProfiles.list();
    const role = userRoles.data.find((role) => role.users.sis_user_id === sis_id);
    return role?.profiles;
  }
  setObfuscatedGradesMode(val: boolean) {
    this._isObfuscatedGrades = val;
    this.isObfuscatedGradesListeners.forEach((cb) => cb(val));
  }
  setOnlyShowGradesFor(val: string) {
    this._onlyShowGradesFor = val;
    this.onlyShowGradesForListeners.forEach((cb) => cb(val));
  }
  get isObfuscatedGrades() {
    return this._isObfuscatedGrades;
  }
  get onlyShowGradesFor() {
    return this._onlyShowGradesFor;
  }
  subscribeObfuscatedGradesMode(cb: (val: boolean) => void) {
    this.isObfuscatedGradesListeners.push(cb);
    return () => {
      this.isObfuscatedGradesListeners = this.isObfuscatedGradesListeners.filter((fn) => fn !== cb);
    };
  }
  subscribeOnlyShowGradesFor(cb: (val: string) => void) {
    this.onlyShowGradesForListeners.push(cb);
    return () => {
      this.onlyShowGradesForListeners = this.onlyShowGradesForListeners.filter((fn) => fn !== cb);
    };
  }

  /**
   * Gets lab sections with optional callback for updates
   */
  listLabSections(callback?: UpdateCallback<LabSection[]>): { unsubscribe: Unsubscribe; data: LabSection[] } {
    return this.labSections.list(callback);
  }

  /**
   * Gets lab section meetings with optional callback for updates
   */
  listLabSectionMeetings(callback?: UpdateCallback<LabSectionMeeting[]>): {
    unsubscribe: Unsubscribe;
    data: LabSectionMeeting[];
  } {
    return this.labSectionMeetings.list(callback);
  }

  /**
   * Gets the lab section ID for a given student profile ID
   */
  getStudentLabSectionId(studentPrivateProfileId: string): number | null {
    const result = this.userRolesWithProfiles.list();
    const userRole = result.data.find((role) => role.private_profile_id === studentPrivateProfileId);
    // lab_section_id should be available on UserRoleWithUser after database types regeneration
    return userRole?.lab_section_id || null;
  }

  /**
   * Calculates the effective due date for an assignment and student, considering lab-based scheduling
   * WARNING: If lab sections are not yet loaded, this will throw an error. Clients must check isLoaded first.
   */
  calculateEffectiveDueDate(
    assignment: Assignment,
    {
      studentPrivateProfileId,
      labSectionId: labSectionIdOverride
    }: { studentPrivateProfileId: string; labSectionId?: number }
  ): Date {
    if (!studentPrivateProfileId && !labSectionIdOverride) {
      throw new Error("No student private profile ID or lab section ID override provided");
    }
    if (!assignment.minutes_due_after_lab) {
      return new Date(assignment.due_date);
    }

    const labSectionId = labSectionIdOverride || this.getStudentLabSectionId(studentPrivateProfileId);
    if (!labSectionId) {
      // Student not in a lab section, falling back to original due date
      return new Date(assignment.due_date);
    }
    const labSectionResult = this.labSections.list();
    const labSection = labSectionResult.data.find((section) => section.id === labSectionId);
    if (!labSection) {
      throw new Error("Lab section not found");
    }

    // Find the most recent lab section meeting before the assignment's original due date
    const assignmentDueDate = new Date(assignment.due_date);
    const labMeetingResult = this.labSectionMeetings.list();
    const relevantMeetings = labMeetingResult.data
      .filter(
        (meeting) =>
          meeting.lab_section_id === labSectionId &&
          !meeting.cancelled &&
          new Date(meeting.meeting_date) < assignmentDueDate
      )
      .sort((a, b) => new Date(b.meeting_date).getTime() - new Date(a.meeting_date).getTime());

    if (relevantMeetings.length === 0) {
      return new Date(assignment.due_date);
    }

    // Calculate lab-based due date
    const mostRecentLabMeeting = relevantMeetings[0];
    const labMeetingDate = new TZDate(
      mostRecentLabMeeting.meeting_date + "T" + labSection.end_time,
      this.course.time_zone ?? "America/New_York"
    );

    const effectiveDueDate = addMinutes(labMeetingDate, assignment.minutes_due_after_lab);

    return effectiveDueDate;
  }

  // All data loading is handled by TableController instances
  get isDataLoaded() {
    // Consider only instantiated controllers to avoid triggering lazy creation
    const createdControllers: Array<
      | TableController<"profiles">
      | TableController<"discussion_threads">
      | TableController<"discussion_thread_read_status">
      | TableController<"tags">
      | TableController<"lab_sections">
      | TableController<"class_sections">
      | TableController<"lab_section_meetings">
      | TableController<"user_roles", "*, profiles!private_profile_id(*), users(*)">
      | TableController<"student_deadline_extensions">
      | TableController<"assignment_due_date_exceptions">
      | TableController<"assignments">
      | TableController<"assignment_groups", "*, assignment_groups_members(*)">
    > = [];
    if (this._profiles) createdControllers.push(this._profiles);
    if (this._userRolesWithProfiles) createdControllers.push(this._userRolesWithProfiles);
    if (this._discussionThreadTeasers) createdControllers.push(this._discussionThreadTeasers);
    if (this._discussionThreadReadStatus) createdControllers.push(this._discussionThreadReadStatus);
    if (this._tags) createdControllers.push(this._tags);
    if (this._labSections) createdControllers.push(this._labSections);
    if (this._labSectionMeetings) createdControllers.push(this._labSectionMeetings);
    if (this._studentDeadlineExtensions) createdControllers.push(this._studentDeadlineExtensions);
    if (this._assignmentDueDateExceptions) createdControllers.push(this._assignmentDueDateExceptions);
    if (this._assignments) createdControllers.push(this._assignments);
    if (this._assignmentGroupsWithMembers) createdControllers.push(this._assignmentGroupsWithMembers);
    if (this._classSections) createdControllers.push(this._classSections);

    return createdControllers.every((c) => c.ready);
  }

  // Close method to clean up TableController instances
  close(): void {
    this._profiles?.close();
    this._userRolesWithProfiles?.close();
    this._discussionThreadTeasers?.close();
    this._discussionThreadReadStatus?.close();
    this._discussionThreadWatchers?.close();
    this._discussionThreadLikes?.close();
    this._discussionTopics?.close();
    this._tags?.close();
    this._labSections?.close();
    this._labSectionMeetings?.close();
    this._labSectionLeaders?.close();
    this._labSectionLeaders = undefined;
    this._studentDeadlineExtensions?.close();
    this._assignmentDueDateExceptions?.close();
    this._assignments?.close();
    this._assignmentGroupsWithMembers?.close();
    this._classSections?.close();
    this._calendarEvents?.close();
    this._calendarEvents = undefined;
    this._classStaffSettings?.close();
    this._classStaffSettings = undefined;
    this._discordChannels?.close();
    this._discordChannels = undefined;
    this._discordMessages?.close();
    this._discordMessages = undefined;
    this._livePolls?.close();
    this._surveys?.close();

    if (this._classRealTimeController) {
      this._classRealTimeController.close();
    }
  }
}

function CourseControllerProviderImpl({ controller }: { controller: CourseController }) {
  const { user } = useAuthState();
  const course = useCourse();

  useEffect(() => {
    controller.course = course;
  }, [course, controller]);

  const { data: notifications } = useList<Notification>({
    resource: "notifications",
    filters: [{ field: "user_id", operator: "eq", value: user?.id }],
    // liveMode: "manual",
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity,
      enabled: !!user?.id
    },
    pagination: {
      pageSize: 1000
    },
    onLiveEvent: (event) => {
      controller.handleGenericDataEvent("notifications", event);
    },
    sorters: [
      { field: "viewed_at", order: "desc" },
      { field: "created_at", order: "desc" }
    ]
  });
  useEffect(() => {
    controller.registerGenericDataType("notifications", (item: Notification) => item.id);
    if (notifications?.data) {
      controller.setGeneric("notifications", notifications.data);
    }
  }, [controller, notifications?.data]);

  const { data: threadWatches } = useList<DiscussionThreadWatcher>({
    resource: "discussion_thread_watchers",
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity,
      enabled: !!user?.id
    },
    filters: [
      {
        field: "user_id",
        operator: "eq",
        value: user?.id
      }
    ],
    pagination: {
      pageSize: 1000
    },
    // liveMode: "manual",
    onLiveEvent: (event) => {
      controller.handleGenericDataEvent("discussion_thread_watchers", event);
    }
  });
  useEffect(() => {
    controller.registerGenericDataType(
      "discussion_thread_watchers",
      (item: DiscussionThreadWatcher) => item.discussion_thread_root_id
    );
    if (threadWatches?.data) {
      controller.setGeneric("discussion_thread_watchers", threadWatches.data);
    }
  }, [controller, threadWatches?.data]);

  // Fetch help request watchers for the current user
  const { data: helpRequestWatches } = useList<HelpRequestWatcher>({
    resource: "help_request_watchers",
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity,
      enabled: !!user?.id
    },
    filters: [
      {
        field: "user_id",
        operator: "eq",
        value: user?.id
      }
    ],
    pagination: {
      pageSize: 1000
    },
    // liveMode: "manual",
    onLiveEvent: (event) => {
      controller.handleGenericDataEvent("help_request_watchers", event);
    }
  });
  useEffect(() => {
    controller.registerGenericDataType("help_request_watchers", (item: HelpRequestWatcher) => item.help_request_id);
    if (helpRequestWatches?.data) {
      controller.setGeneric("help_request_watchers", helpRequestWatches.data);
    }
  }, [controller, helpRequestWatches?.data]);

  return <></>;
}
const CourseControllerContext = createContext<CourseController | null>(null);

export function CourseControllerProvider({
  course_id,
  profile_id,
  role,
  children,
  initialData
}: {
  profile_id: string;
  role: Database["public"]["Enums"]["app_role"];
  course_id: number;
  children: React.ReactNode;
  initialData?: CourseControllerInitialData;
}) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_classRealTimeController, setClassRealTimeController] = useState<ClassRealTimeController | null>(null);
  const [courseController, setCourseController] = useState<CourseController | null>(null);
  const { user } = useAuthState();
  const userId = user?.id;
  // Initialize ClassRealTimeController and ensure it is started before use
  useEffect(() => {
    if (userId) {
      let cancelled = false;
      const client = createClient();
      const realTimeController = new ClassRealTimeController({
        client,
        classId: course_id,
        profileId: profile_id,
        isStaff: role === "instructor" || role === "grader"
      });
      const _courseController = new CourseController(role, course_id, client, realTimeController, userId, initialData);
      setCourseController(_courseController);
      const start = async () => {
        try {
          await realTimeController.start();

          if (cancelled) {
            _courseController?.close();
            await realTimeController.close();
            return;
          }

          // Initialize the critical controllers now that everything is stable
          _courseController.initializeEagerControllers();

          setClassRealTimeController(realTimeController);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("Failed to start ClassRealTimeController:", e);
          _courseController?.close();
          await realTimeController.close();
        }
      };
      start();

      return () => {
        cancelled = true;
        _courseController?.close();
        realTimeController.close();
      };
    }
  }, [course_id, profile_id, role, userId, initialData]);

  if (!courseController || !userId) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" height="100vh">
        <Spinner />
      </Box>
    );
  }

  return (
    <CourseControllerContext.Provider value={courseController}>
      <CourseControllerProviderImpl controller={courseController} />
      {children}
    </CourseControllerContext.Provider>
  );
}

export function formatWithTimeZone(date: string, timeZone: string) {
  const dateObj = new Date(date);
  const timeZoneDate = TZDate.tz(timeZone);
  const offset = timeZoneDate.getTimezoneOffset();
  const offsetHours = Math.abs(Math.floor(offset / 60));
  const offsetMinutes = Math.abs(offset % 60);
  const offsetStr = `${offset < 0 ? "+" : "-"}${offsetHours.toString().padStart(2, "0")}:${offsetMinutes.toString().padStart(2, "0")}`;
  return `${dateObj.toLocaleString("en-US", { timeZone })} ${offsetStr}`;
}

export function useAssignmentDueDate(
  assignment: { id: number; due_date: string; minutes_due_after_lab: number | null },
  options?: { studentPrivateProfileId?: string; labSectionId?: number; assignmentGroupId?: number }
) {
  const controller = useCourseController();
  const course = useCourse();
  const time_zone = course.time_zone;

  const labSections = useTableControllerTableValues(controller.labSections) as LabSection[];
  const labSectionMeetings = useTableControllerTableValues(controller.labSectionMeetings) as LabSectionMeeting[];
  const labSectionsReady = useIsTableControllerReady(controller.labSections);
  const labSectionMeetingsReady = useIsTableControllerReady(controller.labSectionMeetings);

  const dueDateExceptionsFilter = useCallback(
    (e: AssignmentDueDateException) => {
      return Boolean(
        (e.assignment_id === assignment.id &&
          ((!options?.studentPrivateProfileId && !e.student_id) ||
            (options?.studentPrivateProfileId && e.student_id === options.studentPrivateProfileId)) &&
          !options?.assignmentGroupId &&
          !e.assignment_group_id) ||
          (options?.assignmentGroupId && e.assignment_group_id === options.assignmentGroupId)
      );
    },
    [assignment.id, options?.studentPrivateProfileId, options?.assignmentGroupId]
  );
  const dueDateExceptions = useListTableControllerValues(
    controller.assignmentDueDateExceptions,
    dueDateExceptionsFilter
  );

  const ret = useMemo(() => {
    if (!assignment.due_date) {
      return {
        originalDueDate: undefined,
        effectiveDueDate: undefined,
        dueDate: undefined,
        hoursExtended: undefined,
        lateTokensConsumed: undefined,
        hasLabScheduling: false,
        labSectionId: undefined,
        time_zone
      };
    }

    const originalDueDate = new TZDate(assignment.due_date, time_zone);
    const hasLabScheduling = assignment.minutes_due_after_lab !== null;

    let effectiveDueDate = originalDueDate;
    let labSectionId: number | null = null;

    // Only compute lab-based due date if data is ready and we have lab scheduling
    if (hasLabScheduling && labSectionsReady && labSectionMeetingsReady) {
      // Get student's lab section
      if (options?.studentPrivateProfileId) {
        labSectionId = controller.getStudentLabSectionId(options.studentPrivateProfileId);
      } else if (options?.labSectionId) {
        labSectionId = options.labSectionId;
      }

      if (labSectionId) {
        const labSection = labSections.find((section) => section.id === labSectionId);
        if (labSection) {
          // Find the most recent lab section meeting before the assignment's original due date
          const assignmentDueDate = new Date(assignment.due_date);
          const relevantMeetings = labSectionMeetings
            .filter(
              (meeting) =>
                meeting.lab_section_id === labSectionId &&
                !meeting.cancelled &&
                new Date(meeting.meeting_date) < assignmentDueDate
            )
            .sort((a, b) => new Date(b.meeting_date).getTime() - new Date(a.meeting_date).getTime());

          if (relevantMeetings.length > 0 && assignment.minutes_due_after_lab !== null) {
            // Calculate lab-based due date
            const mostRecentLabMeeting = relevantMeetings[0];
            const nonTZDate = new Date(mostRecentLabMeeting.meeting_date + "T" + labSection.end_time);

            const labMeetingDate = new TZDate(
              nonTZDate.getFullYear(),
              nonTZDate.getMonth(),
              nonTZDate.getDate(),
              nonTZDate.getHours(),
              nonTZDate.getMinutes(),
              time_zone
            );

            // Add the minutes offset to the lab meeting date
            effectiveDueDate = addMinutes(labMeetingDate, assignment.minutes_due_after_lab);
          }
        }
      }
    }

    // Calculate extensions
    const hoursExtended = dueDateExceptions?.reduce((acc, curr) => acc + curr.hours, 0) || 0;
    const minutesExtended = dueDateExceptions?.reduce((acc, curr) => acc + curr.minutes, 0) || 0;
    const lateTokensConsumed = dueDateExceptions?.reduce((acc, curr) => acc + curr.tokens_consumed, 0) || 0;

    // Apply extensions on top of the effective due date
    const finalDueDate = addMinutes(addHours(effectiveDueDate, hoursExtended), minutesExtended);

    return {
      originalDueDate,
      effectiveDueDate,
      dueDate: finalDueDate,
      hoursExtended,
      lateTokensConsumed,
      hasLabScheduling,
      labSectionId,
      time_zone
    };
  }, [
    dueDateExceptions,
    labSections,
    labSectionMeetings,
    labSectionsReady,
    labSectionMeetingsReady,
    assignment,
    controller,
    options,
    time_zone
  ]);

  return ret;
}

export function useLateTokens() {
  const controller = useCourseController();
  const [lateTokens, setLateTokens] = useState<AssignmentDueDateException[]>([]);

  useEffect(() => {
    const { data, unsubscribe } = controller.assignmentDueDateExceptions.list((data) => {
      setLateTokens(data);
    });
    setLateTokens(data);
    return unsubscribe;
  }, [controller]);

  return lateTokens;
}

export function useCourse() {
  const { role } = useClassProfiles();
  return role.classes;
}

export function useCourseController() {
  const controller = useContext(CourseControllerContext);
  if (!controller) {
    throw new Error("CourseController not found");
  }
  return controller;
}

export function useSetObfuscatedGradesMode(): (val: boolean) => void {
  const controller = useCourseController();
  return useCallback(
    (val: boolean) => {
      controller.setObfuscatedGradesMode(val);
    },
    [controller]
  );
}

export function useSetOnlyShowGradesFor(): (val: string) => void {
  const controller = useCourseController();
  return useCallback(
    (val: string) => {
      controller.setOnlyShowGradesFor(val);
    },
    [controller]
  );
}

export function useObfuscatedGradesMode(): boolean {
  const controller = useCourseController();
  const [isObfuscated, setIsObfuscated] = useState(controller.isObfuscatedGrades);
  useEffect(() => {
    const unsubscribe = controller.subscribeObfuscatedGradesMode(setIsObfuscated);
    setIsObfuscated(controller.isObfuscatedGrades);
    return unsubscribe;
  }, [controller]);
  return isObfuscated;
}

export function useCanShowGradeFor(userId: string): boolean {
  const controller = useCourseController();
  const [onlyShowFor, setOnlyShowFor] = useState(controller.onlyShowGradesFor);
  const isObfuscated = useObfuscatedGradesMode();
  useEffect(() => {
    const unsubscribe = controller.subscribeOnlyShowGradesFor(setOnlyShowFor);
    setOnlyShowFor(controller.onlyShowGradesFor);
    return unsubscribe;
  }, [controller]);
  if (!isObfuscated) return true;
  return onlyShowFor === userId;
}

/**
 * Hook to get student roster with user information including email
 */
export function useRosterWithUserInfo() {
  const controller = useCourseController();
  const [roster, setRoster] = useState<UserRoleWithUser[]>([]);

  useEffect(() => {
    const { data, unsubscribe } = controller.getRosterWithUserInfo((updatedRoster) => setRoster(updatedRoster));
    setRoster(data);
    return unsubscribe;
  }, [controller]);

  return roster;
}

/**
 * Hook to get user roles with full profile and user information for enrollments management
 * Includes disabled user roles
 */
export function useUserRolesWithProfiles() {
  const controller = useCourseController();
  const [userRoles, setUserRoles] = useState<UserRoleWithPrivateProfileAndUser[]>([]);

  useEffect(() => {
    const { data, unsubscribe } = controller.userRolesWithProfiles.list((updatedUserRoles) => {
      setUserRoles(updatedUserRoles as UserRoleWithPrivateProfileAndUser[]);
    });
    setUserRoles(data as UserRoleWithPrivateProfileAndUser[]);
    return unsubscribe;
  }, [controller]);

  return userRoles;
}

/**
 * Hook to get user roles with full profile and user information for enrollments management
 * Only includes active user roles
 */
export function useActiveUserRolesWithProfiles() {
  const controller = useCourseController();
  const [userRoles, setUserRoles] = useState<UserRoleWithPrivateProfileAndUser[]>([]);

  useEffect(() => {
    const { data, unsubscribe } = controller.userRolesWithProfiles.list((updatedUserRoles) => {
      const activeUserRoles = updatedUserRoles.filter((r) => r.disabled === false);
      setUserRoles(activeUserRoles as UserRoleWithPrivateProfileAndUser[]);
    });
    setUserRoles(data.filter((r) => r.disabled === false) as UserRoleWithPrivateProfileAndUser[]);
    return unsubscribe;
  }, [controller]);

  return userRoles;
}

/**
 * Hook to get all tags for the course
 */
export function useTags() {
  const controller = useCourseController();
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    const { data, unsubscribe } = controller.listTags((updatedTags) => {
      setTags(updatedTags);
    });
    setTags(data);
    return unsubscribe;
  }, [controller]);

  return tags;
}

/**
 * Hook to get tags for a specific profile
 */
export function useProfileTags(profileId: string | undefined) {
  const controller = useCourseController();
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    if (!profileId) {
      setTags([]);
      return;
    }

    const { data, unsubscribe } = controller.getTagsForProfile(profileId, (updatedTags) => {
      setTags(updatedTags);
    });
    setTags(data || []);
    return unsubscribe;
  }, [controller, profileId]);

  return tags;
}

/**
 * Hook to determine role based on tags for a given profile id
 * Returns 'student', 'grader', or 'instructor' based on the presence of that tag on the profile
 */
export function useProfileRole(profileId: string | undefined): "student" | "grader" | "instructor" | undefined {
  const tags = useProfileTags(profileId);

  return useMemo(() => {
    if (!tags || tags.length === 0) {
      return undefined;
    }

    // Look for role tags (case-insensitive)
    const roleTag = tags.find((tag) => {
      const tagName = tag.name.toLowerCase();
      return tagName === "instructor" || tagName === "grader" || tagName === "student";
    });

    if (roleTag) {
      const roleName = roleTag.name.toLowerCase();
      if (roleName === "instructor") return "instructor";
      if (roleName === "grader") return "grader";
      if (roleName === "student") return "student";
    }

    return undefined;
  }, [tags]);
}

/**
 * Hook to get student deadline extensions
 * This provides access to extensions that apply to all assignments for a student in a class
 */
export function useStudentDeadlineExtensions() {
  const controller = useCourseController();
  const [extensions, setExtensions] = useState<StudentDeadlineExtension[]>([]);

  useEffect(() => {
    const { data, unsubscribe } = controller.studentDeadlineExtensions.list((updatedExtensions) => {
      setExtensions(updatedExtensions as StudentDeadlineExtension[]);
    });
    setExtensions(data as StudentDeadlineExtension[]);
    return unsubscribe;
  }, [controller]);

  return extensions;
}

/**
 * Hook to get all assignments for the course
 */
export function useAssignments() {
  const controller = useCourseController();
  const [assignments, setAssignments] = useState<Assignment[]>([]);

  useEffect(() => {
    const { data, unsubscribe } = controller.assignments.list((updatedAssignments) => {
      setAssignments(updatedAssignments as Assignment[]);
    });
    setAssignments(data as Assignment[]);
    return unsubscribe;
  }, [controller]);

  return assignments;
}

/**
 * Hook to get discussion topics for the course
 */
export function useDiscussionTopics() {
  const controller = useCourseController();
  const [topics, setTopics] = useState<DiscussionTopic[]>(controller.discussionTopics.rows);

  useEffect(() => {
    const { data, unsubscribe } = controller.discussionTopics.list((updatedTopics) => {
      setTopics(updatedTopics);
    });
    setTopics(data);
    return unsubscribe;
  }, [controller]);

  return topics;
}

/**
 * Hook to get a discord channel by type and resource_id
 * Useful for finding the channel for a specific help queue, assignment, etc.
 * Uses useFindTableControllerValue for efficient lookup
 */
export function useDiscordChannel(
  channelType: Database["public"]["Enums"]["discord_channel_type"],
  resourceId?: number | null
) {
  const controller = useCourseController();
  const isStaff = controller.isStaff;

  // Only access discordChannels controller if staff (to avoid instantiating it for non-staff)
  // Use useMemo to conditionally access the controller property only when isStaff is true
  // This prevents the lazy getter from being called for non-staff users
  const discordChannelsController = useMemo(() => {
    if (isStaff) {
      return controller.discordChannels;
    }
    // When not staff, we still need to pass a controller to the hook, but we'll use
    // a controller that exists (profiles) as a placeholder since the filter always returns false
    // This satisfies the type requirement without instantiating the staff-only controller
    return controller.profiles as unknown as TableController<"discord_channels">;
  }, [controller, isStaff]);

  const filter = useCallback(
    (channel: Database["public"]["Tables"]["discord_channels"]["Row"]) =>
      channel.channel_type === channelType &&
      (resourceId === undefined || resourceId === null || channel.resource_id === resourceId),
    [channelType, resourceId]
  );

  // Only search if staff (discord_channels is staff-only)
  // When not staff, filter always returns false, so no matching will occur
  const channel = useFindTableControllerValue(discordChannelsController, isStaff ? filter : () => false);

  return channel ?? null;
}

/**
 * Hook to get a discord message by resource type and resource_id
 * Useful for finding the Discord message for a help request, regrade request, etc.
 * Uses useFindTableControllerValue for efficient lookup
 */
export function useDiscordMessage(
  resourceType: Database["public"]["Enums"]["discord_resource_type"],
  resourceId: number | null | undefined
) {
  const controller = useCourseController();
  const isStaff = controller.isStaff;

  // Only access discordMessages controller if staff (to avoid instantiating it for non-staff)
  // Use useMemo to conditionally access the controller property only when isStaff is true
  // This prevents the lazy getter from being called for non-staff users
  const discordMessagesController = useMemo(() => {
    if (isStaff) {
      return controller.discordMessages;
    }
    // When not staff, we still need to pass a controller to the hook, but we'll use
    // a controller that exists (profiles) as a placeholder since the filter always returns false
    // This satisfies the type requirement without instantiating the staff-only controller
    return controller.profiles as unknown as TableController<"discord_messages">;
  }, [controller, isStaff]);

  const filter = useCallback(
    (message: Database["public"]["Tables"]["discord_messages"]["Row"]) =>
      message.resource_type === resourceType && message.resource_id === resourceId,
    [resourceType, resourceId]
  );

  // Only search if staff (discord_messages is staff-only) and resourceId is valid
  // When not staff, filter always returns false, so no matching will occur
  const shouldSearch = isStaff && resourceId !== null && resourceId !== undefined;
  const message = useFindTableControllerValue(discordMessagesController, shouldSearch ? filter : () => false);

  return message ?? null;
}

/**
 * Hook to get all live polls for the course with real-time updates
 */
export function useLivePolls() {
  const controller = useCourseController();
  const [polls, setPolls] = useState<Database["public"]["Tables"]["live_polls"]["Row"][]>([]);

  useEffect(() => {
    const { data, unsubscribe } = controller.livePolls.list((updatedPolls) => {
      setPolls(updatedPolls);
    });
    setPolls(data);
    return unsubscribe;
  }, [controller]);

  return polls;
}

/**
 * Hook to get only live (active) polls for the course with real-time updates
 */
export function useActiveLivePolls() {
  const controller = useCourseController();
  const predicate = useCallback((poll: Database["public"]["Tables"]["live_polls"]["Row"]) => poll.is_live === true, []);
  const polls = useListTableControllerValues(controller.livePolls, predicate);
  const isLoading = !controller.livePolls.ready;

  return { polls, isLoading };
}

/**
 * Hook to get a single poll by ID with real-time updates
 */
export function useLivePoll(pollId: string | undefined) {
  const { livePolls } = useCourseController();
  const poll = useTableControllerValueById(livePolls, pollId);
  return poll;
}

/**
 * Helper to extract choices from poll question JSON
 */
function extractChoicesFromPollQuestion(pollQuestion: unknown): string[] {
  if (!pollQuestion || typeof pollQuestion !== "object") {
    return [];
  }

  const questionData = pollQuestion as Record<string, unknown> | null;
  if (!questionData || !Array.isArray(questionData.elements) || questionData.elements.length === 0) {
    return [];
  }

  const firstElement = (
    questionData?.elements as Array<{
      choices?: string[] | Array<{ text?: string; label?: string; value?: string }>;
    }>
  )?.[0];

  const choicesRaw = Array.isArray(firstElement?.choices) ? firstElement.choices : [];
  return choicesRaw.map((choice) => {
    if (typeof choice === "string") return choice;
    if (!choice || typeof choice !== "object") return "";
    return choice.text || choice.label || choice.value || String(choice);
  });
}

/**
 * Helper to extract answer from poll response
 * Response format: { "poll_question_0": "Answer" } or { "poll_question_0": ["A", "B"] }
 */
function extractPollAnswer(response: unknown): string | string[] | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return null;
  }
  const data = response as Record<string, unknown>;
  const key = Object.keys(data).find((k) => k.startsWith("poll_question_"));
  if (!key) return null;

  const value = data[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  return null;
}

/**
 * Hook to get poll response counts with instant real-time updates.
 * Directly increments counts when new responses arrive - no intermediate array processing.
 *
 * @param pollId - The poll ID to count responses for
 * @param pollQuestion - The poll question JSON containing choices
 */
export function usePollResponseCounts(pollId: string | undefined, pollQuestion: unknown) {
  const controller = useCourseController();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const seenIdsRef = useRef<Set<string>>(new Set());

  // Extract choices from poll question
  const choices = useMemo(() => extractChoicesFromPollQuestion(pollQuestion), [pollQuestion]);

  useEffect(() => {
    if (!pollId || choices.length === 0) {
      setCounts({});
      seenIdsRef.current.clear();
      setIsLoading(false);
      return;
    }

    // Reset state when pollId changes
    seenIdsRef.current.clear();

    // Initialize counts for all choices
    const initialCounts: Record<string, number> = {};
    choices.forEach((choice) => {
      initialCounts[choice] = 0;
    });

    // Fetch initial data and count, then set up real-time subscription
    const fetchInitial = async () => {
      const { data, error } = await controller.client
        .from("live_poll_responses")
        .select("*")
        .eq("live_poll_id", pollId);

      if (!error && data) {
        data.forEach((response) => {
          seenIdsRef.current.add(response.id);
          const answer = extractPollAnswer(response.response);

          if (Array.isArray(answer)) {
            answer.forEach((item: string) => {
              if (!item.startsWith("other:") && initialCounts.hasOwnProperty(item)) {
                initialCounts[item]++;
              }
            });
          } else if (
            typeof answer === "string" &&
            !answer.startsWith("other:") &&
            initialCounts.hasOwnProperty(answer)
          ) {
            initialCounts[answer]++;
          }
        });
      }

      setCounts(initialCounts);
      setIsLoading(false);

      // Set up real-time subscription after initial data is loaded
      // This ensures we don't miss any updates that arrive during the initial fetch
      const unsubscribe = controller.classRealTimeController.subscribe({ table: "live_poll_responses" }, (message) => {
        if (message.operation === "INSERT" && message.data) {
          const responseData = message.data as Database["public"]["Tables"]["live_poll_responses"]["Row"];

          // Only count if it matches our poll and we haven't seen it
          if (responseData.live_poll_id === pollId && !seenIdsRef.current.has(responseData.id)) {
            seenIdsRef.current.add(responseData.id);

            const answer = extractPollAnswer(responseData.response);

            // Increment counts directly - instant update!
            setCounts((prev) => {
              const updated = { ...prev };

              if (Array.isArray(answer)) {
                answer.forEach((item: string) => {
                  if (!item.startsWith("other:") && updated.hasOwnProperty(item)) {
                    updated[item]++;
                  }
                });
              } else if (typeof answer === "string" && !answer.startsWith("other:") && updated.hasOwnProperty(answer)) {
                updated[answer]++;
              }

              return updated;
            });
          }
        }
      });

      return unsubscribe;
    };

    let unsubscribeFunc: (() => void) | undefined;
    fetchInitial().then((unsub) => {
      unsubscribeFunc = unsub;
    });

    return () => {
      unsubscribeFunc?.();
    };
  }, [controller, pollId, choices]);

  return { counts, isLoading };
}

// =============================================================================
// SURVEY HOOKS
// =============================================================================

/**
 * Hook to get all surveys for the course with real-time updates (staff only)
 */
export function useSurveys() {
  const controller = useCourseController();
  const [surveys, setSurveys] = useState<Database["public"]["Tables"]["surveys"]["Row"][]>([]);

  useEffect(() => {
    const { data, unsubscribe } = controller.surveys.list((updatedSurveys) => {
      setSurveys(updatedSurveys);
    });
    setSurveys(data);
    return unsubscribe;
  }, [controller]);

  return surveys;
}

/**
 * Hook to get a single survey by ID with real-time updates
 */
export function useSurvey(surveyId: string | undefined) {
  const { surveys } = useCourseController();
  const survey = useTableControllerValueById(surveys, surveyId);
  return survey;
}

/**
 * Hook to get only published surveys for the course (for students)
 */
export function usePublishedSurveys() {
  const controller = useCourseController();
  const predicate = useCallback(
    (survey: Database["public"]["Tables"]["surveys"]["Row"]) => survey.status === "published" && !survey.deleted_at,
    []
  );
  const surveys = useListTableControllerValues(controller.surveys, predicate);
  const isLoading = !controller.surveys.ready;

  return { surveys, isLoading };
}

/**
 * Type for survey response with profile data
 */
export type SurveyResponseWithProfile = Database["public"]["Tables"]["survey_responses"]["Row"] & {
  profiles: { id: string; name: string | null } | null;
};

/**
 * Hook to get survey responses for a specific survey with real-time updates
 * Uses per-survey loading - creates a TableController scoped to the specific survey
 */
export function useSurveyResponses(surveyId: string | undefined) {
  const controller = useCourseController();
  const [responses, setResponses] = useState<SurveyResponseWithProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!surveyId) {
      setResponses([]);
      setIsLoading(false);
      return;
    }

    // Create a TableController scoped to this specific survey
    const ctrl = new TableController({
      client: controller.client,
      table: "survey_responses",
      query: controller.client
        .from("survey_responses")
        .select("*")
        .eq("survey_id", surveyId)
        .eq("is_submitted", true)
        .is("deleted_at", null),
      classRealTimeController: controller.classRealTimeController,
      realtimeFilter: { survey_id: surveyId }
    });

    // Get profiles for joining response data
    const profilesController = controller.profiles;

    const updateResponsesWithProfiles = (rawResponses: Database["public"]["Tables"]["survey_responses"]["Row"][]) => {
      // Join with profiles data from the profiles controller
      const { data: profiles } = profilesController.list(() => {});
      const profileMap = new Map(profiles.map((p) => [p.id, p]));

      const responsesWithProfiles: SurveyResponseWithProfile[] = rawResponses.map((r) => ({
        ...r,
        profiles: profileMap.get(r.profile_id)
          ? { id: r.profile_id, name: profileMap.get(r.profile_id)?.name ?? null }
          : null
      }));

      setResponses(responsesWithProfiles);
    };

    const { data, unsubscribe } = ctrl.list((updated) => {
      updateResponsesWithProfiles(updated);
      setIsLoading(false);
    });

    updateResponsesWithProfiles(data);
    setIsLoading(!ctrl.ready);

    return () => {
      unsubscribe();
      ctrl.close();
    };
  }, [surveyId, controller]);

  return { responses, isLoading };
}

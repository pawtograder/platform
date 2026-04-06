"use client";

import { toaster } from "@/components/ui/toaster";
import { ClassRealTimeController } from "@/lib/ClassRealTimeController";
// CourseControllerInitialData is no longer needed — SSR data is delivered
// via TanStack Query's HydrationBoundary.
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
import { useQueryClient } from "@tanstack/react-query";
import { addHours, addMinutes } from "date-fns";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLeaderContext } from "@/lib/cross-tab/LeaderProvider";
import useAuthState from "./useAuthState";
import { useClassProfiles } from "./useClassProfiles";
import { DiscussionThreadReadWithAllDescendants } from "./useDiscussionThreadRootController";
import {
  useProfilesQuery,
  useUserRolesQuery,
  useTagsQuery,
  useDiscussionThreadTeasersQuery,
  useDiscussionThreadReadStatusQuery,
  useLabSectionsQuery,
  useLabSectionMeetingsQuery,
  useClassSectionsQuery,
  useSurveySeriesQuery,
  useSurveysQuery,
  useAssignmentsQuery,
  useDiscussionTopicsQuery,
  useDiscordChannelsQuery,
  useDiscordMessagesQuery,
  useLivePollsQuery,
  useStudentDeadlineExtensionsQuery,
  useAssignmentDueDateExceptionsQuery,
  useDiscussionThreadTeaserUpdate,
  useDiscussionThreadReadStatusUpdate,
  useAssignmentGroupsQuery
} from "@/hooks/course-data";

export function useAssignmentGroupWithMembers({
  assignment_group_id
}: {
  assignment_group_id: number | null | undefined;
}) {
  const { data = [] } = useAssignmentGroupsQuery();
  return useMemo(
    () => (assignment_group_id ? data.find((ag) => ag.id === assignment_group_id) : undefined),
    [data, assignment_group_id]
  );
}
export function useAssignmentGroupForUser({ assignment_id }: { assignment_id: number }) {
  const { data = [] } = useAssignmentGroupsQuery();
  const { private_profile_id } = useClassProfiles();

  return useMemo(
    () =>
      data.find(
        (ag) =>
          ag.assignment_id === assignment_id &&
          ag.assignment_groups_members.some((agm) => agm.profile_id === private_profile_id)
      ),
    [data, assignment_id, private_profile_id]
  );
}

export function useAllProfilesForClass() {
  const { data = [] } = useProfilesQuery();
  return data;
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
export type GraderInstructorProfile = UserProfile & { userEmail: string | null };

export function useGradersAndInstructors(): GraderInstructorProfile[] {
  const { data: roles = [] } = useUserRolesQuery();
  return useMemo(
    () =>
      (roles as UserRoleWithPrivateProfileAndUser[])
        .filter((r) => r.role === "grader" || r.role === "instructor")
        .map((r) => ({
          ...r.profiles,
          userEmail: r.users?.email ?? null
        })),
    [roles]
  );
}

export function useIsDroppedStudent(private_profile_id: string | undefined | null) {
  const { data: roles = [] } = useUserRolesQuery();
  const role = useMemo(
    () => (roles as UserRoleWithPrivateProfileAndUser[]).find((r) => r.private_profile_id === private_profile_id),
    [roles, private_profile_id]
  );
  return role?.disabled;
}
export function useAllStudentRoles() {
  const { data: roles = [] } = useUserRolesQuery();
  return useMemo(
    () => (roles as UserRoleWithPrivateProfileAndUser[]).filter((r) => r.role === "student" && !r.disabled),
    [roles]
  );
}
export function useStudentRoster() {
  const { data: roles = [] } = useUserRolesQuery();
  return useMemo(
    () => (roles as UserRoleWithPrivateProfileAndUser[]).filter((r) => r.role === "student").map((r) => r.profiles),
    [roles]
  );
}
export function useProfiles() {
  const { data = [] } = useProfilesQuery();
  return data;
}
/**
 * Hook to update a discussion thread using TableController
 * @returns A function to update a thread by ID
 */
export function useUpdateThreadTeaser() {
  const mutation = useDiscussionThreadTeaserUpdate();
  return useCallback(
    async ({ id, values }: { id: number; old: DiscussionThreadTeaser; values: Partial<DiscussionThread> }) => {
      try {
        await mutation.mutateAsync({ id, values });
      } catch {
        toaster.error({
          title: "Error updating thread",
          description: "Please try again later."
        });
      }
    },
    [mutation]
  );
}
export function useRootDiscussionThreadReadStatuses(threadId: number) {
  const { data = [] } = useDiscussionThreadReadStatusQuery();
  return useMemo(() => data.filter((s) => s.discussion_thread_root_id === threadId), [data, threadId]);
}
/**
 * Returns a hook that returns the read status of a thread.
 * @param threadId The id of the thread to get the read status of.
 * @returns A tuple of the read status and a function to set the read status.
 * Null indicates that the thread is not read
 * Undefined indicates that the thread is not yet loaded
 */
export function useDiscussionThreadReadStatus(threadId: number) {
  const { data: allStatuses = [] } = useDiscussionThreadReadStatusQuery();
  const { user } = useAuthState();
  const readStatusMutation = useDiscussionThreadReadStatusUpdate();
  const controller = useCourseController();

  const readStatus = useMemo(
    () => allStatuses.find((s) => s.discussion_thread_id === threadId && s.user_id === user?.id),
    [allStatuses, threadId, user?.id]
  );

  const setUnread = useCallback(
    async (root_threadId: number, threadId: number, isUnread: boolean) => {
      if (readStatus === undefined) {
        return;
      }
      if (readStatus) {
        if (isUnread && readStatus.read_at) {
          readStatusMutation.mutate({ id: readStatus.id, values: { read_at: null } });
        } else if (!isUnread && !readStatus.read_at) {
          readStatusMutation.mutate({ id: readStatus.id, values: { read_at: new Date().toISOString() } });
        }
      } else {
        // There is a Postgres trigger that creates a read status for every user for every thread. So, if we don't have one, we just haven't fetched it yet!
        if (!user?.id) {
          return;
        }
        const fetchedStatus = await controller.getDiscussionThreadReadStatusByFilters([
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
        if (fetchedStatus) {
          readStatusMutation.mutate({
            id: fetchedStatus.id,
            values: { read_at: isUnread ? null : new Date().toISOString() }
          });
        }
      }
    },
    [user?.id, controller, readStatus, readStatusMutation]
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
  const { data = [] } = useDiscussionThreadTeasersQuery();
  return data as DiscussionThreadTeaser[];
}
type DiscussionThreadFields = keyof DiscussionThreadTeaser;
export function useDiscussionThreadTeaser(id: number | undefined, watchFields?: DiscussionThreadFields[]) {
  const { data = [] } = useDiscussionThreadTeasersQuery();
  const prevRef = useRef<DiscussionThreadTeaser | undefined>(undefined);

  return useMemo(() => {
    if (id === undefined) {
      prevRef.current = undefined;
      return undefined;
    }
    const found = (data as DiscussionThreadTeaser[]).find((t) => t.id === id);
    if (!found) {
      return prevRef.current;
    }
    if (watchFields && prevRef.current) {
      const hasAnyChanges = watchFields.some((field) => prevRef.current![field] !== found[field]);
      if (!hasAnyChanges) {
        return prevRef.current;
      }
    }
    prevRef.current = found;
    return found;
  }, [data, id, watchFields]);
}

export function useLabSections() {
  const { data = [] } = useLabSectionsQuery();
  return data;
}

export function useClassSections() {
  const { data = [] } = useClassSectionsQuery();
  return data;
}

/**
 * Hook to get all survey series for the course with real-time updates (cached on course controller)
 */
export function useSurveySeries() {
  const { data: series = [], isLoading, refetch } = useSurveySeriesQuery();
  return { series, isLoading, refetch };
}

/**
 * Hook to get surveys in a specific series (cached on course controller's surveys TableController)
 */
export function useSurveysInSeries(seriesId: string | undefined) {
  const { data: allSurveys = [], isLoading } = useSurveysQuery();
  const surveys = useMemo(
    () =>
      allSurveys
        .filter((s) => s.series_id === seriesId && !s.deleted_at)
        .sort((a, b) => (a.series_ordinal ?? 0) - (b.series_ordinal ?? 0)),
    [allSurveys, seriesId]
  );

  return { surveys, isLoading };
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

  constructor(
    public role: Database["public"]["Enums"]["app_role"],
    public courseId: number,
    client: SupabaseClient<Database>,
    classRealTimeController: ClassRealTimeController,
    userId: string
  ) {
    this._classRealTimeController = classRealTimeController;
    this.client = client as SupabaseClient<Database>;
    this._userId = userId;
  }

  get userId() {
    return this._userId;
  }
  /**
   * No-op. Data flows through TanStack Query hooks.
   */
  initializeEagerControllers() {
    // No-op
  }

  get classRealTimeController(): ClassRealTimeController {
    if (!this._classRealTimeController) {
      throw new Error("ClassRealTimeController not initialized.");
    }
    return this._classRealTimeController;
  }

  get isStaff() {
    return this.role === "instructor" || this.role === "grader";
  }

  // ---- Table shims ----
  // Provide same create/update/delete/invalidate/list/getById API as the old
  // TableController getters, but delegate to direct Supabase calls and
  // TanStack Query cache invalidation. The `_qc` field is injected by the
  // provider on every render.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _qc: any = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _makeCourseShim(table: string, keySuffix: string): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = this.client as any;
    const cid = this.courseId;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get queryKey() {
        return ["course", cid, keySuffix];
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async create(row: any) {
        const { data, error } = await db.from(table).insert(row).select("*").single();
        if (error) throw error;
        self._qc?.invalidateQueries?.({ queryKey: ["course", cid, keySuffix] });
        return data;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async update(id: any, values: any) {
        const { data, error } = await db.from(table).update(values).eq("id", id).select("*").single();
        if (error) throw error;
        self._qc?.invalidateQueries?.({ queryKey: ["course", cid, keySuffix] });
        return data;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async delete(id: any) {
        const { error } = await db.from(table).update({ deleted_at: new Date().toISOString() }).eq("id", id);
        if (error) throw error;
        self._qc?.invalidateQueries?.({ queryKey: ["course", cid, keySuffix] });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async hardDelete(id: any) {
        const { error } = await db.from(table).delete().eq("id", id);
        if (error) throw error;
        self._qc?.invalidateQueries?.({ queryKey: ["course", cid, keySuffix] });
      },
      async invalidate() {
        self._qc?.invalidateQueries?.({ queryKey: ["course", cid, keySuffix] });
      },
      async refetchAll() {
        self._qc?.invalidateQueries?.({ queryKey: ["course", cid, keySuffix] });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      list(callback?: any) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (self._qc?.getQueryData?.(["course", cid, keySuffix]) ?? []) as any[];
        if (callback) callback(d);
        return { data: d, unsubscribe: () => {} };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getById(id: any, callback?: any) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = ((self._qc?.getQueryData?.(["course", cid, keySuffix]) ?? []) as any[]).find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (r: any) => r.id === id
        );
        if (callback) callback(d);
        return { data: d, unsubscribe: () => {} };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async getOneByFilters(filters: any[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let query: any = db.from(table).select("*");
        for (const f of filters) {
          query = query.filter(f.column, f.operator, f.value);
        }
        const { data } = await query.single();
        return data;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async getByIdAsync(id: any) {
        const { data, error } = await db.from(table).select("*").eq("id", id).single();
        if (error) throw error;
        self._qc?.invalidateQueries?.({ queryKey: ["course", cid, keySuffix] });
        return data;
      },
      readyPromise: Promise.resolve(),
      close() {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get rows(): any[] {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (self._qc?.getQueryData?.(["course", cid, keySuffix]) ?? []) as any[];
      },
      get ready() {
        return true;
      }
    };
  }

  // Lazy-initialized shims
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _shims: Record<string, any> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _getShim(table: string, key: string): any {
    if (!this._shims[key]) {
      this._shims[key] = this._makeCourseShim(table, key);
    }
    return this._shims[key];
  }

  get discussionThreadTeasers() {
    return this._getShim("discussion_threads", "discussion_thread_teasers");
  }
  get discussionThreadReadStatus() {
    return this._getShim("discussion_thread_read_status", "discussion_thread_read_status");
  }
  get discussionThreadLikes() {
    return this._getShim("discussion_thread_likes", "discussion_thread_likes");
  }
  get discussionTopics() {
    return this._getShim("discussion_topics", "discussion_topics");
  }
  get tags() {
    return this._getShim("tags", "tags");
  }
  get profiles() {
    return this._getShim("profiles", "profiles");
  }
  get userRolesWithProfiles() {
    return this._getShim("user_roles", "user_roles");
  }
  get labSections() {
    return this._getShim("lab_sections", "lab_sections");
  }
  get labSectionMeetings() {
    return this._getShim("lab_section_meetings", "lab_section_meetings");
  }
  get classSections() {
    return this._getShim("class_sections", "class_sections");
  }
  get studentDeadlineExtensions() {
    return this._getShim("student_deadline_extensions", "student_deadline_extensions");
  }
  get assignmentDueDateExceptions() {
    return this._getShim("assignment_due_date_exceptions", "assignment_due_date_exceptions");
  }
  get assignments() {
    return this._getShim("assignments", "assignments");
  }
  get assignmentGroupsWithMembers() {
    return this._getShim("assignment_groups", "assignment_groups");
  }
  get repositories() {
    return this._getShim("repositories", "repositories");
  }
  get livePolls() {
    return this._getShim("live_polls", "live_polls");
  }

  // Helper methods that consumers still call
  getUserRole(user_id: string) {
    return undefined; // Data now comes from TanStack hooks
  }
  getUserRoleByPrivateProfileId(private_profile_id: string) {
    return undefined; // Data now comes from TanStack hooks
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTagsForProfile(profile_id: string, callback?: any): { unsubscribe: Unsubscribe; data: Tag[] | undefined } {
    return { unsubscribe: () => {}, data: [] };
  }
  listTags(callback?: UpdateCallback<Tag[]>): { unsubscribe: Unsubscribe; data: Tag[] } {
    return { unsubscribe: () => {}, data: [] };
  }
  getRoster() {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRosterWithUserInfo(callback?: any): { unsubscribe: Unsubscribe; data: UserRoleWithUser[] } {
    return { unsubscribe: () => {}, data: [] };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getProfileBySisId(sis_id: number): any {
    return undefined;
  }
  listLabSections(callback?: UpdateCallback<LabSection[]>): { unsubscribe: Unsubscribe; data: LabSection[] } {
    return { unsubscribe: () => {}, data: [] };
  }
  listLabSectionMeetings(callback?: UpdateCallback<LabSectionMeeting[]>): {
    unsubscribe: Unsubscribe;
    data: LabSectionMeeting[];
  } {
    return { unsubscribe: () => {}, data: [] };
  }
  getStudentLabSectionId(studentPrivateProfileId: string): number | null {
    return null;
  }
  calculateEffectiveDueDate(
    assignment: Assignment,
    {
      studentPrivateProfileId,
      labSectionId: labSectionIdOverride
    }: { studentPrivateProfileId: string; labSectionId?: number }
  ): Date {
    // Simplified: just return original due date. Consumers should use useAssignmentDueDate hook instead.
    return new Date(assignment.due_date);
  }

  /**
   * Direct Supabase lookup for discussion thread read status.
   * Used by useDiscussionThreadReadStatus when a row is not yet in the TanStack cache.
   */
  async getDiscussionThreadReadStatusByFilters(
    filters: Array<{ column: string; operator: string; value: unknown }>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = this.client.from("discussion_thread_read_status").select("*");
    for (const f of filters) {
      query = query.filter(f.column, f.operator, f.value);
    }
    const { data, error } = await query.single();
    if (error) return undefined;
    return data;
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
   * Data is always considered loaded -- TanStack Query handles loading states.
   */
  get isDataLoaded() {
    return true;
  }

  close(): void {
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
  children
}: {
  profile_id: string;
  role: Database["public"]["Enums"]["app_role"];
  course_id: number;
  children: React.ReactNode;
}) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_classRealTimeController, setClassRealTimeController] = useState<ClassRealTimeController | null>(null);
  const [courseController, setCourseController] = useState<CourseController | null>(null);
  const { user } = useAuthState();
  const userId = user?.id;
  const { leader } = useLeaderContext();
  const queryClient = useQueryClient();

  // Initialize ClassRealTimeController.
  // Only the leader tab calls start() to open class-wide WebSocket channels.
  // Follower tabs receive data via BroadcastChannel diffs from the leader.
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
      const _courseController = new CourseController(role, course_id, client, realTimeController, userId);
      setCourseController(_courseController);
      const init = async () => {
        try {
          // Only start WebSocket channels if this tab is the leader
          if (leader?.isLeader) {
            await realTimeController.start();
          }

          if (cancelled) {
            _courseController?.close();
            await realTimeController.close();
            return;
          }

          _courseController.initializeEagerControllers();
          setClassRealTimeController(realTimeController);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("Failed to start ClassRealTimeController:", e);
          _courseController?.close();
          await realTimeController.close();
        }
      };
      init();

      // React to leader changes: start/stop class-wide channels
      const leaderUnsub = leader?.onLeaderChange(async (nowLeader) => {
        if (cancelled) return;
        if (nowLeader) {
          await realTimeController.start();
        } else {
          await realTimeController.closeClassChannels();
        }
      });

      return () => {
        cancelled = true;
        leaderUnsub?.();
        _courseController?.close();
        realTimeController.close();
      };
    }
  }, [course_id, profile_id, role, userId, leader]);

  // Inject QueryClient on every render so shims can invalidate TanStack caches
  if (courseController) {
    courseController._qc = queryClient;
  }

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
  const course = useCourse();
  const time_zone = course.time_zone;

  const { data: labSections = [], isLoading: labSectionsLoading } = useLabSectionsQuery();
  const { data: labSectionMeetings = [], isLoading: labSectionMeetingsLoading } = useLabSectionMeetingsQuery();
  const labSectionsReady = !labSectionsLoading;
  const labSectionMeetingsReady = !labSectionMeetingsLoading;

  const { data: allDueDateExceptions = [] } = useAssignmentDueDateExceptionsQuery();
  const dueDateExceptions = useMemo(
    () =>
      allDueDateExceptions.filter((e) =>
        Boolean(
          (e.assignment_id === assignment.id &&
            ((!options?.studentPrivateProfileId && !e.student_id) ||
              (options?.studentPrivateProfileId && e.student_id === options.studentPrivateProfileId)) &&
            !options?.assignmentGroupId &&
            !e.assignment_group_id) ||
            (options?.assignmentGroupId && e.assignment_group_id === options.assignmentGroupId)
        )
      ),
    [allDueDateExceptions, assignment.id, options?.studentPrivateProfileId, options?.assignmentGroupId]
  );

  const { data: userRoles = [] } = useUserRolesQuery();

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
        const userRole = (userRoles as UserRoleWithPrivateProfileAndUser[]).find(
          (role) => role.private_profile_id === options.studentPrivateProfileId
        );
        labSectionId = userRole?.lab_section_id || null;
      } else if (options?.labSectionId) {
        labSectionId = options.labSectionId;
      }

      if (labSectionId) {
        const labSection = labSections.find((section) => section.id === labSectionId);
        if (labSection) {
          // Find the most recent lab section meeting before the assignment's original due date
          const assignmentDueDate = new Date(assignment.due_date);
          const relevantMeetings = (labSectionMeetings as LabSectionMeeting[])
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
    userRoles,
    options,
    time_zone
  ]);

  return ret;
}

export function useLateTokens() {
  const { data = [] } = useAssignmentDueDateExceptionsQuery();
  return data as AssignmentDueDateException[];
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
  const { data: roles = [] } = useUserRolesQuery();
  return useMemo(
    () => (roles as UserRoleWithPrivateProfileAndUser[]).filter((r) => r.role === "student") as UserRoleWithUser[],
    [roles]
  );
}

/**
 * Hook to get user roles with full profile and user information for enrollments management
 * Includes disabled user roles
 */
export function useUserRolesWithProfiles() {
  const { data = [] } = useUserRolesQuery();
  return data as UserRoleWithPrivateProfileAndUser[];
}

/**
 * Hook to get user roles with full profile and user information for enrollments management
 * Only includes active user roles
 */
export function useActiveUserRolesWithProfiles() {
  const { data = [] } = useUserRolesQuery();
  return useMemo(() => (data as UserRoleWithPrivateProfileAndUser[]).filter((r) => r.disabled === false), [data]);
}

/**
 * Hook to get all tags for the course
 */
export function useTags() {
  const { data = [] } = useTagsQuery();
  return data;
}

/**
 * Hook to get tags for a specific profile
 */
export function useProfileTags(profileId: string | undefined) {
  const { data: allTags = [] } = useTagsQuery();
  return useMemo(() => {
    if (!profileId) return [];
    return allTags.filter((t) => t.profile_id === profileId);
  }, [allTags, profileId]);
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
  const { data = [] } = useStudentDeadlineExtensionsQuery();
  return data as StudentDeadlineExtension[];
}

/**
 * Hook to get all assignments for the course
 */
export function useAssignments() {
  const { data = [] } = useAssignmentsQuery();
  return data;
}

/**
 * Hook to get discussion topics for the course
 */
export function useDiscussionTopics() {
  const { data = [] } = useDiscussionTopicsQuery();
  return data;
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
  const { data: channels = [] } = useDiscordChannelsQuery();

  return useMemo(() => {
    const found = channels.find(
      (channel) =>
        channel.channel_type === channelType &&
        (resourceId === undefined || resourceId === null || channel.resource_id === resourceId)
    );
    return found ?? null;
  }, [channels, channelType, resourceId]);
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
  const { data: messages = [] } = useDiscordMessagesQuery();

  return useMemo(() => {
    if (resourceId === null || resourceId === undefined) return null;
    const found = messages.find((m) => m.resource_type === resourceType && m.resource_id === resourceId);
    return found ?? null;
  }, [messages, resourceType, resourceId]);
}

/**
 * Hook to get all live polls for the course with real-time updates
 */
export function useLivePolls() {
  const { data = [] } = useLivePollsQuery();
  return data;
}

/**
 * Hook to get only live (active) polls for the course with real-time updates
 */
export function useActiveLivePolls() {
  const { data: allPolls = [], isLoading } = useLivePollsQuery();
  const polls = useMemo(() => allPolls.filter((poll) => poll.is_live === true), [allPolls]);

  return { polls, isLoading };
}

/**
 * Hook to get a single poll by ID with real-time updates
 */
export function useLivePoll(pollId: string | undefined) {
  const { data = [] } = useLivePollsQuery();
  return useMemo(() => data.find((p) => p.id === pollId), [data, pollId]);
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
  const { data = [] } = useSurveysQuery();
  return data;
}

/**
 * Hook to get a single survey by ID with real-time updates
 */
export function useSurvey(surveyId: string | undefined) {
  const { data = [] } = useSurveysQuery();
  return useMemo(() => data.find((s) => s.id === surveyId), [data, surveyId]);
}

/**
 * Hook to get only published surveys for the course (for students)
 */
export function usePublishedSurveys() {
  const { data: allSurveys = [], isLoading } = useSurveysQuery();
  const surveys = useMemo(() => allSurveys.filter((s) => s.status === "published" && !s.deleted_at), [allSurveys]);

  return { surveys, isLoading };
}

/**
 * Type for survey response with profile data
 */
export type SurveyResponseWithProfile = Database["public"]["Tables"]["survey_responses"]["Row"] & {
  profiles: { id: string; name: string | null } | null;
};

/**
 * Hook to get survey responses for a specific survey.
 * Fetches directly via Supabase, joined with profiles.
 */
export function useSurveyResponses(surveyId: string | undefined) {
  const controller = useCourseController();
  const { data: allProfiles = [] } = useProfilesQuery();
  const [responses, setResponses] = useState<SurveyResponseWithProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!surveyId) {
      setResponses([]);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    const fetchResponses = async () => {
      setIsLoading(true);
      const { data, error } = await controller.client
        .from("survey_responses")
        .select("*")
        .eq("survey_id", surveyId)
        .eq("is_submitted", true)
        .is("deleted_at", null);
      if (cancelled) return;
      if (error) {
        setIsLoading(false);
        return;
      }
      const profileMap = new Map(allProfiles.map((p: { id: string; name: string | null }) => [p.id, p]));
      const responsesWithProfiles: SurveyResponseWithProfile[] = (data ?? []).map((r) => ({
        ...r,
        profiles: profileMap.get(r.profile_id)
          ? { id: r.profile_id, name: profileMap.get(r.profile_id)?.name ?? null }
          : null
      }));
      setResponses(responsesWithProfiles);
      setIsLoading(false);
    };
    fetchResponses();
    return () => {
      cancelled = true;
    };
  }, [surveyId, controller.client, allProfiles]);

  return { responses, isLoading };
}

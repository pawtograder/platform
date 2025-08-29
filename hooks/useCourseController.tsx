"use client";

import { toaster } from "@/components/ui/toaster";
import { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import TableController, {
  PossiblyTentativeResult,
  useFindTableControllerValue,
  useListTableControllerValues
} from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import {
  Assignment,
  AssignmentDueDateException,
  ClassSection,
  Course,
  DiscussionThread,
  DiscussionThreadReadStatus,
  DiscussionThreadWatcher,
  HelpRequestWatcher,
  LabSection,
  LabSectionMeeting,
  Notification,
  Tag,
  UserProfile,
  UserRoleWithPrivateProfileAndUser,
  UserRoleWithUser
} from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Spinner } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { LiveEvent, useList, useUpdate } from "@refinedev/core";
import { SupabaseClient } from "@supabase/supabase-js";
import { addHours, addMinutes } from "date-fns";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import useAuthState from "./useAuthState";
import { useClassProfiles } from "./useClassProfiles";
import { DiscussionThreadReadWithAllDescendants } from "./useDiscussionThreadRootController";

export function useAllProfilesForClass() {
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
    return allProfiles.filter((profile) => !staffProfileIds.has(profile.id) && profile.is_private_profile);
  }, [allProfiles, allTags]);
}
export function useGradersAndInstructors() {
  const { userRolesWithProfiles: controller } = useCourseController();
  const [gradersAndInstructors, setGradersAndInstructors] = useState<UserProfile[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.list((data) => {
      const gradersAndInstructors = data.filter((r) => r.role === "grader" || r.role === "instructor");
      setGradersAndInstructors((old) => {
        if (old && old.length == gradersAndInstructors.length) {
          if (old.every((r) => gradersAndInstructors.some((s) => s.private_profile_id === r.id))) {
            return old;
          }
        }
        return gradersAndInstructors.map((r) => r.profiles);
      });
    });
    setGradersAndInstructors(data.filter((r) => r.role === "grader" || r.role === "instructor").map((r) => r.profiles));
    return unsubscribe;
  }, [controller]);
  return gradersAndInstructors;
}

export function useAllStudentRoles() {
  const { userRolesWithProfiles: controller } = useCourseController();
  const [roles, setRoles] = useState<UserRoleWithPrivateProfileAndUser[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.list((data) => {
      const students = data.filter((r) => r.role === "student");
      setRoles((old) => {
        if (old && old.length == students.length) {
          if (old.every((r) => students.some((s) => s.id === r.id))) {
            return old;
          }
        }
        return students;
      });
    });
    setRoles(data.filter((r) => r.role === "student"));
    return unsubscribe;
  }, [controller]);
  return roles;
}
export function useStudentRoster() {
  const { userRolesWithProfiles: controller } = useCourseController();
  const studentRoles = useListTableControllerValues(controller, (r) => r.role === "student");
  const [roster, setRoster] = useState<UserProfile[] | undefined>(undefined);
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
export function useUpdateThreadTeaser() {
  const { mutateAsync: updateThread } = useUpdate<DiscussionThread>({
    resource: "discussion_threads",
    mutationMode: "optimistic"
  });
  return useCallback(
    async ({ id, values }: { id: number; old: DiscussionThreadTeaser; values: Partial<DiscussionThreadTeaser> }) => {
      try {
        await updateThread({
          id,
          values
        });
      } catch {
        toaster.error({
          title: "Error updating thread",
          description: "Please try again later."
        });
      }
    },
    [updateThread]
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
      if (!controller.discussionThreadReadStatus.ready || readStatus === undefined) {
        return;
      }
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
        const readStatus = await controller.discussionThreadReadStatus.getOneByFilters([
          {
            column: "discussion_thread_id",
            operator: "eq",
            value: threadId
          },
          {
            column: "user_id",
            operator: "eq",
            value: user?.id || ""
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
  const [teaser, setTeaser] = useState<DiscussionThreadTeaser | undefined>(undefined);
  useEffect(() => {
    if (id === undefined) {
      setTeaser(undefined);
      return;
    }
    const { unsubscribe, data } = controller.discussionThreadTeasers.getById(id, (data) => {
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
    return unsubscribe;
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
  private _client: SupabaseClient<Database>;
  private _userId: string;

  // Lazily created TableController instances to avoid realtime subscription bursts
  private _discussionThreadTeasers?: TableController<"discussion_threads">;
  private _discussionThreadReadStatus?: TableController<"discussion_thread_read_status">;
  private _discussionThreadWatchers?: TableController<"discussion_thread_watchers">;
  private _tags?: TableController<"tags">;
  private _labSections?: TableController<"lab_sections">;
  private _labSectionMeetings?: TableController<"lab_section_meetings">;
  private _classSections?: TableController<"class_sections">;
  private _profiles?: TableController<"profiles">;
  private _userRolesWithProfiles?: TableController<"user_roles", "*, profiles!private_profile_id(*), users(*)">;

  constructor(
    public role: Database["public"]["Enums"]["app_role"],
    public courseId: number,
    client: SupabaseClient<Database>,
    classRealTimeController: ClassRealTimeController,
    userId: string
  ) {
    this._classRealTimeController = classRealTimeController;
    this._client = client as SupabaseClient<Database>;
    this._userId = userId;
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
    void this.userRolesWithProfiles; // Triggers lazy creation
  }

  get classRealTimeController(): ClassRealTimeController {
    if (!this._classRealTimeController) {
      throw new Error("ClassRealTimeController not initialized.");
    }
    return this._classRealTimeController;
  }

  // Lazy getters
  get profiles(): TableController<"profiles"> {
    if (!this._profiles) {
      this._profiles = new TableController({
        client: this._client,
        table: "profiles",
        query: this._client.from("profiles").select("*").eq("class_id", this.courseId),
        classRealTimeController: this.classRealTimeController
      });
    }
    return this._profiles;
  }

  get discussionThreadTeasers(): TableController<"discussion_threads"> {
    if (!this._discussionThreadTeasers) {
      this._discussionThreadTeasers = new TableController({
        client: this._client,
        table: "discussion_threads",
        query: this._client.from("discussion_threads").select("*").eq("root_class_id", this.courseId),
        classRealTimeController: this.classRealTimeController,
        realtimeFilter: { root_class_id: this.courseId }
      });
    }
    return this._discussionThreadTeasers;
  }

  get discussionThreadReadStatus(): TableController<"discussion_thread_read_status"> {
    if (!this._discussionThreadReadStatus) {
      this._discussionThreadReadStatus = new TableController({
        client: this._client,
        table: "discussion_thread_read_status",
        query: this._client.from("discussion_thread_read_status").select("*").eq("user_id", this._userId),
        classRealTimeController: this.classRealTimeController
      });
    }
    return this._discussionThreadReadStatus;
  }

  get discussionThreadWatchers(): TableController<"discussion_thread_watchers"> {
    if (!this._discussionThreadWatchers) {
      this._discussionThreadWatchers = new TableController({
        client: this._client,
        table: "discussion_thread_watchers",
        query: this._client
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

  get tags(): TableController<"tags"> {
    if (!this._tags) {
      this._tags = new TableController({
        client: this._client,
        table: "tags",
        query: this._client.from("tags").select("*").eq("class_id", this.courseId),
        classRealTimeController: this.classRealTimeController
      });
    }
    return this._tags;
  }

  get labSections(): TableController<"lab_sections"> {
    if (!this._labSections) {
      this._labSections = new TableController({
        client: this._client,
        table: "lab_sections",
        query: this._client.from("lab_sections").select("*").eq("class_id", this.courseId),
        classRealTimeController: this.classRealTimeController
      });
    }
    return this._labSections;
  }

  get labSectionMeetings(): TableController<"lab_section_meetings"> {
    if (!this._labSectionMeetings) {
      this._labSectionMeetings = new TableController({
        client: this._client,
        table: "lab_section_meetings",
        query: this._client.from("lab_section_meetings").select("*").eq("class_id", this.courseId),
        classRealTimeController: this.classRealTimeController
      });
    }
    return this._labSectionMeetings;
  }

  get classSections(): TableController<"class_sections"> {
    if (!this._classSections) {
      this._classSections = new TableController({
        client: this._client,
        table: "class_sections",
        query: this._client.from("class_sections").select("*").eq("class_id", this.courseId),
        classRealTimeController: this.classRealTimeController
      });
    }
    return this._classSections;
  }

  get userRolesWithProfiles(): TableController<"user_roles", "*, profiles!private_profile_id(*), users(*)"> {
    if (!this._userRolesWithProfiles) {
      this._userRolesWithProfiles = new TableController({
        client: this._client,
        table: "user_roles",
        query: this._client
          .from("user_roles")
          .select("*, profiles!private_profile_id(*), users(*)")
          .eq("class_id", this.courseId),
        selectForSingleRow: "*, profiles!private_profile_id(*), users(*)",
        classRealTimeController: this.classRealTimeController
      });
    }
    return this._userRolesWithProfiles;
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
    if (!idGetter) return;

    for (const item of data) {
      const id = idGetter(item);
      this.genericData[typeName].set(id, item);
      const itemSubscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
      itemSubscribers.forEach((cb) => cb(item));
    }
    const listSubscribers = this.genericDataListSubscribers[typeName] || [];
    listSubscribers.forEach((cb) => cb(Array.from(this.genericData[typeName]?.values() ?? [])));
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
          this.genericDataListSubscribers[typeName]?.filter((cb) => cb !== (callback as UpdateCallback<unknown[]>)) ||
          [];
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
        const id = relevantIds[0]!;
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
    if (!idGetter) return;

    const id = idGetter(body);
    if (!this.genericData[typeName]) {
      this.genericData[typeName] = new Map();
    }

    if (event.type === "created") {
      this.genericData[typeName]!.set(id, body);
      this.genericDataSubscribers[typeName]?.get(id)?.forEach((cb) => cb(body));
      this.genericDataListSubscribers[typeName]?.forEach((cb) =>
        cb(Array.from(this.genericData[typeName]?.values() ?? []))
      );
    } else if (event.type === "updated") {
      this.genericData[typeName]!.set(id, body);
      this.genericDataSubscribers[typeName]?.get(id)?.forEach((cb) => cb(body));
      this.genericDataListSubscribers[typeName]?.forEach((cb) =>
        cb(Array.from(this.genericData[typeName]?.values() ?? []))
      );
    } else if (event.type === "deleted") {
      this.genericData[typeName]!.delete(id);
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
      (data as UserRoleWithPrivateProfileAndUser[])
        .filter((role) => role.role === "student")
        .map((role) => role as unknown as UserRoleWithUser);

    if (callback) {
      const result = this.userRolesWithProfiles.list((data) => {
        callback(mapToStudentUserRoles(data as unknown[]));
      });
      return {
        unsubscribe: result.unsubscribe,
        data: mapToStudentUserRoles(result.data as unknown[])
      };
    }

    const result = this.userRolesWithProfiles.list();
    return {
      unsubscribe: result.unsubscribe,
      data: mapToStudentUserRoles(result.data as unknown[])
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
    const mostRecentLabMeeting = relevantMeetings[0]!;
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
    > = [];
    if (this._profiles) createdControllers.push(this._profiles);
    if (this._userRolesWithProfiles) createdControllers.push(this._userRolesWithProfiles);
    if (this._discussionThreadTeasers) createdControllers.push(this._discussionThreadTeasers);
    if (this._discussionThreadReadStatus) createdControllers.push(this._discussionThreadReadStatus);
    if (this._tags) createdControllers.push(this._tags);
    if (this._labSections) createdControllers.push(this._labSections);
    if (this._labSectionMeetings) createdControllers.push(this._labSectionMeetings);
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
    this._tags?.close();
    this._labSections?.close();
    this._labSectionMeetings?.close();
    this._classSections?.close();

    if (this._classRealTimeController) {
      this._classRealTimeController.close();
    }
  }
}

function CourseControllerProviderImpl({ controller, course_id }: { controller: CourseController; course_id: number }) {
  const { user } = useAuthState();
  const course = useCourse();

  useEffect(() => {
    controller.course = course;
  }, [course, controller]);

  const { data: notifications } = useList<Notification>({
    resource: "notifications",
    filters: [{ field: "user_id", operator: "eq", value: user?.id }],
    liveMode: "manual",
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
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
    controller.registerGenericDataType("notifications", (item: unknown) => (item as Notification).id);
    if (notifications?.data) {
      controller.setGeneric("notifications", notifications.data);
    }
  }, [controller, notifications?.data]);

  const { data: threadWatches } = useList<DiscussionThreadWatcher>({
    resource: "discussion_thread_watchers",
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
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
    liveMode: "manual",
    onLiveEvent: (event) => {
      controller.handleGenericDataEvent("discussion_thread_watchers", event);
    }
  });
  useEffect(() => {
    controller.registerGenericDataType(
      "discussion_thread_watchers",
      (item: unknown) => (item as DiscussionThreadWatcher).discussion_thread_root_id
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
      cacheTime: Infinity
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
    liveMode: "manual",
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

  const { data: dueDateExceptions } = useList<AssignmentDueDateException>({
    resource: "assignment_due_date_exceptions",
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    },
    liveMode: "manual",
    onLiveEvent: (event) => {
      controller.handleGenericDataEvent("assignment_due_date_exceptions", event);
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    pagination: {
      pageSize: 1000
    }
  });
  useEffect(() => {
    controller.registerGenericDataType(
      "assignment_due_date_exceptions",
      (item: unknown) => (item as AssignmentDueDateException).id
    );
    if (dueDateExceptions?.data) {
      controller.setGeneric("assignment_due_date_exceptions", dueDateExceptions.data);
    }
  }, [controller, dueDateExceptions?.data]);

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
      const _courseController = new CourseController(role, course_id, client, realTimeController, userId);
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
  }, [course_id, profile_id, role, userId]);

  if (!courseController) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" height="100vh">
        <Spinner />
      </Box>
    );
  }

  return (
    <CourseControllerContext.Provider value={courseController}>
      <CourseControllerProviderImpl controller={courseController} course_id={course_id} />
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
  assignment: Assignment,
  options?: { studentPrivateProfileId?: string; labSectionId?: number }
) {
  const controller = useCourseController();
  const course = useCourse();
  const time_zone = course.time_zone;
  const [dueDateExceptions, setDueDateExceptions] = useState<AssignmentDueDateException[]>();
  const [labSections, setLabSections] = useState<LabSection[]>();
  const [labSectionMeetings, setLabSectionMeetings] = useState<LabSectionMeeting[]>();

  useEffect(() => {
    if (assignment.due_date) {
      const { data: dueDateExceptions, unsubscribe } = controller.listGenericData<AssignmentDueDateException>(
        "assignment_due_date_exceptions",
        (data) => setDueDateExceptions(data.filter((e) => e.assignment_id === assignment.id))
      );
      setDueDateExceptions(dueDateExceptions.filter((e) => e.assignment_id === assignment.id));
      return () => unsubscribe();
    }
  }, [assignment, controller]);

  useEffect(() => {
    const { data: labSections, unsubscribe: unsubscribeLabSections } = controller.listLabSections((data) =>
      setLabSections(data)
    );
    setLabSections(labSections);

    const { data: labSectionMeetings, unsubscribe: unsubscribeLabMeetings } = controller.listLabSectionMeetings(
      (data) => setLabSectionMeetings(data)
    );
    setLabSectionMeetings(labSectionMeetings);

    return () => {
      unsubscribeLabSections();
      unsubscribeLabMeetings();
    };
  }, [controller]);

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

    if (hasLabScheduling && labSections && labSectionMeetings) {
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
            const mostRecentLabMeeting = relevantMeetings[0]!;
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
  }, [dueDateExceptions, labSections, labSectionMeetings, assignment, controller, options, time_zone]);

  return ret;
}

export function useLateTokens() {
  const controller = useCourseController();
  const [lateTokens, setLateTokens] = useState<AssignmentDueDateException[]>();
  useEffect(() => {
    const { data: lateTokens, unsubscribe } = controller.listGenericData<AssignmentDueDateException>(
      "assignment_due_date_exceptions",
      (data) => setLateTokens(data)
    );
    setLateTokens(lateTokens);
    return () => unsubscribe();
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

"use client";
import {
  Assignment,
  AssignmentDueDateException,
  Course,
  DiscussionThread,
  DiscussionThreadReadStatus,
  DiscussionThreadWatcher,
  HelpRequestWatcher,
  LabSection,
  LabSectionMeeting,
  Notification,
  Tag,
  UserProfile
} from "@/utils/supabase/DatabaseTypes";

import { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import TableController from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { SupabaseClient } from "@supabase/supabase-js";
import { Box, Spinner } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { LiveEvent, useCreate, useList, useUpdate } from "@refinedev/core";
import { addHours, addMinutes } from "date-fns";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import useAuthState from "./useAuthState";
import { useClassProfiles } from "./useClassProfiles";
import { DiscussionThreadReadWithAllDescendants } from "./useDiscussionThreadRootController";
import { toaster } from "@/components/ui/toaster";

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
  const [readStatus, setReadStatus] = useState<DiscussionThreadReadWithAllDescendants | null | undefined>(undefined);
  useEffect(() => {
    const { unsubscribe, data } = controller.getDiscussionThreadReadStatus(threadId, (data) => {
      setReadStatus(data);
    });
    setReadStatus(data);
    return unsubscribe;
  }, [controller, threadId]);
  const createdThreadReadStatuses = useRef<Set<number>>(new Set<number>());
  const { mutateAsync: createThreadReadStatus } = useCreate<DiscussionThreadReadStatus>({
    resource: "discussion_thread_read_status"
  });
  const { mutateAsync: updateThreadReadStatus } = useUpdate<DiscussionThreadReadStatus>({
    resource: "discussion_thread_read_status",
    mutationMode: "optimistic"
  });

  const setUnread = useCallback(
    (root_threadId: number, threadId: number, isUnread: boolean) => {
      if (!controller.isLoaded) {
        return;
      }
      const { data: threadReadStatus } = controller.getDiscussionThreadReadStatus(threadId);
      if (threadReadStatus) {
        if (isUnread && threadReadStatus.read_at) {
          updateThreadReadStatus({
            id: threadReadStatus.id,
            values: { read_at: null }
          });
        } else if (!isUnread && !threadReadStatus.read_at) {
          updateThreadReadStatus({
            id: threadReadStatus.id,
            values: { read_at: new Date() }
          });
        }
      } else {
        if (createdThreadReadStatuses.current.has(threadId)) {
          return;
        }
        createdThreadReadStatuses.current.add(threadId);
        createThreadReadStatus({
          values: {
            discussion_thread_id: threadId,
            user_id: user?.id,
            discussion_thread_root_id: root_threadId,
            read_at: isUnread ? null : new Date()
          }
        }).catch(() => {
          toaster.error({
            title: "Error creating thread read status",
            description: "Please try again later"
          });
        });
      }
    },
    [user?.id, createdThreadReadStatuses, controller, createThreadReadStatus, updateThreadReadStatus]
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
    const { data, unsubscribe } = controller.discussionThreads.list((data) => {
      setTeasers(data as DiscussionThreadTeaser[]);
    });
    setTeasers(data as DiscussionThreadTeaser[]);
    return unsubscribe;
  }, [controller]);
  return teasers;
}
type DiscussionThreadFields = keyof DiscussionThreadTeaser;
export function useDiscussionThreadTeaser(id: number, watchFields?: DiscussionThreadFields[]) {
  const controller = useCourseController();
  const [teaser, setTeaser] = useState<DiscussionThreadTeaser | undefined>(undefined);
  useEffect(() => {
    const { unsubscribe, data } = controller.discussionThreads.getById(id, (data) => {
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

export type UpdateCallback<T> = (data: T) => void;
export type Unsubscribe = () => void;
export type UserProfileWithPrivateProfile = UserProfile & {
  private_profile?: UserProfile;
};

/**
 * This class is responsible for managing realtime course data.
 */
export class CourseController {
  private _isLoaded = false;
  private _isObfuscatedGrades: boolean = false;
  private _onlyShowGradesFor: string = "";
  private isObfuscatedGradesListeners: ((val: boolean) => void)[] = [];
  private onlyShowGradesForListeners: ((val: string) => void)[] = [];
  private _classRealTimeController: ClassRealTimeController | null = null;

  // TableController instances for each table
  readonly profiles: TableController<"profiles">;
  readonly userRoles: TableController<"user_roles">;
  readonly discussionThreads: TableController<"discussion_threads">;
  readonly discussionThreadReadStatus: TableController<"discussion_thread_read_status">;
  readonly tags: TableController<"tags">;
  readonly labSections: TableController<"lab_sections">;
  readonly labSectionMeetings: TableController<"lab_section_meetings">;

  constructor(
    public courseId: number,
    client: SupabaseClient<Database>,
    classRealTimeController: ClassRealTimeController
  ) {
    this._classRealTimeController = classRealTimeController;

    // Initialize TableController instances
    this.profiles = new TableController({
      client,
      table: "profiles",
      query: client.from("profiles").select("*").eq("class_id", courseId),
      classRealTimeController
    });

    this.userRoles = new TableController({
      client,
      table: "user_roles",
      query: client.from("user_roles").select("*").eq("class_id", courseId),
      classRealTimeController
    });

    this.discussionThreads = new TableController({
      client,
      table: "discussion_threads",
      query: client.from("discussion_threads").select("*").eq("class_id", courseId),
      classRealTimeController
    });

    this.discussionThreadReadStatus = new TableController({
      client,
      table: "discussion_thread_read_status",
      query: client.from("discussion_thread_read_status").select("*"),
      classRealTimeController
    });

    this.tags = new TableController({
      client,
      table: "tags",
      query: client.from("tags").select("*").eq("class_id", courseId),
      classRealTimeController
    });

    this.labSections = new TableController({
      client,
      table: "lab_sections",
      query: client.from("lab_sections").select("*").eq("class_id", courseId),
      classRealTimeController
    });

    this.labSectionMeetings = new TableController({
      client,
      table: "lab_section_meetings",
      query: client.from("lab_section_meetings").select("*").eq("class_id", courseId),
      classRealTimeController
    });
  }

  get classRealTimeController(): ClassRealTimeController {
    if (!this._classRealTimeController) {
      throw new Error("ClassRealTimeController not initialized.");
    }
    return this._classRealTimeController;
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
      return this.discussionThreads.getById(id, (data) => {
        if (data) callback(data as DiscussionThreadTeaser);
      });
    }
    return this.discussionThreads.getById(id);
  }

  listDiscussionThreadTeasers(callback?: UpdateCallback<DiscussionThreadTeaser[]>): {
    unsubscribe: Unsubscribe;
    data: DiscussionThreadTeaser[];
  } {
    if (callback) {
      return this.discussionThreads.list((data) => {
        callback(data as DiscussionThreadTeaser[]);
      });
    }
    const result = this.discussionThreads.list();
    return {
      unsubscribe: result.unsubscribe,
      data: result.data as DiscussionThreadTeaser[]
    };
  }

  get isLoaded() {
    return this._isLoaded;
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

  getUserProfile(id: string, callback?: UpdateCallback<UserProfileWithPrivateProfile>) {
    if (callback) {
      return this.profiles.getById(id, (data) => {
        if (data) callback(data as UserProfileWithPrivateProfile);
      });
    }
    return this.profiles.getById(id);
  }

  getUserRole(user_id: string) {
    const result = this.userRoles.list();
    return result.data.find((role) => role.user_id === user_id);
  }

  getUserRoleByPrivateProfileId(private_profile_id: string) {
    const result = this.userRoles.list();
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
    const result = this.userRoles.list();
    return result.data.filter((role) => role.role === "student");
  }

  getProfileBySisId(sis_id: string) {
    const result = this.profiles.list();
    return result.data.find((profile) => profile.sis_user_id === sis_id);
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
    const result = this.userRoles.list();
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
    // Check if all TableControllers are ready
    return (
      this.profiles.ready &&
      this.userRoles.ready &&
      this.discussionThreads.ready &&
      this.discussionThreadReadStatus.ready &&
      this.tags.ready &&
      this.labSections.ready &&
      this.labSectionMeetings.ready
    );
  }

  // Close method to clean up TableController instances
  close(): void {
    this.profiles.close();
    this.userRoles.close();
    this.discussionThreads.close();
    this.discussionThreadReadStatus.close();
    this.tags.close();
    this.labSections.close();
    this.labSectionMeetings.close();

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
    controller.registerGenericDataType("notifications", (item: Notification) => item.id);
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
    controller.registerGenericDataType("assignment_due_date_exceptions", (item: AssignmentDueDateException) => item.id);
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
  const controller = useRef<CourseController | null>(null);
  const client = createClient();
  const [classRealTimeController, setClassRealTimeController] = useState<ClassRealTimeController | null>(null);

  // Initialize ClassRealTimeController
  useEffect(() => {
    const realTimeController = new ClassRealTimeController({
      client,
      classId: course_id,
      profileId: profile_id,
      isStaff: role === "instructor" || role === "grader"
    });

    setClassRealTimeController(realTimeController);

    return () => {
      realTimeController.close();
    };
  }, [client, course_id, profile_id, role]);

  // Initialize CourseController with required dependencies
  if (!controller.current && classRealTimeController) {
    controller.current = new CourseController(course_id, client, classRealTimeController);
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (controller.current) {
        controller.current.close();
        controller.current = null;
      }
    };
  }, []);

  if (!controller.current) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" height="100vh">
        <Spinner />
      </Box>
    );
  }

  return (
    <CourseControllerContext.Provider value={controller.current}>
      <CourseControllerProviderImpl controller={controller.current} course_id={course_id} />
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

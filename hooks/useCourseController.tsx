"use client";
import {
  Assignment,
  AssignmentDueDateException,
  Course,
  DiscussionThread,
  DiscussionThreadReadStatus,
  DiscussionThreadWatcher,
  LabSection,
  LabSectionMeeting,
  Notification,
  Tag,
  UserProfile,
  UserRoleWithUser
} from "@/utils/supabase/DatabaseTypes";

import { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Spinner } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { LiveEvent, useCreate, useList, useUpdate } from "@refinedev/core";
import { addHours, addMinutes } from "date-fns";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import useAuthState from "./useAuthState";
import { useClassProfiles } from "./useClassProfiles";
import { DiscussionThreadReadWithAllDescendants } from "./useDiscussionThreadRootController";

export function useUpdateThreadTeaser() {
  const controller = useCourseController();
  const { mutateAsync: updateThread } = useUpdate<DiscussionThread>({
    resource: "discussion_threads",
    mutationMode: "optimistic"
  });
  return useCallback(
    async ({
      id,
      old,
      values
    }: {
      id: number;
      old: DiscussionThreadTeaser;
      values: Partial<DiscussionThreadTeaser>;
    }) => {
      const copy = { ...old, ...values };
      controller.handleDiscussionThreadTeaserEvent({
        type: "updated",
        payload: copy,
        channel: "discussion_threads",
        date: new Date()
      });
      try {
        await updateThread({
          id,
          values
        });
      } catch (error) {
        console.error("error updating thread", error);
        controller.handleDiscussionThreadTeaserEvent({
          type: "updated",
          payload: old,
          channel: "discussion_threads",
          date: new Date()
        });
      }
    },
    [updateThread, controller]
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
        }).catch((error) => {
          console.error("error creating thread read status", error);
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
    const { data, unsubscribe } = controller.listDiscussionThreadTeasers((data) => {
      setTeasers(data);
    });
    setTeasers(data);
    return unsubscribe;
  }, [controller]);
  return teasers;
}
type DiscussionThreadFields = keyof DiscussionThreadTeaser;
export function useDiscussionThreadTeaser(id: number, watchFields?: DiscussionThreadFields[]) {
  const controller = useCourseController();
  const [teaser, setTeaser] = useState<DiscussionThreadTeaser | undefined>(undefined);
  useEffect(() => {
    const { unsubscribe, data } = controller.getDiscussionThreadTeaser(id, (data) => {
      if (watchFields) {
        setTeaser((oldTeaser) => {
          if (!oldTeaser) {
            return data;
          }
          const hasAnyChanges = watchFields.some((field) => oldTeaser[field] !== data[field]);
          if (hasAnyChanges) {
            return data;
          }
          return oldTeaser;
        });
      } else {
        setTeaser(data);
      }
    });
    setTeaser(data);
    return unsubscribe;
  }, [controller, id, watchFields]);
  return teaser;
}
export type UpdateCallback<T> = (data: T) => void;
export type Unsubscribe = () => void;
export type UserProfileWithPrivateProfile = UserProfile & {
  private_profile?: UserProfile;
};

export class CourseController {
  private _isLoaded = false;
  private _isObfuscatedGrades: boolean = false;
  private _onlyShowGradesFor: string = "";
  private isObfuscatedGradesListeners: ((val: boolean) => void)[] = [];
  private onlyShowGradesForListeners: ((val: string) => void)[] = [];
  private _classRealTimeController: ClassRealTimeController | null = null;

  constructor(public courseId: number) {}

  initializeRealTimeController(profileId: string, isStaff: boolean) {
    if (this._classRealTimeController) {
      this._classRealTimeController.close();
    }

    this._classRealTimeController = new ClassRealTimeController({
      client: createClient(),
      classId: this.courseId,
      profileId,
      isStaff
    });

    this._setupRealtimeSubscriptions();
  }

  private _setupRealtimeSubscriptions() {
    if (!this._classRealTimeController) return;

    this._classRealTimeController.subscribeToTable("profiles", (message) => {
      this.handleProfileEvent({
        type: message.operation?.toLowerCase() as "created" | "updated" | "deleted",
        payload: message.data as UserProfile,
        channel: "profiles",
        date: new Date()
      });
    });

    this._classRealTimeController.subscribeToTable("user_roles", (message) => {
      this.handleUserRoleEvent({
        type: message.operation?.toLowerCase() as "created" | "updated" | "deleted",
        payload: message.data as UserRoleWithUser,
        channel: "user_roles",
        date: new Date()
      });
    });

    this._classRealTimeController.subscribeToTable("discussion_threads", (message) => {
      this.handleDiscussionThreadTeaserEvent({
        type: message.operation?.toLowerCase() as "created" | "updated" | "deleted",
        payload: message.data as DiscussionThreadTeaser,
        channel: "discussion_threads",
        date: new Date()
      });
    });

    this._classRealTimeController.subscribeToTable("discussion_thread_read_status", (message) => {
      this.handleReadStatusEvent({
        type: message.operation?.toLowerCase() as "created" | "updated" | "deleted",
        payload: message.data as DiscussionThreadReadStatus,
        channel: "discussion_thread_read_status",
        date: new Date()
      });
    });

    this._classRealTimeController.subscribeToTable("tags", (message) => {
      this.handleTagEvent({
        type: message.operation?.toLowerCase() as "created" | "updated" | "deleted",
        payload: message.data as Tag,
        channel: "tags",
        date: new Date()
      });
    });

    this._classRealTimeController.subscribeToTable("lab_sections", (message) => {
      this.handleLabSectionEvent({
        type: message.operation?.toLowerCase() as "created" | "updated" | "deleted",
        payload: message.data as LabSection,
        channel: "lab_sections",
        date: new Date()
      });
    });

    this._classRealTimeController.subscribeToTable("lab_section_meetings", (message) => {
      this.handleLabSectionMeetingEvent({
        type: message.operation?.toLowerCase() as "created" | "updated" | "deleted",
        payload: message.data as LabSectionMeeting,
        channel: "lab_section_meetings",
        date: new Date()
      });
    });
  }

  get classRealTimeController(): ClassRealTimeController {
    if (!this._classRealTimeController) {
      throw new Error("ClassRealTimeController not initialized. Call initializeRealTimeController first.");
    }
    return this._classRealTimeController;
  }
  private discussionThreadReadStatusesSubscribers: Map<
    number,
    UpdateCallback<DiscussionThreadReadWithAllDescendants>[]
  > = new Map();
  private discussionThreadReadStatuses: Map<number, DiscussionThreadReadWithAllDescendants> = new Map();
  private userProfiles: Map<string, UserProfileWithPrivateProfile> = new Map();
  private userRoles: Map<string, UserRoleWithUser> = new Map(); //From uid to role
  private userRolesByPrivateProfileId: Map<string, UserRoleWithUser> = new Map(); //From private profile id to role

  private userProfileSubscribers: Map<string, UpdateCallback<UserProfileWithPrivateProfile>[]> = new Map();

  private discussionThreadTeasers: DiscussionThreadTeaser[] = [];
  private discussionThreadTeaserListSubscribers: UpdateCallback<DiscussionThreadTeaser[]>[] = [];
  private discussionThreadTeaserSubscribers: Map<number, UpdateCallback<DiscussionThreadTeaser>[]> = new Map();

  private tags: Tag[] = [];
  private tagListSubscribers: UpdateCallback<Tag[]>[] = [];
  private profileTagSubscribers: Map<string, UpdateCallback<Tag[]>[]> = new Map();

  private labSections: LabSection[] = [];
  private labSectionMeetings: LabSectionMeeting[] = [];
  private labSectionListSubscribers: UpdateCallback<LabSection[]>[] = [];
  private labSectionMeetingListSubscribers: UpdateCallback<LabSectionMeeting[]>[] = [];

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

  handleDiscussionThreadTeaserEvent(event: LiveEvent) {
    if (event.type === "created") {
      const body = event.payload as DiscussionThreadTeaser;
      this.discussionThreadTeasers.push(body);
      this.discussionThreadTeaserListSubscribers.forEach((cb) => cb(this.discussionThreadTeasers));
    } else if (event.type === "updated") {
      const body = event.payload as DiscussionThreadTeaser;
      const existing = this.discussionThreadTeasers.find((teaser) => teaser.id === body.id);
      //Only propagate an update if there is a change that we care about
      if (
        existing &&
        existing.children_count === body.children_count &&
        existing.likes_count === body.likes_count &&
        existing.subject === body.subject &&
        existing.created_at === body.created_at &&
        existing.author === body.author &&
        existing.topic_id === body.topic_id &&
        existing.is_question === body.is_question &&
        existing.instructors_only === body.instructors_only &&
        existing.body === body.body &&
        existing.answer === body.answer &&
        existing.draft === body.draft
      ) {
        return;
      }
      this.discussionThreadTeasers = this.discussionThreadTeasers.map((teaser) =>
        teaser.id === body.id ? body : teaser
      );
      const subscribers = this.discussionThreadTeaserSubscribers.get(body.id) || [];
      subscribers.forEach((cb) => cb(body));
    }
  }
  setDiscussionThreadTeasers(data: DiscussionThreadTeaser[]) {
    if (this.discussionThreadTeasers.length == 0) {
      this.discussionThreadTeasers = data;
      for (const subscriber of this.discussionThreadTeaserListSubscribers) {
        subscriber(data);
      }
    }
  }
  getDiscussionThreadTeaser(
    id: number,
    callback?: UpdateCallback<DiscussionThreadTeaser>
  ): { unsubscribe: Unsubscribe; data: DiscussionThreadTeaser | undefined } {
    const subscribers = this.discussionThreadTeaserSubscribers.get(id) || [];
    if (callback) {
      this.discussionThreadTeaserSubscribers.set(id, [...subscribers, callback]);
    }
    return {
      unsubscribe: () => {
        this.discussionThreadTeaserSubscribers.set(
          id,
          subscribers.filter((cb) => cb !== callback)
        );
      },
      data: this.discussionThreadTeasers.find((teaser) => teaser.id === id)
    };
  }
  listDiscussionThreadTeasers(callback?: UpdateCallback<DiscussionThreadTeaser[]>): {
    unsubscribe: Unsubscribe;
    data: DiscussionThreadTeaser[];
  } {
    if (callback) {
      this.discussionThreadTeaserListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this.discussionThreadTeaserListSubscribers = this.discussionThreadTeaserListSubscribers.filter(
          (cb) => cb !== callback
        );
      },
      data: this.discussionThreadTeasers
    };
  }

  handleReadStatusEvent(event: LiveEvent) {
    const processUpdatedStatus = (updatedStatus: DiscussionThreadReadStatus) => {
      const isRoot = updatedStatus.discussion_thread_root_id === updatedStatus.discussion_thread_id;
      const existingStatuses = Array.from(this.discussionThreadReadStatuses.values());

      const getChildrenCount = (threadId: number): number => {
        return this.discussionThreadTeasers.find((t) => t.id === threadId)?.children_count ?? 0;
      };

      if (isRoot) {
        let numReadDescendants = 0;
        const readDescendants = existingStatuses.filter(
          (status) =>
            status.discussion_thread_id != status.discussion_thread_root_id &&
            status.discussion_thread_root_id === updatedStatus.discussion_thread_id &&
            status.read_at
        );
        for (const status of readDescendants) {
          numReadDescendants += status.read_at ? 1 : 0;
        }

        const childrenCount = getChildrenCount(updatedStatus.discussion_thread_id);
        const newVal = {
          ...updatedStatus,
          numReadDescendants: numReadDescendants,
          current_children_count: childrenCount
        };
        this.discussionThreadReadStatuses.set(updatedStatus.discussion_thread_id, newVal);
        this.notifyDiscussionThreadReadStatusSubscribers(updatedStatus.discussion_thread_id, newVal);
      } else {
        const childrenCount = getChildrenCount(updatedStatus.discussion_thread_id);
        const newVal = {
          ...updatedStatus,
          numReadDescendants: 0, // Non-root threads don't have descendants in this context
          current_children_count: childrenCount
        };
        this.discussionThreadReadStatuses.set(updatedStatus.discussion_thread_id, newVal);
        this.notifyDiscussionThreadReadStatusSubscribers(updatedStatus.discussion_thread_id, newVal);

        const root = this.discussionThreadReadStatuses.get(updatedStatus.discussion_thread_root_id);
        if (root) {
          const readDescendants = existingStatuses.filter(
            (status) =>
              status.discussion_thread_id != status.discussion_thread_root_id &&
              status.discussion_thread_root_id === updatedStatus.discussion_thread_root_id &&
              status.read_at
          );
          let numReadDescendants = 0;
          for (const status of readDescendants) {
            numReadDescendants += status.read_at ? 1 : 0;
          }

          const rootChildrenCount = getChildrenCount(updatedStatus.discussion_thread_root_id);
          const newRootVal = {
            ...root,
            numReadDescendants: numReadDescendants,
            current_children_count: rootChildrenCount
          };
          this.discussionThreadReadStatuses.set(updatedStatus.discussion_thread_root_id, newRootVal);
          this.notifyDiscussionThreadReadStatusSubscribers(updatedStatus.discussion_thread_root_id, newRootVal);
        }
      }
    };
    if (event.type === "created") {
      const body = event.payload as DiscussionThreadReadStatus;
      processUpdatedStatus(body);
    } else if (event.type === "updated") {
      const body = event.payload as DiscussionThreadReadStatus;
      processUpdatedStatus(body);
    }
  }
  get isLoaded() {
    return this._isLoaded;
  }
  getDiscussionThreadReadStatus(
    threadId: number,
    callback?: UpdateCallback<DiscussionThreadReadWithAllDescendants>
  ): { unsubscribe: Unsubscribe; data: DiscussionThreadReadWithAllDescendants | undefined | null } {
    const subscribers = this.discussionThreadReadStatusesSubscribers.get(threadId) || [];
    if (callback) {
      this.discussionThreadReadStatusesSubscribers.set(threadId, [...subscribers, callback]);
    }
    return {
      unsubscribe: () => {
        this.discussionThreadReadStatusesSubscribers.set(
          threadId,
          subscribers.filter((cb) => cb !== callback)
        );
      },
      data: this.isLoaded ? this.discussionThreadReadStatuses.get(threadId) || null : undefined
    };
  }
  setDiscussionThreadReadStatuses(data: DiscussionThreadReadStatus[]) {
    if (!this._isLoaded) {
      this._isLoaded = true;
      // Ensure teasers are potentially loaded first or available
      const currentTeasers = this.discussionThreadTeasers;
      for (const thread of data) {
        // Find the corresponding teaser to get the children_count
        const correspondingTeaser = currentTeasers.find((t) => t.id === thread.discussion_thread_id);
        const childrenCount = correspondingTeaser?.children_count ?? 0;

        this.discussionThreadReadStatuses.set(thread.discussion_thread_id, {
          ...thread,
          numReadDescendants: data.filter(
            (t) =>
              t.discussion_thread_id != t.discussion_thread_root_id &&
              t.discussion_thread_root_id === thread.discussion_thread_id &&
              t.read_at
          ).length,
          current_children_count: childrenCount
        });
        this.notifyDiscussionThreadReadStatusSubscribers(
          thread.discussion_thread_id,
          this.discussionThreadReadStatuses.get(thread.discussion_thread_id)!
        );
      }
    }
  }
  setUserProfiles(profiles: UserProfile[], roles: UserRoleWithUser[]) {
    for (const profile of profiles) {
      this.userProfiles.set(profile.id, { ...profile });
    }
    for (const role of roles) {
      this.userRoles.set(role.user_id, role);
      this.userRolesByPrivateProfileId.set(role.private_profile_id, role);
      const privateProfile = this.userProfiles.get(role.private_profile_id);
      const publicProfile = this.userProfiles.get(role.public_profile_id);
      if (privateProfile && publicProfile) {
        publicProfile.private_profile = privateProfile;
      }
    }
    //Fire all callbacks
    for (const id of this.userProfileSubscribers.keys()) {
      const callbacks = this.userProfileSubscribers.get(id);
      if (callbacks) {
        callbacks.forEach((cb) => cb(this.userProfiles.get(id)!));
      }
    }
  }
  getUserRole(user_id: string) {
    return this.userRoles.get(user_id);
  }
  getUserRoleByPrivateProfileId(private_profile_id: string) {
    return this.userRolesByPrivateProfileId.get(private_profile_id);
  }
  getUserProfile(id: string, callback?: UpdateCallback<UserProfileWithPrivateProfile>) {
    const profile = this.userProfiles.get(id);
    if (callback) {
      this.userProfileSubscribers.set(id, [...(this.userProfileSubscribers.get(id) || []), callback]);
    }
    return {
      unsubscribe: () => {
        this.userProfileSubscribers.set(
          id,
          this.userProfileSubscribers.get(id)!.filter((cb) => cb !== callback)
        );
      },
      data: profile
    };
  }
  private notifyDiscussionThreadReadStatusSubscribers(threadId: number, data: DiscussionThreadReadWithAllDescendants) {
    const subscribers = this.discussionThreadReadStatusesSubscribers.get(threadId);
    if (subscribers && subscribers.length > 0) {
      subscribers.forEach((cb) => cb(data));
    }
  }

  setTags(data: Tag[]) {
    this.tags = data;
    this.tagListSubscribers.forEach((callback) => callback(data));
    this.profileTagSubscribers.forEach((subscribers, profile_id) => {
      subscribers.forEach((callback) => callback(data.filter((t) => t.profile_id === profile_id)));
    });
  }

  getTagsForProfile(
    profile_id: string,
    callback?: UpdateCallback<Tag[]>
  ): { unsubscribe: Unsubscribe; data: Tag[] | undefined } {
    if (callback) {
      if (!this.profileTagSubscribers.has(profile_id)) {
        this.profileTagSubscribers.set(profile_id, []);
      }
      this.profileTagSubscribers.get(profile_id)!.push(callback);
      const tag = this.tags.filter((t) => t.profile_id === profile_id);
      if (tag) {
        callback(tag);
      }
    }

    return {
      unsubscribe: () => {
        if (callback) {
          const subscribers = this.profileTagSubscribers.get(profile_id);
          if (subscribers) {
            const index = subscribers.indexOf(callback);
            if (index !== -1) {
              subscribers.splice(index, 1);
            }
          }
        }
      },
      data: this.tags.filter((t) => t.profile_id === profile_id)
    };
  }

  listTags(callback?: UpdateCallback<Tag[]>): { unsubscribe: Unsubscribe; data: Tag[] } {
    if (callback) {
      this.tagListSubscribers.push(callback);
      callback(this.tags);
    }

    return {
      unsubscribe: () => {
        if (callback) {
          const index = this.tagListSubscribers.indexOf(callback);
          if (index !== -1) {
            this.tagListSubscribers.splice(index, 1);
          }
        }
      },
      data: this.tags
    };
  }

  handleTagEvent(event: LiveEvent) {
    if (event.type === "created" || event.type === "updated") {
      const tag = event.payload as Tag;
      const existingIndex = this.tags.findIndex((t) => t.id === tag.id);
      if (existingIndex !== -1) {
        this.tags[existingIndex] = tag;
      } else {
        this.tags.push(tag);
      }
      this.tagListSubscribers.forEach((callback) => callback(this.tags));
      this.profileTagSubscribers
        .get(tag.profile_id)
        ?.forEach((callback) => callback(this.tags.filter((t) => t.profile_id === tag.profile_id)));
    } else if (event.type === "deleted") {
      const tag = event.payload as Tag;
      this.tags = this.tags.filter((t) => t.id !== tag.id);
      this.tagListSubscribers.forEach((callback) => callback(this.tags));
      this.profileTagSubscribers
        .get(tag.profile_id)
        ?.forEach((callback) => callback(this.tags.filter((t) => t.profile_id === tag.profile_id)));
    }
  }
  getRoster(): UserRoleWithUser[] {
    return Array.from(this.userRoles.values()).filter((role) => role.role === "student");
  }
  getProfileBySisId(sis_id: string) {
    return Array.from(this.userProfiles.values()).find((profile) => profile.sis_user_id === sis_id);
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
   * Sets lab sections data
   */
  setLabSections(data: LabSection[]) {
    this.labSections = data;
    this.labSectionListSubscribers.forEach((cb) => cb(data));
  }

  /**
   * Sets lab section meetings data
   */
  setLabSectionMeetings(data: LabSectionMeeting[]) {
    this.labSectionMeetings = data;
    this.labSectionMeetingListSubscribers.forEach((cb) => cb(data));
  }

  /**
   * Gets lab sections with optional callback for updates
   */
  listLabSections(callback?: UpdateCallback<LabSection[]>): { unsubscribe: Unsubscribe; data: LabSection[] } {
    if (callback) {
      this.labSectionListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this.labSectionListSubscribers = this.labSectionListSubscribers.filter((cb) => cb !== callback);
      },
      data: this.labSections
    };
  }

  /**
   * Gets lab section meetings with optional callback for updates
   */
  listLabSectionMeetings(callback?: UpdateCallback<LabSectionMeeting[]>): {
    unsubscribe: Unsubscribe;
    data: LabSectionMeeting[];
  } {
    if (callback) {
      this.labSectionMeetingListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this.labSectionMeetingListSubscribers = this.labSectionMeetingListSubscribers.filter((cb) => cb !== callback);
      },
      data: this.labSectionMeetings
    };
  }

  /**
   * Gets the lab section ID for a given student profile ID
   */
  getStudentLabSectionId(studentPrivateProfileId: string): number | null {
    const userRole = this.userRolesByPrivateProfileId.get(studentPrivateProfileId);
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
      console.log("Student not in a lab section, falling back to original due date");
      return new Date(assignment.due_date);
    }
    const labSection = this.labSections.find((section) => section.id === labSectionId);
    if (!labSection) {
      throw new Error("Lab section not found");
    }

    // Find the most recent lab section meeting before the assignment's original due date
    const assignmentDueDate = new Date(assignment.due_date);
    const relevantMeetings = this.labSectionMeetings
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

  async loadInitialData() {
    await this.loadProfiles();
    await this.loadUserRoles();
    await this.loadDiscussionThreads();
    await this.loadTags();
    await this.loadLabSections();
    await this.loadLabSectionMeetings();
    this._isLoaded = true;
  }

  private async loadProfiles() {
    const supabase = createClient();
    let allProfiles: UserProfile[] = [];
    let from = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("class_id", this.courseId)
        .range(from, from + pageSize - 1);

      if (error) {
        console.error("Error fetching profiles:", error);
        break;
      }

      if (data && data.length > 0) {
        allProfiles = [...allProfiles, ...data];
        from += pageSize;
        hasMore = data.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    for (const profile of allProfiles) {
      this.userProfiles.set(profile.id, { ...profile });
    }
  }

  private async loadUserRoles() {
    const supabase = createClient();
    let allRoles: UserRoleWithUser[] = [];
    let from = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from("user_roles")
        .select("*, users(*)")
        .eq("class_id", this.courseId)
        .range(from, from + pageSize - 1);

      if (error) {
        console.error("Error fetching roles:", error);
        break;
      }

      if (data && data.length > 0) {
        allRoles = [...allRoles, ...data];
        from += pageSize;
        hasMore = data.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    // Update internal roles maps and link profiles
    for (const role of allRoles) {
      this.userRoles.set(role.user_id, role);
      this.userRolesByPrivateProfileId.set(role.private_profile_id, role);
      const privateProfile = this.userProfiles.get(role.private_profile_id);
      const publicProfile = this.userProfiles.get(role.public_profile_id);
      if (privateProfile && publicProfile) {
        publicProfile.private_profile = privateProfile;
      }
    }

    // Fire all profile callbacks after linking
    for (const id of this.userProfileSubscribers.keys()) {
      const callbacks = this.userProfileSubscribers.get(id);
      if (callbacks) {
        callbacks.forEach((cb) => cb(this.userProfiles.get(id)!));
      }
    }
  }

  private async loadDiscussionThreads() {
    const supabase = createClient();
    let allThreads: DiscussionThread[] = [];
    let from = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from("discussion_threads")
        .select("*")
        .eq("root_class_id", this.courseId)
        .range(from, from + pageSize - 1);

      if (error) {
        console.error("Error fetching discussion threads:", error);
        break;
      }

      if (data && data.length > 0) {
        allThreads = [...allThreads, ...data];
        from += pageSize;
        hasMore = data.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    this.discussionThreadTeasers = allThreads;
    this.discussionThreadTeaserListSubscribers.forEach((cb) => cb(this.discussionThreadTeasers));
  }

  async loadDiscussionThreadReadStatusForUser(userId: string) {
    const supabase = createClient();
    let allReadStatuses: DiscussionThreadReadStatus[] = [];
    let from = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from("discussion_thread_read_status")
        .select("*")
        .eq("user_id", userId)
        .range(from, from + pageSize - 1);

      if (error) {
        console.error("Error fetching discussion thread read status:", error);
        break;
      }

      if (data && data.length > 0) {
        allReadStatuses = [...allReadStatuses, ...data];
        from += pageSize;
        hasMore = data.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    this.setDiscussionThreadReadStatuses(allReadStatuses);
  }

  private async loadTags() {
    const supabase = createClient();
    let allTags: Tag[] = [];
    let from = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from("tags")
        .select("*")
        .eq("class_id", this.courseId)
        .range(from, from + pageSize - 1);

      if (error) {
        console.error("Error fetching tags:", error);
        break;
      }

      if (data && data.length > 0) {
        allTags = [...allTags, ...data];
        from += pageSize;
        hasMore = data.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    this.tags = allTags;
    this.tagListSubscribers.forEach((callback) => callback(allTags));
  }

  private async loadLabSections() {
    const supabase = createClient();
    let allLabSections: LabSection[] = [];
    let from = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from("lab_sections")
        .select("*")
        .eq("class_id", this.courseId)
        .range(from, from + pageSize - 1);

      if (error) {
        console.error("Error fetching lab sections:", error);
        break;
      }

      if (data && data.length > 0) {
        allLabSections = [...allLabSections, ...data];
        from += pageSize;
        hasMore = data.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    this.labSections = allLabSections;
    this.labSectionListSubscribers.forEach((cb) => cb(allLabSections));
  }

  private async loadLabSectionMeetings() {
    const supabase = createClient();
    let allLabSectionMeetings: LabSectionMeeting[] = [];
    let from = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from("lab_section_meetings")
        .select("*")
        .eq("class_id", this.courseId)
        .range(from, from + pageSize - 1);

      if (error) {
        console.error("Error fetching lab section meetings:", error);
        break;
      }

      if (data && data.length > 0) {
        allLabSectionMeetings = [...allLabSectionMeetings, ...data];
        from += pageSize;
        hasMore = data.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    this.labSectionMeetings = allLabSectionMeetings;
    this.labSectionMeetingListSubscribers.forEach((cb) => cb(allLabSectionMeetings));
  }

  handleProfileEvent(event: LiveEvent) {
    if (event.type === "created" || event.type === "updated") {
      const profile = event.payload as UserProfile;
      this.userProfiles.set(profile.id, { ...profile });

      // Update linked private profile if it exists
      const role = this.userRolesByPrivateProfileId.get(profile.id);
      if (role) {
        const publicProfile = this.userProfiles.get(role.public_profile_id);
        if (publicProfile) {
          publicProfile.private_profile = profile;
        }
      }

      const subscribers = this.userProfileSubscribers.get(profile.id);
      if (subscribers) {
        subscribers.forEach((cb) => cb(this.userProfiles.get(profile.id)!));
      }
    } else if (event.type === "deleted") {
      const profile = event.payload as UserProfile;
      this.userProfiles.delete(profile.id);

      const subscribers = this.userProfileSubscribers.get(profile.id);
      if (subscribers) {
        subscribers.forEach((cb) => cb(undefined as unknown as UserProfileWithPrivateProfile));
      }
    }
  }

  handleUserRoleEvent(event: LiveEvent) {
    if (event.type === "created" || event.type === "updated") {
      const role = event.payload as UserRoleWithUser;
      this.userRoles.set(role.user_id, role);
      this.userRolesByPrivateProfileId.set(role.private_profile_id, role);

      // Link profiles
      const privateProfile = this.userProfiles.get(role.private_profile_id);
      const publicProfile = this.userProfiles.get(role.public_profile_id);
      if (privateProfile && publicProfile) {
        publicProfile.private_profile = privateProfile;

        const subscribers = this.userProfileSubscribers.get(role.public_profile_id);
        if (subscribers) {
          subscribers.forEach((cb) => cb(publicProfile));
        }
      }
    } else if (event.type === "deleted") {
      const role = event.payload as UserRoleWithUser;
      this.userRoles.delete(role.user_id);
      this.userRolesByPrivateProfileId.delete(role.private_profile_id);
    }
  }

  handleLabSectionEvent(event: LiveEvent) {
    if (event.type === "created") {
      const labSection = event.payload as LabSection;
      this.labSections.push(labSection);
      this.labSectionListSubscribers.forEach((cb) => cb(this.labSections));
    } else if (event.type === "updated") {
      const labSection = event.payload as LabSection;
      const index = this.labSections.findIndex((ls) => ls.id === labSection.id);
      if (index !== -1) {
        this.labSections[index] = labSection;
        this.labSectionListSubscribers.forEach((cb) => cb(this.labSections));
      }
    } else if (event.type === "deleted") {
      const labSection = event.payload as LabSection;
      this.labSections = this.labSections.filter((ls) => ls.id !== labSection.id);
      this.labSectionListSubscribers.forEach((cb) => cb(this.labSections));
    }
  }

  handleLabSectionMeetingEvent(event: LiveEvent) {
    if (event.type === "created") {
      const meeting = event.payload as LabSectionMeeting;
      this.labSectionMeetings.push(meeting);
      this.labSectionMeetingListSubscribers.forEach((cb) => cb(this.labSectionMeetings));
    } else if (event.type === "updated") {
      const meeting = event.payload as LabSectionMeeting;
      const index = this.labSectionMeetings.findIndex((m) => m.id === meeting.id);
      if (index !== -1) {
        this.labSectionMeetings[index] = meeting;
        this.labSectionMeetingListSubscribers.forEach((cb) => cb(this.labSectionMeetings));
      }
    } else if (event.type === "deleted") {
      const meeting = event.payload as LabSectionMeeting;
      this.labSectionMeetings = this.labSectionMeetings.filter((m) => m.id !== meeting.id);
      this.labSectionMeetingListSubscribers.forEach((cb) => cb(this.labSectionMeetings));
    }
  }
}

function CourseControllerProviderImpl({ controller, course_id }: { controller: CourseController; course_id: number }) {
  const { user } = useAuthState();
  const course = useCourse();
  useEffect(() => {
    controller.course = course;
  }, [course, controller]);
  useEffect(() => {
    const loadData = async () => {
      await controller.loadInitialData();
      if (user?.id) {
        await controller.loadDiscussionThreadReadStatusForUser(user.id);
      }
    };
    loadData();
  }, [controller, user?.id]);

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
  const controller = useRef<CourseController>(new CourseController(course_id));
  const [isInitialized, setIsInitialized] = useState(false);
  useEffect(() => {
    controller.current.initializeRealTimeController(profile_id, role === "instructor" || role === "grader");
    setIsInitialized(true);
  }, [controller, profile_id, role]);
  if (!isInitialized) {
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

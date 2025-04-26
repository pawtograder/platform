'use client'
import { LiveEvent, useCreate, useList, useUpdate } from "@refinedev/core";
import { DiscussionThreadReadWithAllDescendants, useDiscussionThreadsController } from "./useDiscussionThreadRootController";
import { Assignment, AssignmentDueDateException, DiscussionThread, DiscussionThreadReadStatus, DiscussionThreadWatcher, Notification, UserProfile, UserRole } from "@/utils/supabase/DatabaseTypes";
import useAuthState from "./useAuthState";
import { useCallback, createContext, useContext, useEffect, useRef, useState } from "react";
import { assign } from "nodemailer/lib/shared";
import { useClassProfiles } from "./useClassProfiles";
import { Skeleton } from "@/components/ui/skeleton";
import { addHours } from "date-fns";
import { TZDate } from "@date-fns/tz";

export function useUpdateThreadTeaser() {
    const controller = useCourseController();
    const { mutateAsync: updateThread } = useUpdate<DiscussionThread>({
        resource: "discussion_threads",
        mutationMode: 'optimistic',
    });
    return useCallback(async ({ id, old, values }: { id: number, old: DiscussionThreadTeaser, values: Partial<DiscussionThreadTeaser> }) => {

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
    }, [updateThread, controller]);
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
        resource: "discussion_thread_read_status",
    });
    const { mutateAsync: updateThreadReadStatus } = useUpdate<DiscussionThreadReadStatus>({
        resource: "discussion_thread_read_status",
        mutationMode: "optimistic",
    });

    const setUnread = useCallback((root_threadId: number, threadId: number, isUnread: boolean) => {
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
        }
        else {
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
    }, [user?.id, createdThreadReadStatuses, controller]);
    return { readStatus, setUnread };
}
type DiscussionThreadTeaser = Pick<DiscussionThread, "id" | "subject" | "created_at" | "author" | "children_count" | "instructors_only" | "is_question" | "likes_count" | "topic_id" | "draft" | "class_id" | "body" | "ordinal" | "answer">;
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
                    const hasAnyChanges = watchFields.some(field => oldTeaser[field] !== data[field]);
                    if (hasAnyChanges) {
                        return data;
                    }
                    return oldTeaser;
                });
            }
            else {
                setTeaser(data);
            }
        });
        setTeaser(data);
        return unsubscribe;
    }, [controller, id]);
    return teaser;
}
export type UpdateCallback<T> = (data: T) => void;
export type Unsubscribe = () => void;
export type UserProfileWithPrivateProfile = UserProfile & {
    private_profile?: UserProfile;
}

class CourseController {
    private _isLoaded = false;
    constructor(public courseId: number) {
    }
    private discussionThreadReadStatusesSubscribers: Map<number, UpdateCallback<DiscussionThreadReadWithAllDescendants>[]> = new Map();
    private discussionThreadReadStatuses: Map<number, DiscussionThreadReadWithAllDescendants> = new Map();
    private userProfiles: Map<string, UserProfileWithPrivateProfile> = new Map();
    private userRoles: Map<string, UserRole> = new Map();
    private userProfileSubscribers: Map<string, UpdateCallback<UserProfileWithPrivateProfile>[]> = new Map();

    private discussionThreadTeasers: DiscussionThreadTeaser[] = [];
    private discussionThreadTeaserListSubscribers: UpdateCallback<DiscussionThreadTeaser[]>[] = [];
    private discussionThreadTeaserSubscribers: Map<number, UpdateCallback<DiscussionThreadTeaser>[]> = new Map();


    private genericDataSubscribers: { [key in string]: Map<number, UpdateCallback<any>[]> } = {};
    private genericData: { [key in string]: Map<number, any> } = {};
    private genericDataListSubscribers: { [key in string]: UpdateCallback<any>[] } = {};

    private genericDataTypeToId: { [key in string]: (item: any) => number } = {};

    registerGenericDataType(typeName: string, idGetter: (item: any) => number) {
        if (!this.genericDataTypeToId[typeName]) {
            this.genericDataTypeToId[typeName] = idGetter;
            this.genericDataSubscribers[typeName] = new Map();
            this.genericDataListSubscribers[typeName] = [];
        }
    }

    setGeneric(typeName: string, data: any[]) {
        if (!this.genericData[typeName]) {
            this.genericData[typeName] = new Map();
        }
        const idGetter = this.genericDataTypeToId[typeName];
        for (const item of data) {
            const id = idGetter(item);
            this.genericData[typeName].set(id, item);
            const itemSubscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
            itemSubscribers.forEach(cb => cb(item));
        }
        const listSubscribers = this.genericDataListSubscribers[typeName] || [];
        listSubscribers.forEach(cb => cb(Array.from(this.genericData[typeName].values())));
    }
    listGenericData<T>(typeName: string, callback?: UpdateCallback<T[]>): { unsubscribe: Unsubscribe, data: T[] } {
        const subscribers = this.genericDataListSubscribers[typeName] || [];
        if (callback) {
            subscribers.push(callback);
            this.genericDataListSubscribers[typeName] = subscribers;
        }
        const currentData = this.genericData[typeName]?.values() || [];
        return {
            unsubscribe: () => {
                this.genericDataListSubscribers[typeName] = this.genericDataListSubscribers[typeName]?.filter(cb => cb !== callback) || [];
            }, data: Array.from(currentData) as T[]
        };
    }
    getValueWithSubscription<T>(typeName: string, id: number | ((item: T) => boolean), callback?: UpdateCallback<T>): { unsubscribe: Unsubscribe, data: T | undefined } {
        if (!this.genericDataTypeToId[typeName]) {
            throw new Error(`No id getter for type ${typeName}`);
        }
        if (typeof id === "function") {
            const relevantIds = Array.from(this.genericData[typeName]?.keys() || []).filter(_id => id(this.genericData[typeName]?.get(_id)!));
            if (relevantIds.length == 0) {
                return {
                    unsubscribe: () => { },
                    data: undefined
                };
            } else if (relevantIds.length == 1) {
                const id = relevantIds[0];
                const subscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
                if (callback) {
                    this.genericDataSubscribers[typeName]?.set(id, [...subscribers, callback]);
                }
                return {
                    unsubscribe: () => {
                        this.genericDataSubscribers[typeName]?.set(id, subscribers.filter(cb => cb !== callback));
                    }, data: this.genericData[typeName]?.get(id) as T | undefined
                };
            } else {
                throw new Error(`Multiple ids found for type ${typeName}`);
            }
        } else if (typeof id === "number") {
            const subscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
            if (callback) {
                this.genericDataSubscribers[typeName]?.set(id, [...subscribers, callback]);
            }
            return {
                unsubscribe: () => {
                    this.genericDataSubscribers[typeName]?.set(id, subscribers.filter(cb => cb !== callback));
                }, data: this.genericData[typeName]?.get(id) as T | undefined
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
            this.genericDataSubscribers[typeName]?.get(id)?.forEach(cb => cb(body));
            this.genericDataListSubscribers[typeName]?.forEach(cb => cb(Array.from(this.genericData[typeName].values())));
        }
        else if (event.type === "updated") {
            this.genericData[typeName].set(id, body);
            this.genericDataSubscribers[typeName]?.get(id)?.forEach(cb => cb(body));
            this.genericDataListSubscribers[typeName]?.forEach(cb => cb(Array.from(this.genericData[typeName].values())));
        }
        else if (event.type === "deleted") {
            this.genericData[typeName].delete(id);
            this.genericDataSubscribers[typeName]?.get(id)?.forEach(cb => cb(undefined));
            this.genericDataListSubscribers[typeName]?.forEach(cb => cb(Array.from(this.genericData[typeName].values())));
        }
    }

    handleDiscussionThreadTeaserEvent(event: LiveEvent) {
        if (event.type === "created") {
            const body = event.payload as DiscussionThreadTeaser;
            this.discussionThreadTeasers.push(body);
            this.discussionThreadTeaserListSubscribers.forEach(cb => cb(this.discussionThreadTeasers));
        }
        else if (event.type === "updated") {
            const body = event.payload as DiscussionThreadTeaser;
            const existing = this.discussionThreadTeasers.find(teaser => teaser.id === body.id);
            //Only propagate an update if there is a change that we care about
            if (existing &&
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
                existing.draft === body.draft) {
                return;
            }
            this.discussionThreadTeasers = this.discussionThreadTeasers
                .map(teaser => teaser.id === body.id ? body : teaser);
            const subscribers = this.discussionThreadTeaserSubscribers.get(body.id) || [];
            subscribers.forEach(cb => cb(body));
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
    getDiscussionThreadTeaser(id: number, callback?: UpdateCallback<DiscussionThreadTeaser>): { unsubscribe: Unsubscribe, data: DiscussionThreadTeaser | undefined } {
        const subscribers = this.discussionThreadTeaserSubscribers.get(id) || [];
        if (callback) {
            this.discussionThreadTeaserSubscribers.set(id, [...subscribers, callback]);
        }
        return {
            unsubscribe: () => {
                this.discussionThreadTeaserSubscribers.set(id, subscribers.filter(cb => cb !== callback));
            },
            data: this.discussionThreadTeasers.find(teaser => teaser.id === id)
        };
    }
    listDiscussionThreadTeasers(callback?: UpdateCallback<DiscussionThreadTeaser[]>): { unsubscribe: Unsubscribe, data: DiscussionThreadTeaser[] } {
        if (callback) {
            this.discussionThreadTeaserListSubscribers.push(callback);
        }
        return {
            unsubscribe: () => {
                this.discussionThreadTeaserListSubscribers = this.discussionThreadTeaserListSubscribers.filter(cb => cb !== callback);
            }, data: this.discussionThreadTeasers
        };
    }

    handleReadStatusEvent(event: LiveEvent) {
        const processUpdatedStatus = (updatedStatus: DiscussionThreadReadStatus) => {
            //Is this a root?
            const isRoot = updatedStatus.discussion_thread_root_id === updatedStatus.discussion_thread_id;
            const existingStatuses = Array.from(this.discussionThreadReadStatuses.values());
            if (isRoot) {
                //Calculate the number of read descendants
                let numReadDescendants = 0;
                if (existingStatuses) {
                    const readDescendants = existingStatuses.filter(status =>
                        status.discussion_thread_id != status.discussion_thread_root_id &&
                        status.discussion_thread_root_id === updatedStatus.discussion_thread_id && status.read_at);
                    for (const status of readDescendants) {
                        numReadDescendants += status.read_at ? 1 : 0;
                    }
                }
                const newVal = {
                    ...updatedStatus,
                    numReadDescendants: numReadDescendants
                };
                this.discussionThreadReadStatuses.set(updatedStatus.discussion_thread_id, newVal);
                this.notifyDiscussionThreadReadStatusSubscribers(updatedStatus.discussion_thread_id, newVal);
            } else {
                //Need to update this one, and also its root
                //First update this one
                const newVal = {
                    ...updatedStatus,
                    numReadDescendants: 0
                };
                this.discussionThreadReadStatuses.set(updatedStatus.discussion_thread_id, newVal);
                this.notifyDiscussionThreadReadStatusSubscribers(updatedStatus.discussion_thread_id, newVal);
                //Then root
                const root = this.discussionThreadReadStatuses.get(updatedStatus.discussion_thread_root_id);
                if (root) {
                    const readDescendants = existingStatuses.filter(status =>
                        status.discussion_thread_id != status.discussion_thread_root_id &&
                        status.discussion_thread_root_id === updatedStatus.discussion_thread_root_id && status.read_at);
                    let numReadDescendants = 0;
                    for (const status of readDescendants) {
                        numReadDescendants += status.read_at ? 1 : 0;
                    }
                    const newVal = {
                        ...root,
                        numReadDescendants: numReadDescendants
                    };
                    this.discussionThreadReadStatuses.set(updatedStatus.discussion_thread_root_id, newVal);
                    this.notifyDiscussionThreadReadStatusSubscribers(updatedStatus.discussion_thread_root_id, newVal);
                }
            }
        }
        if (event.type === "created") {
            const body = event.payload as DiscussionThreadReadStatus;
            processUpdatedStatus(body);
        }
        else if (event.type === "updated") {
            const body = event.payload as DiscussionThreadReadStatus;
            processUpdatedStatus(body);
        }
    }
    get isLoaded() {
        return this._isLoaded;
    }
    getDiscussionThreadReadStatus(threadId: number, callback?: UpdateCallback<DiscussionThreadReadWithAllDescendants>): { unsubscribe: Unsubscribe, data: DiscussionThreadReadWithAllDescendants | undefined | null } {
        const subscribers = this.discussionThreadReadStatusesSubscribers.get(threadId) || [];
        if (callback) {
            this.discussionThreadReadStatusesSubscribers.set(threadId, [...subscribers, callback]);
        }
        return {
            unsubscribe: () => {
                this.discussionThreadReadStatusesSubscribers.set(threadId, subscribers.filter(cb => cb !== callback));
            },
            data: this.isLoaded ? (this.discussionThreadReadStatuses.get(threadId) || null) : undefined
        }
    }
    setDiscussionThreadReadStatuses(data: DiscussionThreadReadStatus[]) {
        if (!this._isLoaded) {
            this._isLoaded = true;
            for (const thread of data) {
                this.discussionThreadReadStatuses.set(thread.discussion_thread_id, {
                    ...thread,
                    numReadDescendants: data.filter(t => t.discussion_thread_id != t.discussion_thread_root_id &&
                        t.discussion_thread_root_id === thread.discussion_thread_id && t.read_at).length
                });
                this.notifyDiscussionThreadReadStatusSubscribers(thread.discussion_thread_id, this.discussionThreadReadStatuses.get(thread.discussion_thread_id)!);
            }
        }
    }
    setUserProfiles(profiles: UserProfile[], roles: UserRole[]) {
        for (const profile of profiles) {
            this.userProfiles.set(profile.id, { ...profile });
        }
        for (const role of roles) {
            this.userRoles.set(role.user_id, role);
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
                callbacks.forEach(cb => cb(this.userProfiles.get(id)!));
            }
        }
    }
    getUserProfile(id: string, callback?: UpdateCallback<UserProfileWithPrivateProfile>) {
        const profile = this.userProfiles.get(id);
        if (callback) {
            this.userProfileSubscribers.set(id, [...(this.userProfileSubscribers.get(id) || []), callback]);
        }
        return {
            unsubscribe: () => {
                this.userProfileSubscribers.set(id, this.userProfileSubscribers.get(id)!.filter(cb => cb !== callback));
            },
            data: profile
        };
    }
    private notifyDiscussionThreadReadStatusSubscribers(threadId: number, data: DiscussionThreadReadWithAllDescendants) {
        const subscribers = this.discussionThreadReadStatusesSubscribers.get(threadId);
        if (subscribers && subscribers.length > 0) {
            subscribers.forEach(cb => cb(data));
        }
    }
}

function CourseControllerProviderImpl({ controller, course_id }: { controller: CourseController, course_id: number }) {
    const { user } = useAuthState();
    const threadReadStatuses = useList<DiscussionThreadReadStatus>({
        resource: "discussion_thread_read_status",
        queryOptions: {
            staleTime: Infinity,
            cacheTime: Infinity,
        },
        filters: [
            { field: "user_id", operator: "eq", value: user?.id }
        ],
        pagination: {
            pageSize: 1000,
        },
        liveMode: "auto",
        onLiveEvent: (event) => {
            controller.handleReadStatusEvent(event);
        }
    });
    useEffect(() => {
        if (threadReadStatuses.data) {
            controller.setDiscussionThreadReadStatuses(threadReadStatuses.data.data);
        }
    }, [controller, threadReadStatuses.data]);
    const { data: userProfiles } = useList<UserProfile>({
        resource: "profiles",
        queryOptions: {
            staleTime: Infinity,
        },
        pagination: {
            pageSize: 1000,
        },
        filters: [
            { field: "class_id", operator: "eq", value: course_id }
        ]
    });
    const { data: roles } = useList<UserRole>({
        resource: "user_roles",
        queryOptions: {
            staleTime: Infinity,
        },
        pagination: {
            pageSize: 1000,
        },
        filters: [
            { field: "class_id", operator: "eq", value: course_id }
        ]
    });
    useEffect(() => {
        if (userProfiles?.data && roles?.data) {
            controller.setUserProfiles(userProfiles.data, roles.data);
        }
    }, [controller, userProfiles?.data, roles?.data]);

    const query = useList<DiscussionThread>({
        resource: "discussion_threads",
        queryOptions: {
            staleTime: Infinity,
            cacheTime: Infinity,
        },
        filters: [
            { field: "root_class_id", operator: "eq", value: course_id },
        ],
        pagination: {
            pageSize: 1000,
        },
        liveMode: "manual",
        onLiveEvent: (event) => {
            controller.handleDiscussionThreadTeaserEvent(event);
        }
    });
    const { data: rootDiscusisonThreads } = query;
    useEffect(() => {
        if (rootDiscusisonThreads?.data) {
            controller.setDiscussionThreadTeasers(rootDiscusisonThreads.data);
        }
    }, [controller, rootDiscusisonThreads?.data]);

    const { data: notifications } = useList<Notification>({
        resource: "notifications",
        filters: [
            { field: "user_id", operator: "eq", value: user?.id }
        ],
        liveMode: "manual",
        queryOptions: {
            staleTime: Infinity,
            cacheTime: Infinity,
        },
        pagination: {
            pageSize: 1000,
        },
        onLiveEvent: (event) => {
            controller.handleGenericDataEvent('notifications', event);
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
        },
        filters: [
            {
                field: "user_id",
                operator: "eq",
                value: user?.id
            }
        ],
        pagination: {
            pageSize: 1000,
        },
        liveMode: "manual",
        onLiveEvent: (event) => {
            controller.handleGenericDataEvent('discussion_thread_watchers', event);
        }
    });
    useEffect(() => {
        controller.registerGenericDataType("discussion_thread_watchers", (item: DiscussionThreadWatcher) => item.discussion_thread_root_id);
        if (threadWatches?.data) {
            controller.setGeneric("discussion_thread_watchers", threadWatches.data);
        }
    }, [controller, threadWatches?.data]);
    const { data: dueDateExceptions } = useList<AssignmentDueDateException>({
        resource: "assignment_due_date_exceptions",
        queryOptions: {
            staleTime: Infinity,
            cacheTime: Infinity,
        },
        filters: [
            { field: "class_id", operator: "eq", value: course_id }
        ],
        pagination: {
            pageSize: 1000,
        },
    });
    useEffect(() => {
        controller.registerGenericDataType("assignment_due_date_exceptions", (item: AssignmentDueDateException) => item.id);
        if (dueDateExceptions?.data) {
            controller.setGeneric("assignment_due_date_exceptions", dueDateExceptions.data);
        }
    }, [controller, dueDateExceptions?.data]);
    return <></>
}
const CourseControllerContext = createContext<CourseController | null>(null);
export function CourseControllerProvider({ course_id, children }: { course_id: number, children: React.ReactNode }) {
    const controller = useRef<CourseController>(new CourseController(course_id));
    return <CourseControllerContext.Provider value={controller.current}>
        <CourseControllerProviderImpl controller={controller.current} course_id={course_id} />
        {children}
    </CourseControllerContext.Provider>
}

export function useAssignmentDueDate(assignment: Assignment) {
    const controller = useCourseController();
    const course = useCourse();
    const time_zone = course.time_zone || "America/New_York";
    const [dueDateExceptions, setDueDateExceptions] = useState<AssignmentDueDateException[]>();
    useEffect(() => {
        if (assignment.due_date) {
            const { data: dueDateExceptions, unsubscribe } = controller.listGenericData<AssignmentDueDateException>("assignment_due_date_exceptions",
                data => setDueDateExceptions(data.filter(e => e.assignment_id === assignment.id))
            );
            setDueDateExceptions(dueDateExceptions.filter(e => e.assignment_id === assignment.id));
            return () => unsubscribe();
        }
    }, [assignment, controller]);
    if (!dueDateExceptions) {
        return {
            originalDueDate: undefined,
            dueDate: undefined,
            hoursExtended: undefined
        };
    }
    const hoursExtended = dueDateExceptions.reduce((acc, curr) => acc + curr.hours, 0);
    const originalDueDate = new TZDate(assignment.due_date, time_zone);
    const dueDate = addHours(originalDueDate, hoursExtended);
    const lateTokensConsumed = dueDateExceptions.reduce((acc, curr) => acc + curr.tokens_consumed, 0);
    return {
        originalDueDate,
        dueDate,
        hoursExtended,
        lateTokensConsumed
    };
}

export function useLateTokens() {
    const controller = useCourseController();
    const [lateTokens, setLateTokens] = useState<AssignmentDueDateException[]>();
    useEffect(() => {
        const { data: lateTokens, unsubscribe } = controller.listGenericData<AssignmentDueDateException>("assignment_due_date_exceptions",
            data => setLateTokens(data)
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
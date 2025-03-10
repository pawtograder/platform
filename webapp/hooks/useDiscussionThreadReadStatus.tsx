'use client'
import { DiscussionThreadReadStatus } from "@/utils/supabase/DatabaseTypes";
import { useList, useCreate, useUpdate } from "@refinedev/core";
import { createContext, useContext, useEffect, useState, useCallback } from "react";
import useAuthState from "./useAuthState";
import { useParams } from "next/navigation";

type DiscussionThreadReadStatusContext = {
    getUnreadStatus: (threadId: number, callback: (readStatus: boolean) => void) => boolean;
    getUnreadStatusForRoot: (rootThreadID: number, callback: (params: { rootIsUnread: boolean, repliesRead: number }) => void) => { rootIsUnread: boolean, repliesRead: number };
    setUnread: (root_threadId: number, threadId: number, readStatus: boolean) => void;
    unsubscribeFromRootUnreadStatus: (rootThreadID: number, callback: (params: { rootIsUnread: boolean, repliesRead: number }) => void) => void;
    unsubscribeFromUnreadStatus: (threadId: number, callback: (readStatus: boolean) => void) => void;
}

const DiscussionThreadReadStatusContext = createContext<DiscussionThreadReadStatusContext | undefined>(undefined);

type SubscribedComponent = {
    callback: (readStatus: boolean) => void;
}
type RootSubscribedComponent = {
    callback: (params: { rootIsUnread: boolean, repliesRead: number }) => void;
}
export function useDiscussionThreadReadStatusForRoot(rootThreadID: number) {
    const { getUnreadStatusForRoot, setUnread, unsubscribeFromRootUnreadStatus } = useDiscussionThreadReadStatusContext();
    const [threadRead, setThreadRead] = useState<{ rootIsUnread: boolean, repliesRead: number } | undefined>(undefined);
    useEffect(() => {
        const cb = (params: { rootIsUnread: boolean, repliesRead: number }) => {
            setThreadRead(params);
        }
        setThreadRead(getUnreadStatusForRoot(rootThreadID, cb));
        return () => unsubscribeFromRootUnreadStatus(rootThreadID, cb);
    }, [rootThreadID, getUnreadStatusForRoot, setUnread, unsubscribeFromRootUnreadStatus]);
    return {
        threadRead,
        setUnread
    }
}

export function useDiscussionThreadReadStatus(threadId: number) {
    const { getUnreadStatus, setUnread, unsubscribeFromUnreadStatus } = useDiscussionThreadReadStatusContext();
    const [threadIsUnread, setThreadIsUnread] = useState<boolean | undefined>(undefined);
    useEffect(() => {
        const cb = (isUnread: boolean) => {
            setThreadIsUnread(isUnread);
        }
        setThreadIsUnread(getUnreadStatus(threadId, cb));
        return () => unsubscribeFromUnreadStatus(threadId, cb);
    }, [threadId, getUnreadStatus, setUnread, unsubscribeFromUnreadStatus]);
    return {
        threadIsUnread,
        setUnread
    }
}

function useDiscussionThreadReadStatusContext() {
    const context = useContext(DiscussionThreadReadStatusContext);
    if (!context) {
        throw new Error("useDiscussionThreadReadStatusContext must be used within a DiscussionThreadReadStatusProvider");
    }
    return context;
}

export function DiscussionThreadReadStatusProvider({ children }: { children: React.ReactNode }) {
    const { user } = useAuthState();
    const [subscribedComponents] = useState<Map<string, SubscribedComponent[]>>(new Map<string, SubscribedComponent[]>());
    const [rootThreadSubscribedComponents] = useState<Map<string, RootSubscribedComponent[]>>(new Map<string, RootSubscribedComponent[]>());
    const [createdThreadReadStatuses] = useState<Set<number>>(new Set<number>());
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
            const payload = event.payload as DiscussionThreadReadStatus;
            if (event.type === "created") {
                const threadID = payload.discussion_thread_id;
                const subscriptions = subscribedComponents.get(threadID.toString()) || [];
                subscriptions.forEach(c => c.callback(event.payload.enabled));
                const rootThreadID = payload.discussion_thread_root_id;
                const rootSubscriptions = rootThreadSubscribedComponents.get(rootThreadID.toString()) || [];
                rootSubscriptions.forEach(c => c.callback(event.payload.enabled));
            }
            else if (event.type === "updated") {
                const threadID = payload.discussion_thread_id;
                const subscriptions = subscribedComponents.get(threadID.toString()) || [];
                subscriptions.forEach(c => c.callback(event.payload.enabled));
                const rootThreadID = payload.discussion_thread_root_id;
                const rootSubscriptions = rootThreadSubscribedComponents.get(rootThreadID.toString()) || [];
                rootSubscriptions.forEach(c => c.callback(event.payload.enabled));
            }
        }
    });
    const { mutateAsync: createThreadReadStatus } = useCreate<DiscussionThreadReadStatus>({
        resource: "discussion_thread_read_status",
    });
    const { mutateAsync: updateThreadReadStatus } = useUpdate<DiscussionThreadReadStatus>({
        resource: "discussion_thread_read_status",
        mutationMode: "optimistic",
    });
    const getUnreadStatusForRoot = useCallback((rootThreadID: number, callback: (params: { rootIsUnread: boolean, repliesRead: number }) => void) => {
        const components = rootThreadSubscribedComponents.get(rootThreadID.toString()) || [];
        rootThreadSubscribedComponents.set(rootThreadID.toString(), [...components, { callback }]);
        if(threadReadStatuses.isLoading) {
            return {
                rootIsUnread: false,
                repliesRead: 0
            }
        }
        return {
            rootIsUnread: threadReadStatuses?.data?.data.find(r => r.discussion_thread_id === rootThreadID)?.read_at ? false : true,
            repliesRead: threadReadStatuses?.data?.data.filter(r => r.discussion_thread_root_id === rootThreadID && r.discussion_thread_id !== rootThreadID && r.read_at).length ?? 0
        }
    }, [threadReadStatuses?.data?.data]);
    const getUnreadStatus = useCallback((threadId: number, callback: (isUnread: boolean) => void) => {
        const components = subscribedComponents.get(threadId.toString()) || [];
        subscribedComponents.set(threadId.toString(), [...components, { callback }]);
        if(threadReadStatuses.isLoading) {
            return false;
        }
        return threadReadStatuses?.data?.data.find(r => r.discussion_thread_id === threadId)?.read_at ? false : true;
    }, [threadReadStatuses?.data?.data]);
    const setUnread = useCallback((root_threadId: number, threadId: number, isUnread: boolean) => {
        const threadReadStatus = threadReadStatuses?.data?.data.find(r => r.discussion_thread_id === threadId);
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
            if (createdThreadReadStatuses.has(threadId)) {
                return;
            }
            createdThreadReadStatuses.add(threadId);
            createThreadReadStatus({
                values: {
                    discussion_thread_id: threadId,
                    user_id: user?.id,
                    discussion_thread_root_id: root_threadId,
                    read_at: isUnread ? null : new Date()
                }
            }).catch((error) => {
            });
        }
    }, [threadReadStatuses?.data?.data, createdThreadReadStatuses]);
    const unsubscribeFromUnreadStatus = useCallback((threadId: number, callback: (isUnread: boolean) => void) => {
        const components = subscribedComponents.get(threadId.toString()) || [];
        subscribedComponents.set(threadId.toString(), components.filter(c => c.callback !== callback));
    }, [subscribedComponents]);
    const unsubscribeFromRootUnreadStatus = useCallback((rootThreadID: number, callback: (params: { rootIsUnread: boolean, repliesRead: number }) => void) => {
        const components = rootThreadSubscribedComponents.get(rootThreadID.toString()) || [];
        rootThreadSubscribedComponents.set(rootThreadID.toString(), components.filter(c => c.callback !== callback));
    }, [rootThreadSubscribedComponents]);
    return <DiscussionThreadReadStatusContext.Provider value={{
        getUnreadStatusForRoot,
        getUnreadStatus,
        setUnread,
        unsubscribeFromUnreadStatus,
        unsubscribeFromRootUnreadStatus
    }}>{children}</DiscussionThreadReadStatusContext.Provider>
}
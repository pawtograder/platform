'use client';
import { createContext, useEffect } from "react";
import { useContext, useState } from "react";
import { useList, useCreate, useDelete, useUpdate } from "@refinedev/core";
import { DiscussionThreadWatcher } from "@/utils/supabase/DatabaseTypes";
import useAuthState from "./useAuthState";
import { useParams } from "next/navigation";
type DiscussionThreadWatchContext = {
    unsubscribeFromThreadWatch(threadId: number, callback: (isWatched: boolean) => void): void;
    threadWatchStatus(threadId: number, callback: (isWatched: boolean) => void): boolean;
    setThreadWatchStatus(threadId: number, status: boolean): void;
}

const DiscussionThreadWatchContext = createContext<DiscussionThreadWatchContext | undefined>(undefined);

function useDiscussionThreadWatchContext() {
    const context = useContext(DiscussionThreadWatchContext);
    if (!context) {
        throw new Error("useDiscussionThreadWatchContext must be used within a DiscussionThreadWatchProvider");
    }
    return context;
}

export function useDiscussionThreadWatchStatus(threadId: number) {
    const { threadWatchStatus, setThreadWatchStatus, unsubscribeFromThreadWatch } = useDiscussionThreadWatchContext();
    const [status, setStatus] = useState<boolean | undefined>(undefined);
    useEffect(() => {
        const cb = (isWatched: boolean) => {
            setStatus(isWatched);
        }
        setStatus(threadWatchStatus(threadId, cb));
        return () => {
            unsubscribeFromThreadWatch(threadId, cb);
        }
    }, [threadId, threadWatchStatus, setThreadWatchStatus, unsubscribeFromThreadWatch]);
    return {
        status,
        setThreadWatchStatus
    }
}
type SubscribedComponent = {
    callback: (isWatched: boolean) => void;
}
export function DiscussionThreadWatchProvider({ children }: { children: React.ReactNode }) {
    const { user } = useAuthState();
    const { course_id } = useParams();
    const subscribedComponents = new Map<string, SubscribedComponent[]>();
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
        liveMode: "auto",
        onLiveEvent: (event) => {
            if (event.type === "created") {
                const threadID = event.payload.discussion_thread_root_id;
                const subscriptions = subscribedComponents.get(threadID.toString()) || [];
                subscriptions.forEach(c => c.callback(event.payload.enabled));
            }
            else if (event.type === "updated") {
                const threadID = event.payload.discussion_thread_root_id;
                const subscriptions = subscribedComponents.get(threadID.toString()) || [];
                subscriptions.forEach(c => c.callback(event.payload.enabled));
            }
        }
    });
    const { mutateAsync: createThreadWatcher } = useCreate({
        resource: "discussion_thread_watchers",
    });
    const { mutateAsync: updateWatch } = useUpdate({
        resource: "discussion_thread_watchers",
        values: {
            enabled: false
        }
    });
    return <DiscussionThreadWatchContext.Provider value={{
        threadWatchStatus: (threadId: number, callback: (isWatched: boolean) => void) => {
            const components = subscribedComponents.get(threadId.toString()) || [];
            subscribedComponents.set(threadId.toString(), [...components, { callback }]);
            return threadWatches?.data.find(w => w.discussion_thread_root_id === threadId)?.enabled ?? false;
        },
        unsubscribeFromThreadWatch: (threadId: number, callback: (isWatched: boolean) => void) => {
            const components = subscribedComponents.get(threadId.toString()) || [];
            subscribedComponents.set(threadId.toString(), components.filter(c => c.callback !== callback));
        },
        setThreadWatchStatus: (threadId: number, status: boolean) => {
            const threadWatch = threadWatches?.data.find(w => w.discussion_thread_root_id === threadId);
            if (status) {
                if (threadWatch) {
                    updateWatch({
                        id: threadWatch.id,
                        values: {
                            enabled: true
                        }
                    })
                    return;
                }
                createThreadWatcher({
                    values: {
                        user_id: user?.id,
                        class_id: course_id,
                        discussion_thread_root_id: threadId
                    }
                })
            } else {
                if (!threadWatch) {
                    return;
                }
                updateWatch({
                    id: threadWatch.id,
                    values: {
                        enabled: false
                    }
                })
            }
        }
    }}>{children}</DiscussionThreadWatchContext.Provider>
}


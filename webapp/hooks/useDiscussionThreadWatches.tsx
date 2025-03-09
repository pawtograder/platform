'use client';
import { createContext, useEffect } from "react";
import { useContext, useState } from "react";
import { useList, useCreate, useDelete } from "@refinedev/core";
import { DiscussionThreadWatcher } from "@/utils/supabase/DatabaseTypes";
import useAuthState from "./useAuthState";
import { useParams } from "next/navigation";
type DiscussionThreadWatchContext = {
    unsubscribeFromThreadWatch(threadId: number, callback: (isWatched: boolean) => void): void;
    threadWatchStatus(threadId: number, callback: (isWatched: boolean) => void): boolean;
    setThreadWatchStatus(threadId: number, status: boolean): void;
    data: DiscussionThreadWatcher[];
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
    }, [threadId]);
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
        liveMode: "manual",
        onLiveEvent: (event) => {
            //TODO
            console.log("Live event");
            if (event.type === "created") {
                const newID = event.payload.id;
                const subscriptions = subscribedComponents.get(newID.toString()) || [];
                console.log("Subscriptions", subscriptions);
                subscriptions.forEach(c => c.callback(true));
            }
            console.log(event);
        }
    });
    const { mutateAsync: createThreadWatcher } = useCreate({
        resource: "discussion_thread_watchers",
    });
    const { mutateAsync: deleteThreadWatcher } = useDelete({
    });
    return <DiscussionThreadWatchContext.Provider value={{
        data: threadWatches?.data || [],
        threadWatchStatus: (threadId: number, callback: (isWatched: boolean) => void) => {
            const components = subscribedComponents.get(threadId.toString()) || [];
            subscribedComponents.set(threadId.toString(), [...components, { callback }]);
            console.log("Checking watch status for thread", threadId);
            console.log(subscribedComponents);
            console.log(threadWatches?.data);
            return threadWatches?.data.find(w => w.discussion_thread_root_id === threadId) !== undefined;
        },
        unsubscribeFromThreadWatch: (threadId: number, callback: (isWatched: boolean) => void) => {
            console.log("Unsubscribing from thread watch", threadId, callback);
            const components = subscribedComponents.get(threadId.toString()) || [];
            subscribedComponents.set(threadId.toString(), components.filter(c => c.callback !== callback));
        },
        setThreadWatchStatus: (threadId: number, status: boolean) => {
            const threadWatch = threadWatches?.data.find(w => w.discussion_thread_root_id === threadId);
            console.log("Setting thread watch status", threadId, status);
            console.log(threadWatches?.data);
            if (status) {
                if (threadWatch) {
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
                deleteThreadWatcher({
                    id: threadWatch.id,
                    resource: "discussion_thread_watchers",
                })
            }
        }
    }}>{children}</DiscussionThreadWatchContext.Provider>
}


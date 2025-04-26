import { DiscussionThread, DiscussionThreadReadStatus } from "@/utils/supabase/DatabaseTypes";
import { LiveEvent, useList } from "@refinedev/core";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import useAuthState from "./useAuthState";
export type DiscussionThreadWithChildren = DiscussionThread & {
    children: DiscussionThread[];
}
type UpdateCallback<T> = (data: T) => void;
type Unsubscribe = () => void;

export function useDiscussionThreadRoot() {
    const controller = useDiscussionThreadsController();
    const [thread, setThread] = useState<DiscussionThreadWithChildren>();
    useEffect(() => {
        const { unsubscribe, data } = controller.getDiscussionThreadWithChildren(controller.root_id, (data) => {
            setThread(data);
        });
        if (data) {
            setThread(data);
        }
        return unsubscribe;
    }, [controller]);
    return thread;
}
export default function useDiscussionThreadChildren(threadId: number) {
    const controller = useDiscussionThreadsController();
    const [thread, setThread] = useState<DiscussionThreadWithChildren>();

    useEffect(() => {
        const { unsubscribe, data } = controller.getDiscussionThreadWithChildren(threadId, (data) => {
            setThread({ ...data });
        });
        if (data) {
            setThread({ ...data });
        }
        return unsubscribe;
    }, [controller, threadId]);
    return thread;
}
export type DiscussionThreadReadWithAllDescendants = DiscussionThreadReadStatus & {
    numReadDescendants: number;
}
export class DiscussionThreadsController {
    private discussionThreadWithChildrenSubscribers: Map<number, UpdateCallback<DiscussionThreadWithChildren>[]> = new Map();
    private discussionThreadWithChildren: Map<number, DiscussionThreadWithChildren> = new Map();

    constructor(public root_id: number) {
    }
    handleEvent(event: LiveEvent) {
        if (event.type === "created") {
            const body = event.payload as DiscussionThread;
            //Create the thread in the map
            this.discussionThreadWithChildren.set(body.id, {
                ...body,
                children: []
            });
            //Notify subscribers
            this.notifyDiscussionThreadWithChildrenSubscribers(body.id, {
                ...body,
                children: []
            });
            const parent = body.parent;
            if (parent) {
                const parentThread = this.discussionThreadWithChildren.get(parent);
                if (parentThread) {
                    parentThread.children = [...parentThread.children, body];
                    this.notifyDiscussionThreadWithChildrenSubscribers(parent, parentThread);
                }
            }
        } else if (event.type === "updated") {
            const body = event.payload as DiscussionThread;
            const thread = this.discussionThreadWithChildren.get(body.id);
            if (thread && (thread.body !== body.body
                || thread.answer !== body.answer
                || thread.draft !== body.draft

            )) { //Only notify if the body has changed
                this.discussionThreadWithChildren.set(body.id, { children: thread.children, ...body });
                this.notifyDiscussionThreadWithChildrenSubscribers(body.id, { children: thread.children, ...body });
            }
        }
    }

    getDiscussionThreadWithChildren(threadId: number, callback?: UpdateCallback<DiscussionThreadWithChildren>): { unsubscribe: Unsubscribe, data: DiscussionThreadWithChildren | undefined } {
        const subscribers = this.discussionThreadWithChildrenSubscribers.get(threadId) || [];
        if (callback) {
            this.discussionThreadWithChildrenSubscribers.set(threadId, [...subscribers, callback]);
        }
        return {
            unsubscribe: () => {
                if (callback) {
                    this.discussionThreadWithChildrenSubscribers.set(threadId, subscribers.filter(cb => cb !== callback));
                }
            },
            data: this.discussionThreadWithChildren.get(threadId)
        }
    }

    setDiscussionThreads(data: DiscussionThread[]) {
        if (this.discussionThreadWithChildren.size > 0) {
            //TODO: Why does this happen? liveMode=manual should prevent this from getting called after first load
            return;
        }
        for (const thread of data) {
            const children = data.filter(t => t.parent === thread.id);
            this.discussionThreadWithChildren.set(thread.id, {
                ...thread,
                children
            });
            this.notifyDiscussionThreadWithChildrenSubscribers(thread.id, {
                ...thread,
                children
            });
        }

    }
    private notifyDiscussionThreadWithChildrenSubscribers(threadId: number, data: DiscussionThreadWithChildren) {
        const subscribers = this.discussionThreadWithChildrenSubscribers.get(threadId);
        if (subscribers) {
            subscribers.filter(cb => cb !== undefined).forEach(cb => cb(data));
        }
    }
}
function DiscussionThreadChildrenProvider({ controller }: { controller: DiscussionThreadsController }) {
    const { user } = useAuthState();
    const { data } = useList<DiscussionThread>({
        resource: "discussion_threads",
        meta: {
            select: "*"
        },
        pagination: {
            pageSize: 10000
        },
        liveMode: "manual",
        onLiveEvent: (event) => {
            controller.handleEvent(event);
        },
        queryOptions: {
            cacheTime: Infinity,
            staleTime: Infinity, // Realtime data
        },
        sorters: [{
            field: "created_at",
            order: "asc"
        }],
        filters: [
            {
                field: 'root',
                operator: 'eq',
                value: controller.root_id
            }
        ]
    });

    useEffect(() => {
        if (data) {
            controller.setDiscussionThreads(data.data);
        }
    }, [controller, data]);
    return <></>
}
const DiscussionThreadsControllerContext = createContext<DiscussionThreadsController | null>(null);
export function DiscussionThreadsControllerProvider({ root_id, children }: { children: React.ReactNode, root_id: number }) {

    const controller = useRef<DiscussionThreadsController>(new DiscussionThreadsController(root_id));
    return <DiscussionThreadsControllerContext.Provider value={controller.current}>
        <DiscussionThreadChildrenProvider controller={controller.current} />
        {children}
    </DiscussionThreadsControllerContext.Provider>
}
export function useDiscussionThreadsController() {
    const controller = useContext(DiscussionThreadsControllerContext);
    if (!controller) {
        throw new Error("DiscussionThreadsController not found");
    }
    return controller;
}
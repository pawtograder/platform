import { DiscussionThread, DiscussionThreadReadStatus } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { SupabaseClient } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useCourseController } from "./useCourseController";
import { DiscussionThreadRealTimeController } from "@/lib/DiscussionThreadRealTimeController";
import { DiscussionDataProvider, useDiscussionThreadQuery } from "./discussion-data";

export type DiscussionThreadWithChildren = DiscussionThread & {
  children: DiscussionThread[];
};

export type DiscussionThreadReadWithAllDescendants = DiscussionThreadReadStatus & {
  numReadDescendants: number;
  current_children_count: number;
};

/**
 * Hook to get the root discussion thread with its immediate children
 */
export function useDiscussionThreadRoot() {
  const controller = useDiscussionThreadsController();
  const { data } = useDiscussionThreadQuery();
  return useMemo(() => {
    if (!data) return undefined;
    const rootThread = data.find((t) => t.id === controller.root_id);
    if (!rootThread) return undefined;
    const children = data.filter((t) => t.parent === rootThread.id);
    return {
      ...rootThread,
      children
    } as DiscussionThreadWithChildren;
  }, [data, controller.root_id]);
}

/**
 * Hook to get a discussion thread with its immediate children
 * Children are sorted by likes_count descending (then created_at ascending) with stable ordering
 */
export default function useDiscussionThreadChildren(threadId: number): DiscussionThreadWithChildren | undefined {
  const { data } = useDiscussionThreadQuery();

  const thread = useMemo(() => data?.find((t) => t.id === threadId), [data, threadId]);
  const children = useMemo(() => (data ?? []).filter((t) => t.parent === thread?.id), [data, thread]);

  // Stable sort order: capture initial order on first render, maintain it during session
  // Reset when threadId changes (component remounts)
  const sortOrderRef = useRef<{ threadId: number; order: number[] } | null>(null);

  const sortedChildren = useMemo(() => {
    if (!children || children.length === 0) return children;

    // Reset sort order if threadId changed (remount)
    if (sortOrderRef.current === null || sortOrderRef.current.threadId !== threadId) {
      // Sort by likes_count descending, then created_at ascending
      const sorted = [...children].sort((a, b) => {
        const likesDiff = (b.likes_count ?? 0) - (a.likes_count ?? 0);
        if (likesDiff !== 0) return likesDiff;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });
      // Capture the thread IDs in this order
      sortOrderRef.current = {
        threadId,
        order: sorted.map((c) => c.id)
      };
      return sorted;
    }

    // We have a captured order - maintain it
    // Deduplicate order array while preserving order (keep first occurrence)
    const seenIds = new Set<number>();
    const deduplicatedOrder: number[] = [];
    sortOrderRef.current.order.forEach((id) => {
      if (!seenIds.has(id)) {
        seenIds.add(id);
        deduplicatedOrder.push(id);
      }
    });
    sortOrderRef.current.order = deduplicatedOrder;

    const orderMap = new Map<number, number>();
    sortOrderRef.current.order.forEach((id, index) => {
      orderMap.set(id, index);
    });

    // Separate known children (in order) from new children (not in order)
    const knownChildren: DiscussionThread[] = [];
    const newChildren: DiscussionThread[] = [];

    children.forEach((child) => {
      if (orderMap.has(child.id)) {
        knownChildren.push(child);
      } else {
        newChildren.push(child);
      }
    });

    // Sort known children by captured order
    knownChildren.sort((a, b) => {
      const orderA = orderMap.get(a.id) ?? Infinity;
      const orderB = orderMap.get(b.id) ?? Infinity;
      return orderA - orderB;
    });

    // Sort new children by likes_count descending, then created_at ascending
    newChildren.sort((a, b) => {
      const likesDiff = (b.likes_count ?? 0) - (a.likes_count ?? 0);
      if (likesDiff !== 0) return likesDiff;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    // Append new children IDs to the sort order ref (only if not already present)
    // This prevents duplicates if children array changes and recalculates
    const orderSet = new Set(sortOrderRef.current!.order);
    newChildren.forEach((child) => {
      if (!orderSet.has(child.id)) {
        sortOrderRef.current!.order.push(child.id);
        orderSet.add(child.id);
      }
    });

    // Clean up: remove IDs from order array that are no longer in children
    // This prevents memory leaks from deleted/removed threads
    const childrenIdsSet = new Set(children.map((c) => c.id));
    sortOrderRef.current!.order = sortOrderRef.current!.order.filter((id) => childrenIdsSet.has(id));

    return [...knownChildren, ...newChildren];
  }, [children, threadId]);

  return useMemo(() => {
    if (!thread) return undefined;

    return {
      ...thread,
      children: sortedChildren
    } as DiscussionThreadWithChildren;
  }, [thread, sortedChildren]);
}

/**
 * Hook to get all discussion threads for the current root (flat list)
 */
export function useAllDiscussionThreads(): DiscussionThread[] {
  const { data } = useDiscussionThreadQuery();
  return data ?? [];
}
/**
 * Lightweight controller for a discussion thread root.
 * The old TableController is replaced by a thin shim providing
 * create/update/delete via direct Supabase calls.
 */
export class DiscussionThreadsController {
  public readonly root_id: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly tableController: any;

  constructor(
    root_id: number,
    client: SupabaseClient<Database>,
    courseId: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryClient: any
  ) {
    this.root_id = root_id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;
    const qk = ["discussion", courseId, "threads", root_id];
    this.tableController = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async create(row: any) {
        const { data, error } = await db.from("discussion_threads").insert(row).select("*").single();
        if (error) throw error;
        queryClient?.invalidateQueries?.({ queryKey: qk });
        return data;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async update(id: number, values: any) {
        const { data, error } = await db.from("discussion_threads").update(values).eq("id", id).select("*").single();
        if (error) throw error;
        queryClient?.invalidateQueries?.({ queryKey: qk });
        return data;
      },
      async delete(id: number) {
        const { error } = await db
          .from("discussion_threads")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", id);
        if (error) throw error;
        queryClient?.invalidateQueries?.({ queryKey: qk });
      },
      async invalidate() {
        queryClient?.invalidateQueries?.({ queryKey: qk });
      },
      async refetchAll() {
        queryClient?.invalidateQueries?.({ queryKey: qk });
      }
    };
  }

  close() {
    // No subscriptions to tear down.
  }
}

const DiscussionThreadsControllerContext = createContext<DiscussionThreadsController | null>(null);

export function DiscussionThreadsControllerProvider({
  root_id,
  children
}: {
  children: React.ReactNode;
  root_id: number;
}) {
  const courseController = useCourseController();
  const queryClient = useQueryClient();
  const [controller, setController] = useState<DiscussionThreadsController | null>(null);
  const threadRtcRef = useRef<DiscussionThreadRealTimeController | null>(null);

  useEffect(() => {
    let cancelled = false;

    const initializeControllers = async () => {
      if (!courseController?.client) {
        return;
      }

      const threadRealTimeController = new DiscussionThreadRealTimeController({
        client: courseController.client,
        threadRootId: root_id
      });

      await threadRealTimeController.start();

      if (cancelled) {
        await threadRealTimeController.close();
        return;
      }

      threadRtcRef.current = threadRealTimeController;

      const discussionController = new DiscussionThreadsController(
        root_id,
        courseController.client,
        courseController.courseId,
        queryClient
      );

      setController(discussionController);
    };

    initializeControllers();

    return () => {
      cancelled = true;
      if (threadRtcRef.current) {
        threadRtcRef.current.close();
        threadRtcRef.current = null;
      }
    };
  }, [courseController, root_id, queryClient]);

  const discussionDataValue = useMemo(() => {
    if (!controller || !courseController?.client) return null;
    let classRtc = null;
    try {
      classRtc = courseController.classRealTimeController;
    } catch {
      // Not yet initialized
    }
    return {
      rootThreadId: root_id,
      courseId: courseController.courseId,
      supabase: courseController.client,
      classRtc
    };
  }, [controller, courseController, root_id]);

  if (!controller || !discussionDataValue) {
    return null;
  }

  return (
    <DiscussionThreadsControllerContext.Provider value={controller}>
      <DiscussionDataProvider value={discussionDataValue}>{children}</DiscussionDataProvider>
    </DiscussionThreadsControllerContext.Provider>
  );
}

export function useDiscussionThreadsController() {
  const controller = useContext(DiscussionThreadsControllerContext);
  if (!controller) {
    throw new Error("DiscussionThreadsController not found");
  }
  return controller;
}

import TableController from "@/lib/TableController";
import { DiscussionThread, DiscussionThreadReadStatus } from "@/utils/supabase/DatabaseTypes";
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
 * Controller for managing a specific discussion thread and its realtime subscriptions.
 * Subscribes to the thread-specific channel (discussion_thread:$root_id) for targeted updates.
 */
export class DiscussionThreadsController {
  public readonly tableController: TableController<"discussion_threads">;
  public readonly threadRealTimeController: DiscussionThreadRealTimeController;
  public readonly root_id: number;

  constructor(
    root_id: number,
    tableController: TableController<"discussion_threads">,
    threadRealTimeController: DiscussionThreadRealTimeController
  ) {
    this.root_id = root_id;
    this.tableController = tableController;
    this.threadRealTimeController = threadRealTimeController;
  }

  close() {
    // Controllers are closed in the provider's useEffect cleanup
    this.threadRealTimeController.close();
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
  const [controller, setController] = useState<DiscussionThreadsController | null>(null);
  const controllersRef = useRef<{
    threadController: DiscussionThreadsController;
    tableController: TableController<"discussion_threads">;
    threadRealTimeController: DiscussionThreadRealTimeController;
  } | null>(null);

  // Create all controllers with async initialization
  useEffect(() => {
    let cancelled = false;

    const initializeControllers = async () => {
      if (!courseController?.client) {
        return;
      }

      // Create DiscussionThreadRealTimeController for per-thread channel
      const threadRealTimeController = new DiscussionThreadRealTimeController({
        client: courseController.client,
        threadRootId: root_id
      });

      // Start the realtime controller
      await threadRealTimeController.start();

      if (cancelled) {
        await threadRealTimeController.close();
        return;
      }

      // Create TableController with BOTH class and thread-specific realtime controllers
      const tableController = new TableController({
        client: courseController.client,
        table: "discussion_threads",
        query: courseController.client
          .from("discussion_threads")
          .select("*")
          .eq("root", root_id)
          .order("created_at", { ascending: true }),
        classRealTimeController: courseController.classRealTimeController,
        additionalRealTimeControllers: [threadRealTimeController],
        realtimeFilter: { root: root_id },
        loadEntireTable: true
      });

      if (cancelled) {
        await threadRealTimeController.close();
        tableController.close();
        return;
      }

      // Create DiscussionThreadsController
      const discussionController = new DiscussionThreadsController(root_id, tableController, threadRealTimeController);

      controllersRef.current = {
        threadController: discussionController,
        tableController,
        threadRealTimeController
      };

      setController(discussionController);
    };

    initializeControllers();

    return () => {
      cancelled = true;
      if (controllersRef.current) {
        controllersRef.current.threadController.close();
        controllersRef.current.tableController.close();
        controllersRef.current.threadRealTimeController.close();
        controllersRef.current = null;
      }
    };
  }, [courseController, root_id]);

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

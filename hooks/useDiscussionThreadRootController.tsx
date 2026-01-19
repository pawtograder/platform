import TableController, {
  useListTableControllerValues,
  useTableControllerTableValues,
  useTableControllerValueById
} from "@/lib/TableController";
import { DiscussionThread, DiscussionThreadReadStatus } from "@/utils/supabase/DatabaseTypes";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useCourseController } from "./useCourseController";
import { DiscussionThreadRealTimeController } from "@/lib/DiscussionThreadRealTimeController";

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
  const rootThread = useTableControllerValueById(controller.tableController, controller.root_id);
  const childrenPredicate = useCallback((t: DiscussionThread) => t.parent === rootThread?.id, [rootThread]);
  const children = useListTableControllerValues(controller.tableController, childrenPredicate);
  const ret = useMemo(() => {
    if (!rootThread) return undefined;
    return {
      ...rootThread,
      children
    } as DiscussionThreadWithChildren;
  }, [rootThread, children]);
  return ret;
}

/**
 * Hook to get a discussion thread with its immediate children
 * Children are sorted by likes_count descending (then created_at ascending) with stable ordering
 */
export default function useDiscussionThreadChildren(threadId: number): DiscussionThreadWithChildren | undefined {
  const controller = useDiscussionThreadsController();
  const thread = useTableControllerValueById(controller.tableController, threadId);
  const childrenPredicate = useCallback((t: DiscussionThread) => t.parent === thread?.id, [thread]);
  const children = useListTableControllerValues(controller.tableController, childrenPredicate);

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

    // Append new children IDs to the sort order ref
    newChildren.forEach((child) => {
      sortOrderRef.current!.order.push(child.id);
    });

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
  const controller = useDiscussionThreadsController();
  return useTableControllerTableValues(controller.tableController);
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

  if (!controller) {
    return null;
  }

  return (
    <DiscussionThreadsControllerContext.Provider value={controller}>
      {children}
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

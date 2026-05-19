import TableController, {
  useIndexedTableControllerValues,
  useTableControllerTableValues,
  useTableControllerValueById
} from "@/lib/TableController";
import { DiscussionThread, DiscussionThreadReadStatus } from "@/utils/supabase/DatabaseTypes";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  // Indexed on `parent`: every PostRow that mounted in this thread tree used
  // to register its own predicate-scan list-listener, so each row mutation
  // re-scanned every row × every listener (O(N²) per write). The indexed
  // path fans out only to the listener whose `value` actually matches.
  const children = useIndexedTableControllerValues(controller.tableController, "parent", rootThread?.id);
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
  // See `useDiscussionThreadRoot` above — indexed by `parent` to avoid
  // O(listeners × rows) predicate scans on every reply mutation.
  const children = useIndexedTableControllerValues(controller.tableController, "parent", thread?.id);

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

  // Create all controllers with async initialization.
  //
  // Previously this awaited threadRealTimeController.start() before creating
  // the TableController and resolving setController(...). On webkit (and
  // anywhere websocket negotiation is slow) that gated the entire provider
  // subtree behind realtime channel join — including the discussion thread
  // heading, which only depends on the course-wide teasers controller.
  // Symptom: navigating into a thread, the URL changed but the page sat on
  // the loading skeleton until reload.
  //
  // Fix: construct the per-thread controllers synchronously and resolve
  // setController immediately. The realtime controller starts in the
  // background; the TableController buffers any pre-join broadcasts and
  // catches up once the channel reaches "joined" via its existing
  // since-watermark mechanism.
  useEffect(() => {
    if (!courseController?.client) {
      // Clear any previously-set controller so consumers don't render with
      // a stale, already-closed reference if the client briefly drops.
      setController(null);
      return;
    }

    // Create DiscussionThreadRealTimeController for per-thread channel
    const threadRealTimeController = new DiscussionThreadRealTimeController({
      client: courseController.client,
      threadRootId: root_id
    });

    // Kick off realtime channel join in the background; do not block render.
    // Without the .catch, a subscription failure silently leaves the thread
    // with a half-initialized realtime controller and no diagnostics. close()
    // is async (returns a Promise); chain its own .catch so a teardown failure
    // doesn't surface as an unhandled rejection.
    void threadRealTimeController.start().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("Failed to start DiscussionThreadRealTimeController:", error);
      void threadRealTimeController.close().catch((closeError) => {
        // eslint-disable-next-line no-console
        console.error("Failed to close DiscussionThreadRealTimeController after start failure:", closeError);
      });
    });

    // Create TableController with BOTH class and thread-specific realtime controllers.
    //
    // Hot path: rehydrate from the per-course LRU cache so the second
    // (and subsequent) visits to a thread skip the SELECT round trip
    // entirely. The TableController will still do a since-watermark
    // refetch once the realtime channel joins, picking up any replies
    // that arrived while the user was off this thread — see
    // `_needsCatchUpAfterInitialDataHydration` in TableController.
    const cachedRows = courseController.getCachedDiscussionThreadRows(root_id);
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
      loadEntireTable: true,
      initialData: cachedRows
    });

    // Create DiscussionThreadsController
    const discussionController = new DiscussionThreadsController(root_id, tableController, threadRealTimeController);

    controllersRef.current = {
      threadController: discussionController,
      tableController,
      threadRealTimeController
    };

    setController(discussionController);

    return () => {
      if (controllersRef.current) {
        // Snapshot rows BEFORE closing — `close()` clears `_rows`. Caching
        // these means the next mount for the same `root_id` rehydrates
        // synchronously and skips the REST round trip.
        const snapshot = controllersRef.current.tableController.rows as DiscussionThread[];
        if (snapshot.length > 0) {
          courseController.cacheDiscussionThreadRows(root_id, snapshot);
        }
        // threadController.close() already closes the realtime controller
        // (DiscussionThreadsController.close at line ~168), so no explicit
        // threadRealTimeController.close here.
        controllersRef.current.threadController.close();
        controllersRef.current.tableController.close();
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

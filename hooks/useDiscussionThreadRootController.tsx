import { DiscussionThread, DiscussionThreadReadStatus } from "@/utils/supabase/DatabaseTypes";
import TableController, { useTableControllerValueById, useTableControllerTableValues } from "@/lib/TableController";
import { createContext, useContext, useEffect, useRef, useMemo } from "react";
import { useCourseController } from "./useCourseController";

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
  const allThreads = useTableControllerTableValues(controller.tableController);

  return useMemo(() => {
    if (!rootThread) return undefined;

    const children = allThreads.filter((t) => t.parent === rootThread.id);

    return {
      ...rootThread,
      children
    } as DiscussionThreadWithChildren;
  }, [rootThread, allThreads]);
}

/**
 * Hook to get a discussion thread with its immediate children
 */
export default function useDiscussionThreadChildren(threadId: number): DiscussionThreadWithChildren | undefined {
  const controller = useDiscussionThreadsController();
  const thread = useTableControllerValueById(controller.tableController, threadId);
  const allThreads = useTableControllerTableValues(controller.tableController);

  return useMemo(() => {
    if (!thread) return undefined;

    const children = allThreads.filter((t) => t.parent === thread.id);

    return {
      ...thread,
      children
    } as DiscussionThreadWithChildren;
  }, [thread, allThreads]);
}

/**
 * Hook to get all discussion threads for the current root (flat list)
 */
export function useAllDiscussionThreads(): DiscussionThread[] {
  const controller = useDiscussionThreadsController();
  return useTableControllerTableValues(controller.tableController);
}
/**
 * Simple controller that holds a reference to the TableController for discussion threads.
 * The hierarchy building is now done in the hooks themselves using TableController hooks.
 */
export class DiscussionThreadsController {
  public readonly tableController: TableController<"discussion_threads">;
  public readonly root_id: number;

  constructor(root_id: number, tableController: TableController<"discussion_threads">) {
    this.root_id = root_id;
    this.tableController = tableController;
  }

  close() {
    // TableController is closed in the provider's useEffect cleanup
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
  const controllerRef = useRef<DiscussionThreadsController | null>(null);

  // Create both TableController and DiscussionThreadsController in useEffect for proper cleanup
  useEffect(() => {
    if (!courseController?.client || !courseController?.classRealTimeController) {
      return;
    }

    // Create TableController with realtime filter for this root
    const tableController = new TableController({
      client: courseController.client,
      table: "discussion_threads",
      query: courseController.client
        .from("discussion_threads")
        .select("*")
        .eq("root", root_id)
        .order("created_at", { ascending: true }),
      classRealTimeController: courseController.classRealTimeController,
      realtimeFilter: { root: root_id },
      loadEntireTable: true
    });

    // Create DiscussionThreadsController
    const controller = new DiscussionThreadsController(root_id, tableController);
    controllerRef.current = controller;

    return () => {
      controller.close();
      tableController.close();
      controllerRef.current = null;
    };
  }, [courseController, root_id]);

  if (!controllerRef.current) {
    return null;
  }

  return (
    <DiscussionThreadsControllerContext.Provider value={controllerRef.current}>
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

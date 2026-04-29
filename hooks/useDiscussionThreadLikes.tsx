import { useIndexedTableControllerValue } from "@/lib/TableController";
import { useCourseController } from "./useCourseController";

/**
 * Hook to get the like status for a discussion thread by the current user.
 *
 * Uses the indexed-by-`discussion_thread` subscription path. The likes
 * controller is already filtered to the current user (`.eq("creator",
 * profileId)` in the lazy getter), so indexing on the thread foreign key
 * alone uniquely identifies "this user's like for this thread". Indexed
 * subscription means a row mutation only notifies the listener whose
 * `discussion_thread` actually matches — same scaling motivation as the
 * read-status / watcher hooks.
 */
export function useDiscussionThreadLikes(thread_id: number) {
  const controller = useCourseController();
  return useIndexedTableControllerValue(controller.discussionThreadLikes, "discussion_thread", thread_id);
}

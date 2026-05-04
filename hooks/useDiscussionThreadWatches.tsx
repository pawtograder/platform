"use client";
import { useIndexedTableControllerValue } from "@/lib/TableController";
import { useCallback } from "react";
import useAuthState from "./useAuthState";
import { useCourseController } from "./useCourseController";
import { toaster } from "@/components/ui/toaster";

export function useDiscussionThreadFollowStatus(threadId: number) {
  const controller = useCourseController();
  const { user } = useAuthState();

  // Indexed-by-`discussion_thread_root_id` subscription. The watchers
  // controller is already filtered by `user_id` at construction (see the
  // lazy getter in `useCourseController.tsx`), so the previous compound
  // predicate was redundantly re-checking user_id. The indexed path
  // notifies only the one listener whose root_id matches a mutation,
  // instead of every PostRow / DiscussionThreadContent re-evaluating the
  // predicate against the whole watcher table.
  void user; // referenced below for the setThreadWatchStatus callback
  const curWatch = useIndexedTableControllerValue(
    controller.discussionThreadWatchers,
    "discussion_thread_root_id",
    threadId
  );

  const setThreadWatchStatus = useCallback(
    async (status: boolean) => {
      if (!user?.id) {
        toaster.error({
          title: "Error",
          description: "You must be logged in to follow threads"
        });
        return;
      }

      try {
        if (curWatch) {
          // Update existing follow status
          await controller.discussionThreadWatchers.update(curWatch.id, {
            enabled: status
          });
        } else {
          // Create new follow record
          await controller.discussionThreadWatchers.create({
            user_id: user.id,
            class_id: controller.courseId,
            discussion_thread_root_id: threadId,
            enabled: status
          });
        }
      } catch (error) {
        toaster.error({
          title: "Error updating follow status",
          description: "Please try again later"
        });
        // eslint-disable-next-line no-console
        console.error("Failed to update thread follow status:", error);
      }
    },
    [threadId, curWatch, controller, user?.id]
  );

  return {
    status: curWatch?.enabled ?? false,
    setThreadWatchStatus
  };
}

// Backwards-compatible alias (older UI still imports the Watch naming).
export const useDiscussionThreadWatchStatus = useDiscussionThreadFollowStatus;

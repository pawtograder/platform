"use client";
import { DiscussionThreadWatcher } from "@/utils/supabase/DatabaseTypes";
import { useFindTableControllerValue } from "@/lib/TableController";
import { useCallback, useMemo } from "react";
import useAuthState from "./useAuthState";
import { useCourseController } from "./useCourseController";
import { toaster } from "@/components/ui/toaster";

export function useDiscussionThreadFollowStatus(threadId: number) {
  const controller = useCourseController();
  const { user } = useAuthState();

  // Find the current follow status for this user and thread
  const predicate = useMemo(
    () => (data: DiscussionThreadWatcher) => data.discussion_thread_root_id === threadId && data.user_id === user?.id,
    [threadId, user?.id]
  );

  const curWatch = useFindTableControllerValue(controller.discussionThreadWatchers, predicate);

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

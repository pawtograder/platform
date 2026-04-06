"use client";
import { useCallback, useMemo } from "react";
import useAuthState from "./useAuthState";
import { useCourseController } from "./useCourseController";
import {
  useDiscussionThreadWatchersQuery,
  useDiscussionThreadWatcherInsert,
  useDiscussionThreadWatcherUpdate
} from "./course-data";
import { toaster } from "@/components/ui/toaster";

export function useDiscussionThreadFollowStatus(threadId: number) {
  const controller = useCourseController();
  const { user } = useAuthState();
  const { data: watchers = [] } = useDiscussionThreadWatchersQuery();
  const insertWatcher = useDiscussionThreadWatcherInsert();
  const updateWatcher = useDiscussionThreadWatcherUpdate();

  // Find the current follow status for this user and thread
  const curWatch = useMemo(
    () => watchers.find((data) => data.discussion_thread_root_id === threadId && data.user_id === user?.id),
    [watchers, threadId, user?.id]
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
          await updateWatcher.mutateAsync({
            id: curWatch.id,
            values: { enabled: status }
          });
        } else {
          // Create new follow record
          await insertWatcher.mutateAsync({
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
    [threadId, curWatch, controller, user?.id, insertWatcher, updateWatcher]
  );

  return {
    status: curWatch?.enabled ?? false,
    setThreadWatchStatus
  };
}

// Backwards-compatible alias (older UI still imports the Watch naming).
export const useDiscussionThreadWatchStatus = useDiscussionThreadFollowStatus;

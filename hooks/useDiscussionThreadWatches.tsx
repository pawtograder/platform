"use client";
import { DiscussionThreadWatcher } from "@/utils/supabase/DatabaseTypes";
import { useFindTableControllerValue } from "@/lib/TableController";
import { useCallback, useMemo } from "react";
import useAuthState from "./useAuthState";
import { useCourseController } from "./useCourseController";
import { useTrackEvent } from "./useTrackEvent";
import { toaster } from "@/components/ui/toaster";

export function useDiscussionThreadWatchStatus(threadId: number) {
  const controller = useCourseController();
  const { user } = useAuthState();
  const trackEvent = useTrackEvent();

  // Find the current watch status for this user and thread
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
          description: "You must be logged in to watch threads"
        });
        return;
      }

      try {
        if (curWatch) {
          // Update existing watch status
          await controller.discussionThreadWatchers.update(curWatch.id, {
            enabled: status
          });
        } else {
          // Create new watch record
          await controller.discussionThreadWatchers.create({
            user_id: user.id,
            class_id: controller.courseId,
            discussion_thread_root_id: threadId,
            enabled: status
          });
        }

        // Track discussion thread watch
        trackEvent("discussion_thread_watched", {
          thread_id: threadId,
          course_id: controller.courseId,
          is_watching: status
        });
      } catch (error) {
        toaster.error({
          title: "Error updating watch status",
          description: "Please try again later"
        });
        // eslint-disable-next-line no-console
        console.error("Failed to update thread watch status:", error);
      }
    },
    [threadId, curWatch, controller, user?.id, trackEvent]
  );

  return {
    status: curWatch?.enabled ?? false,
    setThreadWatchStatus
  };
}

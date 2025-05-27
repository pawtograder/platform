"use client";
import type { DiscussionThreadWatcher } from "@/utils/supabase/DatabaseTypes";
import { useCreate, useUpdate } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import useAuthState from "./useAuthState";
import { useCourseController } from "./useCourseController";
export function useDiscussionThreadWatchStatus(threadId: number) {
  const controller = useCourseController();
  const [curWatch, setCurWatch] = useState<DiscussionThreadWatcher | undefined>(undefined);
  useEffect(() => {
    const { unsubscribe, data } = controller.getValueWithSubscription<DiscussionThreadWatcher>(
      "discussion_thread_watchers",
      threadId,
      (data) => {
        setCurWatch(data);
      }
    );
    setCurWatch(data);
    return unsubscribe;
  }, [controller, threadId]);
  const { mutateAsync: createThreadWatcher } = useCreate({
    resource: "discussion_thread_watchers"
  });
  const { mutateAsync: updateWatch } = useUpdate({
    resource: "discussion_thread_watchers"
  });
  const { user } = useAuthState();
  const { course_id } = useParams();
  const setThreadWatchStatus = useCallback(
    async (status: boolean) => {
      if (curWatch) {
        await updateWatch({
          id: curWatch.id,
          values: {
            enabled: status
          }
        });
      } else {
        await createThreadWatcher({
          values: {
            user_id: user?.id,
            class_id: course_id,
            discussion_thread_root_id: threadId
          }
        });
      }
    },
    [threadId, curWatch, course_id, createThreadWatcher, updateWatch, user]
  );
  return {
    status: curWatch?.enabled ?? false,
    setThreadWatchStatus
  };
}

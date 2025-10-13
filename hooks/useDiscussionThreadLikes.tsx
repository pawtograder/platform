import { useFindTableControllerValue } from "@/lib/TableController";
import { DiscussionThreadLike } from "@/utils/supabase/DatabaseTypes";
import { useCourseController } from "./useCourseController";
import { useMemo } from "react";

/**
 * Hook to get the like status for a discussion thread by the current user
 */
export function useDiscussionThreadLikes(thread_id: number) {
  const controller = useCourseController();

  const predicate = useMemo(() => (like: DiscussionThreadLike) => like.discussion_thread === thread_id, [thread_id]);

  const like = useFindTableControllerValue(controller.discussionThreadLikes, predicate);

  return like;
}

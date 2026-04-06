import { useDiscussionThreadLikesQuery } from "@/hooks/course-data";
import { useMemo } from "react";

/**
 * Hook to get the like status for a discussion thread by the current user
 */
export function useDiscussionThreadLikes(thread_id: number) {
  const { data: likes = [] } = useDiscussionThreadLikesQuery();

  const like = useMemo(() => likes?.find((l) => l.discussion_thread === thread_id) ?? null, [likes, thread_id]);

  return like;
}

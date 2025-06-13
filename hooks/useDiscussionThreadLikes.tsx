import { useList } from "@refinedev/core";
import type { DiscussionThreadLike } from "@/utils/supabase/DatabaseTypes";
import { useClassProfiles } from "./useClassProfiles";
export function useDiscussionThreadLikes(thread_id: number) {
  const { private_profile_id } = useClassProfiles();
  const { data } = useList<DiscussionThreadLike>({
    resource: "discussion_thread_likes",
    pagination: {
      pageSize: 1000
    },
    liveMode: "auto",
    filters: [
      {
        field: "creator",
        operator: "eq",
        value: private_profile_id!
      }
    ]
  });
  return data?.data.find((like) => like.discussion_thread === thread_id);
}

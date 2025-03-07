import { useList } from "@refinedev/core";
import { DiscussionThreadLike } from "@/utils/supabase/DatabaseTypes";
import useAuthState from "./useAuthState";
export function useDiscussionThreadLikes(thread_id: number) {
    const { private_profile_id } = useAuthState();
    const { data, isLoading, error } = useList<DiscussionThreadLike>({
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
            }]
    });
    return data?.data.find((like) => like.discussion_thread === thread_id);
}
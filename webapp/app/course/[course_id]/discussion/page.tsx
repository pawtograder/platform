'use client';
import { DiscussionPostSummary } from "@/components/ui/discussion-post-summary";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Skeleton } from "@chakra-ui/react";
import { useList, useMany, useTable } from "@refinedev/core";
import Link from "next/link";
import { useParams } from "next/navigation";

type Thread = Database['public']['Tables']['discussion_threads']['Row'];

export default function DiscussionPage() {

    // const supabase = createClient();
    const { course_id } = useParams();
    // const allLikes = useList<Database['public']['Tables']['discussion_thread_likes']['Row']>({
    //     resource: "discussion_thread_likes",
    //     filters: [{
    //         field: "user_id",
    //         operator: "eq",
    //         value: supabase.auth.
    //     }]
    // });
    const table = useTable<Thread>({
        resource: "discussion_threads",
        filters: {
            permanent: [
                {
                    field: "root_class_id",
                    operator: "eq",
                    value: Number(course_id)
                },

            ]
        }

    });
    return (
        <div>
            <h1>Discussion</h1>
            <Link href={`/course/${course_id}/discussion/new`}>New Thread</Link>
            {
                table.tableQuery.isLoading ? <Skeleton w="100%" h="300px" /> :
                table.tableQuery.data?.data.map((thread) => (<DiscussionPostSummary key={thread.id} thread={thread} />))
            }
        </div>
    );
}
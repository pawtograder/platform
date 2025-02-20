'use client';
import { DiscussionPostSummary } from "@/components/ui/discussion-post-summary";
import { createClient } from "@/utils/supabase/client";
import { DiscussionThreadWithAuthorAndTopic } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Container, Skeleton, Stack } from "@chakra-ui/react";
import { useList, useMany, useTable } from "@refinedev/core";
import Link from "next/link";
import { useParams } from "next/navigation";


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
    const table = useTable<DiscussionThreadWithAuthorAndTopic>({
        resource: "discussion_threads",
        meta: {
            select: "*, public_profiles(*), discussion_topics(*)"
        },
        filters: {
            permanent: [
                {
                    field: "root_class_id",
                    operator: "eq",
                    value: Number(course_id)
                },

            ]
        }, sorters: {
            mode: "server",
            initial: [{
                field: "created_at",
                order: "desc"
            }]
        }

    });
    return (
        <div>
            <h1>Discussion</h1>
            <Link href={`/course/${course_id}/discussion/new`}>New Thread</Link>
            <Container maxW="4xl" py={{ base: '2', md: '4' }}>
                <Stack gap="6">
                    {
                        table.tableQuery.isLoading ? <Skeleton w="100%" h="300px" /> :
                            table.tableQuery.data?.data.map((thread) => (
                                <Link href={`/course/${thread.class}/discussion/${thread.id}`} key={thread.id}><DiscussionPostSummary thread={thread} /> </Link>))
                    }
                </Stack>
            </Container>
        </div>
    );
}
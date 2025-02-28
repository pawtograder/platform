'use client';
import { DiscussionThreadWithAuthorAndTopic } from "@/utils/supabase/DatabaseTypes";
import { Container } from "@chakra-ui/react";
import { useTable } from "@refinedev/core";
import { useParams } from "next/navigation";


export default function DiscussionPage() {

    const { course_id } = useParams();
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
        <Container maxW="4xl" py={{ base: '2', md: '4' }}>
           (Dashboard goes here, pick a thread from the left)
        </Container>
    );
}
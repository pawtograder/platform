'use client';

import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { set } from "react-hook-form";
import { DiscussionThread, threadsToTree } from "../discussion_thread";
import { Skeleton } from "@/components/ui/skeleton";
import { useList, useMany } from "@refinedev/core";
import { DiscussionThreadWithAuthorAndTopic, ThreadWithChildren } from "@/utils/supabase/DatabaseTypes";
import { DiscussionPostSummary } from "@/components/ui/discussion-post-summary";

type Thread = Database['public']['Tables']['discussion_threads']['Row'];

export default function ThreadView() {
    const [thread, setThread] = useState<ThreadWithChildren>();
    const { root_id } = useParams();
    const { data, isLoading, error } = useList<DiscussionThreadWithAuthorAndTopic>({
        resource: "discussion_threads",
        meta: {
            select: "*, discussion_topics(*), public_profiles(*)"
        },
        pagination: {
            pageSize: 10000
        },
        sorters: [{
            field: "created_at",
            order: "asc"
        }],
        filters: [
            {
                operator: 'or',
                value: [
                    {
                        field: 'id',
                        operator: 'eq',
                        value: root_id
                    },
                    {
                        field: 'root',
                        operator: 'eq',
                        value: root_id
                    }
                ]
            }
        ]
    })
    useEffect(() => {
        if (data) {
            setThread(threadsToTree(data.data));
        }
    }, [data, data?.data]);

    if (!data || !thread) {
        return <Skeleton height="100px" />
    }
    if (data.data.length === 0) {
        return <Box>
            No thread found
        </Box>
    }
    const rootThread = data.data.find((t) => t.id === Number.parseInt(root_id as string));

    return <Box>
        {rootThread ?
            <DiscussionPostSummary thread={thread} standalone={true} />
            // <DiscussionThread thread={thread} />
            : <Skeleton height="100px" />}
    </Box >

}
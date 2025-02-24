'use client'
import { HelpQueue } from "@/components/ui/help-queue/HelpQueue"
import { useList } from "@refinedev/core"
import { HelpQueue as HelpQueueType } from "@/utils/supabase/DatabaseTypes"
import { useParams } from "next/navigation"
export default function HelpManagePage() {
    const { course_id   } = useParams()
    const queues = useList<HelpQueueType>({
        resource: "help_queues",
        filters:
            [
                { field: "class", operator: "eq", value: course_id }
            ]
    })
    if (queues.isLoading) {
        return <div>Loading...</div>
    }
    if (queues.error) {
        return <div>Error: {queues.error.message}</div>
    }
    return <HelpQueue queue_id={queues.data?.data[0].id} />

}
'use client'
import { useList } from "@refinedev/core"
import { HelpQueue as HelpQueueType } from "@/utils/supabase/DatabaseTypes"
import { useParams } from "next/navigation"
import { Box } from "@chakra-ui/react"
export default function HelpManagePage() {
    const { course_id } = useParams()
    const queues = useList<HelpQueueType>({
        resource: "help_queues",
        filters:
            [
                { field: "class_id", operator: "eq", value: course_id }
            ]
    })
    if (queues.isLoading) {
        return <div>Loading...</div>
    }
    if (queues.error) {
        return <div>Error: {queues.error.message}</div>
    }
    return <Box>
        (Dashboard goes here)
    </Box>

}
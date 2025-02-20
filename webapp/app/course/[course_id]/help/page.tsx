'use client'

import { HelpQueue } from "@/utils/supabase/DatabaseTypes"
import { useList } from "@refinedev/core"

export default function HelpPage() {
    const queues = useList<HelpQueue>({
        resource: 'help_queues',

    })
    if (queues.isLoading) {
        return <div>Loading...</div>
    }
    if (queues.error) {
        return <div>Error: {queues.error.message}</div>
    }
    console.log(queues.data)
    return <div>Help

        {queues.data?.data.map((queue) => (
            <div key={queue.id}>
                <h2>{queue.name}</h2>
            </div>
        ))}
    </div>
}
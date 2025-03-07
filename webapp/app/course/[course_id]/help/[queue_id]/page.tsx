'use client'

import { useParams } from "next/navigation"
import { MeetingProvider, VoiceFocusProvider, BackgroundBlurProvider, BackgroundReplacementProvider, useMeetingManager } from "amazon-chime-sdk-component-library-react"
import { NavigationProvider } from "@/lib/aws-chime-sdk-meeting/providers/NavigationProvider"
import { createContext, useCallback, useContext, useEffect, useState } from "react"
import { DeviceSetup } from "@/lib/aws-chime-sdk-meeting/views"
import dynamic from 'next/dynamic'
import { MeetingSessionConfiguration } from "amazon-chime-sdk-js"
import { fetchGetMeeting } from "@/lib/generated/pawtograderComponents"
import { join } from "path"
import useUserProfiles from "@/hooks/useUserProfiles"
import { HelpQueue, HelpRequest } from "@/utils/supabase/DatabaseTypes"
import { useList, useShow } from "@refinedev/core"
import { Box, DataList, Heading, Text, Tabs, TabsList, TabsIndicator } from "@chakra-ui/react"
import { createClient } from "@/utils/supabase/client"
import { RealtimeChannel } from "@supabase/supabase-js"
import { EphemeralChatChannelProvider, useChatChannel } from "@/lib/chat"
import { ChatChannel } from "@/components/ui/chat/ChatChannel"
import CurrentRequest from "./currentRequest"
import useAuthState from "@/hooks/useAuthState"
import HelpRequestHistory from "./resolvedRequests"
import HelpRequestForm from "./newRequestForm"

export default function HelpQueuePage() {
    const { queue_id, course_id } = useParams()

    const { query: queue } = useShow<HelpQueue>({
        resource: "help_queues",
        id: Number.parseInt(queue_id as string)
    })
    const { data: requests } = useList<HelpRequest>({
        resource: "help_requests",
        pagination: {
            pageSize: 1000
        },
        filters: [
            {
                field: "class_id",
                operator: "eq",
                value: Number.parseInt(course_id as string)
            }
        ],
    })
    if (queue.isLoading || !requests || requests?.isLoading) {
        return <div>Loading...</div>
    }
    if (queue.error) {
        return <div>Error: {queue.error.message}</div>
    }
    const unResolvedRequest = requests?.data?.filter((request) => !request.resolved_by)
    return <Box>
        <EphemeralChatChannelProvider queue_id={queue.data?.data.id} class_id={queue.data?.data.class_id}>
            <Heading>Help Queue: {queue.data?.data.name}</Heading>
            <Tabs.Root 
            size='md' orientation="vertical" defaultValue="current">
                <Tabs.List>
                    <Tabs.Trigger value="current">Current Request</Tabs.Trigger>
                    <Tabs.Trigger value="past">Previous Requests</Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content width="100%" value="current">
                    {unResolvedRequest && unResolvedRequest.length > 0 &&
                        <CurrentRequest queue={queue.data?.data} request={unResolvedRequest?.[0]} />
                    }
                    {!unResolvedRequest || unResolvedRequest.length === 0 && <HelpRequestForm />}
                </Tabs.Content>
                <Tabs.Content width="100%" value="past">
                    {requests && <HelpRequestHistory queue={queue.data?.data} requests={requests.data.filter((request) => request.resolved_by)}/>}
                </Tabs.Content>
                <Tabs.Indicator />
            </Tabs.Root>
        </EphemeralChatChannelProvider>
    </Box>
}
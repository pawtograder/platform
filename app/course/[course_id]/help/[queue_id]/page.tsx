"use client";

import { EphemeralChatChannelProvider } from "@/lib/chat";
import { HelpQueue, HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, Tabs } from "@chakra-ui/react";
import { useList, useShow } from "@refinedev/core";
import { useParams } from "next/navigation";
import CurrentRequest from "./currentRequest";
import HelpRequestForm from "./newRequestForm";
import HelpRequestHistory from "./resolvedRequests";

export default function HelpQueuePage() {
  const { queue_id, course_id } = useParams();

  const { query: queue } = useShow<HelpQueue>({
    resource: "help_queues",
    id: Number.parseInt(queue_id as string)
  });
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
    ]
  });
  if (queue.isLoading || !requests || requests?.isLoading) {
    return <div>Loading...</div>;
  }
  if (queue.error) {
    return <div>Error: {queue.error.message}</div>;
  }
  const unResolvedRequest = requests?.data?.filter((request) => !request.resolved_by);
  return (
    <Box>
      <EphemeralChatChannelProvider queue_id={queue.data?.data.id} class_id={queue.data?.data.class_id}>
        <Heading>Help Queue: {queue.data?.data.name}</Heading>
        <Tabs.Root size="md" orientation="vertical" defaultValue="current">
          <Tabs.List>
            <Tabs.Trigger value="current">Current Request</Tabs.Trigger>
            <Tabs.Trigger value="past">Previous Requests</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content width="100%" value="current">
            {unResolvedRequest && unResolvedRequest.length > 0 && (
              <CurrentRequest queue={queue.data?.data} request={unResolvedRequest?.[0]} />
            )}
            {!unResolvedRequest || (unResolvedRequest.length === 0 && <HelpRequestForm />)}
          </Tabs.Content>
          <Tabs.Content width="100%" value="past">
            {requests && (
              <HelpRequestHistory
                queue={queue.data?.data}
                requests={requests.data.filter((request) => request.resolved_by)}
              />
            )}
          </Tabs.Content>
          <Tabs.Indicator />
        </Tabs.Root>
      </EphemeralChatChannelProvider>
    </Box>
  );
}

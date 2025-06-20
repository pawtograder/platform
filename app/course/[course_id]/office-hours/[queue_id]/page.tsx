"use client";

import { EphemeralChatChannelProvider } from "@/lib/chat";
import { HelpQueue, HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, Tabs } from "@chakra-ui/react";
import { useList, useShow } from "@refinedev/core";
import { useParams } from "next/navigation";
import CurrentRequest from "./currentRequest";
import HelpRequestForm from "./newRequestForm";
import HelpRequestHistory from "./resolvedRequests";
import { useClassProfiles } from "@/hooks/useClassProfiles";

export default function HelpQueuePage() {
  const { queue_id, course_id } = useParams();
  const { private_profile_id } = useClassProfiles();

  const { query: queue } = useShow<HelpQueue>({
    resource: "help_queues",
    id: Number.parseInt(queue_id as string)
  });
  const { data: allRequests } = useList<HelpRequest>({
    resource: "help_requests",
    pagination: {
      pageSize: 1000
    },
    filters: [
      {
        field: "class_id",
        operator: "eq",
        value: Number.parseInt(course_id as string)
      },
      {
        field: "creator",
        operator: "eq",
        value: private_profile_id
      }
    ]
  });
  const { data: currentRequestData } = useList<HelpRequest>({
    resource: "help_requests",
    pagination: { pageSize: 1 },
    filters: [
      { field: "help_queue", operator: "eq", value: Number.parseInt(queue_id as string) },
      { field: "creator", operator: "eq", value: private_profile_id },
      { field: "resolved_by", operator: "null", value: null }
    ],
    sorters: [{ field: "created_at", order: "desc" }]
  });

  // Fetch recent public requests in this queue for students to see similar questions
  const { data: publicRequests } = useList<HelpRequest>({
    resource: "help_requests",
    pagination: { pageSize: 50 },
    filters: [
      { field: "help_queue", operator: "eq", value: Number.parseInt(queue_id as string) },
      { field: "is_private", operator: "eq", value: false },
      { field: "resolved_by", operator: "nnull", value: null }
    ],
    sorters: [{ field: "resolved_at", order: "desc" }]
  });

  if (
    queue.isLoading ||
    !allRequests ||
    allRequests?.isLoading ||
    !currentRequestData ||
    currentRequestData?.isLoading
  ) {
    return <div>Loading...</div>;
  }
  if (queue.error) {
    return <div>Error: {queue.error.message}</div>;
  }

  const currentRequest = currentRequestData?.data?.[0] || null;
  const resolvedRequests = allRequests?.data?.filter((request) => request.resolved_by) || [];
  const recentPublicRequests = publicRequests?.data || [];

  return (
    <Box>
      <EphemeralChatChannelProvider queue_id={queue.data?.data.id} class_id={queue.data?.data.class_id}>
        <Heading>Help Queue: {queue.data?.data.name}</Heading>
        <Tabs.Root size="md" orientation="vertical" defaultValue="current">
          <Tabs.List>
            <Tabs.Trigger value="current">Current Request</Tabs.Trigger>
            <Tabs.Trigger value="similar">Similar Questions</Tabs.Trigger>
            <Tabs.Trigger value="past">Previous Requests</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content width="100%" value="current">
            {currentRequest && <CurrentRequest queue={queue.data?.data} request={currentRequest} />}
            {!currentRequest && <HelpRequestForm />}
          </Tabs.Content>
          <Tabs.Content width="100%" value="similar">
            <HelpRequestHistory requests={recentPublicRequests} />
          </Tabs.Content>
          <Tabs.Content width="100%" value="past">
            <HelpRequestHistory requests={resolvedRequests} />
          </Tabs.Content>
          <Tabs.Indicator />
        </Tabs.Root>
      </EphemeralChatChannelProvider>
    </Box>
  );
}

"use client";

import { HelpQueue, HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, Tabs } from "@chakra-ui/react";
import { useList, useShow } from "@refinedev/core";
import { useParams } from "next/navigation";
import CurrentRequest from "./currentRequest";
import HelpRequestForm from "./newRequestForm";
import HelpRequestHistory from "./requestList";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import ModerationBanNotice from "@/components/ui/moderation-ban-notice";

export default function HelpQueuePage() {
  const { queue_id, course_id } = useParams();
  const { private_profile_id } = useClassProfiles();

  const { query: queue } = useShow<HelpQueue>({
    resource: "help_queues",
    id: Number.parseInt(queue_id as string)
  });

  // Fetch all requests by this user in this class
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

  // Fetch current active request in this specific queue
  const { data: currentRequestData } = useList<HelpRequest>({
    resource: "help_requests",
    pagination: { pageSize: 1 },
    filters: [
      { field: "help_queue", operator: "eq", value: Number.parseInt(queue_id as string) },
      { field: "creator", operator: "eq", value: private_profile_id },
      { field: "status", operator: "in", value: ["open", "in_progress"] }
    ],
    sorters: [{ field: "created_at", order: "desc" }]
  });

  // Fetch recent resolved/closed public requests in this queue for students to see similar questions
  const { data: publicRequests } = useList<HelpRequest>({
    resource: "help_requests",
    pagination: { pageSize: 50 },
    filters: [
      { field: "help_queue", operator: "eq", value: Number.parseInt(queue_id as string) },
      { field: "is_private", operator: "eq", value: false },
      { field: "status", operator: "in", value: ["resolved", "closed"] }
    ],
    sorters: [{ field: "resolved_at", order: "desc" }]
  });

  // Fetch all currently active requests in this queue (for queue status) - ordered by creation time (oldest first)
  const { data: queueRequests } = useList<HelpRequest>({
    resource: "help_requests",
    pagination: { pageSize: 100 },
    filters: [
      { field: "help_queue", operator: "eq", value: Number.parseInt(queue_id as string) },
      { field: "status", operator: "in", value: ["open", "in_progress"] }
    ],
    sorters: [{ field: "created_at", order: "asc" }]
  });

  if (
    queue.isLoading ||
    !allRequests ||
    allRequests?.isLoading ||
    !currentRequestData ||
    currentRequestData?.isLoading ||
    !queueRequests ||
    queueRequests?.isLoading
  ) {
    return <div>Loading...</div>;
  }
  if (queue.error) {
    return <div>Error: {queue.error.message}</div>;
  }

  const currentRequest = currentRequestData?.data?.[0] || null;

  // Filter resolved/closed requests for history (both student-resolved and staff-resolved)
  const resolvedRequests =
    allRequests?.data?.filter((request) => request.status === "resolved" || request.status === "closed") || [];

  const pendingRequests = queueRequests?.data || [];

  // Use only resolved public requests for "similar questions" to avoid duplication with queue status
  const recentPublicRequests = publicRequests?.data || [];
  const similarQuestions = recentPublicRequests.filter((request) => request.creator !== private_profile_id); // Don't show user's own requests

  return (
    <ModerationBanNotice classId={Number(course_id)}>
      <Box m={4}>
        <Heading>Help Queue: {queue.data?.data.name}</Heading>
        <Tabs.Root size="md" orientation="vertical" defaultValue={"queue"}>
          <Tabs.List>
            <Tabs.Trigger value="queue">Queue Status ({pendingRequests.length})</Tabs.Trigger>
            {currentRequest && <Tabs.Trigger value="current">My Request</Tabs.Trigger>}
            <Tabs.Trigger value="new-request">Submit Request</Tabs.Trigger>
            <Tabs.Trigger value="similar" textAlign="left">
              Resolved Public Requests From Other Students ({similarQuestions.length})
            </Tabs.Trigger>
            <Tabs.Trigger value="past">My History ({resolvedRequests.length})</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content width="100%" value="queue">
            <HelpRequestHistory requests={pendingRequests} />
          </Tabs.Content>
          {currentRequest && (
            <Tabs.Content width="100%" value="current">
              <CurrentRequest queue={queue.data?.data} request={currentRequest} />
            </Tabs.Content>
          )}
          <Tabs.Content width="100%" value="new-request">
            <HelpRequestForm currentRequest={currentRequest} />
          </Tabs.Content>
          <Tabs.Content width="100%" value="similar">
            <HelpRequestHistory requests={similarQuestions} />
          </Tabs.Content>
          <Tabs.Content width="100%" value="past">
            <HelpRequestHistory requests={resolvedRequests} showPrivacyIndicator={true} />
          </Tabs.Content>
          <Tabs.Indicator />
        </Tabs.Root>
      </Box>
    </ModerationBanNotice>
  );
}

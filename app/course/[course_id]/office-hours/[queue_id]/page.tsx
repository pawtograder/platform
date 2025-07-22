"use client";

import { HelpRequest, HelpRequestStudent } from "@/utils/supabase/DatabaseTypes";
import { useOfficeHoursRealtime } from "@/hooks/useOfficeHoursRealtime";

import { Box, Heading, Tabs } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import CurrentRequest from "./currentRequest";
import HelpRequestForm from "./newRequestForm";
import HelpRequestHistory from "./requestList";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import ModerationBanNotice from "@/components/ui/moderation-ban-notice";
import { useEffect, useState, useMemo } from "react";

export default function HelpQueuePage() {
  const { queue_id, course_id } = useParams();
  const { private_profile_id } = useClassProfiles();
  const searchParams = useSearchParams();
  const router = useRouter();

  // Get active tab from URL params, default to "queue"
  const activeTab = searchParams.get("tab") || "queue";

  // Handle tab change by updating URL
  const handleTabChange = (newTab: string) => {
    const newSearchParams = new URLSearchParams(searchParams);
    newSearchParams.set("tab", newTab);
    router.push(`/course/${course_id}/office-hours/${queue_id}?${newSearchParams.toString()}`);
  };

  const [currentRequest, setCurrentRequest] = useState<HelpRequest | null>(null);

  // Use the enhanced office hours realtime hook for this specific queue
  const { data, isLoading, connectionStatus } = useOfficeHoursRealtime({
    classId: Number(course_id),
    helpQueueId: Number(queue_id),
    enableActiveRequests: true,
    enableGlobalQueues: false, // We only need this specific queue
    enableStaffData: false
  });

  const { helpQueue, activeHelpRequests } = data;

  // Get active requests in this specific queue (filter from activeHelpRequests)
  const queueRequests = useMemo(() => {
    return (activeHelpRequests || [])
      .filter((request) => request.help_queue === Number(queue_id))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()); // Sort by creation time (oldest first)
  }, [activeHelpRequests, queue_id]);

  // Fetch user's help request associations with real-time updates (still needed for user-specific data)
  const { data: userRequestStudents } = useList<HelpRequestStudent>({
    resource: "help_request_students",
    filters: [
      { field: "profile_id", operator: "eq", value: private_profile_id },
      { field: "class_id", operator: "eq", value: Number.parseInt(course_id as string) }
    ],
    pagination: { pageSize: 1000 },
    liveMode: "auto",
    queryOptions: {
      enabled: !!private_profile_id
    }
  });

  // Get the help request IDs for this user
  const userRequestIds = userRequestStudents?.data?.map((student) => student.help_request_id) || [];

  // Fetch the actual help requests for this user with real-time updates
  const { data: userRequestsData } = useList<HelpRequest>({
    resource: "help_requests",
    filters: [
      { field: "id", operator: "in", value: userRequestIds },
      { field: "class_id", operator: "eq", value: Number.parseInt(course_id as string) }
    ],
    sorters: [{ field: "created_at", order: "desc" }],
    pagination: { pageSize: 1000 },
    liveMode: "auto",
    queryOptions: {
      enabled: userRequestIds.length > 0
    }
  });

  const userRequests = useMemo(() => userRequestsData?.data || [], [userRequestsData?.data]);

  // Update current request when user requests change
  useEffect(() => {
    const activeRequestInQueue = userRequests.find(
      (request) =>
        request.help_queue === Number.parseInt(queue_id as string) &&
        (request.status === "open" || request.status === "in_progress")
    );
    setCurrentRequest(activeRequestInQueue || null);
  }, [userRequests, queue_id]);

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

  // Fetch help request students for public requests to filter out user's own requests
  const publicRequestIds = publicRequests?.data?.map((request) => request.id) || [];
  const { data: publicRequestStudents } = useList<HelpRequestStudent>({
    resource: "help_request_students",
    filters: [{ field: "help_request_id", operator: "in", value: publicRequestIds }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      enabled: publicRequestIds.length > 0
    }
  });

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (connectionStatus?.overall === "disconnected") {
    return <div>Connection error. Please try refreshing the page.</div>;
  }

  if (!helpQueue) {
    return <div>Help queue not found.</div>;
  }

  // Filter resolved/closed requests for history (both student-resolved and staff-resolved)
  const resolvedRequests = userRequests.filter(
    (request) => request.status === "resolved" || request.status === "closed"
  );

  const pendingRequests = queueRequests || [];

  // Calculate position of current request in queue
  const currentRequestPosition = currentRequest ? pendingRequests.findIndex((r) => r.id === currentRequest.id) + 1 : 0;

  // Use only resolved public requests for "similar questions" to avoid duplication with queue status
  const recentPublicRequests = publicRequests?.data || [];
  const similarQuestions = recentPublicRequests.filter((request) => {
    // Don't show requests where the current user is associated
    const isUserAssociated = publicRequestStudents?.data?.some(
      (student: HelpRequestStudent) =>
        student.help_request_id === request.id && student.profile_id === private_profile_id
    );
    return !isUserAssociated;
  });

  return (
    <ModerationBanNotice classId={Number(course_id)}>
      <Box m={4}>
        <Heading>Help Queue: {helpQueue.name}</Heading>
        <Tabs.Root
          size="md"
          orientation="vertical"
          value={activeTab}
          onValueChange={(details) => handleTabChange(details.value)}
        >
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
              <CurrentRequest request={currentRequest} position={currentRequestPosition} />
            </Tabs.Content>
          )}
          <Tabs.Content width="100%" value="new-request">
            <HelpRequestForm />
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

"use client";

import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { useOfficeHoursRealtime, useHelpRequests, useHelpRequestStudents } from "@/hooks/useOfficeHoursRealtime";
import { Box, Heading, Tabs } from "@chakra-ui/react";
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

  // Get all help requests and students data from realtime
  const allHelpRequests = useHelpRequests();
  const allHelpRequestStudents = useHelpRequestStudents();

  // Get active requests in this specific queue (filter from activeHelpRequests)
  const queueRequests = useMemo(() => {
    return (activeHelpRequests || [])
      .filter((request) => request.help_queue === Number(queue_id))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()); // Sort by creation time (oldest first)
  }, [activeHelpRequests, queue_id]);

  // Get user's help request associations from realtime data
  const userRequestStudents = useMemo(() => {
    if (!private_profile_id) return [];
    return allHelpRequestStudents.filter(
      (student) => student.profile_id === private_profile_id && student.class_id === Number(course_id)
    );
  }, [allHelpRequestStudents, private_profile_id, course_id]);

  // Get the help request IDs for this user
  const userRequestIds = userRequestStudents.map((student) => student.help_request_id);

  // Get the actual help requests for this user from realtime data
  const userRequests = useMemo(() => {
    if (userRequestIds.length === 0) return [];
    return allHelpRequests
      .filter((request) => userRequestIds.includes(request.id) && request.class_id === Number(course_id))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()); // Sort by creation time (newest first)
  }, [allHelpRequests, userRequestIds, course_id]);

  // Update current request when user requests change
  useEffect(() => {
    const activeRequestInQueue = userRequests.find(
      (request) =>
        request.help_queue === Number.parseInt(queue_id as string) &&
        (request.status === "open" || request.status === "in_progress")
    );
    setCurrentRequest(activeRequestInQueue || null);
  }, [userRequests, queue_id]);

  // Get recent resolved/closed public requests in this queue for students to see similar questions
  const publicRequests = useMemo(() => {
    return allHelpRequests
      .filter(
        (request) =>
          request.help_queue === Number(queue_id) &&
          request.is_private === false &&
          (request.status === "resolved" || request.status === "closed")
      )
      .sort((a, b) => {
        const aTime = a.resolved_at ? new Date(a.resolved_at).getTime() : 0;
        const bTime = b.resolved_at ? new Date(b.resolved_at).getTime() : 0;
        return bTime - aTime; // Sort by resolved time (newest first)
      })
      .slice(0, 50); // Limit to 50 recent requests
  }, [allHelpRequests, queue_id]);

  // Filter public requests to exclude user's own requests
  const similarQuestions = useMemo(() => {
    const publicRequestIds = publicRequests.map((request) => request.id);
    const userAssociatedRequestIds = allHelpRequestStudents
      .filter(
        (student) => student.profile_id === private_profile_id && publicRequestIds.includes(student.help_request_id)
      )
      .map((student) => student.help_request_id);

    return publicRequests.filter((request) => !userAssociatedRequestIds.includes(request.id));
  }, [publicRequests, allHelpRequestStudents, private_profile_id]);

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
            <HelpRequestHistory requests={pendingRequests} readOnly={false} />
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
            <HelpRequestHistory requests={similarQuestions} readOnly={true} />
          </Tabs.Content>
          <Tabs.Content width="100%" value="past">
            <HelpRequestHistory requests={resolvedRequests} showPrivacyIndicator={true} readOnly={true} />
          </Tabs.Content>
          <Tabs.Indicator />
        </Tabs.Root>
      </Box>
    </ModerationBanNotice>
  );
}

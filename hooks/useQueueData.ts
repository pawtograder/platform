import { useMemo } from "react";
import {
  useHelpQueues,
  useHelpRequests,
  useHelpRequestStudents,
  useConnectionStatus
} from "@/hooks/useOfficeHoursRealtime";
import { useClassProfiles } from "@/hooks/useClassProfiles";

interface UseQueueDataParams {
  courseId: number;
  queueId: number;
}

export function useQueueData({ courseId, queueId }: UseQueueDataParams) {
  const { private_profile_id } = useClassProfiles();

  // Use individual hooks for better performance and maintainability
  const allHelpQueues = useHelpQueues();
  const allHelpRequests = useHelpRequests();
  const allHelpRequestStudents = useHelpRequestStudents();
  const { connectionStatus } = useConnectionStatus();

  // Find the specific help queue by ID
  const helpQueue = useMemo(() => {
    return allHelpQueues?.find((queue) => queue.id === queueId) || null;
  }, [allHelpQueues, queueId]);

  // Loading state - true if any required data is missing
  const isLoading = !allHelpQueues || !allHelpRequests || !allHelpRequestStudents;

  // Get active requests in this specific queue
  const queueRequests = useMemo(() => {
    if (!allHelpRequests) return [];
    return allHelpRequests
      .filter(
        (request) => request.help_queue === queueId && (request.status === "open" || request.status === "in_progress")
      )
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }, [allHelpRequests, queueId]);

  // Get user's help request associations from realtime data
  const userRequestStudents = useMemo(() => {
    if (!private_profile_id) return [];
    return allHelpRequestStudents.filter(
      (student) => student.profile_id === private_profile_id && student.class_id === courseId
    );
  }, [allHelpRequestStudents, private_profile_id, courseId]);

  // Get the help request IDs for this user
  const userRequestIds = userRequestStudents.map((student) => student.help_request_id);

  // Get the actual help requests for this user from realtime data
  const userRequests = useMemo(() => {
    if (userRequestIds.length === 0) return [];
    return allHelpRequests
      .filter((request) => userRequestIds.includes(request.id) && request.class_id === courseId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [allHelpRequests, userRequestIds, courseId]);

  // Get current active request in this queue
  const currentRequest = useMemo(() => {
    return userRequests.find(
      (request) => request.help_queue === queueId && (request.status === "open" || request.status === "in_progress")
    );
  }, [userRequests, queueId]);

  // Get recent resolved/closed public requests in this queue
  const publicRequests = useMemo(() => {
    return allHelpRequests
      .filter(
        (request) =>
          request.help_queue === queueId &&
          request.is_private === false &&
          (request.status === "resolved" || request.status === "closed")
      )
      .sort((a, b) => {
        const aTime = a.resolved_at ? new Date(a.resolved_at).getTime() : 0;
        const bTime = b.resolved_at ? new Date(b.resolved_at).getTime() : 0;
        return bTime - aTime;
      })
      .slice(0, 50);
  }, [allHelpRequests, queueId]);

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

  // Filter resolved/closed requests for history
  const resolvedRequests = userRequests.filter(
    (request) => request.status === "resolved" || request.status === "closed"
  );

  return {
    helpQueue,
    queueRequests,
    userRequests,
    currentRequest,
    similarQuestions,
    resolvedRequests,
    isLoading,
    connectionStatus
  };
}

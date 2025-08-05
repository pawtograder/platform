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

/**
 * Custom hook for managing help queue data with support for multi-student help requests.
 *
 * This hook handles scenarios where:
 * - Multiple students can be associated with a single help request (group work)
 * - Students can join or leave existing help requests
 * - Public requests should exclude any request the user is associated with
 * - All user associations (including creators) are tracked via help_request_students
 *
 * @param params - Configuration object containing courseId and queueId
 * @returns Object containing all relevant queue data and loading states
 */
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
    const allForQueue = allHelpRequests.filter((request) => request.help_queue === queueId);

    const filtered = allForQueue
      .filter((request) => request.status === "open" || request.status === "in_progress")
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return filtered;
  }, [allHelpRequests, queueId]);

  // Get user's help request associations from realtime data
  // This handles multi-student requests where multiple students can be associated with one help request
  const userRequestStudents = useMemo(() => {
    if (!private_profile_id) return [];
    return allHelpRequestStudents.filter(
      (student) => student.profile_id === private_profile_id && student.class_id === courseId
    );
  }, [allHelpRequestStudents, private_profile_id, courseId]);

  // Get the help request IDs for this user (memoized to prevent unnecessary re-renders)
  const userRequestIds = useMemo(() => {
    return userRequestStudents.map((student) => student.help_request_id);
  }, [userRequestStudents]);

  // Get the actual help requests for this user from realtime data
  // This includes all requests where the user is associated (both created and collaborated on)
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
  // This properly handles multi-student requests by checking if the user is associated with any public request
  const similarQuestions = useMemo(() => {
    if (!private_profile_id) return publicRequests;

    // Create a Set of request IDs where the current user is associated for efficient lookup
    const userAssociatedRequestIds = new Set(
      allHelpRequestStudents
        .filter((student) => student.profile_id === private_profile_id)
        .map((student) => student.help_request_id)
    );

    // Filter out requests where the user is associated, regardless of other students on the same request
    return publicRequests.filter((request) => !userAssociatedRequestIds.has(request.id));
  }, [publicRequests, allHelpRequestStudents, private_profile_id]);

  // Get information about other students associated with the user's requests
  // This is useful for showing collaborators on multi-student requests
  const requestCollaborators = useMemo(() => {
    if (!private_profile_id || userRequestIds.length === 0) return new Map();

    const collaboratorsMap = new Map<number, Array<{ profile_id: string; class_id: number }>>();

    userRequestIds.forEach((requestId) => {
      const allStudentsOnRequest = allHelpRequestStudents.filter(
        (student) => student.help_request_id === requestId && student.profile_id !== private_profile_id // Exclude the current user
      );

      if (allStudentsOnRequest.length > 0) {
        collaboratorsMap.set(requestId, allStudentsOnRequest);
      }
    });

    return collaboratorsMap;
  }, [allHelpRequestStudents, private_profile_id, userRequestIds]);

  // Filter resolved/closed requests for history
  const resolvedRequests = useMemo(() => {
    return userRequests.filter((request) => request.status === "resolved" || request.status === "closed");
  }, [userRequests]);

  return {
    helpQueue,
    queueRequests,
    userRequests,
    currentRequest,
    similarQuestions,
    resolvedRequests,
    requestCollaborators,
    userRequestIds,
    isLoading,
    connectionStatus
  };
}

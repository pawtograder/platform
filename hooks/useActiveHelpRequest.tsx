"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { useHelpRequests, useHelpRequestStudents, useHelpQueues } from "@/hooks/useOfficeHoursRealtime";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import type { HelpRequest } from "@/utils/supabase/DatabaseTypes";

export interface ActiveHelpRequestInfo {
  request: HelpRequest;
  queuePosition: number;
  queueName: string;
}

/**
 * Hook to track the current user's active help request and calculate their queue position.
 * Returns null if no active request exists or if user is currently viewing the request page.
 */
export function useActiveHelpRequest() {
  const { private_profile_id } = useClassProfiles();
  const pathname = usePathname();
  const allHelpRequests = useHelpRequests();
  const allHelpRequestStudents = useHelpRequestStudents();
  const allHelpQueues = useHelpQueues();

  // Check if we're currently on a help request detail page
  // Pattern: /course/[course_id]/office-hours/[queue_id]/[request_id]
  const isOnRequestPage = useMemo(() => {
    if (!pathname) return false;
    return /\/office-hours\/[^/]+\/\d+$/.test(pathname);
  }, [pathname]);

  // Find user's active help requests
  const activeRequest = useMemo<ActiveHelpRequestInfo | null>(() => {
    if (!private_profile_id || isOnRequestPage) return null;

    // Find all help requests where user is associated
    const userRequestIds = allHelpRequestStudents
      .filter((student) => student.profile_id === private_profile_id)
      .map((student) => student.help_request_id);

    if (userRequestIds.length === 0) return null;

    // Find active requests (open or in_progress)
    const activeRequests = allHelpRequests.filter(
      (request) =>
        userRequestIds.includes(request.id) && (request.status === "open" || request.status === "in_progress")
    );

    if (activeRequests.length === 0) return null;

    // For now, return the first active request (could be enhanced to handle multiple)
    const request = activeRequests[0];

    // Calculate queue position
    const queueRequests = allHelpRequests
      .filter((r) => r.help_queue === request.help_queue && (r.status === "open" || r.status === "in_progress"))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    const position = queueRequests.findIndex((r) => r.id === request.id) + 1;

    const queue = allHelpQueues.find((q) => q.id === request.help_queue);

    return {
      request,
      queuePosition: position,
      queueName: queue?.name || "Queue"
    };
  }, [private_profile_id, allHelpRequests, allHelpRequestStudents, allHelpQueues, isOnRequestPage]);

  return activeRequest;
}

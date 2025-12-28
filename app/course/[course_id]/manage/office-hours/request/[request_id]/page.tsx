"use client";

import HelpRequestChat from "@/components/help-queue/help-request-chat";
import { useCourseController } from "@/hooks/useCourseController";
import { useHelpRequest } from "@/hooks/useOfficeHoursRealtime";
import { Skeleton } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Main page component for displaying and managing a help request
 * Sidebar is rendered in the layout for persistence across navigation
 * @returns JSX element for the help request page
 */
export default function HelpRequestPage() {
  const { request_id } = useParams();

  // Get help request data
  const request = useHelpRequest(Number(request_id));
  const course = useCourseController();

  const title = (() => {
    try {
      const c = course.course; // may throw until loaded
      return `${c.course_title || c.name} - Office Hours #${request_id} - Pawtograder`;
    } catch {
      return undefined;
    }
  })();

  useEffect(() => {
    if (title) {
      document.title = title;
    }
  }, [title]);

  if (!request) {
    return <Skeleton height="100%" />;
  }

  return <HelpRequestChat request_id={request.id} />;
}

"use client";

import { OfficeHoursHeader, type OfficeHoursViewMode } from "@/components/help-queue/office-hours-header";
import { useCourseController } from "@/hooks/useCourseController";
import { Box } from "@chakra-ui/react";
import { useEffect, useMemo } from "react";
import { useParams, usePathname } from "next/navigation";
import { useHelpQueue, useHelpRequests } from "@/hooks/useOfficeHoursRealtime";

export default function HelpManageLayoutClient({ children }: Readonly<{ children: React.ReactNode }>) {
  const { course_id, request_id, queue_id } = useParams();
  const courseController = useCourseController();
  const pathname = usePathname();

  const officeHoursBaseHref = `/course/${course_id}/manage/office-hours`;

  // Get current request if viewing one
  const requestId = request_id ? Number.parseInt(request_id as string) : null;
  const allHelpRequests = useHelpRequests();
  const currentRequestData = useMemo(() => {
    if (!requestId) return undefined;
    return allHelpRequests.find((r) => r.id === requestId);
  }, [allHelpRequests, requestId]);

  const helpQueue = useHelpQueue(queue_id ? Number(queue_id) : currentRequestData?.help_queue || undefined);
  const currentRequest = useMemo(() => {
    if (!currentRequestData || !helpQueue) return undefined;
    return {
      id: currentRequestData.id,
      queueName: helpQueue.name
    };
  }, [currentRequestData, helpQueue]);

  const mode = useMemo<OfficeHoursViewMode>(() => {
    if (!pathname) return "working";

    // Determine mode based on pathname
    if (pathname === officeHoursBaseHref || pathname === `${officeHoursBaseHref}/`) {
      return "working"; // default/root page
    }
    if (pathname.startsWith(`${officeHoursBaseHref}/all-requests`)) {
      return "all-requests";
    }
    if (pathname.startsWith(`${officeHoursBaseHref}/settings`)) {
      return "settings";
    }
    if (request_id) {
      return "working"; // viewing a request
    }
    return "working"; // default to working
  }, [pathname, officeHoursBaseHref, request_id]);

  useEffect(() => {
    document.title = `${courseController.course.name} - Office Hours`;
  }, [courseController.course.name]);

  return (
    <Box height="100dvh" overflow="hidden" display="flex" flexDirection="column">
      <OfficeHoursHeader
        mode={mode}
        officeHoursBaseHref={officeHoursBaseHref}
        currentRequest={currentRequest}
        isManageMode={true}
      />
      <Box flex="1" minH="0" overflow="auto" px={{ base: 3, md: 6 }} py={{ base: 3, md: 6 }}>
        {children}
      </Box>
    </Box>
  );
}

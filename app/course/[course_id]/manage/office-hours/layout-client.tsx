"use client";

import { OfficeHoursHeader, type OfficeHoursViewMode } from "@/components/help-queue/office-hours-header";
import { HelpRequestSidebar } from "@/components/help-queue/help-request-sidebar";
import { useCourseController } from "@/hooks/useCourseController";
import { Box, Flex, useBreakpointValue } from "@chakra-ui/react";
import { useEffect, useMemo, useState, useCallback } from "react";
import { useParams, usePathname } from "next/navigation";
import { useHelpQueue, useHelpRequests } from "@/hooks/useOfficeHoursRealtime";

export default function HelpManageLayoutClient({ children }: Readonly<{ children: React.ReactNode }>) {
  const { course_id, request_id, queue_id } = useParams();
  const courseController = useCourseController();
  const pathname = usePathname();

  // Sidebar state - persists across request navigation
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isDesktop = useBreakpointValue({ base: false, lg: true }) ?? false;
  const showFullSidebar = isDesktop && sidebarOpen;

  const handleSidebarToggle = useCallback(() => {
    if (!isDesktop) return;
    setSidebarOpen((prev) => !prev);
  }, [isDesktop]);

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

  // Show sidebar only when viewing a specific request
  const showSidebar = !!requestId;

  useEffect(() => {
    try {
      const name = courseController.course.name;
      document.title = `${name} - Office Hours`;
    } catch {
      // Course not loaded yet, do nothing
      return;
    }
  }, [courseController.course.name]);

  return (
    <Box height="100dvh" overflow="hidden" display="flex" flexDirection="column">
      <OfficeHoursHeader
        mode={mode}
        officeHoursBaseHref={officeHoursBaseHref}
        currentRequest={currentRequest}
        isManageMode={true}
      />
      <Flex flex="1" minH="0" overflow="hidden" px={{ base: 2, md: 3 }} py={{ base: 2, md: 2 }} gap={2}>
        {showSidebar && (
          <Box
            flexShrink={0}
            width={{ base: "44px", lg: showFullSidebar ? "280px" : "44px" }}
            transition="width 0.2s ease-in-out"
          >
            <HelpRequestSidebar
              requestId={requestId}
              isOpen={showFullSidebar}
              onToggle={handleSidebarToggle}
              queueId={queue_id ? Number(queue_id) : currentRequestData?.help_queue}
              isManageMode={true}
            />
          </Box>
        )}
        <Box flex="1" minW={0} overflow="hidden">
          {children}
        </Box>
      </Flex>
    </Box>
  );
}

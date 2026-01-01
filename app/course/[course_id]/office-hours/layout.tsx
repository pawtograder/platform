"use client";

import { OfficeHoursHeader, type OfficeHoursViewMode } from "@/components/help-queue/office-hours-header";
import ModerationBanNotice from "@/components/ui/moderation-ban-notice";
import { ClassProfileProvider } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { useHelpQueue, useHelpRequests } from "@/hooks/useOfficeHoursRealtime";
import { Box } from "@chakra-ui/react";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";

const OfficeHoursLayout = ({ children }: Readonly<{ children: React.ReactNode }>) => {
  const { course_id, queue_id, request_id } = useParams();
  const courseController = useCourseController();
  const searchParams = useSearchParams();

  const officeHoursBaseHref = `/course/${course_id}/office-hours`;

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
      queueName: helpQueue.name,
      queueId: currentRequestData.help_queue
    };
  }, [currentRequestData, helpQueue]);

  const mode = useMemo<OfficeHoursViewMode>(() => {
    const v = searchParams.get("view");
    if (v === "browse") return "browse";
    if (v === "my-requests") return "my-requests";
    // Default based on pathname
    if (request_id) return "browse"; // viewing a request
    if (queue_id) return "browse"; // viewing a queue
    return "browse"; // default to browse
  }, [searchParams, request_id, queue_id]);

  useEffect(() => {
    if (courseController?.course?.name) {
      document.title = `${courseController.course.name} - Office Hours`;
    }
  }, [courseController?.course?.name]);

  return (
    <ClassProfileProvider>
      <ModerationBanNotice classId={Number(course_id)}>
        <Box height="100dvh" overflow="hidden" display="flex" flexDirection="column">
          <OfficeHoursHeader
            mode={mode}
            officeHoursBaseHref={officeHoursBaseHref}
            currentRequest={currentRequest}
            isManageMode={false}
          />
          <Box flex="1" minH="0" overflow="auto" px={{ base: 3, md: 6 }} py={{ base: 3, md: 6 }}>
            {children}
          </Box>
        </Box>
      </ModerationBanNotice>
    </ClassProfileProvider>
  );
};

export default OfficeHoursLayout;

"use client";

import { useParams } from "next/navigation";
import CurrentRequest from "../currentRequest";
import { useQueueData } from "@/hooks/useQueueData";
import { useMemo, useState } from "react";
import { Box, Flex, useBreakpointValue } from "@chakra-ui/react";
import { HelpRequestSidebar } from "@/components/help-queue/help-request-sidebar";

export default function RequestDetailPage() {
  const { queue_id, course_id, request_id } = useParams();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const isDesktop = useBreakpointValue({ base: false, lg: true }) ?? false;
  const showFullSidebar = isDesktop && sidebarOpen;

  const { queueRequests, userRequests } = useQueueData({
    courseId: Number(course_id),
    queueId: Number(queue_id)
  });

  // Find the specific request - could be from user's requests or queue requests
  const request = useMemo(() => {
    const requestIdNum = Number(request_id);
    return userRequests.find((req) => req.id === requestIdNum) || queueRequests.find((req) => req.id === requestIdNum);
  }, [userRequests, queueRequests, request_id]);

  // Calculate position in queue for active requests
  const position = useMemo(() => {
    if (!request || (request.status !== "open" && request.status !== "in_progress")) {
      return 0;
    }
    return queueRequests.findIndex((r) => r.id === request.id) + 1;
  }, [request, queueRequests]);

  if (!request) {
    return <div>Request not found.</div>;
  }

  return (
    <Flex direction="row" gap={{ base: 3, lg: 6 }} align="stretch">
      <Box
        flex={{ lg: showFullSidebar ? 4 : "unset" }}
        width={{ base: "52px", lg: showFullSidebar ? "auto" : "52px" }}
        minW={0}
      >
        <HelpRequestSidebar
          requestId={Number(request_id)}
          isOpen={showFullSidebar}
          onToggle={() => {
            if (!isDesktop) return;
            setSidebarOpen((v) => !v);
          }}
          queueId={Number(queue_id)}
          isManageMode={false}
        />
      </Box>
      <Box flex={{ lg: 8 }} minW={0}>
        <CurrentRequest request={request} position={position} />
      </Box>
    </Flex>
  );
}

"use client";

import { useParams } from "next/navigation";
import HelpRequestHistory from "../requestList";
import { Box } from "@chakra-ui/react";
import { useQueueData } from "@/hooks/useQueueData";

export default function RequestHistoryPage() {
  const { queue_id, course_id } = useParams();

  const { resolvedRequests, requestCollaborators, userRequestIds } = useQueueData({
    courseId: Number(course_id),
    queueId: Number(queue_id)
  });

  return (
    <Box w={{ base: "auto", md: "full" }} maxW={{ base: "md", md: "full" }} mx={{ base: "auto", md: 0 }}>
      <HelpRequestHistory
        requests={resolvedRequests}
        showPrivacyIndicator={true}
        readOnly={true}
        requestCollaborators={requestCollaborators}
        userRequestIds={userRequestIds}
        sortOrder="newest"
      />
    </Box>
  );
}

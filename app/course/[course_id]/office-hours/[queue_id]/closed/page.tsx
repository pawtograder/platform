"use client";

import { useParams } from "next/navigation";
import HelpRequestHistory from "../requestList";
import { Box } from "@chakra-ui/react";
import { useQueueData } from "@/hooks/useQueueData";

export default function ClosedRequestsPage() {
  const { queue_id, course_id } = useParams();

  const { similarQuestions, requestCollaborators, userRequestIds } = useQueueData({
    courseId: Number(course_id),
    queueId: Number(queue_id)
  });

  return (
    <Box w={{ base: "auto", md: "full" }} maxW={{ base: "md", md: "full" }} mx={{ base: "auto", md: 0 }}>
      <HelpRequestHistory
        requests={similarQuestions}
        readOnly={true}
        requestCollaborators={requestCollaborators}
        userRequestIds={userRequestIds}
      />
    </Box>
  );
}

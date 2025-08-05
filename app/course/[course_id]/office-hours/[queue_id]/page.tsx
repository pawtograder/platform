"use client";

import { useParams } from "next/navigation";
import HelpRequestHistory from "./requestList";
import { useQueueData } from "@/hooks/useQueueData";

export default function QueueStatusPage() {
  const { queue_id, course_id } = useParams();

  const { queueRequests, requestCollaborators, userRequestIds } = useQueueData({
    courseId: Number(course_id),
    queueId: Number(queue_id)
  });

  return (
    <HelpRequestHistory
      requests={queueRequests}
      readOnly={false}
      requestCollaborators={requestCollaborators}
      userRequestIds={userRequestIds}
    />
  );
}

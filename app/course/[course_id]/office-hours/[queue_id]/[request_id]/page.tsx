"use client";

import { useParams } from "next/navigation";
import CurrentRequest from "../currentRequest";
import { useQueueData } from "@/hooks/useQueueData";
import { useMemo } from "react";

export default function RequestDetailPage() {
  const { queue_id, course_id, request_id } = useParams();

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

  return <CurrentRequest request={request} position={position} />;
}

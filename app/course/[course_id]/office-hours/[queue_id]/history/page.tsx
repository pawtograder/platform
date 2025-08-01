"use client";

import { useParams } from "next/navigation";
import HelpRequestHistory from "../requestList";
import { useQueueData } from "@/hooks/useQueueData";

export default function RequestHistoryPage() {
  const { queue_id, course_id } = useParams();

  const { resolvedRequests } = useQueueData({
    courseId: Number(course_id),
    queueId: Number(queue_id)
  });

  return <HelpRequestHistory requests={resolvedRequests} showPrivacyIndicator={true} readOnly={true} />;
}

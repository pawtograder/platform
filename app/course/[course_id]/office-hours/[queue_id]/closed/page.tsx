"use client";

import { useParams } from "next/navigation";
import HelpRequestHistory from "../requestList";
import { useQueueData } from "@/hooks/useQueueData";

export default function ClosedRequestsPage() {
  const { queue_id, course_id } = useParams();

  const { similarQuestions } = useQueueData({
    courseId: Number(course_id),
    queueId: Number(queue_id)
  });

  return <HelpRequestHistory requests={similarQuestions} readOnly={true} />;
}

"use client";

import { useParams } from "next/navigation";
import TimeTrackingDashboard from "./_components/TimeTrackingDashboard";

export default function TimeTrackingPage() {
  const { course_id } = useParams();
  const courseId = Number(course_id);

  return <TimeTrackingDashboard courseId={courseId} />;
}

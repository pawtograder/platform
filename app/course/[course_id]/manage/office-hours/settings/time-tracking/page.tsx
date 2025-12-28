"use client";

import { useParams, useRouter } from "next/navigation";
import React, { useMemo, useEffect } from "react";
import TimeTrackingDashboard from "../../time-tracking/_components/TimeTrackingDashboard";

export default function TimeTrackingSettingsPage() {
  const { course_id } = useParams();
  const router = useRouter();

  // Validate and parse course_id
  const courseId = useMemo(() => {
    if (!course_id || typeof course_id !== "string") {
      return null;
    }
    // Check if it's a valid numeric string
    if (!/^\d+$/.test(course_id)) {
      return null;
    }
    const parsed = Number.parseInt(course_id, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }, [course_id]);

  // Redirect if course_id is invalid
  useEffect(() => {
    if (courseId === null) {
      router.replace("/");
    }
  }, [courseId, router]);

  // Conditional render if course_id is invalid
  if (courseId === null) {
    return null;
  }

  return <TimeTrackingDashboard courseId={courseId} />;
}

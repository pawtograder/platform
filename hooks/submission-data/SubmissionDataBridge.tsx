"use client";

import React, { useMemo } from "react";
import { useCourseController } from "@/hooks/useCourseController";
import { SubmissionDataProvider } from "./useSubmissionDataContext";
import type { PawtograderRealTimeController } from "@/lib/PawtograderRealTimeController";
import { useParams } from "next/navigation";

export function SubmissionDataBridge({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const courseController = useCourseController();

  const submissionId = Number(params.submissions_id);
  const courseId = Number(params.course_id);

  let classRtc: PawtograderRealTimeController | null = null;
  try {
    classRtc = courseController.classRealTimeController;
  } catch {
    // Not yet initialized
  }

  // Use the same supabase client as the course controller for consistency
  const supabase = courseController.client;

  const value = useMemo(
    () => ({
      submissionId,
      courseId,
      supabase,
      classRtc
    }),
    [submissionId, courseId, supabase, classRtc]
  );

  return <SubmissionDataProvider value={value}>{children}</SubmissionDataProvider>;
}

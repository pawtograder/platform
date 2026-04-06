"use client";

import React, { useMemo } from "react";
import { useCourseController } from "@/hooks/useCourseController";
import { AssignmentDataProvider } from "./useAssignmentDataContext";
import type { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import { useParams } from "next/navigation";

export function AssignmentDataBridge({
  children,
  assignmentId: assignmentIdProp
}: {
  children: React.ReactNode;
  assignmentId?: number;
}) {
  const params = useParams();
  const controller = useCourseController();
  const assignmentId = assignmentIdProp ?? Number(params.assignment_id);

  let classRtc: ClassRealTimeController | null = null;
  try {
    classRtc = controller.classRealTimeController;
  } catch {
    // Not yet initialized
  }

  const profileId = classRtc?.profileId ?? null;
  const isStaff = controller.role === "instructor" || controller.role === "grader";

  const value = useMemo(
    () => ({
      assignmentId,
      courseId: controller.courseId,
      profileId,
      supabase: controller.client,
      classRtc,
      isStaff
    }),
    [assignmentId, controller.courseId, controller.client, profileId, classRtc, isStaff]
  );

  return <AssignmentDataProvider value={value}>{children}</AssignmentDataProvider>;
}

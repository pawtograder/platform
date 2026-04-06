"use client";

import React, { useMemo } from "react";
import { useCourseController } from "@/hooks/useCourseController";
import { AssignmentDataProvider } from "./useAssignmentDataContext";
import type { AssignmentControllerInitialData } from "@/lib/ssrUtils";
import type { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import { useParams } from "next/navigation";

export function AssignmentDataBridge({
  children,
  assignmentId: assignmentIdProp,
  initialData
}: {
  children: React.ReactNode;
  assignmentId?: number;
  initialData?: AssignmentControllerInitialData;
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
      isStaff,
      initialData
    }),
    [assignmentId, controller.courseId, controller.client, profileId, classRtc, isStaff, initialData]
  );

  return <AssignmentDataProvider value={value}>{children}</AssignmentDataProvider>;
}

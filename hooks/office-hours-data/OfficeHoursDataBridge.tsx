"use client";

import React, { useMemo } from "react";
import { useCourseController } from "@/hooks/useCourseController";
import { useOfficeHoursController } from "@/hooks/useOfficeHoursRealtime";
import { OfficeHoursDataProvider } from "./useOfficeHoursDataContext";
import type { PawtograderRealTimeController } from "@/lib/PawtograderRealTimeController";

export function OfficeHoursDataBridge({ children }: { children: React.ReactNode }) {
  const courseController = useCourseController();
  const ohController = useOfficeHoursController();

  let classRtc: PawtograderRealTimeController | null = null;
  try {
    classRtc = courseController.classRealTimeController;
  } catch {
    // Not yet initialized
  }

  let officeHoursRtc: PawtograderRealTimeController | null = null;
  try {
    officeHoursRtc = ohController.officeHoursRealTimeController;
  } catch {
    // Not yet initialized
  }

  const value = useMemo(
    () => ({
      classId: ohController.classId,
      supabase: courseController.client,
      classRtc,
      officeHoursRtc
    }),
    [ohController.classId, courseController.client, classRtc, officeHoursRtc]
  );

  return <OfficeHoursDataProvider value={value}>{children}</OfficeHoursDataProvider>;
}

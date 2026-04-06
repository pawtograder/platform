"use client";

/**
 * Bridge component that reads from the legacy CourseController context and
 * provides the same values to the new CourseDataProvider (TanStack Query path).
 *
 * SSR data is now delivered via TanStack Query's HydrationBoundary (wrapping the
 * layout tree), so this bridge no longer needs an initialData prop.
 *
 * This lets both old and new hooks coexist during the incremental migration.
 * Once all consumers are migrated, this bridge and the old CourseController
 * can be deleted.
 */

import React, { useMemo } from "react";
import { useCourseController } from "@/hooks/useCourseController";
import { CourseDataProvider } from "./useCourseDataContext";
import useAuthState from "@/hooks/useAuthState";

export function CourseDataBridge({ children }: { children: React.ReactNode }) {
  const controller = useCourseController();
  const { user } = useAuthState();

  // The controller always exists (even for follower tabs that haven't started
  // class-wide channels), so this access is safe without try/catch.
  const classRtc = controller.classRealTimeController;

  const userId = user?.id ?? "";
  const profileId = classRtc?.profileId ?? null;
  const isStaff = controller.role === "instructor" || controller.role === "grader";

  const value = useMemo(
    () => ({
      courseId: controller.courseId,
      role: controller.role,
      userId,
      profileId,
      supabase: controller.client,
      classRtc,
      isStaff
    }),
    [controller.courseId, controller.role, controller.client, userId, profileId, classRtc, isStaff]
  );

  return <CourseDataProvider value={value}>{children}</CourseDataProvider>;
}

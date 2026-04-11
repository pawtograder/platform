"use client";

import { COURSE_FEATURES } from "@/lib/courseFeatures";
import { CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import { useClassProfiles } from "./useClassProfiles";

/**
 * Read a course feature from `classes.features`.
 *
 * @param defaultWhenMissing - When no entry exists for `name`, return this value (opt-in flags use `false`; nav-style flags often use `true`).
 */
export function useCourseFeature(name: string, defaultWhenMissing: boolean): boolean {
  const { role } = useClassProfiles();
  const course = role.classes as CourseWithFeatures;
  const featureFlag = course.features?.find((f) => f.name === name);
  return featureFlag?.enabled ?? defaultWhenMissing;
}

/** Opt-in: student gradebook "What If" is off unless explicitly enabled for the course. */
export function useGradebookWhatIfFeatureEnabled(): boolean {
  return useCourseFeature(COURSE_FEATURES.GRADEBOOK_WHAT_IF, false);
}

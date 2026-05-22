"use client";

import { useCourse } from "@/hooks/useCourseController";
import { COURSE_FEATURES, courseFeatureEnabled, type CourseFeatureName } from "@/lib/courseFeatures";
import { CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";

/**
 * Read a course feature from `classes.features`.
 * Requires `CourseControllerProvider` (via `useCourse()`).
 *
 * @param defaultWhenMissing - When no entry exists for `name`, return this value (opt-in flags use `false`; nav-style flags often use `true`).
 */
export function useCourseFeature(name: CourseFeatureName, defaultWhenMissing: boolean): boolean {
  const course = useCourse() as CourseWithFeatures;
  const featureFlag = course.features?.find((f) => f.name === name);
  return featureFlag?.enabled ?? defaultWhenMissing;
}

/** Nav-style flags: enabled when missing from `classes.features`. Requires CourseControllerProvider. */
export function useFeatureEnabled(feature: CourseFeatureName): boolean {
  const course = useCourse() as CourseWithFeatures;
  return courseFeatureEnabled(course.features, feature);
}

/** Opt-in: student gradebook "What If" is off unless explicitly enabled for the course. */
export function useGradebookWhatIfFeatureEnabled(): boolean {
  return useCourseFeature(COURSE_FEATURES.GRADEBOOK_WHAT_IF, false);
}

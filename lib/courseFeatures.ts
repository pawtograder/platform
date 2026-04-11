/**
 * Canonical names for `classes.features` entries ({ name, enabled }).
 * Add new keys here as course-level flags are introduced.
 */
export const COURSE_FEATURES = {
  GRADEBOOK_WHAT_IF: "gradebook-what-if"
} as const;

export type CourseFeatureName = (typeof COURSE_FEATURES)[keyof typeof COURSE_FEATURES];

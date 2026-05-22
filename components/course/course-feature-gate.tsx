"use client";

import { useCourseFeature } from "@/hooks/useCourseFeatures";
import { courseFeatureDefaultEnabled, type CourseFeatureName } from "@/lib/courseFeatures";

export function CourseFeatureGate({
  feature,
  children,
  defaultWhenMissing = courseFeatureDefaultEnabled(feature)
}: {
  feature: CourseFeatureName;
  children: React.ReactNode;
  defaultWhenMissing?: boolean;
}) {
  const enabled = useCourseFeature(feature, defaultWhenMissing);

  if (!enabled) {
    return null;
  }

  return <>{children}</>;
}

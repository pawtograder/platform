"use client";

import { useCourseController } from "@/hooks/useCourseController";
import { GradebookProvider } from "@/hooks/useGradebook";
import { useEffect } from "react";

export default function GradebookLayout({ children }: { children: React.ReactNode }) {
  const controller = useCourseController();
  useEffect(() => {
    try {
      const courseData = controller?.course;
      if (courseData) {
        document.title = `${courseData.course_title || courseData.name} - Gradebook - Pawtograder`;
      }
    } catch {
      // Course data not available yet, skip setting title
    }
  }, [controller]);
  return <GradebookProvider>{children}</GradebookProvider>;
}

"use client";

import { useCourseController } from "@/hooks/useCourseController";
import { GradebookProvider } from "@/hooks/useGradebook";
import { useEffect } from "react";

export default function GradebookLayout({ children }: { children: React.ReactNode }) {
  const course = useCourseController();
  useEffect(() => {
    if (course?.course) {
      document.title = `${course.course.course_title || course.course.name} - Gradebook - Pawtograder`;
    }
  }, [course?.course]);
  return <GradebookProvider>{children}</GradebookProvider>;
}

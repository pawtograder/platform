"use client";

import { useCourseController } from "@/hooks/useCourseController";
import { GradebookProvider } from "@/hooks/useGradebook";
import { Box } from "@chakra-ui/react";
import { useEffect } from "react";

export default function GradebookLayout({ children }: { children: React.ReactNode }) {
  const course = useCourseController();
  const title = (() => {
    try {
      const c = course.course; // may throw until loaded
      return `${c.course_title || c.name} - Gradebook - Pawtograder`;
    } catch {
      return undefined;
    }
  })();
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
  return (
    <GradebookProvider>
      <Box w="100vw" overflowX="hidden">
        {children}
      </Box>
    </GradebookProvider>
  );
}

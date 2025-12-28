"use client";

import ModerationBanNotice from "@/components/ui/moderation-ban-notice";
import { useCourseController } from "@/hooks/useCourseController";
import { useHelpQueue } from "@/hooks/useOfficeHoursRealtime";
import { Box } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useEffect } from "react";

interface LayoutProps {
  children: React.ReactNode;
}

export default function QueueLayout({ children }: LayoutProps) {
  const { queue_id, course_id } = useParams();
  const helpQueue = useHelpQueue(Number(queue_id));
  const course = useCourseController();

  const title = (() => {
    try {
      const c = course.course; // may throw until loaded
      return `${c.course_title || c.name} - Office Hours - ${helpQueue?.name || ""} - Pawtograder`;
    } catch {
      return undefined;
    }
  })();

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  if (!helpQueue) {
    return <div>Help queue not found.</div>;
  }

  return (
    <ModerationBanNotice classId={Number(course_id)}>
      <Box width="100%" maxW="full">
        {children}
      </Box>
    </ModerationBanNotice>
  );
}

"use client";
import { Box, Heading, Text } from "@chakra-ui/react";
import { useTrackEvent } from "@/hooks/useTrackEvent";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import WhatIf from "./whatIf";

export default function GradebookPage() {
  const { course_id } = useParams();
  const trackEvent = useTrackEvent();

  // Track gradebook view
  useEffect(() => {
    if (course_id) {
      trackEvent("gradebook_viewed", {
        course_id: Number(course_id),
        viewer_role: "student"
      });
    }
  }, [course_id, trackEvent]);

  /*
  To use the &quot;What If&quot; grade
        simulator, click on a score for an assignment, and edit the value. Calculated fields will automatically
        re-calculate, and you can not edit those fields directly.
  */
  return (
    <Box p={4}>
      <Heading size="lg">Gradebook</Heading>
      <Text fontSize="sm" color="fg.muted">
        Grades that have been released by your instructor are shown below.
      </Text>
      <WhatIf />
    </Box>
  );
}

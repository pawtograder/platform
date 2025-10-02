"use client";
import { Box } from "@chakra-ui/react";
import { useTrackEvent } from "@/hooks/useTrackEvent";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import GradebookTable from "./gradebookTable";

export default function GradebookPage() {
  const { course_id } = useParams();
  const trackEvent = useTrackEvent();

  // Track gradebook view
  useEffect(() => {
    if (course_id) {
      trackEvent("gradebook_viewed", {
        course_id: Number(course_id),
        viewer_role: "instructor"
      });
    }
  }, [course_id, trackEvent]);

  return (
    <Box p={0} m={0}>
      <GradebookTable />
    </Box>
  );
}

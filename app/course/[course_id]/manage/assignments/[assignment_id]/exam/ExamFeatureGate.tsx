"use client";

import { useFeatureEnabled } from "@/hooks/useCourseFeatures";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import { Box, Heading, Text, VStack } from "@chakra-ui/react";

/**
 * Hides the paper-exam pages unless the course has turned the feature on.
 *
 * `ManageAssignmentNav` already drops the Exam entry when the flag is off, but the nav only
 * controls what is linked, not what is reachable: the three exam routes are plain pages and a
 * pasted or bookmarked URL still renders them. Most course flags in this repo stop at the nav on
 * purpose -- Gradebook's own description says "you can still open manage URLs directly" -- and
 * that is fine for a feature that already shipped, where the URL leads somewhere that works.
 *
 * Paper exams are not that yet. Until the feature has shipped once, a direct URL should land on
 * this notice rather than on a live upload form that enqueues worker jobs and spends the shared
 * Gemini budget for a course that never opted in.
 */
export function ExamFeatureGate({ children }: { children: React.ReactNode }) {
  const enabled = useFeatureEnabled(COURSE_FEATURES.EXAMS);

  if (!enabled) {
    return (
      <Box p={4}>
        <VStack align="flex-start" gap={2}>
          <Heading size="md">Paper exams are not enabled for this course</Heading>
          <Text fontSize="sm" color="fg.muted">
            An instructor can turn on <strong>Paper exams</strong> under Course Settings &rsaquo; Feature flags to scan,
            OCR and grade paper exams for this course.
          </Text>
        </VStack>
      </Box>
    );
  }

  return <>{children}</>;
}

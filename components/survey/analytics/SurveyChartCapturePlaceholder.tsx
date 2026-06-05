"use client";

import { Box, Text } from "@chakra-ui/react";
import { useLayoutEffect, useRef } from "react";

type SurveyChartCapturePlaceholderProps = {
  label: string;
  height: number;
};

/**
 * Static stand-in for heavy Recharts mounts during WebKit visual captures on the
 * instructor responses page. Marks itself ready so Playwright stabilization does
 * not wait on a .recharts-surface that will never exist.
 */
export function SurveyChartCapturePlaceholder({ label, height }: SurveyChartCapturePlaceholderProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    hostRef.current?.setAttribute("data-survey-chart-ready", "");
  }, []);

  const bodyHeight = Math.max(120, height - 56);

  return (
    <Box
      ref={hostRef}
      w="100%"
      h={`${height}px`}
      borderWidth="1px"
      borderColor="border"
      borderRadius="md"
      p={4}
      bg="bg.subtle"
      data-survey-chart-host=""
      data-survey-chart-placeholder=""
    >
      <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={3}>
        {label}
      </Text>
      <Box w="100%" h={`${bodyHeight}px`} bg="bg.muted" borderRadius="md" borderWidth="1px" borderColor="border" />
    </Box>
  );
}

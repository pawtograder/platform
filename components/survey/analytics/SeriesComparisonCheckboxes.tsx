"use client";

import { Box, Checkbox, HStack, Text } from "@chakra-ui/react";

type SurveyInSeries = { id: string; title?: string | null; due_date?: string | null };

type SeriesComparisonCheckboxesProps = {
  surveysInSeries: SurveyInSeries[];
  surveysToCompare: string[];
  onSurveysToCompareChange: (ids: string[]) => void;
  disabled?: boolean;
};

export function SeriesComparisonCheckboxes({
  surveysInSeries,
  surveysToCompare,
  onSurveysToCompareChange,
  disabled = false
}: SeriesComparisonCheckboxesProps) {
  return (
    <Box borderWidth="1px" borderColor="border" borderRadius="md" p={4}>
      <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={3}>
        Compare across surveys in series
      </Text>
      <HStack gap={4} flexWrap="wrap" mb={4}>
        {surveysInSeries.map((s) => {
          const sid = s.id;
          const checked = surveysToCompare.includes(sid);
          return (
            <Checkbox.Root
              key={sid}
              checked={checked}
              disabled={disabled}
              onCheckedChange={(e) => {
                const v = e.checked as boolean;
                onSurveysToCompareChange(v ? [...surveysToCompare, sid] : surveysToCompare.filter((id) => id !== sid));
              }}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control />
              <Checkbox.Label fontSize="sm">{s.title ?? `Survey ${sid.slice(0, 8)}`}</Checkbox.Label>
            </Checkbox.Root>
          );
        })}
      </HStack>
    </Box>
  );
}

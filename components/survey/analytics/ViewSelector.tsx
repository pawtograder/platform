"use client";

import type { AnalyticsViewMode } from "@/types/survey-analytics";
import { Tabs, Text } from "@chakra-ui/react";

type ViewSelectorProps = {
  value: AnalyticsViewMode;
  onChange: (value: AnalyticsViewMode) => void;
  showMentorOption?: boolean;
};

export function ViewSelector({ value, onChange, showMentorOption = false }: ViewSelectorProps) {
  return (
    <Tabs.Root value={value} onValueChange={(details) => onChange(details.value as AnalyticsViewMode)} variant="line">
      <Tabs.List>
        <Tabs.Trigger value="course">
          <Text>Course Overview</Text>
        </Tabs.Trigger>
        <Tabs.Trigger value="section">
          <Text>By Section</Text>
        </Tabs.Trigger>
        <Tabs.Trigger value="group">
          <Text>By Group</Text>
        </Tabs.Trigger>
        {showMentorOption && (
          <Tabs.Trigger value="mentor">
            <Text>My Groups</Text>
          </Tabs.Trigger>
        )}
      </Tabs.List>
    </Tabs.Root>
  );
}

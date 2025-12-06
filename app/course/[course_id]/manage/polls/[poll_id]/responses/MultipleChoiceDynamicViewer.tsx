"use client";

import { useMemo } from "react";
import { usePollResponseCounts } from "@/hooks/useCourseController";
import PollBarChart from "./PollBarChart";

type MultipleChoiceDynamicViewerProps = {
  pollId: string;
  pollQuestion: JSON;
};

export default function MultipleChoiceDynamicViewer({ pollId, pollQuestion }: MultipleChoiceDynamicViewerProps) {
  // Extract question title for display
  const questionData = pollQuestion as unknown as Record<string, unknown> | null;
  const firstElement = (questionData?.elements as unknown as Array<{ title: string }>)?.[0];
  const questionPrompt = firstElement?.title || "Poll";

  // Get counts directly from hook - all logic is handled internally
  const { counts: choiceCounts } = usePollResponseCounts(pollId, pollQuestion);

  // Transform counts to chart data format
  const chartData = useMemo(() => {
    return Object.entries(choiceCounts).map(([name, value]) => ({
      name,
      value
    }));
  }, [choiceCounts]);

  return <PollBarChart chartData={chartData} questionPrompt={questionPrompt} />;
}

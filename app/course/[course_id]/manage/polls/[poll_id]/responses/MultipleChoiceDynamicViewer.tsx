"use client";

import { useMemo } from "react";
import { usePollResponseCounts } from "@/hooks/useCourseController";
import { Json } from "@/utils/supabase/SupabaseTypes";
import PollBarChart from "./PollBarChart";

type MultipleChoiceDynamicViewerProps = {
  pollId: string;
  pollQuestion: Json;
};

export default function MultipleChoiceDynamicViewer({ pollId, pollQuestion }: MultipleChoiceDynamicViewerProps) {
  // Extract question title for display
  // Type guard: check if pollQuestion is an object (not null, not a primitive)
  const questionData =
    pollQuestion !== null &&
    typeof pollQuestion === "object" &&
    !Array.isArray(pollQuestion)
      ? (pollQuestion as Record<string, Json>)
      : null;
  
  // Type guard: check if elements exists and is an array
  const elements = questionData?.elements;
  const elementsArray = Array.isArray(elements) ? elements : null;
  const firstElement =
    elementsArray && elementsArray.length > 0 && typeof elementsArray[0] === "object" && elementsArray[0] !== null
      ? (elementsArray[0] as Record<string, Json>)
      : null;
  
  const questionPrompt =
    firstElement && typeof firstElement.title === "string" ? firstElement.title : "Poll";

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

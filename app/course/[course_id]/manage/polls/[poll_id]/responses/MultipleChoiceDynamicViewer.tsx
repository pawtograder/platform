"use client";

import { Box, VStack, Heading, Text } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer } from "recharts";
import { useMemo, useState, useEffect } from "react";
import { PollResponseData } from "@/types/poll";
import { getPollAnswer } from "@/utils/pollUtils";
import { Database } from "@/utils/supabase/SupabaseTypes";

type MultipleChoiceDynamicViewerProps = {
  pollQuestion: JSON;
  responses: Database["public"]["Tables"]["live_poll_responses"]["Row"][];
};

export default function MultipleChoiceDynamicViewer({
  pollQuestion,
  responses
}: MultipleChoiceDynamicViewerProps) {
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const tickColor = useColorModeValue("#1A202C", "#FFFFFF");

  // Track viewport dimensions for relative sizing
  const [viewportHeight, setViewportHeight] = useState(0);
  
  useEffect(() => {
    const updateViewportSize = () => {
      setViewportHeight(window.innerHeight);
    };
    
    updateViewportSize();
    window.addEventListener("resize", updateViewportSize);
    return () => window.removeEventListener("resize", updateViewportSize);
  }, []);

  const questionData = pollQuestion as unknown as Record<string, unknown> | null;
  const firstElement = (
    questionData?.elements as unknown as Array<{
      title: string;
      choices: string[] | Array<{ text?: string; label?: string; value?: string }>;
    }>
  )?.[0];
  const questionPrompt = firstElement?.title || "Poll";
  // Handle choices as either string array or object array
  const choicesRaw = firstElement?.choices || [];
  const choices = choicesRaw.map((choice) => {
    if (typeof choice === "string") return choice;
    return choice.text || choice.label || choice.value || String(choice);
  });

  const chartData = useMemo(() => {
    const choiceCounts: Record<string, number> = {};

    choices.forEach((choice) => {
      choiceCounts[choice] = 0;
    });

    responses.forEach((response) => {
      const answer = getPollAnswer(response.response as PollResponseData);

      if (Array.isArray(answer)) {
        answer.forEach((item: string) => {
          if (!item.startsWith("other:") && choiceCounts.hasOwnProperty(item)) {
            choiceCounts[item]++;
          }
        });
      } else if (typeof answer === "string" && !answer.startsWith("other:") && choiceCounts.hasOwnProperty(answer)) {
        choiceCounts[answer]++;
      }
    });

    return Object.entries(choiceCounts).map(([name, value]) => ({
      name,
      value
    }));
  }, [responses, choices]);

  // Calculate max value for X-axis with padding
  const xAxisMax = useMemo(() => {
    if (chartData.length === 0) return 10;

    const maxValue = Math.max(...chartData.map((d) => d.value));

    if (maxValue === 0) return 10;

    // Add 20% padding
    const paddedValue = maxValue * 1.2;

    // Round up to a number based on scale
    if (paddedValue <= 5) {
      return Math.ceil(paddedValue);
    } else if (paddedValue <= 20) {
      return Math.ceil(paddedValue / 5) * 5;
    } else if (paddedValue <= 100) {
      return Math.ceil(paddedValue / 10) * 10;
    } else if (paddedValue <= 500) {
      return Math.ceil(paddedValue / 50) * 50;
    } else {
      return Math.ceil(paddedValue / 100) * 100;
    }
  }, [chartData]);

  // Calculate chart height and bar size relative to viewport
  const chartHeight = useMemo(() => {
    if (viewportHeight === 0) return 500; // fallback for SSR
    // Use 55% of viewport height
    return viewportHeight * 0.55;
  }, [viewportHeight]);

  const barSize = useMemo(() => {
    const numChoices = chartData.length || 1;
    // Calculate bar size based on chart height and number of choices
    // Leave some space between bars (use ~60% of available space per bar)
    const availableHeightPerBar = chartHeight / numChoices;
    const calculatedSize = availableHeightPerBar * 0.6;
    // Clamp between reasonable min/max values relative to viewport
    const minSize = viewportHeight * 0.02 || 20;
    const maxSize = viewportHeight * 0.15 || 150;
    return Math.min(Math.max(calculatedSize, minSize), maxSize);
  }, [chartHeight, chartData.length, viewportHeight]);

  return (
    <VStack align="center" justify="center" gap={4} w="100%">
      <Heading size="2xl" color={textColor} textAlign="center">
        {questionPrompt}
      </Heading>
      <Box w="100%" translate="auto" translateX="-20px">
        <ResponsiveContainer width="100%" height={chartHeight}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 100, top: 0, bottom: 0 }}>
            <XAxis
              type="number"
              tick={{ fill: tickColor, fontSize: 10 }}
              allowDecimals={false}
              domain={[0, xAxisMax]}
              tickFormatter={(value) => (Number.isInteger(value) ? String(value) : "")}
            />
            <YAxis type="category" dataKey="name" tick={{ fill: tickColor, fontSize: 12 }} width={200} />
            <Bar dataKey="value" fill="#3B82F6" barSize={barSize} />
          </BarChart>
        </ResponsiveContainer>
      </Box>
      <Text fontSize="lg" color={textColor} textAlign="center">
        Number of Responses
      </Text>
    </VStack>
  );
}

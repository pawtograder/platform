"use client";

import { useMemo } from "react";
import { Box, Heading, Text, VStack } from "@chakra-ui/react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { useColorModeValue } from "@/components/ui/color-mode";

type PollResponse = {
  id: string;
  live_poll_id: string;
  public_profile_id: string;
  response: Record<string, unknown>;
  submitted_at: string | null;
  is_submitted: boolean;
  created_at: string;
  profile_name: string;
};

type PollAnalyticsChartProps = {
  pollQuestion: Record<string, unknown> | null;
  responses: PollResponse[];
};

export default function PollAnalyticsChart({ pollQuestion, responses }: PollAnalyticsChartProps) {
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const tickColor = useColorModeValue("#1A202C", "#FFFFFF");
  const tooltipBg = useColorModeValue("#FFFFFF", "#1A1A1A");
  const tooltipTextColor = useColorModeValue("#1A202C", "#FFFFFF");

  const chartData = useMemo(() => {
    if (!pollQuestion || responses.length === 0) {
      return [];
    }

    const questionData = pollQuestion as any;
    const submittedResponses = responses.filter((r) => r.is_submitted);

    // Handle multiple-choice and single-choice
    if (questionData?.type === "multiple-choice" || questionData?.type === "single-choice") {
      const choiceCounts: Record<string, number> = {};
      const otherResponses: string[] = [];

      // Initialize counts for all choices
      questionData.choices?.forEach((choice: any) => {
        choiceCounts[choice.label] = 0;
      });

      // Count responses
      submittedResponses.forEach((response) => {
        const answer = response.response.poll_question;
        
        if (Array.isArray(answer)) {
          // Multiple choice - can have multiple selections
          answer.forEach((item: string) => {
            if (item.startsWith("other:")) {
              // Extract the "other" text
              const otherText = item.replace("other:", "");
              if (otherText) {
                otherResponses.push(otherText);
              }
            } else if (choiceCounts.hasOwnProperty(item)) {
              choiceCounts[item]++;
            }
          });
        } else if (typeof answer === "string") {
          // Single choice
          if (answer.startsWith("other:")) {
            const otherText = answer.replace("other:", "");
            if (otherText) {
              otherResponses.push(otherText);
            }
          } else if (choiceCounts.hasOwnProperty(answer)) {
            choiceCounts[answer]++;
          }
        }
      });

      // Convert to chart data format
      const data = Object.entries(choiceCounts).map(([name, value]) => ({
        name: name.length > 30 ? `${name.slice(0, 30)}...` : name,
        fullName: name,
        Responses: value,
      }));

      // Add "Other" category if there are other responses
      if (otherResponses.length > 0) {
        data.push({
          name: "Other",
          fullName: "Other",
          Responses: otherResponses.length,
        });
      }

      return data.sort((a, b) => b.Responses - a.Responses);
    }

    // Handle rating
    if (questionData?.type === "rating") {
      const ratingCounts: Record<number, number> = {};
      const min = questionData.min || 1;
      const max = questionData.max || 5;

      // Initialize counts
      for (let i = min; i <= max; i++) {
        ratingCounts[i] = 0;
      }

      // Count responses
      submittedResponses.forEach((response) => {
        const rating = Number(response.response.poll_question);
        if (!isNaN(rating) && rating >= min && rating <= max) {
          ratingCounts[rating]++;
        }
      });

      return Object.entries(ratingCounts).map(([name, value]) => ({
        name: `Rating ${name}`,
        Responses: value,
      }));
    }

    // Text and open-ended responses - show count but no chart (too many unique values)
    if (questionData?.type === "text" || questionData?.type === "open-ended") {
      return [];
    }

    return [];
  }, [pollQuestion, responses]);

  const questionData = pollQuestion as any;

  // Don't show chart for text or open-ended questions (too many unique responses)
  if (questionData?.type === "text" || questionData?.type === "open-ended") {
    return null;
  }

  if (chartData.length === 0) {
    return null;
  }

  return (
    <Box
      bg={cardBgColor}
      border="1px solid"
      borderColor={borderColor}
      borderRadius="lg"
      p={6}
      mb={6}
    >
      <VStack align="stretch" gap={4}>
        <Heading size="md" color={textColor}>
          Response Analytics
        </Heading>
        <ResponsiveContainer width="100%" height={400}>
          <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={borderColor} />
            <XAxis
              dataKey="name"
              tick={{ fill: tickColor, fontSize: 12 }}
              angle={-45}
              textAnchor="end"
              height={100}
              interval={0}
            />
            <YAxis tick={{ fill: tickColor }} />
            <Tooltip
              contentStyle={{
                backgroundColor: tooltipBg,
                color: tooltipTextColor,
                border: `1px solid ${borderColor}`,
                borderRadius: "4px",
              }}
              formatter={(value: number, name: string, props: any) => {
                if (props.payload.fullName && props.payload.fullName !== props.payload.name) {
                  return [`${value}`, `${props.payload.fullName}`];
                }
                return [value, name];
              }}
            />
            <Legend />
            <Bar
              dataKey="Responses"
              fill="#3B82F6"
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
        <Text fontSize="sm" color={textColor} opacity={0.7}>
          Total responses: {responses.filter((r) => r.is_submitted).length}
        </Text>
      </VStack>
    </Box>
  );
}


"use client";

import { Box, VStack, HStack, Heading, Text, Button } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { useMemo } from "react";

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

type MultipleChoiceDynamicViewerProps = {
  pollQuestion: JSON;
  responses: PollResponse[];
  onClose: () => void;
};

export default function MultipleChoiceDynamicViewer({
  pollQuestion,
  responses,
  onClose
}: MultipleChoiceDynamicViewerProps) {
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const tickColor = useColorModeValue("#1A202C", "#FFFFFF");
  const tooltipBg = useColorModeValue("#FFFFFF", "#1A1A1A");
  const tooltipTextColor = useColorModeValue("#1A202C", "#FFFFFF");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");

  const questionData = (pollQuestion as unknown) as Record<string, unknown> | null;
  const questionPrompt = (questionData?.prompt as string) || "Poll";
  const choices = (questionData?.choices as Array<{ label: string }>) || [];

  const chartData = useMemo(() => {
    const submittedResponses = responses.filter((r) => r.is_submitted);
    const choiceCounts: Record<string, number> = {};
    const otherResponses: string[] = [];

    // Initialize counts for all choices
    choices.forEach((choice) => {
      choiceCounts[choice.label] = 0;
    });

    // Count responses
    submittedResponses.forEach((response) => {
      const answer = response.response.poll_question;
      
      if (Array.isArray(answer)) {
        // Multiple choice - can have multiple selections
        answer.forEach((item: string) => {
          if (item.startsWith("other:")) {
            const otherText = item.replace("other:", "");
            if (otherText) {
              otherResponses.push(otherText);
            }
          } else if (choiceCounts.hasOwnProperty(item)) {
            choiceCounts[item]++;
          }
        });
      } else if (typeof answer === "string") {
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
  }, [responses, choices]);

  const submittedResponses = responses.filter((r) => r.is_submitted);

  return (
    <Box
      position="fixed"
      inset="0"
      bg={cardBgColor}
      zIndex="9999"
      display="flex"
      flexDirection="column"
      p={8}
    >
      <VStack align="stretch" gap={6} flex="1" overflow="auto">
        {/* Header with close button */}
        <HStack justify="space-between">
          <Heading size="2xl" color={textColor}>
            {questionPrompt}
          </Heading>
          <Button
            variant="outline"
            size="sm"
            bg="transparent"
            borderColor={buttonBorderColor}
            color={buttonTextColor}
            _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
            onClick={onClose}
          >
            Close
          </Button>
        </HStack>

        {/* Response count */}
        <Text fontSize="lg" color={textColor}>
          {submittedResponses.length} response{submittedResponses.length !== 1 ? "s" : ""}
        </Text>

        {/* Chart */}
        {chartData.length > 0 ? (
          <Box
            flex="1"
            bg={cardBgColor}
            border="1px solid"
            borderColor={borderColor}
            borderRadius="lg"
            p={6}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={borderColor} />
                <XAxis
                  dataKey="name"
                  tick={{ fill: tickColor, fontSize: 14 }}
                  angle={-45}
                  textAnchor="end"
                  height={100}
                  interval={0}
                />
                <YAxis tick={{ fill: tickColor, fontSize: 14 }} />
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
          </Box>
        ) : (
          <Box
            bg={cardBgColor}
            border="1px solid"
            borderColor={borderColor}
            borderRadius="lg"
            p={12}
            textAlign="center"
          >
            <Text fontSize="lg" color={textColor}>
              No responses yet
            </Text>
          </Box>
        )}
      </VStack>
    </Box>
  );
}


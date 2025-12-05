"use client";

import { Box, VStack, Heading, Text, HStack } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer } from "recharts";
import { useMemo } from "react";
import { PollResponseData } from "@/types/poll";
import { getPollAnswer } from "@/utils/pollUtils";
import { Database } from "@/utils/supabase/SupabaseTypes";
import QrCode from "./QrCode";

type MultipleChoiceDynamicViewerProps = {
  pollQuestion: JSON;
  responses: Database["public"]["Tables"]["live_poll_responses"]["Row"][];
  pollUrl?: string;
  qrCodeUrl?: string | null;
  isFullscreen?: boolean;
};

export default function MultipleChoiceDynamicViewer({
  pollQuestion,
  responses,
  pollUrl,
  qrCodeUrl,
  isFullscreen = false
}: MultipleChoiceDynamicViewerProps) {
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const tickColor = useColorModeValue("#1A202C", "#FFFFFF");

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

  const containerProps = isFullscreen
    ? {
        w: "100%",
        h: "100%",
        bg: cardBgColor,
        display: "flex",
        flexDirection: "column" as const,
        p: 8
      }
    : {
        bg: cardBgColor,
        borderRadius: "2xl",
        p: 10,
        border: "1px solid",
        borderColor: borderColor,
        display: "flex",
        flexDirection: "column" as const,
        minH: "700px",
        maxW: "1400px",
        w: "95%",
        mx: "auto",
        boxShadow: "lg"
      };

  return (
    <Box
      display="flex"
      justifyContent={isFullscreen ? "stretch" : "center"}
      alignItems={isFullscreen ? "stretch" : "center"}
      minH={isFullscreen ? "100%" : "80vh"}
      w="100%"
      h={isFullscreen ? "100%" : "auto"}
      mt={isFullscreen ? 0 : -5}
    >
      <Box {...containerProps}>
        {isFullscreen && pollUrl && (
          <Box position="absolute" bottom={4} right={4} zIndex={10000}>
            <HStack gap={4} align="center" justify="flex-end">
              <VStack align="flex-end" gap={1}>
                <Text fontSize="2xl" color={textColor} textAlign="right">
                  Answer Live at:{" "}
                  <Text as="span" fontWeight="semibold" color="#3B82F6">
                    {pollUrl}
                  </Text>
                </Text>
              </VStack>
              {qrCodeUrl && <QrCode qrCodeUrl={qrCodeUrl} size="80px" isFullscreen={true} />}
            </HStack>
          </Box>
        )}
        <VStack align="center" justify="center" gap={4} flex="1" minH="0" w="100%">
          <Heading size={isFullscreen ? "xl" : "lg"} color={textColor} textAlign="center">
            {questionPrompt}
          </Heading>
          <Box w="100%" translate="auto" translateX="-20px">
            <ResponsiveContainer width="100%" height={isFullscreen ? 700 : 500}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 100, top: 0, bottom: 0 }}>
                <XAxis
                  type="number"
                  tick={{ fill: tickColor, fontSize: 10 }}
                  allowDecimals={false}
                  domain={[0, xAxisMax]}
                  tickFormatter={(value) => (Number.isInteger(value) ? String(value) : "")}
                />
                <YAxis type="category" dataKey="name" tick={{ fill: tickColor, fontSize: 12 }} width={200} />
                <Bar dataKey="value" fill="#3B82F6" barSize={isFullscreen ? 150 : 100} />
              </BarChart>
            </ResponsiveContainer>
          </Box>
          <Text fontSize="md" color={textColor} textAlign="center">
            Number of Responses
          </Text>
        </VStack>
      </Box>
    </Box>
  );
}

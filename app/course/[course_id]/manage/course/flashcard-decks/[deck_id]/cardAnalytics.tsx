"use client";

import { useList } from "@refinedev/core";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Heading, Spinner, Text, VStack } from "@chakra-ui/react";
import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { useColorModeValue } from "@/components/ui/color-mode";

// Supabase types
type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];
type FlashcardInteractionLogRow = Database["public"]["Tables"]["flashcard_interaction_logs"]["Row"];

/**
 * This type defines the props for the CardAnalytics component.
 * @param deckId - The deck ID
 */
type CardAnalyticsProps = {
  deckId: string;
};

/**
 * This type defines the metrics for a flashcard.
 * @param prompt_viewed - The number of times a card has been viewed
 * @param returned_to_deck - The number of times a card has been returned to the deck
 * @param answer_viewed_duration - The average time spent on the answer
 * @param answer_viewed_count - The number of times a card has been viewed
 * @param got_it_duration - The average time spent for "Got It"
 * @param got_it_count - The number of times a card has been marked as "Got It"
 */
type CardMetrics = {
  prompt_viewed: number;
  returned_to_deck: number;
  answer_viewed_duration: number;
  answer_viewed_count: number;
  got_it_duration: number;
  got_it_count: number;
  keep_trying_duration: number;
  keep_trying_count: number;
};

/**
 * This component displays analytics for a flashcard deck.
 * It shows the number of times a card has been viewed, the number of times a card has been returned to the deck,
 * the average time spent on the answer, the average time spent for "Got It", and the average time spent for "Keep Trying".
 * @param deckId - The deck ID
 * @returns The analytics data
 */
export default function CardAnalytics({ deckId }: CardAnalyticsProps) {
  const { data: cardsData, isLoading: isLoadingCards } = useList<FlashcardRow>({
    resource: "flashcards",
    filters: [{ field: "deck_id", operator: "eq", value: deckId }],
    queryOptions: { enabled: !!deckId }
  });

  const { data: interactionsData, isLoading: isLoadingInteractions } = useList<FlashcardInteractionLogRow>({
    resource: "flashcard_interaction_logs",
    filters: [{ field: "deck_id", operator: "eq", value: deckId }],
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: !!deckId }
  });

  const analyticsData = useMemo(() => {
    if (!cardsData?.data || !interactionsData?.data) {
      return [];
    }

    const cardMap = new Map(cardsData.data.map((card) => [card.id, card.title]));
    const metrics: { [cardId: number]: CardMetrics } = {};

    for (const card of cardsData.data) {
      metrics[card.id] = {
        prompt_viewed: 0,
        returned_to_deck: 0,
        answer_viewed_duration: 0,
        answer_viewed_count: 0,
        got_it_duration: 0,
        got_it_count: 0,
        keep_trying_duration: 0,
        keep_trying_count: 0
      };
    }

    for (const log of interactionsData.data) {
      if (log.card_id && metrics[log.card_id]) {
        switch (log.action) {
          case "card_prompt_viewed":
            metrics[log.card_id].prompt_viewed++;
            break;
          case "card_returned_to_deck":
            metrics[log.card_id].returned_to_deck++;
            break;
          case "card_answer_viewed":
            metrics[log.card_id].answer_viewed_duration += log.duration_on_card_ms;
            metrics[log.card_id].answer_viewed_count++;
            break;
          case "card_marked_got_it":
            metrics[log.card_id].got_it_duration += log.duration_on_card_ms;
            metrics[log.card_id].got_it_count++;
            break;
          case "card_marked_keep_trying":
            metrics[log.card_id].keep_trying_duration += log.duration_on_card_ms;
            metrics[log.card_id].keep_trying_count++;
            break;
        }
      }
    }

    return Object.entries(metrics)
      .map(([cardId, data]) => {
        const gotItPlusKeepTrying = data.got_it_count + data.keep_trying_count;
        return {
          name: cardMap.get(Number(cardId)) || `Card ${cardId}`,
          "Prompt Views": data.prompt_viewed,
          "Returned to Deck": data.returned_to_deck,
          "Avg. Time on Answer (s)":
            data.answer_viewed_count > 0
              ? (data.answer_viewed_duration / data.answer_viewed_count / 1000).toFixed(2)
              : 0,
          'Avg. Time for "Got It" (s)':
            data.got_it_count > 0 ? (data.got_it_duration / data.got_it_count / 1000).toFixed(2) : 0,
          'Avg. Time for "Keep Trying" (s)':
            data.keep_trying_count > 0 ? (data.keep_trying_duration / data.keep_trying_count / 1000).toFixed(2) : 0,
          "% Got It": gotItPlusKeepTrying > 0 ? ((data.got_it_count / gotItPlusKeepTrying) * 100).toFixed(2) : 0
        };
      })
      .map((d) => ({
        ...d,
        "Avg. Time on Answer (s)": parseFloat(String(d["Avg. Time on Answer (s)"])),
        'Avg. Time for "Got It" (s)': parseFloat(String(d['Avg. Time for "Got It" (s)'])),
        'Avg. Time for "Keep Trying" (s)': parseFloat(String(d['Avg. Time for "Keep Trying" (s)'])),
        "% Got It": parseFloat(String(d["% Got It"]))
      }));
  }, [cardsData, interactionsData]);

  const tickColor = useColorModeValue("black", "white");
  const tooltipBg = useColorModeValue("white", "black");

  if (isLoadingCards || isLoadingInteractions) {
    return <Spinner />;
  }

  const charts = [
    { dataKey: "Prompt Views", color: "#8884d8" },
    { dataKey: "Returned to Deck", color: "#82ca9d" },
    { dataKey: "Avg. Time on Answer (s)", color: "#ffc658" },
    { dataKey: 'Avg. Time for "Got It" (s)', color: "#ff8042" },
    { dataKey: 'Avg. Time for "Keep Trying" (s)', color: "#d0ed57" },
    { dataKey: "% Got It", color: "#ff7300", yAxisId: "percent" }
  ];

  return (
    <VStack align="stretch" gap={8}>
      {charts.map((chart) => (
        <Box key={chart.dataKey}>
          <Heading size="md" mb={4}>
            {chart.dataKey}
          </Heading>
          {analyticsData.length > 0 ? (
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={analyticsData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="name"
                  tick={{ fill: tickColor, fontSize: 12 }}
                  interval={0}
                  angle={-45}
                  textAnchor="end"
                  height={100}
                />
                <YAxis yAxisId="left" tick={{ fill: tickColor }} />
                {chart.yAxisId === "percent" && (
                  <YAxis yAxisId="percent" orientation="right" tick={{ fill: tickColor }} domain={[0, 100]} unit="%" />
                )}
                <Tooltip contentStyle={{ backgroundColor: tooltipBg }} />
                <Legend />
                <Bar
                  dataKey={chart.dataKey}
                  fill={chart.color}
                  yAxisId={chart.yAxisId === "percent" ? "percent" : "left"}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Text>No data available for this metric.</Text>
          )}
        </Box>
      ))}
    </VStack>
  );
}

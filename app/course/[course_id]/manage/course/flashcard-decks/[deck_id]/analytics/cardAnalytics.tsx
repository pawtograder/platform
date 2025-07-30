"use client";

import { useList } from "@refinedev/core";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Heading, Spinner, Text, VStack } from "@chakra-ui/react";
import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { useColorModeValue } from "@/components/ui/color-mode";

// Supabase types
type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];

// Aggregated per-card metrics view row
type CardAggRow = {
  class_id: number;
  deck_id: number;
  card_id: number;
  prompt_views: number;
  returned_to_deck: number;
  avg_answer_time_ms: number | null;
  answer_viewed_count: number;
  avg_got_it_time_ms: number | null;
  got_it_count: number;
  avg_keep_trying_time_ms: number | null;
  keep_trying_count: number;
};

/**
 * This type defines the props for the CardAnalytics component.
 * @param deckId - The deck ID
 */
type CardAnalyticsProps = {
  deckId: string;
};

/**
 * This type defines the data for a flashcard analytics.
 * @param name - The name of the card
 * @param "Prompt Views" - The number of times a card has been viewed
 * @param "Returned to Deck" - The number of times a card has been returned to the deck
 * @param "Avg. Time on Answer (s)" - The average time spent on the answer
 * @param 'Avg. Time for "Got It" (s)' - The average time spent for "Got It"
 * @param 'Avg. Time for "Keep Trying" (s)' - The average time spent for "Keep Trying"
 * @param "% Got It" - The percentage of times a card has been marked as "Got It"
 */
type CardAnalyticsData = {
  name: string;
  "Prompt Views": number;
  "Returned to Deck": number;
  "Avg. Time on Answer (s)": number;
  'Avg. Time for "Got It" (s)': number;
  'Avg. Time for "Keep Trying" (s)': number;
  "% Got It": number;
};

/**
 * This type defines the numeric keys for a flashcard analytics.
 * @param "Prompt Views" - The number of times a card has been viewed
 * @param "Returned to Deck" - The number of times a card has been returned to the deck
 * @param "Avg. Time on Answer (s)" - The average time spent on the answer
 * @param 'Avg. Time for "Got It" (s)' - The average time spent for "Got It"
 * @param 'Avg. Time for "Keep Trying" (s)' - The average time spent for "Keep Trying"
 * @param "% Got It" - The percentage of times a card has been marked as "Got It"
 */
type NumericCardAnalyticsDataKey = Exclude<keyof CardAnalyticsData, "name">;

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
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: !!deckId }
  });

  const { data: cardAggData, isLoading: isLoadingAgg } = useList<CardAggRow>({
    resource: "flashcard_card_analytics",
    filters: [{ field: "deck_id", operator: "eq", value: deckId }],
    pagination: { pageSize: 2000 },
    queryOptions: { enabled: !!deckId }
  });

  const analyticsData = useMemo(() => {
    if (!cardsData?.data || !cardAggData?.data) {
      return [];
    }

    const cardMap = new Map(cardsData.data.map((card) => [card.id, card.title]));

    return cardAggData.data.map((row) => {
      const gotItPlusKeepTrying = row.got_it_count + row.keep_trying_count;
      return {
        name: cardMap.get(row.card_id) || `Card ${row.card_id}`,
        "Prompt Views": row.prompt_views,
        "Returned to Deck": row.returned_to_deck,
        "Avg. Time on Answer (s)": row.avg_answer_time_ms ? row.avg_answer_time_ms / 1000 : 0,
        'Avg. Time for "Got It" (s)': row.avg_got_it_time_ms ? row.avg_got_it_time_ms / 1000 : 0,
        'Avg. Time for "Keep Trying" (s)': row.avg_keep_trying_time_ms ? row.avg_keep_trying_time_ms / 1000 : 0,
        "% Got It": gotItPlusKeepTrying > 0 ? (row.got_it_count / gotItPlusKeepTrying) * 100 : 0
      };
    });
  }, [cardsData, cardAggData]);

  const tickColor = useColorModeValue("black", "white");
  const tooltipBg = useColorModeValue("white", "black");

  if (isLoadingCards || isLoadingAgg) {
    return <Spinner />;
  }

  interface ChartConfig {
    dataKey: NumericCardAnalyticsDataKey;
    color: string;
    yAxisId?: string;
  }

  const charts: ChartConfig[] = [
    { dataKey: "Prompt Views", color: "#8884d8" },
    { dataKey: "Returned to Deck", color: "#82ca9d" },
    { dataKey: "Avg. Time on Answer (s)", color: "#ffc658" },
    { dataKey: 'Avg. Time for "Got It" (s)', color: "#ff8042" },
    { dataKey: 'Avg. Time for "Keep Trying" (s)', color: "#d0ed57" },
    { dataKey: "% Got It", color: "#ff7300", yAxisId: "percent" }
  ];

  return (
    <VStack align="stretch" gap={8}>
      {charts.map((chart) => {
        const top10Data = [...(analyticsData as CardAnalyticsData[])]
          .sort((a, b) => b[chart.dataKey] - a[chart.dataKey])
          .slice(0, 10);
        return (
          <Box key={chart.dataKey}>
            <Heading size="md" mb={4}>
              Top 10 Cards by {chart.dataKey}
            </Heading>
            {top10Data.length > 0 ? (
              <ResponsiveContainer width="100%" height={400}>
                <BarChart data={top10Data}>
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
                    <YAxis
                      yAxisId="percent"
                      orientation="right"
                      tick={{ fill: tickColor }}
                      domain={[0, 100]}
                      unit="%"
                    />
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
        );
      })}
    </VStack>
  );
}

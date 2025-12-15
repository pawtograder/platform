"use client";

import { useList } from "@refinedev/core";
import { Box, Heading, Spinner, Text, VStack } from "@chakra-ui/react";
import { useMemo } from "react";
import { useColorModeValue } from "@/components/ui/color-mode";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from "@/components/ui/recharts-wrapper";

// Row returned by the new view `flashcard_deck_analytics`.
type DeckAnalyticsRow = {
  class_id: number;
  deck_id: number;
  deck_name: string | null;
  views: number;
  resets: number;
};

/**
 * This type defines the props for the DeckAnalytics component.
 * @param courseId - The course ID
 */
type DeckAnalyticsProps = {
  courseId: string;
};

/**
 * This component displays analytics for a flashcard deck.
 * It shows the number of times a deck has been viewed and the number of times a deck has been reset.
 * @param courseId - The course ID
 * @returns The analytics data
 */
export default function DeckAnalytics({ courseId }: DeckAnalyticsProps) {
  const { data: deckAnalyticsData, isLoading: isLoadingAnalytics } = useList<DeckAnalyticsRow>({
    resource: "flashcard_deck_analytics",
    filters: [{ field: "class_id", operator: "eq", value: courseId }],
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: !!courseId }
  });

  const analyticsData = useMemo(() => {
    if (!deckAnalyticsData?.data) {
      return { views: [], resets: [] };
    }

    const viewsChartData = deckAnalyticsData.data.map((row) => ({
      name: row.deck_name || `Deck ${row.deck_id}`,
      Views: row.views
    }));
    const resetsChartData = deckAnalyticsData.data.map((row) => ({
      name: row.deck_name || `Deck ${row.deck_id}`,
      Resets: row.resets
    }));

    return { views: viewsChartData, resets: resetsChartData };
  }, [deckAnalyticsData]);

  const tickColor = useColorModeValue("black", "white");
  const tooltipBg = useColorModeValue("white", "black");

  if (isLoadingAnalytics) {
    return <Spinner />;
  }

  return (
    <VStack align="stretch" gap={8}>
      <Box>
        <Heading size="md" mb={4}>
          Deck Views
        </Heading>
        {analyticsData.views.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={analyticsData.views}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fill: tickColor }} />
              <YAxis tick={{ fill: tickColor }} />
              <Tooltip contentStyle={{ backgroundColor: tooltipBg }} />
              <Legend />
              <Bar dataKey="Views" fill="#8884d8" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <Text>No deck view data available.</Text>
        )}
      </Box>
      <Box>
        <Heading size="md" mb={4}>
          Deck Progress Resets
        </Heading>
        {analyticsData.resets.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={analyticsData.resets}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fill: tickColor }} />
              <YAxis tick={{ fill: tickColor }} />
              <Tooltip contentStyle={{ backgroundColor: tooltipBg }} />
              <Legend />
              <Bar dataKey="Resets" fill="#82ca9d" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <Text>No deck reset data available.</Text>
        )}
      </Box>
    </VStack>
  );
}

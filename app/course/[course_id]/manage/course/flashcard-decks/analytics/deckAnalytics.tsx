"use client";

import { useList } from "@refinedev/core";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Heading, Spinner, Text, VStack } from "@chakra-ui/react";
import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { useColorModeValue } from "@/components/ui/color-mode";

// Supabase types
type FlashcardDeckRow = Database["public"]["Tables"]["flashcard_decks"]["Row"];
type FlashcardInteractionLogRow = Database["public"]["Tables"]["flashcard_interaction_logs"]["Row"];

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
  const { data: decksData, isLoading: isLoadingDecks } = useList<FlashcardDeckRow>({
    resource: "flashcard_decks",
    filters: [{ field: "class_id", operator: "eq", value: courseId }],
    queryOptions: {
      enabled: !!courseId
    }
  });

  const { data: interactionsData, isLoading: isLoadingInteractions } = useList<FlashcardInteractionLogRow>({
    resource: "flashcard_interaction_logs",
    filters: [{ field: "class_id", operator: "eq", value: courseId }],
    pagination: {
      pageSize: 10000
    },
    queryOptions: {
      enabled: !!courseId
    }
  });

  const analyticsData = useMemo(() => {
    if (!decksData?.data || !interactionsData?.data) {
      return { views: [], resets: [] };
    }

    const deckMap = new Map(decksData.data.map((deck) => [deck.id, deck.name]));

    const views = new Map<string, number>();
    const resets = new Map<string, number>();

    for (const deck of decksData.data) {
      views.set(deck.name, 0);
      resets.set(deck.name, 0);
    }

    for (const log of interactionsData.data) {
      const deckName = deckMap.get(log.deck_id);
      if (deckName) {
        if (log.action === "deck_viewed") {
          views.set(deckName, (views.get(deckName) || 0) + 1);
        } else if (log.action === "deck_progress_reset_all") {
          resets.set(deckName, (resets.get(deckName) || 0) + 1);
        }
      }
    }

    const viewsChartData = Array.from(views.entries()).map(([name, count]) => ({ name, Views: count }));
    const resetsChartData = Array.from(resets.entries()).map(([name, count]) => ({ name, Resets: count }));

    return { views: viewsChartData, resets: resetsChartData };
  }, [decksData, interactionsData]);

  const tickColor = useColorModeValue("black", "white");
  const tooltipBg = useColorModeValue("white", "black");

  if (isLoadingDecks || isLoadingInteractions) {
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

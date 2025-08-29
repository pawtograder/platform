"use client";

import { Heading, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import CardAnalytics from "./cardAnalytics";

/**
 * Aggregated card analytics page for a flashcard deck
 * @returns The Analytics page
 */
export default function AnalyticsPage() {
  const params = useParams();
  const deck_id = params["deck_id"] as string;

  return (
    <VStack align="stretch" gap={6}>
      <Heading size="lg">Aggregated Card Analytics</Heading>
      <CardAnalytics deckId={deck_id} />
    </VStack>
  );
}

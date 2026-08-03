"use client";

import { Container, VStack } from "@chakra-ui/react";
import GradingProgressDashboard from "../reviews/GradingProgressDashboard";

export default function GradingProgressPage() {
  return (
    <Container maxW="container.xl" py={4}>
      <VStack align="stretch" gap={4}>
        <GradingProgressDashboard showHeading={true} />
      </VStack>
    </Container>
  );
}

"use client";

import { Badge, Box, Heading, HStack, Text, VStack } from "@chakra-ui/react";

export type GradeAdjustmentsProps = {
  tweak: number;
  tweakNote: string | null;
};

/**
 * A small card surfacing a manual grade adjustment (tweak) and its optional reason. Renders
 * nothing when there is no adjustment.
 */
export default function GradeAdjustments({ tweak, tweakNote }: GradeAdjustmentsProps) {
  if (tweak === 0) {
    return null;
  }

  const signed = `${tweak < 0 ? "−" : "+"}${Math.abs(tweak)}`;

  return (
    <Box borderWidth="1px" borderColor="border.subtle" borderRadius="md" bg="bg.subtle" p={4} w="100%">
      <VStack align="stretch" gap={2}>
        <HStack justify="space-between" align="center" gap={2}>
          <Heading as="h3" size="sm">
            Adjustments
          </Heading>
          <Badge colorPalette={tweak < 0 ? "red" : "green"} size="sm">
            {signed}
          </Badge>
        </HStack>
        {tweakNote && (
          <Text fontSize="sm" color="fg.muted">
            {tweakNote}
          </Text>
        )}
      </VStack>
    </Box>
  );
}

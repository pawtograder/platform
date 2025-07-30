"use client";
import { Box, Heading, Text } from "@chakra-ui/react";
import WhatIf from "./whatIf";

export default function GradebookPage() {
  return (
    <Box p={4}>
      <Heading size="lg">Gradebook</Heading>
      <Text fontSize="sm" color="fg.muted">
        Grades that have been released by your instructor are shown below.
      </Text>
      <WhatIf />
    </Box>
  );
}

"use client";

import { GradebookProvider } from "@/hooks/useGradebook";
import { Box } from "@chakra-ui/react";

export default function GradebookLayout({ children }: { children: React.ReactNode }) {
  return (
    <GradebookProvider>
      <Box w="100vw" overflowX="hidden">
        {children}
      </Box>
    </GradebookProvider>
  );
}

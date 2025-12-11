"use client";

import React, { useEffect, useRef } from "react";
import { Box, Button, HStack, VStack, Heading, Text } from "@chakra-ui/react";
import PollBuilder from "@/components/PollBuilder";

type PollBuilderModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSave: (json: string) => void;
  initialJson?: string;
};

export default function PollBuilderModal({ isOpen, onClose, onSave, initialJson }: PollBuilderModalProps) {
  // Ref to get current JSON from PollBuilder
  const getCurrentJsonRef = useRef<(() => string) | null>(null);

  useEffect(() => {
    // Reset when modal opens
    if (isOpen) {
      getCurrentJsonRef.current = null;
    }
  }, [isOpen]);

  // Callback to receive the getter function from PollBuilder
  const handleGetCurrentJson = (getJson: () => string) => {
    getCurrentJsonRef.current = getJson;
  };

  const handleUsePoll = () => {
    // Get current JSON from PollBuilder when "Use This Poll" is clicked
    if (getCurrentJsonRef.current) {
      const currentJson = getCurrentJsonRef.current();
      onSave(currentJson);
    } else {
      // Fallback to initial JSON if getter not available
      onSave(initialJson || "");
    }
    onClose();
  };

  if (!isOpen) return null;

  return (
    <Box
      position="fixed"
      inset="0"
      bg="bg.muted"
      zIndex="9999"
      display="flex"
      alignItems="center"
      justifyContent="center"
    >
      <Box
        bg="bg.subtle"
        border="1px solid"
        borderColor="border.default"
        borderRadius="lg"
        w="90vw"
        maxW="800px"
        maxH="90vh"
        display="flex"
        flexDirection="column"
        overflow="hidden"
      >
        {/* Header */}
        <Box
          p={4}
          borderBottom="1px solid"
          borderColor="border.subtle"
          display="flex"
          justifyContent="space-between"
          alignItems="center"
        >
          <VStack align="start" gap={1}>
            <Heading size="lg" color="fg.default">
              Visual Poll Builder
            </Heading>
            <Text fontSize="sm" color="fg.muted">
              Build your poll question visually
            </Text>
          </VStack>
          <HStack gap={2}>
            <Button
              variant="outline"
              size="sm"
              bg="transparent"
              borderColor="border"
              color="fg"
              _hover={{ bg: "bg.muted" }}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button size="sm" bg="green.500" color="white" _hover={{ bg: "green.600" }} onClick={handleUsePoll}>
              Use This Poll
            </Button>
          </HStack>
        </Box>

        {/* Body: the builder */}
        <Box flex="1" overflow="auto" p={4}>
          <PollBuilder
            key={isOpen ? "builder" : undefined}
            value={initialJson ?? ""}
            onGetCurrentJson={handleGetCurrentJson}
          />
        </Box>
      </Box>
    </Box>
  );
}

"use client";

import React, { useEffect, useRef } from "react";
import { Box, Button, HStack, VStack, Heading, Text } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import PollBuilder from "@/components/PollBuilder";

type PollBuilderModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSave: (json: string) => void;
  initialJson?: string;
};

export default function PollBuilderModal({ isOpen, onClose, onSave, initialJson }: PollBuilderModalProps) {
  const bgColor = useColorModeValue("#FFFFFF", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");

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
      bg="rgba(0,0,0,0.8)"
      zIndex="9999"
      display="flex"
      alignItems="center"
      justifyContent="center"
    >
      <Box
        bg={bgColor}
        border="1px solid"
        borderColor={borderColor}
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
          borderColor={borderColor}
          display="flex"
          justifyContent="space-between"
          alignItems="center"
        >
          <VStack align="start" gap={1}>
            <Heading size="lg" color={textColor}>
              Visual Poll Builder
            </Heading>
            <Text fontSize="sm" color={buttonTextColor}>
              Build your poll question visually
            </Text>
          </VStack>
          <HStack gap={2}>
            <Button
              variant="outline"
              size="sm"
              bg="transparent"
              borderColor={buttonBorderColor}
              color={buttonTextColor}
              _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button size="sm" bg="#22C55E" color="white" _hover={{ bg: "#16A34A" }} onClick={handleUsePoll}>
              Use This Poll
            </Button>
          </HStack>
        </Box>

        {/* Body: the builder */}
        <Box flex="1" overflow="auto" p={4}>
          <PollBuilder
            key={isOpen ? `builder-${initialJson ?? "new"}` : undefined}
            value={initialJson ?? ""}
            onGetCurrentJson={handleGetCurrentJson}
          />
        </Box>
      </Box>
    </Box>
  );
}

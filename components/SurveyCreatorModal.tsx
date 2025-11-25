"use client";

import { useState, useRef } from "react";
import { Box, Button, VStack, HStack, Text, Heading } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import dynamic from "next/dynamic";

// Dynamic import to prevent SSR issues
const SurveyCreatorWidget = dynamic(() => import("@/components/SurveyCreator"), {
  ssr: false,
  loading: () => <div>Loading Survey Creator...</div>
});

type SurveyCreatorModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSave: (json: string) => void;
  initialJson?: string;
  startFresh?: boolean;
};

export default function SurveyCreatorModal({
  isOpen,
  onClose,
  onSave,
  initialJson,
  startFresh
}: SurveyCreatorModalProps) {
  // Color mode values
  const bgColor = useColorModeValue("#FFFFFF", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");

  const creatorRef = useRef<any>(null);

  if (!isOpen) return null;

  const handleConfirmSave = () => {
    let currentJson = "";

    // Try to get JSON from the creator instance first
    if (creatorRef.current) {
      currentJson = creatorRef.current.text || "";
    }

    // Fallback to localStorage if creator doesn't have text
    if (!currentJson || currentJson.trim() === "") {
      currentJson = window.localStorage.getItem("survey-json") || "";
    }

    // Final fallback - if still empty, use initial JSON
    if (!currentJson || currentJson.trim() === "") {
      currentJson = initialJson || "";
    }

    onSave(currentJson);
    onClose();
  };

  const handleCreatorReady = (creator: any) => {
    creatorRef.current = creator;
  };

  return (
    <Box
      position="fixed"
      top="0"
      left="0"
      right="0"
      bottom="0"
      bg="rgba(0, 0, 0, 0.8)"
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
        w="95vw"
        h="95vh"
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
              SurveyJS Creator
            </Heading>
            <Text fontSize="sm" color={buttonTextColor}>
              Design your survey using the visual editor
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
            <Button size="sm" bg="#22C55E" color="white" _hover={{ bg: "#16A34A" }} onClick={handleConfirmSave}>
              Use This Survey
            </Button>
          </HStack>
        </Box>

        {/* Survey Creator */}
        <Box flex="1" overflow="hidden">
          <SurveyCreatorWidget
            json={initialJson ? JSON.parse(initialJson) : undefined}
            startFresh={startFresh}
            onCreatorReady={handleCreatorReady}
          />
        </Box>
      </Box>
    </Box>
  );
}

"use client";

import { useRef, useState, useEffect } from "react";
import { Box, Button, HStack, VStack, Heading, Text } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import SurveyBuilder from "@/components/survey/SurveyBuilder";

type SurveyBuilderModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSave: (json: string) => void;
  initialJson?: string;
};

export default function SurveyBuilderModal({ isOpen, onClose, onSave, initialJson }: SurveyBuilderModalProps) {
  // Colors
  const bgColor = useColorModeValue("#FFFFFF", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");

  // Local JSON buffer (so user can cancel without mutating form)
  const [draftJson, setDraftJson] = useState<string>(initialJson ?? "");

  useEffect(() => {
    if (isOpen) setDraftJson(initialJson ?? "");
  }, [isOpen, initialJson]);

  if (!isOpen) return null;

  const handleUseSurvey = () => {
    onSave(draftJson || "");
    onClose();
  };

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
              Visual Survey Builder
            </Heading>
            <Text fontSize="sm" color={buttonTextColor}>
              Build or edit your survey JSON visually
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
            <Button size="sm" bg="#22C55E" color="white" _hover={{ bg: "#16A34A" }} onClick={handleUseSurvey}>
              Use This Survey
            </Button>
          </HStack>
        </Box>

        {/* Body: the builder */}
        <Box flex="1" overflow="auto" p={4}>
          <SurveyBuilder initialJson={initialJson} value={draftJson} onChange={setDraftJson} />
        </Box>
      </Box>
    </Box>
  );
}

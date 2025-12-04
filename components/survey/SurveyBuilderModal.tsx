"use client";

import { useState, useEffect } from "react";
import { Box, Button, HStack, VStack, Heading, Text } from "@chakra-ui/react";
import SurveyBuilder from "@/components/survey/SurveyBuilder";

type SurveyBuilderModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSave: (json: string) => void;
  initialJson?: string;
};

export default function SurveyBuilderModal({ isOpen, onClose, onSave, initialJson }: SurveyBuilderModalProps) {
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
          borderColor="border.subtle"
          display="flex"
          justifyContent="space-between"
          alignItems="center"
        >
          <VStack align="start" gap={1}>
            <Heading size="lg" color="fg.default">
              Visual Survey Builder
            </Heading>
            <Text fontSize="sm" color="fg.muted">
              Build or edit your survey JSON visually
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
            <Button size="sm" colorPalette="green" onClick={handleUseSurvey}>
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

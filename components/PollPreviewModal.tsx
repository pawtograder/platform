"use client";

import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogCloseTrigger
} from "@/components/ui/dialog";
import { Box, Text, VStack } from "@chakra-ui/react";
import { useColorMode } from "@/components/ui/color-mode";
import { useState, useEffect } from "react";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import { DefaultDark, DefaultLight } from "survey-core/themes";
import "survey-core/survey-core.min.css";

interface PollPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  pollJson: string;
}

export function PollPreviewModal({ isOpen, onClose, pollJson }: PollPreviewModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [surveyModel, setSurveyModel] = useState<Model | null>(null);
  const { colorMode } = useColorMode();

  useEffect(() => {
    if (!isOpen || !pollJson.trim()) {
      setError("Error, please validate JSON");
      setSurveyModel(null);
      return;
    }

    try {
      // Parse and validate JSON
      const parsedJson = JSON.parse(pollJson);

      // Create SurveyJS model directly
      const model = new Model(parsedJson);

      // Apply theme based on color mode
      if (colorMode === "dark") {
        model.applyTheme(DefaultDark);
      } else {
        model.applyTheme(DefaultLight);
      }

      setSurveyModel(model);
      setError(null);
    } catch (error) {
      console.error("Error creating survey model:", error);
      setError("Error, please validate JSON");
      setSurveyModel(null);
    }
  }, [isOpen, pollJson, colorMode]);

  // Update theme when color mode changes
  useEffect(() => {
    if (surveyModel) {
      if (colorMode === "dark") {
        surveyModel.applyTheme(DefaultDark);
      } else {
        surveyModel.applyTheme(DefaultLight);
      }
    }
  }, [colorMode, surveyModel]);

  return (
    <DialogRoot open={isOpen} onOpenChange={onClose}>
      <DialogContent
        maxW="4xl"
        w="90vw"
        h="90vh"
        bg="bg.default"
        borderColor="border.subtle"
        borderRadius="lg"
        className="flex flex-col"
      >
        <DialogHeader bg="bg.muted" p={4} borderRadius="lg">
          <DialogTitle color="fg.default" fontSize="xl" fontWeight="bold">
            Poll Preview
          </DialogTitle>
          <DialogCloseTrigger />
        </DialogHeader>

        <DialogBody p={6} overflow="auto">
          {error ? (
            <VStack align="center" py={8} gap={4}>
              <Text color="red.500">{error}</Text>
            </VStack>
          ) : surveyModel ? (
            <Box className="poll-preview-container">
              <Survey model={surveyModel} />
            </Box>
          ) : (
            <Box textAlign="center" py={8}>
              <Text color="fg.muted">Loading poll preview...</Text>
            </Box>
          )}
        </DialogBody>
      </DialogContent>
    </DialogRoot>
  );
}

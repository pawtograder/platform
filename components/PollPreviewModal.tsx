"use client";

import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogCloseTrigger
} from "@/components/ui/dialog";
import { useColorModeValue } from "@/components/ui/color-mode";
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

  // Color mode values
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const bgColor = useColorModeValue("#FFFFFF", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const headerBgColor = useColorModeValue("#F8F9FA", "#2D2D2D");
  const isDarkMode = useColorModeValue(false, true);

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
      if (isDarkMode) {
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
  }, [isOpen, pollJson, isDarkMode]);

  // Update theme when color mode changes
  useEffect(() => {
    if (surveyModel) {
      if (isDarkMode) {
        surveyModel.applyTheme(DefaultDark);
      } else {
        surveyModel.applyTheme(DefaultLight);
      }
    }
  }, [isDarkMode, surveyModel]);

  return (
    <DialogRoot open={isOpen} onOpenChange={onClose}>
      <DialogContent
        maxW="4xl"
        w="90vw"
        h="90vh"
        bg={bgColor}
        borderColor={borderColor}
        borderRadius="lg"
        className="flex flex-col"
      >
        <DialogHeader bg={headerBgColor} p={4} borderRadius="lg">
          <DialogTitle color={textColor} fontSize="xl" fontWeight="bold">
            Poll Preview
          </DialogTitle>
          <DialogCloseTrigger />
        </DialogHeader>

        <DialogBody p={6} overflow="auto">
          {error ? (
            <div className="text-center py-8">
              <p className="text-red-500">{error}</p>
            </div>
          ) : surveyModel ? (
            <div className="poll-preview-container">
              <Survey model={surveyModel} />
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500">Loading poll preview...</p>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </DialogRoot>
  );
}

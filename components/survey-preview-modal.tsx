"use client";

import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogCloseTrigger
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useColorModeValue } from "@/components/ui/color-mode";
import { Survey } from "survey-react-ui";
import { Model } from "survey-core";
import { useCallback, useEffect, useState } from "react";
import { DefaultDark, DefaultLight } from "survey-core/themes";

interface SurveyPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  surveyJson: string;
  surveyTitle?: string;
}

export function SurveyPreviewModal({ isOpen, onClose, surveyJson, surveyTitle }: SurveyPreviewModalProps) {
  const [surveyModel, setSurveyModel] = useState<Model | null>(null);
  const [isValidJson, setIsValidJson] = useState(true);

  // Color mode values
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const bgColor = useColorModeValue("#FFFFFF", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const headerBgColor = useColorModeValue("#F8F9FA", "#2D2D2D");
  const isDarkMode = useColorModeValue(false, true);

  const initializeSurvey = useCallback(() => {
    if (!surveyJson.trim()) {
      setIsValidJson(false);
      return;
    }

    try {
      const surveyConfig = JSON.parse(surveyJson);
      const model = new Model(surveyConfig);

      // Configure the survey for preview mode
      model.mode = "display"; // Set to display mode for preview
      model.showProgressBar = "top";
      model.showQuestionNumbers = "on";
      model.showCompletedPage = false; // Don't show completion page in preview
      model.showTitle = false; // Hide title since we show it in modal header
      model.showPageTitles = true;
      model.showPageNumbers = true;

      // Apply SurveyJS theme based on color mode
      if (isDarkMode) {
        model.applyTheme(DefaultDark);
      } else {
        model.applyTheme(DefaultLight);
      }

      setSurveyModel(model);
      setIsValidJson(true);
    } catch (error) {
      console.error("Invalid survey JSON:", error);
      setIsValidJson(false);
    }
  }, [surveyJson, isDarkMode]);

  useEffect(() => {
    if (isOpen && surveyJson) {
      initializeSurvey();
    }
  }, [isOpen, surveyJson, initializeSurvey]);

  const handleSurveyComplete = useCallback((sender: Model) => {
    // In preview mode, we don't actually submit the survey
    console.log("Survey completed in preview mode");
  }, []);

  const handleSurveyValueChanged = useCallback((sender: Model, options: any) => {
    // Handle value changes if needed
    console.log("Survey value changed:", options.name, options.value);
  }, []);

  useEffect(() => {
    if (surveyModel) {
      surveyModel.onComplete.add(handleSurveyComplete);
      surveyModel.onValueChanged.add(handleSurveyValueChanged);

      return () => {
        surveyModel.onComplete.remove(handleSurveyComplete);
        surveyModel.onValueChanged.remove(handleSurveyValueChanged);
      };
    }
  }, [surveyModel, handleSurveyComplete, handleSurveyValueChanged]);

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
            Survey Preview: {surveyTitle || "Untitled Survey"}
          </DialogTitle>
          <DialogCloseTrigger />
        </DialogHeader>

        <DialogBody p={6} overflow="auto">
          {!isValidJson ? (
            <div className="text-center py-8">
              <p className="text-red-500 mb-4">Invalid JSON configuration</p>
              <p className="text-gray-500">Please check your survey JSON and try again.</p>
            </div>
          ) : surveyModel ? (
            <div className="survey-preview-container">
              <Survey model={surveyModel} />
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500">Loading survey preview...</p>
            </div>
          )}
        </DialogBody>

        <div className="relative p-6 pt-0">
          <div style={{ display: "flex", justifyContent: "flex-end", marginRight: "1rem", marginBottom: "1rem" }}>
            <Button
              variant="outline"
              onClick={onClose}
              style={{
                borderColor: borderColor,
                color: textColor
              }}
            >
              Close Preview
            </Button>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

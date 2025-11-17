"use client";

import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogCloseTrigger,
} from "@/components/ui/dialog";
import { useColorModeValue } from "@/components/ui/color-mode";
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";

const SurveyComponent = dynamic(() => import("@/components/Survey"), {
  ssr: false,
});

interface PollPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  pollJson: string;
  pollTitle?: string;
}

export function PollPreviewModal({ isOpen, onClose, pollJson, pollTitle }: PollPreviewModalProps) {
  const [isValidJson, setIsValidJson] = useState(true);
  const [surveyConfig, setSurveyConfig] = useState<any>(null);

  // Color mode values
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const bgColor = useColorModeValue("#FFFFFF", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const headerBgColor = useColorModeValue("#F8F9FA", "#2D2D2D");

  const initializePoll = useCallback(() => {
    if (!pollJson.trim()) {
      setIsValidJson(false);
      return;
    }

    try {
      const pollData = JSON.parse(pollJson);
      
      // Convert poll JSON to SurveyJS format for preview
      const surveyConfig: any = {
        pages: [
          {
            name: "page1",
            elements: [],
          },
        ],
      };

      // Convert poll question to SurveyJS element
      if (pollData.type === "multiple-choice" || pollData.type === "single-choice") {
        surveyConfig.pages[0].elements.push({
          type: pollData.type === "multiple-choice" ? "checkbox" : "radiogroup",
          name: "poll_question",
          title: pollData.prompt,
          choices: pollData.choices?.map((c: any) => c.label) || [],
          isRequired: true,
        });
      } else if (pollData.type === "open-ended") {
        surveyConfig.pages[0].elements.push({
          type: "comment",
          name: "poll_question",
          title: pollData.prompt,
          isRequired: true,
        });
      } else if (pollData.type === "rating") {
        surveyConfig.pages[0].elements.push({
          type: "rating",
          name: "poll_question",
          title: pollData.prompt,
          rateMin: pollData.min || 1,
          rateMax: pollData.max || 5,
          minRateDescription: pollData.minLabel || "",
          maxRateDescription: pollData.maxLabel || "",
          isRequired: true,
        });
      } else if (pollData.type === "text") {
        surveyConfig.pages[0].elements.push({
          type: "text",
          name: "poll_question",
          title: pollData.prompt,
          isRequired: true,
        });
      }

      setSurveyConfig(surveyConfig);
      setIsValidJson(true);
    } catch (error) {
      console.error("Invalid poll JSON:", error);
      setIsValidJson(false);
    }
  }, [pollJson]);

  useEffect(() => {
    if (isOpen && pollJson) {
      initializePoll();
    }
  }, [isOpen, pollJson, initializePoll]);

  const handleComplete = useCallback((survey: any) => {
    // In preview mode, we don't actually submit
    console.log("Poll preview completed", survey);
  }, []);

  const handleValueChanged = useCallback((survey: any, options: any) => {
    // Handle value changes if needed
    console.log("Poll preview value changed", options);
  }, []);

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
            Poll Preview: {pollTitle || "Untitled Poll"}
          </DialogTitle>
          <DialogCloseTrigger />
        </DialogHeader>

        <DialogBody p={6} overflow="auto">
          {!isValidJson ? (
            <div className="text-center py-8">
              <p className="text-red-500 mb-4">Invalid JSON configuration</p>
              <p className="text-gray-500">Please check your poll JSON and try again.</p>
            </div>
          ) : surveyConfig ? (
            <div className="poll-preview-container">
              <SurveyComponent
                surveyJson={JSON.stringify(surveyConfig)}
                onComplete={handleComplete}
                onValueChanged={handleValueChanged}
                isPopup={false}
                readOnly={false}
              />
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


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
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const SurveyComponent = dynamic(() => import("@/components/Survey"), {
  ssr: false,
  loading: () => (
    <div className="text-center py-8">
      <p className="text-gray-500">Loading survey preview...</p>
    </div>
  )
});

interface SurveyPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  surveyJson: string;
  surveyTitle?: string;
}

export function SurveyPreviewModal({ isOpen, onClose, surveyJson, surveyTitle }: SurveyPreviewModalProps) {
  const [isValidJson, setIsValidJson] = useState(true);
  const [parsedJson, setParsedJson] = useState<any>(null);

  // Color mode values
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const bgColor = useColorModeValue("#FFFFFF", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const headerBgColor = useColorModeValue("#F8F9FA", "#2D2D2D");

  useEffect(() => {
    if (!isOpen || !surveyJson) return;

    if (!surveyJson.trim()) {
      setIsValidJson(false);
      setParsedJson(null);
      return;
    }

    try {
      const parsed = JSON.parse(surveyJson);
      setParsedJson(parsed);
      setIsValidJson(true);
    } catch (error) {
      console.error("Invalid survey JSON:", error);
      setIsValidJson(false);
      setParsedJson(null);
    }
  }, [isOpen, surveyJson]);

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
          ) : parsedJson ? (
            <div className="survey-preview-container">
              <SurveyComponent
                surveyJson={parsedJson}
                isPopup={false}
                readOnly={false}
              />
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
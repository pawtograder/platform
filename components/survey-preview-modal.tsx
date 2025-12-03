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
import { Box, Text, VStack } from "@chakra-ui/react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { Json } from "@/utils/supabase/SupabaseTypes";

const SurveyComponent = dynamic(() => import("@/components/Survey"), {
  ssr: false,
  loading: () => (
    <Box textAlign="center" py={8}>
      <Text color="fg.muted">Loading survey preview...</Text>
    </Box>
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
  const [parsedJson, setParsedJson] = useState<Json | null>(null);

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
    <DialogRoot
      open={isOpen}
      onOpenChange={({ open }) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        maxW="4xl"
        w="90vw"
        h="90vh"
        bg="bg.default"
        borderColor="border.subtle"
        borderRadius="lg"
        className="flex flex-col"
      >
        <DialogHeader bg="bg.subtle" p={4} borderRadius="lg">
          <DialogTitle color="fg.default" fontSize="xl" fontWeight="bold">
            Survey Preview: {surveyTitle || "Untitled Survey"}
          </DialogTitle>
          <DialogCloseTrigger />
        </DialogHeader>

        <DialogBody p={6} overflow="auto">
          {!isValidJson ? (
            <VStack align="center" py={8} gap={4}>
              <Text color="red.500">Invalid JSON configuration</Text>
              <Text color="fg.muted">Please check your survey JSON and try again.</Text>
            </VStack>
          ) : parsedJson ? (
            <Box className="survey-preview-container">
              <SurveyComponent surveyJson={parsedJson} isPopup={false} readOnly={false} />
            </Box>
          ) : (
            <Box textAlign="center" py={8}>
              <Text color="fg.muted">Loading survey preview...</Text>
            </Box>
          )}
        </DialogBody>

        <Box position="relative" p={6} pt={0}>
          <Box display="flex" justifyContent="flex-end" mr={4} mb={4}>
            <Button variant="outline" onClick={onClose} borderColor="border" color="fg.default">
              Close Preview
            </Button>
          </Box>
        </Box>
      </DialogContent>
    </DialogRoot>
  );
}

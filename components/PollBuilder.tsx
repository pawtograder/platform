"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Box,
  Button,
  HStack,
  IconButton,
  Input,
  Text,
  VStack,
  createListCollection,
  Separator,
  Select,
  Portal,
} from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { LuTrash2, LuPlus } from "react-icons/lu";

type PollQuestionJSON = {
  prompt: string;
  type: "multiple-choice" | "single-choice" | "rating" | "text" | "open-ended";
  choices?: Array<{ id: string; label: string }>;
  min?: number;
  max?: number;
  minLabel?: string;
  maxLabel?: string;
};

type PollBuilderProps = {
  value: string;
  onChange: (json: string) => void;
};

const pollTypeCollection = createListCollection({
  items: [
    { label: "Multiple Choice", value: "multiple-choice" },
    { label: "Single Choice", value: "single-choice" },
    { label: "Rating", value: "rating" },
    { label: "Text", value: "text" },
    { label: "Open Ended", value: "open-ended" },
  ],
});

export default function PollBuilder({ value, onChange }: PollBuilderProps) {
  const [pollData, setPollData] = useState<PollQuestionJSON>({
    prompt: "",
    type: "multiple-choice",
    choices: [{ id: "choice1", label: "" }],
  });

  const jsonTextColor = useColorModeValue("#1A202C", "#FFFFFF");
  const jsonBgColor = useColorModeValue("#F9FAFB", "#1F2937");
  const jsonBorderColor = useColorModeValue("#E5E7EB", "#374151");
  const textColor = useColorModeValue("#1A202C", "#FFFFFF");
  const secondaryTextColor = useColorModeValue("#6B7280", "#9CA3AF");

  // Track the last normalized JSON we received and emitted to prevent loops
  const lastReceivedNormalizedRef = React.useRef<string>("");
  const lastEmittedNormalizedRef = React.useRef<string>("");
  const isInitialMount = React.useRef(true);

  // Helper to normalize JSON for comparison (parse and stringify to remove formatting differences)
  const normalizeJson = React.useCallback((jsonStr: string): string => {
    try {
      const parsed = JSON.parse(jsonStr);
      return JSON.stringify(parsed);
    } catch {
      return jsonStr;
    }
  }, []);

  // Parse initial value - only when value prop actually changes from outside
  useEffect(() => {
    if (!value || !value.trim()) {
      isInitialMount.current = false;
      return;
    }

    const normalized = normalizeJson(value);
    
    // Only update if the normalized value actually changed from outside
    if (normalized !== lastReceivedNormalizedRef.current) {
      try {
        const parsed = JSON.parse(value);
        setPollData(parsed);
        lastReceivedNormalizedRef.current = normalized;
        lastEmittedNormalizedRef.current = normalized;
      } catch {
        // Invalid JSON, use defaults - don't update
        lastReceivedNormalizedRef.current = normalized;
      }
    }
    isInitialMount.current = false;
  }, [value, normalizeJson]);

  // Update JSON when pollData changes - but skip on initial mount and if we just received this value
  useEffect(() => {
    if (isInitialMount.current) {
      return; // Skip on initial mount
    }
    
    const jsonString = JSON.stringify(pollData, null, 2);
    const normalized = normalizeJson(jsonString);
    
    // Only call onChange if the normalized JSON actually changed and it's different from what we last received
    if (normalized !== lastEmittedNormalizedRef.current && normalized !== lastReceivedNormalizedRef.current) {
      lastEmittedNormalizedRef.current = normalized;
      onChange(jsonString);
    }
  }, [pollData, onChange, normalizeJson]);

  const handlePromptChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPollData((prev) => ({ ...prev, prompt: e.target.value }));
  }, []);

  const handleTypeChange = useCallback((e: { value: string } | null) => {
    const newType = (e?.value || "multiple-choice") as PollQuestionJSON["type"];
    setPollData((prev) => {
      const updated: PollQuestionJSON = { ...prev, type: newType };
      
      // Add choices for choice-based types
      if (newType === "multiple-choice" || newType === "single-choice") {
        if (!updated.choices || updated.choices.length === 0) {
          updated.choices = [{ id: "choice1", label: "" }];
        }
      } else {
        // Remove choices for non-choice types
        delete updated.choices;
      }
      
      // Open-ended doesn't need any special fields
      if (newType === "open-ended") {
        delete updated.choices;
        delete updated.min;
        delete updated.max;
        delete updated.minLabel;
        delete updated.maxLabel;
      }

      // Add min/max for rating type
      if (newType === "rating") {
        updated.min = updated.min || 1;
        updated.max = updated.max || 5;
        updated.minLabel = updated.minLabel || "Poor";
        updated.maxLabel = updated.maxLabel || "Excellent";
      } else {
        delete updated.min;
        delete updated.max;
        delete updated.minLabel;
        delete updated.maxLabel;
      }

      return updated;
    });
  }, []);

  const handleAddChoice = useCallback(() => {
    setPollData((prev) => {
      if (!prev.choices) return prev;
      const newId = `choice${Date.now()}`;
      return {
        ...prev,
        choices: [...prev.choices, { id: newId, label: "" }],
      };
    });
  }, []);

  const handleRemoveChoice = useCallback((index: number) => {
    setPollData((prev) => {
      if (!prev.choices || prev.choices.length <= 1) return prev;
      return {
        ...prev,
        choices: prev.choices.filter((_, i) => i !== index),
      };
    });
  }, []);

  const handleChoiceChange = useCallback((index: number, label: string) => {
    setPollData((prev) => {
      if (!prev.choices) return prev;
      const updated = [...prev.choices];
      updated[index] = { ...updated[index], label };
      return { ...prev, choices: updated };
    });
  }, []);

  const handleRatingChange = useCallback((field: "min" | "max" | "minLabel" | "maxLabel", value: string | number) => {
    setPollData((prev) => ({
      ...prev,
      [field]: value,
    }));
  }, []);

  return (
    <VStack align="stretch" gap={6} p={4}>
      {/* Prompt */}
      <Box>
        <Text fontSize="sm" fontWeight="medium" mb={2} color={textColor}>
          Question Prompt
        </Text>
        <Input
          placeholder="Enter your poll question..."
          value={pollData.prompt}
          onChange={handlePromptChange}
        />
      </Box>

      {/* Type Selection */}
      <Box>
        <Text fontSize="sm" fontWeight="medium" mb={2} color={textColor}>
          Question Type
        </Text>
        <Select.Root
          collection={pollTypeCollection}
          value={[pollData.type]}
          onValueChange={(details) => {
            const selectedValue = details.value[0];
            if (selectedValue) {
              handleTypeChange({ value: selectedValue });
            }
          }}
        >
          <Select.HiddenSelect />
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder="Select question type" />
            </Select.Trigger>
            <Select.IndicatorGroup>
              <Select.Indicator />
            </Select.IndicatorGroup>
          </Select.Control>
          <Portal>
            <Select.Positioner>
              <Select.Content style={{ zIndex: 9999 }}>
                {pollTypeCollection.items.map((item) => (
                  <Select.Item key={item.value} item={item}>
                    {item.label}
                    <Select.ItemIndicator />
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Portal>
        </Select.Root>
      </Box>

      {/* Choices (for multiple-choice and single-choice) */}
      {(pollData.type === "multiple-choice" || pollData.type === "single-choice") && pollData.choices && (
        <Box>
          <HStack justify="space-between" mb={2}>
            <Text fontSize="sm" fontWeight="medium" color={textColor}>
              Choices
            </Text>
            <Button size="sm" onClick={handleAddChoice}>
              <LuPlus size={16} />
              Add Choice
            </Button>
          </HStack>
          <VStack align="stretch" gap={2}>
            {pollData.choices.map((choice, index) => (
              <HStack key={choice.id} gap={2}>
                <Input
                  placeholder={`Choice ${index + 1}`}
                  value={choice.label}
                  onChange={(e) => handleChoiceChange(index, e.target.value)}
                  flex={1}
                />
                {pollData.choices && pollData.choices.length > 1 && (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    onClick={() => handleRemoveChoice(index)}
                    aria-label="Remove choice"
                  >
                    <LuTrash2 size={16} />
                  </IconButton>
                )}
              </HStack>
            ))}
          </VStack>
        </Box>
      )}

      {/* Rating Options */}
      {pollData.type === "rating" && (
        <VStack align="stretch" gap={4}>
          <HStack gap={4}>
            <Box flex={1}>
              <Text fontSize="sm" fontWeight="medium" mb={2} color={textColor}>
                Minimum Value
              </Text>
              <Input
                type="number"
                value={pollData.min || 1}
                onChange={(e) => handleRatingChange("min", parseInt(e.target.value) || 1)}
              />
            </Box>
            <Box flex={1}>
              <Text fontSize="sm" fontWeight="medium" mb={2} color={textColor}>
                Maximum Value
              </Text>
              <Input
                type="number"
                value={pollData.max || 5}
                onChange={(e) => handleRatingChange("max", parseInt(e.target.value) || 5)}
              />
            </Box>
          </HStack>
          <HStack gap={4}>
            <Box flex={1}>
              <Text fontSize="sm" fontWeight="medium" mb={2} color={textColor}>
                Minimum Label
              </Text>
              <Input
                value={pollData.minLabel || ""}
                onChange={(e) => handleRatingChange("minLabel", e.target.value)}
                placeholder="e.g., Poor"
              />
            </Box>
            <Box flex={1}>
              <Text fontSize="sm" fontWeight="medium" mb={2} color={textColor}>
                Maximum Label
              </Text>
              <Input
                value={pollData.maxLabel || ""}
                onChange={(e) => handleRatingChange("maxLabel", e.target.value)}
                placeholder="e.g., Excellent"
              />
            </Box>
          </HStack>
        </VStack>
      )}

      {/* Text type doesn't need additional options */}
      {pollData.type === "text" && (
        <Box>
          <Text fontSize="sm" color={secondaryTextColor}>
            Text questions allow free-form responses from students.
          </Text>
        </Box>
      )}

      {/* Open-ended type */}
      {pollData.type === "open-ended" && (
        <Box>
          <Text fontSize="sm" color={secondaryTextColor}>
            Open-ended questions allow students to provide detailed text responses.
          </Text>
        </Box>
      )}

      <Separator />

      {/* JSON Preview */}
      <Box>
        <Text fontSize="sm" fontWeight="medium" mb={2} color={textColor}>
          JSON Preview
        </Text>
        <Box
          p={3}
          bg={jsonBgColor}
          borderRadius="md"
          fontSize="xs"
          fontFamily="mono"
          overflow="auto"
          maxH="200px"
          border="1px solid"
          borderColor={jsonBorderColor}
        >
          <pre style={{ margin: 0, color: jsonTextColor }}>
            {JSON.stringify(pollData, null, 2)}
          </pre>
        </Box>
      </Box>
    </VStack>
  );
}


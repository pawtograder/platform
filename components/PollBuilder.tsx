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
  Portal
} from "@chakra-ui/react";
import { LuTrash2, LuPlus } from "react-icons/lu";

// Question type registry
type QuestionType = "multiple-choice" | "single-choice";

type QuestionTypeConfig = {
  label: string;
  surveyJSType: string; // The SurveyJS type (e.g., "checkbox", "radiogroup")
  requiresChoices: boolean; // Whether this type needs choices
  defaultData?: Record<string, unknown>; // Additional default data for this type
};

// Registry of question types - add new types here
const QUESTION_TYPE_REGISTRY: Record<QuestionType, QuestionTypeConfig> = {
  "multiple-choice": {
    label: "Multiple Choice",
    surveyJSType: "checkbox",
    requiresChoices: true
  },
  "single-choice": {
    label: "Single Choice",
    surveyJSType: "radiogroup",
    requiresChoices: true
  }
};

// Helper to get all question types for the select dropdown
const getQuestionTypeItems = () => {
  return Object.entries(QUESTION_TYPE_REGISTRY).map(([value, config]) => ({
    label: config.label,
    value: value as QuestionType
  }));
};

type PollQuestionJSON = {
  prompt: string;
  type: QuestionType;
  choices?: Array<{ id: string; label: string }>;
  // Add other fields here as needed for new question types
  [key: string]: unknown;
};

type PollBuilderProps = {
  value: string;
  onGetCurrentJson?: (getJson: () => string) => void; // Callback to expose getter function
};

const pollTypeCollection = createListCollection({
  items: getQuestionTypeItems()
});

// Helper function to find internal type from SurveyJS type
const findInternalTypeFromSurveyJS = (surveyType: string): QuestionType => {
  const entry = Object.entries(QUESTION_TYPE_REGISTRY).find(([, config]) => config.surveyJSType === surveyType);
  return entry ? (entry[0] as QuestionType) : "multiple-choice"; // Default fallback
};

// Helper function to convert internal format to SurveyJS format
const convertToSurveyJSFormat = (data: PollQuestionJSON): Record<string, unknown> => {
  const typeConfig = QUESTION_TYPE_REGISTRY[data.type];
  const element: Record<string, unknown> = {
    type: typeConfig.surveyJSType,
    title: data.prompt || ""
  };

  // Add choices if this type requires them
  if (typeConfig.requiresChoices) {
    const choices = (data.choices || []).map((choice) => choice.label).filter((label) => label.trim() !== "");
    element.choices = choices.length > 0 ? choices : ["Choice 1"];
  }

  // Add any additional fields from the data (for extensibility)
  Object.keys(data).forEach((key) => {
    if (key !== "prompt" && key !== "type" && key !== "choices") {
      element[key] = data[key];
    }
  });

  return {
    elements: [element]
  };
};

export default function PollBuilder({ value, onGetCurrentJson }: PollBuilderProps) {
  const [pollData, setPollData] = useState<PollQuestionJSON>({
    prompt: "",
    type: "multiple-choice",
    choices: [{ id: "choice1", label: "" }]
  });

  // Track if we've initialized from the value prop
  const hasInitializedRef = React.useRef(false);

  // Parse initial value - ONLY ONCE when component mounts
  useEffect(() => {
    // Only initialize once from the value prop
    if (hasInitializedRef.current) {
      return; // Ignore subsequent value prop changes
    }

    if (!value || !value.trim()) {
      // If no initial value, keep defaults
      hasInitializedRef.current = true;
      return;
    }

    try {
      const parsed = JSON.parse(value);

      // Check if it's SurveyJS format (has elements array)
      if (parsed.elements && Array.isArray(parsed.elements) && parsed.elements.length > 0) {
        const firstElement = parsed.elements[0];
        const surveyType = firstElement.type;

        // Convert SurveyJS format to internal format using registry
        const internalType = findInternalTypeFromSurveyJS(surveyType);
        const typeConfig = QUESTION_TYPE_REGISTRY[internalType];

        const pollData: PollQuestionJSON = {
          prompt: firstElement.title || "",
          type: internalType
        };

        // Handle choices if this type requires them
        if (typeConfig.requiresChoices) {
          const choices = Array.isArray(firstElement.choices)
            ? firstElement.choices.map((choice: string | { value: string; text?: string }, index: number) => ({
              id: `choice${index + 1}`,
              label: typeof choice === "string" ? choice : choice.text || choice.value || ""
            }))
            : [{ id: "choice1", label: "" }];

          pollData.choices = choices.length > 0 ? choices : [{ id: "choice1", label: "" }];
        }

        // Merge any additional default data from config
        if (typeConfig.defaultData) {
          Object.assign(pollData, typeConfig.defaultData);
        }

        setPollData(pollData);
      } else {
        // Old format (prompt/type/choices) - use directly
        setPollData(parsed);
      }

      hasInitializedRef.current = true;
    } catch {
      // Invalid JSON, use defaults
      hasInitializedRef.current = true;
    }
  }, [value]);

  // Expose a function to get current JSON (for parent to call when needed)
  useEffect(() => {
    if (onGetCurrentJson) {
      onGetCurrentJson(() => {
        const surveyJSFormat = convertToSurveyJSFormat(pollData);
        return JSON.stringify(surveyJSFormat, null, 2);
      });
    }
  }, [pollData, onGetCurrentJson]);

  const handlePromptChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPollData((prev) => ({ ...prev, prompt: e.target.value }));
  }, []);

  const handleTypeChange = useCallback((e: { value: string } | null) => {
    const newType = (e?.value || "multiple-choice") as QuestionType;
    setPollData((prev) => {
      const typeConfig = QUESTION_TYPE_REGISTRY[newType];
      const updated: PollQuestionJSON = { ...prev, type: newType };

      // Initialize choices if this type requires them
      if (typeConfig.requiresChoices) {
        if (!updated.choices || updated.choices.length === 0) {
          updated.choices = [{ id: "choice1", label: "" }];
        }
      } else {
        // Remove choices if this type doesn't need them
        delete updated.choices;
      }

      // Merge default data for this type
      if (typeConfig.defaultData) {
        Object.assign(updated, typeConfig.defaultData);
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
        choices: [...prev.choices, { id: newId, label: "" }]
      };
    });
  }, []);

  const handleRemoveChoice = useCallback((index: number) => {
    setPollData((prev) => {
      if (!prev.choices || prev.choices.length <= 1) return prev;
      return {
        ...prev,
        choices: prev.choices.filter((_, i) => i !== index)
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

  return (
    <VStack align="stretch" gap={6} p={4}>
      {/* Prompt */}
      <Box>
        <Text fontSize="sm" fontWeight="medium" mb={2} color="fg.default">
          Question Prompt
        </Text>
        <Input placeholder="Enter your poll question..." value={pollData.prompt} onChange={handlePromptChange} />
      </Box>

      {/* Type Selection */}
      <Box>
        <Text fontSize="sm" fontWeight="medium" mb={2} color="fg.default">
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

      {/* Choices - only show if current type requires them */}
      {QUESTION_TYPE_REGISTRY[pollData.type]?.requiresChoices && pollData.choices && (
        <Box>
          <HStack justify="space-between" mb={2}>
            <Text fontSize="sm" fontWeight="medium" color="fg.default">
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

      <Separator />

      {/* JSON Preview */}
      <Box>
        <Text fontSize="sm" fontWeight="medium" mb={2} color="fg.default">
          JSON Preview
        </Text>
        <Box
          p={3}
          bg="bg.subtle"
          borderRadius="md"
          fontSize="xs"
          fontFamily="mono"
          overflow="auto"
          maxH="200px"
          border="1px solid"
          borderColor="border.default"
        >
          <pre style={{ margin: 0, color: "var(--chakra-colors-fg-default)" }}>
            {JSON.stringify(convertToSurveyJSFormat(pollData), null, 2)}
          </pre>
        </Box>
      </Box>
    </VStack>
  );
}

"use client";

import { Button } from "@/components/ui/button";
import { useColorMode } from "@/components/ui/color-mode";
import {
  DialogBody,
  DialogCloseTrigger,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import useAuthState from "@/hooks/useAuthState";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, HStack, Text, Textarea, VStack } from "@chakra-ui/react";
import Editor, { Monaco } from "@monaco-editor/react";
import { useCreate } from "@refinedev/core";
import { configureMonacoYaml } from "monaco-yaml";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { FaPlus } from "react-icons/fa";
import * as YAML from "yaml";

// Type definitions
type FlashcardDeckInsert = Database["public"]["Tables"]["flashcard_decks"]["Insert"];
type FlashcardInsert = Database["public"]["Tables"]["flashcards"]["Insert"];

interface CreateDeckModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

interface FlashcardDeckFormData {
  name: string;
  description?: string;
  yamlContent?: string;
}

interface YamlCard {
  title: string;
  prompt: string;
  answer: string;
}

interface ParsedFlashcardYaml {
  cards?: YamlCard[];
}

function validateYamlCards(cards: YamlCard[]): void {
  for (const [index, card] of cards.entries()) {
    if (!card.title || !card.prompt || !card.answer) {
      throw new Error(`Card ${index + 1} is missing required fields (title, prompt, or answer)`);
    }
    if (typeof card.title !== "string" || typeof card.prompt !== "string" || typeof card.answer !== "string") {
      throw new Error(`Card ${index + 1} fields must be strings`);
    }
    if (card.title.trim().length === 0) {
      throw new Error(`Card ${index + 1} title cannot be empty`);
    }
    if (card.prompt.trim().length === 0) {
      throw new Error(`Card ${index + 1} prompt cannot be empty`);
    }
    if (card.answer.trim().length === 0) {
      throw new Error(`Card ${index + 1} answer cannot be empty`);
    }
  }
}

export default function CreateDeckModal({ isOpen, onClose, onSuccess }: CreateDeckModalProps) {
  const params = useParams();
  const course_id = params.course_id as string;
  const { colorMode } = useColorMode();
  const [yamlValue, setYamlValue] = useState("");
  const { user } = useAuthState();

  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<FlashcardDeckFormData>({
    defaultValues: {
      name: "",
      description: "",
      yamlContent: ""
    }
  });

  const { mutateAsync: createDeck } = useCreate<FlashcardDeckInsert>();
  const { mutateAsync: createFlashcard } = useCreate<FlashcardInsert>();

  // Handle Monaco Editor setup
  const handleEditorWillMount = useCallback((monaco: Monaco) => {
    window.MonacoEnvironment = {
      getWorker(_moduleId, label) {
        switch (label) {
          case "editorWorkerService":
            return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker", import.meta.url));
          case "yaml":
            return new Worker(new URL("monaco-yaml/yaml.worker", import.meta.url));
          default:
            throw new Error(`Unknown label ${label}`);
        }
      }
    };

    configureMonacoYaml(monaco, {
      enableSchemaRequest: false,
      schemas: []
    });
  }, []);

  // Handle YAML editor changes
  const handleYamlChange = useCallback(
    (value: string | undefined) => {
      const newValue = value || "";
      setYamlValue(newValue);
      setValue("yamlContent", newValue);
    },
    [setValue]
  );

  // Form submission handler
  const onSubmit = async (data: FlashcardDeckFormData) => {
    try {
      if (!user?.id) {
        toaster.create({
          title: "Error",
          description: "You must be logged in to create a flashcard deck.",
          type: "error"
        });
        return;
      }

      // Parse YAML content if provided
      let parsedCards: YamlCard[] = [];
      if (data.yamlContent && data.yamlContent.trim() !== "") {
        try {
          const parsedYaml = YAML.parse(data.yamlContent) as ParsedFlashcardYaml;
          if (parsedYaml && parsedYaml.cards && Array.isArray(parsedYaml.cards)) {
            validateYamlCards(parsedYaml.cards);
            parsedCards = parsedYaml.cards;
          } else if (parsedYaml && parsedYaml.cards !== undefined) {
            throw new Error("'cards' must be an array");
          }
        } catch (yamlError) {
          toaster.create({
            title: "YAML Error",
            description: `Invalid YAML: ${yamlError instanceof Error ? yamlError.message : "Unknown YAML parsing error"}`,
            type: "error"
          });
          return;
        }
      }

      // Create the deck (without source_yml)
      const deckData: FlashcardDeckInsert = {
        name: data.name.trim(),
        description: data.description?.trim() || null,
        class_id: Number(course_id),
        creator_id: user.id
      };

      const createdDeckResult = await createDeck({
        resource: "flashcard_decks",
        values: deckData
      });

      const newDeckId = createdDeckResult?.data?.id;

      if (!newDeckId) {
        throw new Error("Failed to create flashcard deck or retrieve its ID.");
      }

      // Create flashcards from parsed YAML
      if (parsedCards.length > 0) {
        for (const [index, card] of parsedCards.entries()) {
          const flashcardData: FlashcardInsert = {
            deck_id: newDeckId,
            class_id: Number(course_id),
            title: card.title.trim(),
            prompt: card.prompt.trim(),
            answer: card.answer.trim(),
            order: index + 1
          };

          await createFlashcard({
            resource: "flashcards",
            values: flashcardData
          });
        }
      }

      toaster.create({
        title: "Success",
        description: `Flashcard deck "${data.name}" has been created successfully${parsedCards.length > 0 ? ` with ${parsedCards.length} cards` : ""}.`,
        type: "success"
      });

      handleClose();
      onSuccess?.();
    } catch (error) {
      toaster.create({
        title: "Error",
        description: `Failed to create flashcard deck: ${error instanceof Error ? error.message : "Unknown error"}`,
        type: "error"
      });
    }
  };

  // Handle modal close
  const handleClose = useCallback(() => {
    reset();
    setYamlValue("");
    onClose();
  }, [reset, onClose]);

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      reset({
        name: "",
        description: "",
        yamlContent: ""
      });
      setYamlValue("");
    }
  }, [isOpen, reset]);

  // Sample YAML template
  const sampleYaml = `# Flashcard Deck Configuration
# Define your flashcards using YAML format

cards:
  - title: "Sample Card 1"
    prompt: |
      What is the capital of France?
    answer: |
      Paris is the capital and largest city of France.
  
  - title: "Sample Card 2"
    prompt: |
      Explain the concept of recursion in programming.
    answer: |
      Recursion is a programming technique where a function calls itself to solve smaller instances of the same problem.
      
      Key components:
      - Base case: condition to stop recursion
      - Recursive case: function calls itself with modified parameters
      
      Example: calculating factorial
      \`\`\`
      factorial(n) = n * factorial(n-1) if n > 1
      factorial(1) = 1 (base case)
      \`\`\``;

  const loadSampleTemplate = () => {
    setYamlValue(sampleYaml);
    setValue("yamlContent", sampleYaml);
  };

  return (
    <DialogRoot
      open={isOpen}
      onOpenChange={(details) => {
        if (!details.open) handleClose();
      }}
      size="xl"
    >
      <DialogContent maxHeight="90vh">
        <DialogHeader>
          <DialogTitle>Create New Flashcard Deck</DialogTitle>
          <DialogCloseTrigger aria-label="Close dialog">
            <FaPlus style={{ transform: "rotate(45deg)" }} />
          </DialogCloseTrigger>
        </DialogHeader>

        <DialogBody overflowY="auto">
          <form onSubmit={handleSubmit(onSubmit)} id="create-deck-form">
            <VStack gap={4} align="stretch">
              {/* Deck Name */}
              <Field label="Deck Name" invalid={!!errors.name} errorText={errors.name?.message} required>
                <Textarea
                  placeholder="Enter a descriptive name for your flashcard deck"
                  {...register("name", {
                    required: "Deck name is required",
                    minLength: {
                      value: 2,
                      message: "Deck name must be at least 2 characters"
                    },
                    maxLength: {
                      value: 100,
                      message: "Deck name must not exceed 100 characters"
                    }
                  })}
                />
              </Field>

              {/* Description */}
              <Field
                label="Description (Optional)"
                invalid={!!errors.description}
                errorText={errors.description?.message}
              >
                <Textarea
                  placeholder="Provide a brief description of this flashcard deck's content and purpose"
                  {...register("description", {
                    maxLength: {
                      value: 500,
                      message: "Description must not exceed 500 characters"
                    }
                  })}
                  rows={3}
                />
              </Field>

              {/* YAML Editor */}
              <Field
                label="Flashcard Configuration (YAML)"
                invalid={!!errors.yamlContent}
                errorText={errors.yamlContent?.message}
              >
                <VStack align="stretch" gap={2} width="100%">
                  <HStack justifyContent="space-between" alignItems="center">
                    <Text fontSize="sm">Define your flashcards using YAML format. You can add more cards later.</Text>
                    <Button size="sm" variant="outline" onClick={loadSampleTemplate} type="button">
                      Load Sample Template
                    </Button>
                  </HStack>

                  <Controller
                    name="yamlContent"
                    control={control}
                    render={() => (
                      <Box border="1px solid" borderRadius="md" overflow="hidden" height="300px" width="100%">
                        <Editor
                          height="300px"
                          width="100%"
                          defaultLanguage="yaml"
                          value={yamlValue}
                          theme={colorMode === "dark" ? "vs-dark" : "vs"}
                          beforeMount={handleEditorWillMount}
                          onChange={handleYamlChange}
                          options={{
                            minimap: { enabled: false },
                            scrollBeyondLastLine: false,
                            fontSize: 14,
                            tabSize: 2,
                            insertSpaces: true,
                            wordWrap: "on",
                            lineNumbers: "on",
                            folding: true,
                            automaticLayout: true
                          }}
                        />
                      </Box>
                    )}
                  />

                  <Text fontSize="xs">
                    The YAML configuration is optional. You can create an empty deck and add cards later through the
                    deck management interface.
                  </Text>
                </VStack>
              </Field>
            </VStack>
          </form>
        </DialogBody>

        <DialogFooter>
          <HStack gap={3} justifyContent="flex-end">
            <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" form="create-deck-form" loading={isSubmitting} colorPalette="green">
              Create Deck
            </Button>
          </HStack>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

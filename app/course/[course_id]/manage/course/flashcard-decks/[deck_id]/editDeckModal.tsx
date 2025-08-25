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
import { useCreate, useDelete, useList, useOne, useUpdate } from "@refinedev/core";
import { configureMonacoYaml } from "monaco-yaml";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { FaPlus } from "react-icons/fa";
import * as YAML from "yaml";

// Supabase types
type FlashcardDeckUpdate = Database["public"]["Tables"]["flashcard_decks"]["Update"];
type FlashcardDeckRow = Database["public"]["Tables"]["flashcard_decks"]["Row"];
type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];
type FlashcardInsert = Database["public"]["Tables"]["flashcards"]["Insert"];
type FlashcardUpdate = Database["public"]["Tables"]["flashcards"]["Update"];

/**
 * This type defines the props for the EditDeckModal component.
 * @param isOpen - Whether the modal is open
 * @param onClose - The function to call when the modal is closed
 * @param deckId - The ID of the deck to edit
 * @param onSuccess - The function to call when the deck is updated successfully
 */
type EditDeckModalProps = {
  isOpen: boolean;
  onClose: () => void;
  deckId: string;
  onSuccess?: () => void;
};

/**
 * This type defines the form data for the EditDeckModal component.
 * @param name - The name of the deck
 * @param description - The description of the deck
 * @param yamlContent - The YAML content of the deck
 */
type FlashcardDeckFormData = {
  name: string;
  description?: string;
  yamlContent?: string;
};

/**
 * This type defines the YAML card for the EditDeckModal component.
 * @param id - The ID of the card
 * @param title - The title of the card
 * @param prompt - The prompt of the card
 * @param answer - The answer of the card
 */
type YamlCard = {
  id?: number;
  title: string;
  prompt: string;
  answer: string;
};

/**
 * This type defines the parsed flashcard YAML for the EditDeckModal component.
 * @param cards - The cards of the deck
 */
type ParsedFlashcardYaml = {
  cards?: YamlCard[];
};

/**
 * This type defines the flashcard changes for the EditDeckModal component.
 * @param toCreate - The cards to create
 * @param toUpdate - The cards to update
 * @param toDelete - The cards to delete
 * @param numItemsWithBadIDs - The number of items with bad IDs
 */
type FlashcardChanges = {
  toCreate: YamlCard[];
  toUpdate: YamlCard[];
  toDelete: number[];
  numItemsWithBadIDs: number;
};

/**
 * This function validates the YAML cards for the EditDeckModal component.
 * @param cards - The cards to validate
 */
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

/**
 * This function finds the flashcard changes for the EditDeckModal component.
 * @param newCards - The new cards
 * @param existingCards - The existing cards
 * @returns The flashcard changes
 */
function findFlashcardChanges(newCards: YamlCard[], existingCards: FlashcardRow[]): FlashcardChanges {
  const existingCardMap = new Map(existingCards.map((card) => [card.id, card]));

  const toCreate: YamlCard[] = [];
  const toUpdate: YamlCard[] = [];

  let numItemsWithBadIDs = 0;
  for (const newCard of newCards) {
    if (newCard.id === undefined || newCard.id === null || newCard.id <= 0) {
      toCreate.push(newCard);
    } else {
      const existingCard = existingCardMap.get(newCard.id);
      if (existingCard) {
        // Check if the card has changed
        if (
          newCard.title !== existingCard.title ||
          newCard.prompt !== existingCard.prompt ||
          newCard.answer !== existingCard.answer
        ) {
          toUpdate.push(newCard);
        }
        existingCardMap.delete(newCard.id);
      } else {
        numItemsWithBadIDs++;
        toCreate.push(newCard);
      }
    }
  }

  const toDelete: number[] = Array.from(existingCardMap.keys());

  return { toCreate, toUpdate, toDelete, numItemsWithBadIDs };
}

/**
 * This function converts the flashcards to YAML for the EditDeckModal component.
 * @param flashcards - The flashcards to convert
 * @returns The YAML content
 */
function flashcardsToYaml(flashcards: FlashcardRow[]): string {
  if (flashcards.length === 0) {
    return `# Flashcard Deck Configuration
# Define your flashcards using YAML format

cards: []`;
  }

  const yamlData = {
    cards: flashcards.map((card) => ({
      id: card.id,
      title: card.title,
      prompt: card.prompt,
      answer: card.answer
    }))
  };

  return YAML.stringify(yamlData, {
    blockQuote: "literal",
    lineWidth: 0
  });
}

/**
 * This component displays a modal for editing a flashcard deck.
 * It allows the user to edit the name, description, and YAML content of the deck.
 * @param isOpen - Whether the modal is open
 * @param onClose - The function to call when the modal is closed
 * @param deckId - The ID of the deck to edit
 * @param onSuccess - The function to call when the deck is updated successfully
 * @returns The EditDeckModal component
 */
export default function EditDeckModal({ isOpen, onClose, deckId, onSuccess }: EditDeckModalProps) {
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

  // Fetch deck data
  const { data: deckData, isLoading: isDeckLoading } = useOne<FlashcardDeckRow>({
    resource: "flashcard_decks",
    id: deckId,
    queryOptions: {
      enabled: !!deckId && isOpen
    }
  });

  // Fetch existing flashcards
  const { data: flashcardsData, isLoading: isFlashcardsLoading } = useList<FlashcardRow>({
    resource: "flashcards",
    filters: [
      {
        field: "deck_id",
        operator: "eq",
        value: deckId
      },
      {
        field: "deleted_at",
        operator: "null",
        value: null
      }
    ],
    sorters: [
      {
        field: "order",
        order: "asc"
      },
      {
        field: "created_at",
        order: "asc"
      }
    ],
    queryOptions: {
      enabled: !!deckId && isOpen
    }
  });

  const { mutateAsync: updateDeck } = useUpdate<FlashcardDeckUpdate>();
  const { mutateAsync: createFlashcard } = useCreate<FlashcardInsert>();
  const { mutateAsync: updateFlashcard } = useUpdate<FlashcardUpdate>();
  const { mutateAsync: deleteFlashcard } = useDelete();

  const deck = deckData?.data;
  const flashcards = useMemo(() => flashcardsData?.data || [], [flashcardsData?.data]);

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

  // Load current deck data into form
  useEffect(() => {
    if (deck && isOpen && !isDeckLoading && !isFlashcardsLoading) {
      // Generate YAML from current flashcard data in database
      const currentYaml = flashcardsToYaml(flashcards);

      reset({
        name: deck.name,
        description: deck.description || "",
        yamlContent: currentYaml
      });

      setYamlValue(currentYaml);
    }
  }, [deck, flashcards, isOpen, isDeckLoading, isFlashcardsLoading, reset]);

  // Form submission handler
  const onSubmit = async (data: FlashcardDeckFormData) => {
    try {
      if (!user?.id || !deck) {
        toaster.create({
          title: "Error",
          description: "You must be logged in to edit a flashcard deck.",
          type: "error"
        });
        return;
      }

      // Parse YAML content
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

      // Update the deck metadata (without source_yml)
      const deckUpdateData: FlashcardDeckUpdate = {
        name: data.name.trim(),
        description: data.description?.trim() || null,
        updated_at: new Date().toISOString()
      };

      await updateDeck({
        resource: "flashcard_decks",
        id: deck.id,
        values: deckUpdateData
      });

      // Handle flashcard changes
      const flashcardChanges = findFlashcardChanges(parsedCards, flashcards);

      if (flashcardChanges.numItemsWithBadIDs > 0) {
        toaster.create({
          title: "Items in YAML had invalid IDs",
          description: `${flashcardChanges.numItemsWithBadIDs} items found with an "id" that appears to be a copy/paste from elsewhere. Treating as new items.`,
          type: "warning"
        });
      }

      // Delete removed flashcards
      await Promise.all(
        flashcardChanges.toDelete.map((id: number) =>
          deleteFlashcard({
            resource: "flashcards",
            id: id
          })
        )
      );

      // Create new flashcards with temporary order values
      const createdCardIds: number[] = [];
      for (const card of flashcardChanges.toCreate) {
        const flashcardData: FlashcardInsert = {
          deck_id: deck.id,
          class_id: Number(course_id),
          title: card.title.trim(),
          prompt: card.prompt.trim(),
          answer: card.answer.trim(),
          order: Number.MAX_SAFE_INTEGER // Temporary order to avoid conflicts during creation
        };

        const result = await createFlashcard({
          resource: "flashcards",
          values: flashcardData
        });

        if (result.data?.id) {
          createdCardIds.push(result.data.id);
        }
      }

      // Update existing flashcards content (not order yet)
      await Promise.all(
        flashcardChanges.toUpdate.map((card) => {
          const updateData: FlashcardUpdate = {
            title: card.title.trim(),
            prompt: card.prompt.trim(),
            answer: card.answer.trim(),
            updated_at: new Date().toISOString()
          };

          return updateFlashcard({
            resource: "flashcards",
            id: card.id!,
            values: updateData
          });
        })
      );

      // Now update order for all cards based on their position in the parsed YAML
      // This ensures consistent ordering for both new and existing cards
      let createdCardIndex = 0;
      for (const [index, card] of parsedCards.entries()) {
        if (card.id && card.id > 0) {
          // Existing card - update its order
          await updateFlashcard({
            resource: "flashcards",
            id: card.id,
            values: { order: index + 1 }
          });
        } else {
          // New card - update its order using the created card ID
          if (createdCardIndex < createdCardIds.length) {
            await updateFlashcard({
              resource: "flashcards",
              id: createdCardIds[createdCardIndex],
              values: { order: index + 1 }
            });
            createdCardIndex++;
          }
        }
      }

      toaster.create({
        title: "Success",
        description: `Flashcard deck "${data.name}" has been updated successfully.`,
        type: "success"
      });

      handleClose();
      onSuccess?.();
    } catch (error) {
      toaster.create({
        title: "Error",
        description: `Failed to update flashcard deck: ${error instanceof Error ? error.message : "Unknown error"}`,
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

  if (isDeckLoading || isFlashcardsLoading) {
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
            <DialogTitle>Edit Flashcard Deck</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <VStack align="center" justify="center" h="300px">
              <Text>Loading deck...</Text>
            </VStack>
          </DialogBody>
        </DialogContent>
      </DialogRoot>
    );
  }

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
          <DialogTitle>Edit Flashcard Deck</DialogTitle>
          <DialogCloseTrigger aria-label="Close dialog">
            <FaPlus style={{ transform: "rotate(45deg)" }} />
          </DialogCloseTrigger>
        </DialogHeader>

        <DialogBody overflowY="auto">
          <form onSubmit={handleSubmit(onSubmit)} id="edit-deck-form">
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
                  <Text fontSize="sm">
                    Edit your flashcards using YAML format. Changes will update the corresponding database records.
                  </Text>

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
                    Note: Cards with valid IDs will be updated, cards without IDs will be created as new cards, and
                    cards removed from the YAML will be deleted.
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
            <Button type="submit" form="edit-deck-form" loading={isSubmitting} colorPalette="green">
              Update Deck
            </Button>
          </HStack>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { VStack, HStack, Text, Textarea, Box } from "@chakra-ui/react";
import { useForm, Controller } from "react-hook-form";
import { useParams } from "next/navigation";
import { useCreate } from "@refinedev/core";
import Editor, { Monaco } from "@monaco-editor/react";
import { configureMonacoYaml } from "monaco-yaml";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogCloseTrigger
} from "@/components/ui/dialog";
import { toaster } from "@/components/ui/toaster";
import { useColorMode } from "@/components/ui/color-mode";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { FaPlus } from "react-icons/fa";
import useAuthState from "@/hooks/useAuthState";

// Type definitions
type FlashcardDeckInsert = Database["public"]["Tables"]["flashcard_decks"]["Insert"];

interface CreateDeckModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

interface FlashcardDeckFormData {
  name: string;
  description?: string;
  source_yml?: string;
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
      source_yml: ""
    }
  });

  const { mutateAsync: createDeck } = useCreate<FlashcardDeckInsert>();

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
      setValue("source_yml", newValue);
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

      const deckData: FlashcardDeckInsert = {
        name: data.name.trim(),
        description: data.description?.trim() || null,
        source_yml: data.source_yml?.trim() || null,
        class_id: Number(course_id),
        creator_id: user.id
      };

      await createDeck({
        resource: "flashcard_decks",
        values: deckData
      });

      toaster.create({
        title: "Success",
        description: `Flashcard deck "${data.name}" has been created successfully.`,
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
        source_yml: ""
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
    setValue("source_yml", sampleYaml);
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

        <DialogBody>
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
                invalid={!!errors.source_yml}
                errorText={errors.source_yml?.message}
              >
                <VStack align="stretch" gap={2}>
                  <HStack justifyContent="space-between" alignItems="center">
                    <Text fontSize="sm" color="gray.600">
                      Define your flashcards using YAML format. You can edit this later.
                    </Text>
                    <Button size="sm" variant="outline" onClick={loadSampleTemplate} type="button">
                      Load Sample Template
                    </Button>
                  </HStack>

                  <Controller
                    name="source_yml"
                    control={control}
                    render={() => (
                      <Box
                        border="1px solid"
                        borderColor="border.default"
                        borderRadius="md"
                        overflow="hidden"
                        height="300px"
                      >
                        <Editor
                          height="300px"
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

                  <Text fontSize="xs" color="gray.500">
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
            <Button variant="outline" colorPalette="gray" onClick={handleClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" form="create-deck-form" loading={isSubmitting} colorPalette="blue">
              Create Deck
            </Button>
          </HStack>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

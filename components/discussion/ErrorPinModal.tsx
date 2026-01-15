"use client";

import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useAssignments } from "@/hooks/useCourseController";
import { createClient } from "@/utils/supabase/client";
import { Json } from "@/utils/supabase/SupabaseTypes";
import {
  Box,
  Button as ChakraButton,
  Dialog,
  Field,
  HStack,
  Icon,
  Input,
  NativeSelect,
  Stack,
  Text
} from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { BsPlus, BsTrash, BsX } from "react-icons/bs";

type ErrorPinRuleTarget =
  | "grader_output_student"
  | "grader_output_hidden"
  | "lint_output"
  | "test_name"
  | "test_part"
  | "test_output"
  | "test_hidden_output"
  | "test_score_range"
  | "grader_score_range"
  | "lint_failed";

type MatchType = "contains" | "regex" | "equals" | "range";

interface ErrorPinRule {
  target: ErrorPinRuleTarget;
  match_type: MatchType;
  match_value: string;
  match_value_max?: string;
  test_name_filter?: string;
  ordinal: number;
}

interface ErrorPinFormData {
  assignment_id: number | null;
  rule_logic: "and" | "or";
  enabled: boolean;
  rules: ErrorPinRule[];
}

interface ErrorPinModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  discussion_thread_id: number;
  existingPinId?: number;
}

const RULE_TARGETS: { value: ErrorPinRuleTarget; label: string }[] = [
  { value: "test_name", label: "Test Name" },
  { value: "test_part", label: "Test Part" },
  { value: "test_output", label: "Test Output (Student Visible)" },
  { value: "test_hidden_output", label: "Test Hidden Output" },
  { value: "test_score_range", label: "Test Score Range" },
  { value: "grader_output_student", label: "Grader Output (Student Visible)" },
  { value: "grader_output_hidden", label: "Grader Output (Hidden)" },
  { value: "lint_output", label: "Lint Output" },
  { value: "lint_failed", label: "Lint Failed" },
  { value: "grader_score_range", label: "Grader Score Range" }
];

const MATCH_TYPES: { value: MatchType; label: string; supportsRange: boolean }[] = [
  { value: "contains", label: "Contains", supportsRange: false },
  { value: "equals", label: "Equals", supportsRange: false },
  { value: "regex", label: "Regex Match", supportsRange: false },
  { value: "range", label: "Range", supportsRange: true }
];

export function ErrorPinModal({ isOpen, onClose, onSuccess, discussion_thread_id, existingPinId }: ErrorPinModalProps) {
  const { course_id } = useParams();
  const assignments = useAssignments();
  const { private_profile_id } = useClassProfiles();
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);

  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<ErrorPinFormData>({
    defaultValues: {
      assignment_id: null,
      rule_logic: "and",
      enabled: true,
      rules: []
    }
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "rules"
  });

  const assignmentId = watch("assignment_id");
  const rules = watch("rules");

  // Load existing pin data if editing
  const { data: existingPin } = useQuery({
    queryKey: ["error_pin", existingPinId],
    queryFn: async () => {
      if (!existingPinId) return null;
      const supabase = createClient();
      const { data: pin, error } = await supabase.from("error_pins").select("*").eq("id", existingPinId).single();
      if (error) throw error;
      return pin;
    },
    enabled: !!existingPinId
  });

  const { data: existingRules } = useQuery({
    queryKey: ["error_pin_rules", existingPinId],
    queryFn: async () => {
      if (!existingPinId) return null;
      const supabase = createClient();
      const { data: rules, error } = await supabase
        .from("error_pin_rules")
        .select("*")
        .eq("error_pin_id", existingPinId)
        .order("ordinal");
      if (error) throw error;
      return rules;
    },
    enabled: !!existingPinId
  });

  // Reset form when existing pin data loads
  useMemo(() => {
    if (existingPin && existingRules) {
      reset({
        assignment_id: existingPin.assignment_id,
        rule_logic: existingPin.rule_logic as "and" | "or",
        enabled: existingPin.enabled,
        rules: existingRules.map((r) => ({
          target: r.target as ErrorPinRuleTarget,
          match_type: r.match_type as MatchType,
          match_value: r.match_value,
          match_value_max: r.match_value_max || undefined,
          test_name_filter: r.test_name_filter || undefined,
          ordinal: r.ordinal
        }))
      });
    }
  }, [existingPin, existingRules, reset]);

  const handleClose = () => {
    reset();
    setPreviewCount(null);
    setIsPreviewing(false);
    onClose();
  };

  const handlePreview = async () => {
    if (!assignmentId || rules.length === 0) {
      toaster.error({
        title: "Error",
        description: "Please select an assignment and add at least one rule"
      });
      return;
    }

    setIsPreviewing(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("preview_error_pin_matches", {
        p_assignment_id: assignmentId,
        p_rules: rules as unknown as Json,
        p_rule_logic: watch("rule_logic")
      });

      if (error) throw error;
      const result = data as { match_count?: number; submission_ids?: number[] } | null;
      setPreviewCount(result?.match_count || 0);
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to preview matches: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      setIsPreviewing(false);
    }
  };

  const onSubmit = async (data: ErrorPinFormData) => {
    if (!data.assignment_id || data.rules.length === 0) {
      toaster.error({
        title: "Error",
        description: "Please select an assignment and add at least one rule"
      });
      return;
    }

    if (!private_profile_id) {
      toaster.error({
        title: "Error",
        description: "User profile not found"
      });
      return;
    }

    try {
      const supabase = createClient();
      const pinData = {
        id: existingPinId || undefined,
        discussion_thread_id,
        assignment_id: data.assignment_id,
        class_id: Number(course_id),
        created_by: private_profile_id,
        rule_logic: data.rule_logic,
        enabled: data.enabled
      };

      const { error } = await supabase.rpc("save_error_pin", {
        p_error_pin: pinData as unknown as Json,
        p_rules: data.rules.map((r, idx) => ({
          ...r,
          ordinal: idx
        })) as unknown as Json
      });

      if (error) throw error;

      toaster.success({
        title: "Success",
        description: existingPinId ? "Error pin updated successfully" : "Error pin created successfully"
      });

      handleClose();
      onSuccess();
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to save error pin: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && handleClose()} size="xl">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>{existingPinId ? "Edit Error Pin" : "Create Error Pin"}</Dialog.Title>
            <Dialog.CloseTrigger asChild>
              <ChakraButton variant="ghost" colorPalette="red" size="sm">
                <Icon as={BsX} />
              </ChakraButton>
            </Dialog.CloseTrigger>
          </Dialog.Header>

          <Dialog.Body>
            <form onSubmit={handleSubmit(onSubmit)}>
              <Stack spaceY={4}>
                <Field.Root invalid={!!errors.assignment_id}>
                  <Field.Label>Assignment</Field.Label>
                  <NativeSelect.Root>
                    <NativeSelect.Field
                      {...register("assignment_id", {
                        required: "Assignment is required",
                        valueAsNumber: true
                      })}
                    >
                      <option value="">Select an assignment</option>
                      {assignments.map((assignment) => (
                        <option key={assignment.id} value={assignment.id}>
                          {assignment.title}
                        </option>
                      ))}
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                  <Field.ErrorText>{errors.assignment_id?.message}</Field.ErrorText>
                </Field.Root>

                <Controller
                  control={control}
                  name="rule_logic"
                  render={({ field }) => (
                    <Field.Root>
                      <Field.Label>Rule Logic</Field.Label>
                      <NativeSelect.Root>
                        <NativeSelect.Field {...field}>
                          <option value="and">All rules must match (AND)</option>
                          <option value="or">Any rule must match (OR)</option>
                        </NativeSelect.Field>
                      </NativeSelect.Root>
                      <Field.HelperText>
                        {field.value === "and"
                          ? "All rules must match for the pin to be shown"
                          : "Any rule matching will show the pin"}
                      </Field.HelperText>
                    </Field.Root>
                  )}
                />

                <Controller
                  control={control}
                  name="enabled"
                  render={({ field }) => (
                    <Field.Root>
                      <ChakraButton
                        variant={field.value ? "solid" : "outline"}
                        colorPalette={field.value ? "green" : "gray"}
                        onClick={() => field.onChange(!field.value)}
                        size="sm"
                      >
                        {field.value ? "Enabled" : "Disabled"}
                      </ChakraButton>
                      <Field.HelperText>Disable to temporarily hide this pin without deleting it</Field.HelperText>
                    </Field.Root>
                  )}
                />

                <Box>
                  <HStack justify="space-between" mb={2}>
                    <Field.Label>Rules</Field.Label>
                    <ChakraButton
                      size="xs"
                      onClick={() =>
                        append({
                          target: "test_name",
                          match_type: "contains",
                          match_value: "",
                          ordinal: fields.length
                        })
                      }
                    >
                      <Icon as={BsPlus} mr={1} />
                      Add Rule
                    </ChakraButton>
                  </HStack>

                  {fields.length === 0 && (
                    <Text color="fg.muted" fontSize="sm" mb={2}>
                      Add at least one rule to match against submission errors
                    </Text>
                  )}

                  {fields.map((field, index) => {
                    const matchType = watch(`rules.${index}.match_type`);
                    const target = watch(`rules.${index}.target`);
                    const supportsRange = MATCH_TYPES.find((mt) => mt.value === matchType)?.supportsRange || false;
                    const isRangeTarget = target === "test_score_range" || target === "grader_score_range";

                    return (
                      <Box
                        key={field.id}
                        border="1px solid"
                        borderColor="border.emphasized"
                        borderRadius="md"
                        p={3}
                        mb={2}
                      >
                        <HStack justify="space-between" mb={2}>
                          <Text fontWeight="semibold">Rule {index + 1}</Text>
                          <ChakraButton size="xs" variant="ghost" colorPalette="red" onClick={() => remove(index)}>
                            <Icon as={BsTrash} />
                          </ChakraButton>
                        </HStack>

                        <Stack spaceY={2}>
                          <Field.Root>
                            <Field.Label>Target</Field.Label>
                            <NativeSelect.Root>
                              <NativeSelect.Field {...register(`rules.${index}.target`)}>
                                {RULE_TARGETS.map((t) => (
                                  <option key={t.value} value={t.value}>
                                    {t.label}
                                  </option>
                                ))}
                              </NativeSelect.Field>
                            </NativeSelect.Root>
                          </Field.Root>

                          <Field.Root>
                            <Field.Label>Match Type</Field.Label>
                            <NativeSelect.Root>
                              <NativeSelect.Field {...register(`rules.${index}.match_type`)}>
                                {MATCH_TYPES.filter((mt) => {
                                  // Range targets only support range match type
                                  if (isRangeTarget) {
                                    return mt.value === "range";
                                  }
                                  // lint_failed doesn't need match type
                                  if (target === "lint_failed") {
                                    return false;
                                  }
                                  return true;
                                }).map((mt) => (
                                  <option key={mt.value} value={mt.value}>
                                    {mt.label}
                                  </option>
                                ))}
                              </NativeSelect.Field>
                            </NativeSelect.Root>
                          </Field.Root>

                          {target !== "lint_failed" && (
                            <>
                              {supportsRange || isRangeTarget ? (
                                <HStack>
                                  <Field.Root flex="1">
                                    <Field.Label>Min Value</Field.Label>
                                    <Input
                                      {...register(`rules.${index}.match_value`, { required: "Value is required" })}
                                      type="number"
                                      placeholder="Minimum"
                                    />
                                  </Field.Root>
                                  <Field.Root flex="1">
                                    <Field.Label>Max Value</Field.Label>
                                    <Input
                                      {...register(`rules.${index}.match_value_max`)}
                                      type="number"
                                      placeholder="Maximum (optional)"
                                    />
                                  </Field.Root>
                                </HStack>
                              ) : (
                                <Field.Root>
                                  <Field.Label>Match Value</Field.Label>
                                  <Input
                                    {...register(`rules.${index}.match_value`, { required: "Value is required" })}
                                    placeholder={
                                      matchType === "regex"
                                        ? "Regular expression pattern"
                                        : matchType === "equals"
                                          ? "Exact match"
                                          : "Text to search for"
                                    }
                                  />
                                </Field.Root>
                              )}

                              {target.startsWith("test_") && target !== "test_score_range" && (
                                <Field.Root>
                                  <Field.Label>Test Name Filter (Optional)</Field.Label>
                                  <Input
                                    {...register(`rules.${index}.test_name_filter`)}
                                    placeholder="Regex pattern to filter by test name (e.g., '^Test.*')"
                                  />
                                  <Field.HelperText>
                                    Only apply this rule to tests whose names match this pattern
                                  </Field.HelperText>
                                </Field.Root>
                              )}
                            </>
                          )}
                        </Stack>
                      </Box>
                    );
                  })}
                </Box>

                {previewCount !== null && (
                  <Box p={3} bg="blue.50" borderRadius="md" _dark={{ bg: "blue.900" }}>
                    <Text fontWeight="semibold" color="blue.600" _dark={{ color: "blue.300" }}>
                      Preview: {previewCount} submission{previewCount !== 1 ? "s" : ""} would match this pin
                    </Text>
                  </Box>
                )}
              </Stack>
            </form>
          </Dialog.Body>

          <Dialog.Footer>
            <HStack justify="space-between" w="100%">
              <ChakraButton
                variant="outline"
                onClick={handlePreview}
                loading={isPreviewing}
                disabled={!assignmentId || rules.length === 0}
              >
                Preview Matches
              </ChakraButton>
              <HStack gap={3}>
                <ChakraButton colorPalette="red" onClick={handleClose}>
                  Cancel
                </ChakraButton>
                <ChakraButton
                  colorPalette="green"
                  onClick={handleSubmit(onSubmit)}
                  loading={isSubmitting}
                  disabled={!assignmentId || rules.length === 0}
                >
                  {existingPinId ? "Update Pin" : "Create Pin"}
                </ChakraButton>
              </HStack>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

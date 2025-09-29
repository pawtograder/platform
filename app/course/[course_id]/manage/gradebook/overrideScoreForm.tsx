"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { useGradebookController, useLinkToAssignment } from "@/hooks/useGradebook";
import { GradebookColumnStudent } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, HStack, Heading, Input, Link, Separator, Text, VStack } from "@chakra-ui/react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";

export function OverrideScoreForm({
  studentGradebookColumn,
  onSuccess,
  isAutoCalculated,
  showWarning
}: {
  studentGradebookColumn: GradebookColumnStudent;
  onSuccess?: () => void;
  isAutoCalculated?: boolean;
  showWarning?: boolean;
}) {
  const gradebookController = useGradebookController();
  const linkToAssignment = useLinkToAssignment(
    studentGradebookColumn.gradebook_column_id,
    studentGradebookColumn.student_id
  );

  const {
    register,
    setFocus,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<Partial<GradebookColumnStudent>>({
    defaultValues: {
      is_droppable: studentGradebookColumn.is_droppable,
      is_excused: studentGradebookColumn.is_excused,
      is_missing: studentGradebookColumn.is_missing,
      score_override: studentGradebookColumn.score_override ?? undefined,
      score: studentGradebookColumn.score ?? undefined
    }
  });

  // Watch form values for checkboxes
  const watchedValues = watch();
  const column = gradebookController.getGradebookColumn(studentGradebookColumn.gradebook_column_id);
  const renderer = gradebookController.getRendererForColumn(studentGradebookColumn.gradebook_column_id);

  useEffect(() => {
    if (isAutoCalculated) {
      setFocus("score_override");
    } else {
      setFocus("score");
    }
  }, [isAutoCalculated, setFocus]);

  const onSubmit = async (values: Partial<GradebookColumnStudent>) => {
    // Normalize NaN values to null
    const normalizedScore = values.score !== undefined && Number.isNaN(values.score) ? null : values.score;
    const normalizedOverride = values.score_override !== undefined && Number.isNaN(values.score_override) ? null : values.score_override;
    
    const forceMissingOff =
      (normalizedScore !== undefined || normalizedOverride !== undefined) &&
      !studentGradebookColumn.score &&
      !studentGradebookColumn.score_override &&
      studentGradebookColumn.is_missing;
    await gradebookController.updateGradebookColumnStudent(studentGradebookColumn.id, {
      ...values,
      score: values.is_missing && !forceMissingOff ? null : normalizedScore,
      score_override: normalizedOverride,
      is_missing: forceMissingOff ? false : values.is_missing
    });
    if (onSuccess) onSuccess();
  };

  return (
    <Box as="form" onSubmit={handleSubmit(onSubmit)} minW="300px">
      <VStack gap={2} align="stretch">
        {!isAutoCalculated && (
          <HStack gap={2} align="stretch">
            <Field label="Score" errorText={errors.score?.message?.toString()} flexGrow={1}>
              <Input type="number" step="any" {...register("score", { valueAsNumber: true })} />
            </Field>
            {renderer && (
              <Field label="New Score" flexGrow={0} flexShrink={1}>
                {renderer({
                  ...studentGradebookColumn,
                  score: watchedValues.score ?? 0,
                  max_score: column?.max_score ?? 0
                })}
              </Field>
            )}
          </HStack>
        )}
        {isAutoCalculated && (
          <Box w="100%" border="1px solid" borderColor="border.warning" p={1} borderRadius="md">
            <HStack>
              <Separator flex="1" />
              <Heading size="sm" color="fg.warning">
                Override score from {studentGradebookColumn.score ?? "N/A"}
              </Heading>
              <Separator flex="1" />
            </HStack>
            {showWarning && (
              <Heading size="sm" color="fg.warning">
                This column is automatically calculated{" "}
                {linkToAssignment && (
                  <Link href={linkToAssignment} target="_blank" color="fg.info" tabIndex={-1}>
                    (View Submission)
                  </Link>
                )}
              </Heading>
            )}
            <Text fontSize="sm" color="fg.warning">
              {showWarning
                ? "There are very, very few cases where you should override the score. However, you CAN do so here. Note that other instructors and graders, AS WELL AS THE STUDENT will see that it was overriden from the default calculated value. Your override will persist through recalculation."
                : "This score was imported from an external source and you are overriding it. You and other graders will be able to see that it was overriden from the import, but students will not. Your override will persist through re-imports."}
            </Text>
            <HStack gap={0}>
              <Field label="Score" errorText={errors.score_override?.message?.toString()} flex={1} minW="5em">
                <Input
                  type="number"
                  {...register("score_override", { valueAsNumber: true })}
                  placeholder={studentGradebookColumn.score?.toString()}
                />
              </Field>
              {renderer && (
                <Field label="New Score" flexGrow={0} flexShrink={1}>
                  {renderer({
                    ...studentGradebookColumn,
                    score:
                      watchedValues.score_override === undefined || Number.isNaN(watchedValues.score_override)
                        ? (watchedValues.score ?? 0)
                        : watchedValues.score_override,
                    max_score: column?.max_score ?? 0
                  })}
                </Field>
              )}
              <Field label="Note" errorText={errors.score_override_note?.message?.toString()} flexGrow={20}>
                <Input type="text" {...register("score_override_note")} />
              </Field>
            </HStack>
          </Box>
        )}
        <HStack justify="space-between">
          <HStack gap={4}>
            <Checkbox {...register("is_droppable")} checked={watchedValues.is_droppable ?? false}>
              Droppable
            </Checkbox>
            <Checkbox {...register("is_excused")} checked={watchedValues.is_excused ?? false}>
              Excused
            </Checkbox>
            <Checkbox {...register("is_missing")} checked={watchedValues.is_missing ?? false}>
              Missing
            </Checkbox>
          </HStack>
          <Button
            type="submit"
            loading={isSubmitting}
            colorPalette={showWarning ? "orange" : "green"}
            size="xs"
            alignSelf="end"
          >
            {showWarning ? "Override" : "Update"}
          </Button>
          {showWarning && (
            <Button
              size="xs"
              colorPalette="orange"
              variant="surface"
              onClick={async () => {
                await gradebookController.updateGradebookColumnStudent(studentGradebookColumn.id, {
                  score_override: null
                });
                if (onSuccess) onSuccess();
              }}
            >
              Reset
            </Button>
          )}
        </HStack>
      </VStack>
    </Box>
  );
}

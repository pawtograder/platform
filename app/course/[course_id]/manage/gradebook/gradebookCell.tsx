"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { useColorMode } from "@/components/ui/color-mode";
import { Field } from "@/components/ui/field";
import { Tooltip } from "@/components/ui/tooltip";
import { useCanShowGradeFor } from "@/hooks/useCourseController";
import {
  useGradebookColumn,
  useGradebookColumnStudent,
  useGradebookController,
  useLinkToAssignment
} from "@/hooks/useGradebook";
import { IncompleteValuesAdvice } from "@/hooks/useGradebookWhatIf";
import { GradebookColumnStudent } from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Button,
  Float,
  HStack,
  Heading,
  Icon,
  Input,
  Link,
  Popover,
  Portal,
  Separator,
  Text,
  VStack
} from "@chakra-ui/react";
import { memo, useEffect, useId, useState } from "react";
import { useForm } from "react-hook-form";
import { FaRobot } from "react-icons/fa6";
import { LuCalculator } from "react-icons/lu";

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
    const forceMissingOff =
      (values.score !== undefined || values.score_override !== undefined) &&
      !studentGradebookColumn.score &&
      !studentGradebookColumn.score_override &&
      studentGradebookColumn.is_missing;
    await gradebookController.gradebook_column_students.update(studentGradebookColumn.id, {
      ...values,
      score: values.is_missing && !forceMissingOff ? null : values.score,
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
          {!showWarning && (
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
          )}
          <Button
            type="submit"
            loading={isSubmitting}
            colorPalette={showWarning ? "orange" : "green"}
            size="sm"
            alignSelf="end"
          >
            {showWarning ? "Save Override" : "Update"}
          </Button>
          {showWarning && (
            <Button
              size="sm"
              colorPalette="orange"
              variant="surface"
              onClick={async () => {
                await gradebookController.gradebook_column_students.update(studentGradebookColumn.id, {
                  score_override: null
                });
                if (onSuccess) onSuccess();
              }}
            >
              Clear Override
            </Button>
          )}
        </HStack>
      </VStack>
    </Box>
  );
}
export const GradeCellOverlay = memo(function GradeCellOverlay({ studentId }: { studentId: string }) {
  const canShowGradeFor = useCanShowGradeFor(studentId);
  const { colorMode } = useColorMode();
  if (!canShowGradeFor) {
    return (
      <Box
        position="absolute"
        top={0}
        left={0}
        w="100%"
        h="100%"
        bg={colorMode === "light" ? "rgba(220,220,220,0.7)" : "rgba(100,100,100,0.7)"}
        style={{ backdropFilter: "blur(8px)" }}
        pointerEvents="auto"
        zIndex={2}
      />
    );
  }
  return null;
});
export function GradebookColumnExpression() {
  return (
    <VStack gap={1} w="100%" p={1} borderRadius="md" mb={2} align="flex-start">
      <HStack gap={2} w="100%" p={0} borderRadius="md">
        <Icon as={FaRobot} color="fg.info" />
        <Heading size="sm">This column is automatically calculated</Heading>
      </HStack>
      <Text fontSize="sm" color="fg.muted">
        Your override will persist through recalculation
      </Text>
    </VStack>
  );
}

export function IncompleteValuesList(incompleteValues: IncompleteValuesAdvice) {
  const allKeys: string[] = [];
  if (incompleteValues.missing?.gradebook_columns) {
    allKeys.push(...incompleteValues.missing.gradebook_columns);
  }
  if (incompleteValues.not_released?.gradebook_columns) {
    allKeys.push(...incompleteValues.not_released.gradebook_columns);
  }
  return allKeys.join(", ");
}
export default function GradebookCell({ columnId, studentId }: { columnId: number; studentId: string }) {
  const gradebookController = useGradebookController();
  const column = useGradebookColumn(columnId);
  const [isEditing, setIsEditing] = useState(false);
  const studentGradebookColumn = useGradebookColumnStudent(columnId, studentId);
  const triggerId = useId();

  // Handle case where student doesn't have a gradebook entry yet (normal during imports or new columns)
  if (!studentGradebookColumn) {
    return (
      <Box p={2} minH="40px" display="flex" alignItems="center" justifyContent="center">
        <Text fontSize="sm" color="fg.muted">
          -
        </Text>
      </Box>
    );
  }

  let scoreAdvice: string | undefined = undefined;
  if (column.score_expression) {
    scoreAdvice = `This column is automatically calculated.`;
  } else if (studentGradebookColumn?.score_override) {
    if (studentGradebookColumn.score) {
      scoreAdvice = `This column has been overridden from ${studentGradebookColumn.score} to ${studentGradebookColumn.score_override}`;
    } else {
      scoreAdvice = `This column has been overridden from undefined to ${studentGradebookColumn.score_override}`;
    }
    if (studentGradebookColumn.score_override_note) {
      scoreAdvice += ` with note: ${studentGradebookColumn.score_override_note}`;
    }
  }
  if (column.render_expression && !scoreAdvice) {
    scoreAdvice = `Raw score: ${studentGradebookColumn?.score_override ?? studentGradebookColumn?.score ?? "Missing"}`;
  }
  const isSpecial =
    studentGradebookColumn?.score_override || studentGradebookColumn?.is_excused || !studentGradebookColumn;

  if (!studentGradebookColumn) {
    scoreAdvice = `Missing ${columnId} for ${studentId}`;
  }
  if (studentGradebookColumn?.incomplete_values) {
    scoreAdvice = `${scoreAdvice ? scoreAdvice + "\n" : ""}This calculated column is missing these values: ${IncompleteValuesList(studentGradebookColumn.incomplete_values as IncompleteValuesAdvice)}`;
  }
  return (
    <>
      <style>
        {`
          .pulse-animation {
            animation: pulse 2s ease-in-out infinite;
          }
          @keyframes pulse {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 1; }
          }
        `}
      </style>
      <Box
        w="100%"
        textAlign="right"
        border="1px solid"
        borderColor="border.muted"
        position="relative"
        _hover={{ border: "2px solid border.info", borderColor: "border.info" }}
      >
        <Popover.Root
          positioning={{
            placement: "bottom",
            strategy: "fixed"
          }}
          lazyMount
          unmountOnExit
          open={isEditing}
          ids={{ trigger: triggerId }}
          onOpenChange={(details) => {
            setIsEditing(details.open);
          }}
        >
          <Tooltip
            content={scoreAdvice}
            positioning={{ placement: "top" }}
            showArrow={true}
            ids={{ trigger: triggerId }}
            disabled={!scoreAdvice}
          >
            <Popover.Trigger asChild>
              <Box
                cursor="pointer"
                w="100%"
                h="100%"
                py={1}
                px={4}
                border="1px solid"
                borderColor={isEditing ? "border.info" : "border.subtle"}
                _hover={{ border: "2px solid border.info", borderColor: "border.info" }}
                _active={{ border: "2px solid border.info", borderColor: "border.info" }}
                position="relative"
                role="gridcell"
                aria-label={`Grade cell for ${column.name}: ${
                  studentGradebookColumn &&
                  (studentGradebookColumn?.score !== undefined || studentGradebookColumn?.score_override !== undefined)
                    ? gradebookController.getRendererForColumn(column.id)({
                        ...studentGradebookColumn,
                        max_score: column.max_score
                      })
                    : "Not available"
                }`}
                aria-describedby={scoreAdvice ? `grade-advice-${columnId}-${studentId}` : undefined}
                tabIndex={0}
              >
                {isSpecial && (
                  <Float placement="top-end" offset={3}>
                    <Box color="red.500" fontWeight="bold" fontSize="lg" pointerEvents="none">
                      *
                    </Box>
                  </Float>
                )}
                {studentGradebookColumn?.is_recalculating && (
                  <Float placement="bottom-end" offset={2}>
                    <Box color="fg.info" pointerEvents="none" className="pulse-animation">
                      <Icon as={LuCalculator} size="sm" />
                    </Box>
                  </Float>
                )}
                {studentGradebookColumn?.incomplete_values && (
                  <Float placement="top-end" offset={3}>
                    <Box color="blue.500" fontWeight="bold" fontSize="lg" pointerEvents="none">
                      *
                    </Box>
                  </Float>
                )}
                <Text>
                  {studentGradebookColumn &&
                  (studentGradebookColumn?.score !== undefined || studentGradebookColumn?.score_override !== undefined)
                    ? gradebookController.getRendererForColumn(column.id)({
                        ...studentGradebookColumn,
                        max_score: column.max_score
                      })
                    : "(N/A)"}
                </Text>
              </Box>
            </Popover.Trigger>
          </Tooltip>
          <Portal>
            <Popover.Positioner>
              <Popover.Content w="lg" maxH="80vh" bg={column.score_expression ? "bg.warning" : "bg.panel"}>
                <Popover.Arrow />
                <Popover.Body p={1} m={2}>
                  {studentGradebookColumn && (
                    <OverrideScoreForm
                      studentGradebookColumn={studentGradebookColumn}
                      onSuccess={() => setIsEditing(false)}
                      isAutoCalculated={column.score_expression !== null || column.external_data !== null}
                      showWarning={column.score_expression !== null}
                    />
                  )}
                </Popover.Body>
              </Popover.Content>
            </Popover.Positioner>
          </Portal>
        </Popover.Root>
        <GradeCellOverlay studentId={studentId} />
      </Box>
    </>
  );
}

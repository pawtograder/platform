"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { useColorMode } from "@/components/ui/color-mode";
import { Field } from "@/components/ui/field";
import PersonName from "@/components/ui/person-name";
import { Tooltip } from "@/components/ui/tooltip";
import { useCanShowGradeFor } from "@/hooks/useCourseController";
import {
  useGradebookColumn,
  useGradebookColumnStudent,
  useGradebookController,
  useReferencedContent
} from "@/hooks/useGradebook";
import { GradebookColumnStudent } from "@/utils/supabase/DatabaseTypes";
import { Alert, Box, Button, Code, HStack, Icon, Input, Popover, Portal, Text, VStack } from "@chakra-ui/react";
import { useUpdate } from "@refinedev/core";
import { memo, useEffect, useId, useState } from "react";
import { useForm } from "react-hook-form";
import { FaRobot } from "react-icons/fa6";

export function OverrideScoreForm({
  studentGradebookColumn,
  onSuccess,
  isAutoCalculated
}: {
  studentGradebookColumn: GradebookColumnStudent;
  onSuccess?: () => void;
  isAutoCalculated?: boolean;
}) {
  const { mutateAsync: updateStudentGradebookColumn } = useUpdate<GradebookColumnStudent>({
    resource: "gradebook_column_students"
  });
  const {
    register,
    setFocus,
    handleSubmit,
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

  useEffect(() => {
    if (isAutoCalculated) {
      setFocus("score_override");
    } else {
      setFocus("score");
    }
  }, [isAutoCalculated, setFocus]);

  const onSubmit = async (values: Partial<GradebookColumnStudent>) => {
    await updateStudentGradebookColumn({
      id: studentGradebookColumn.id,
      values: values
    });
    if (onSuccess) onSuccess();
  };

  return (
    <Box as="form" onSubmit={handleSubmit(onSubmit)} minW="300px">
      <VStack gap={2} align="stretch">
        {isAutoCalculated && (
          <Box fontSize="sm" color="fg.muted" mb={1}>
            Original Score: {studentGradebookColumn.score ?? "N/A"}
          </Box>
        )}
        {isAutoCalculated && (
          <Field label="Score Override" errorText={errors.score_override?.message?.toString()} flex={1}>
            <Input type="number" step="any" {...register("score_override", { valueAsNumber: true })} />
          </Field>
        )}
        {!isAutoCalculated && (
          <Field label="Score" errorText={errors.score?.message?.toString()} flex={1}>
            <Input type="number" step="any" {...register("score", { valueAsNumber: true })} />
          </Field>
        )}
        <Field label="Score Override Note" errorText={errors.score_override_note?.message?.toString()}>
          <Input type="text" {...register("score_override_note")} />
        </Field>
        <HStack gap={4} align="center">
          <Checkbox {...register("is_droppable")}>Droppable</Checkbox>
          <Checkbox {...register("is_excused")}>Excused</Checkbox>
          <Checkbox {...register("is_missing")}>Missing</Checkbox>
        </HStack>
        <Button type="submit" loading={isSubmitting} colorPalette="green" size="sm" alignSelf="end">
          Update
        </Button>
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
export default function GradebookCell({ columnId, studentId }: { columnId: number; studentId: string }) {
  const gradebookController = useGradebookController();
  const column = useGradebookColumn(columnId);
  const [isEditing, setIsEditing] = useState(false);
  const studentGradebookColumn = useGradebookColumnStudent(columnId, studentId);
  const triggerId = useId();
  const referencedContent = useReferencedContent(column.id, studentId);

  let scoreAdvice: string | undefined = undefined;
  if (column.score_expression && !studentGradebookColumn) {
    scoreAdvice = `This column is automatically calculated but has not been calculated yet.`;
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
    scoreAdvice = `Raw score: ${studentGradebookColumn?.score_override ?? studentGradebookColumn?.score}`;
  }
  const isSpecial = studentGradebookColumn?.score_override || studentGradebookColumn?.is_excused;
  return (
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
            >
              {isSpecial && (
                <Box
                  position="absolute"
                  top={1}
                  right={1}
                  zIndex={1}
                  pointerEvents="none"
                  color="red.500"
                  fontWeight="bold"
                  fontSize="lg"
                >
                  *
                </Box>
              )}
              {studentGradebookColumn &&
              (studentGradebookColumn?.score !== undefined || studentGradebookColumn?.score_override !== undefined)
                ? gradebookController.getRendererForColumn(column.id)(studentGradebookColumn)
                : "(Missing)"}
            </Box>
          </Popover.Trigger>
        </Tooltip>
        <Portal>
          <Popover.Positioner>
            <Popover.Content w="lg" maxH="80vh" overflowY="auto">
              <Popover.Arrow />
              <Popover.Body p={1} m={2}>
                {column.score_expression &&
                  (() => {
                    const isImportCSV = column.score_expression?.startsWith("importCSV");
                    if (isImportCSV) {
                      //Parse the quoted string in the expression
                      const quotedString = column.score_expression.match(/'([^']+)'/)?.[1];
                      if (quotedString) {
                        try {
                          const json = JSON.parse(quotedString);
                          return (
                            <VStack gap={0}>
                              <Alert.Root status="warning" direction="column" p={1}>
                                <Alert.Indicator>
                                  <Icon as={FaRobot} />
                                </Alert.Indicator>
                                <Alert.Content p={1}>
                                  <Alert.Title>This column was imported from a CSV file</Alert.Title>
                                  <Alert.Description>
                                    <Text>File: {json.fileName}</Text>
                                    <Text>Date: {json.date}</Text>
                                    <HStack gap={1}>
                                      <Text>By:</Text>
                                      <PersonName uid={json.creator} showAvatar={false} />
                                    </HStack>
                                  </Alert.Description>
                                </Alert.Content>
                              </Alert.Root>
                            </VStack>
                          );
                        } catch (e) {
                          console.error(e);
                        }
                      }
                    }
                    return (
                      <VStack gap={0}>
                        <Alert.Root status="warning" direction="column" p={1}>
                          <Alert.Indicator>
                            <Icon as={FaRobot} />
                          </Alert.Indicator>
                          <Alert.Content p={1}>
                            <Alert.Title>This column is automatically calculated</Alert.Title>
                            <Alert.Description>
                              Using the expression: <Code>{column.score_expression}</Code>
                              {referencedContent}
                            </Alert.Description>
                          </Alert.Content>
                        </Alert.Root>
                      </VStack>
                    );
                  })()}
                {studentGradebookColumn && (
                  <OverrideScoreForm
                    studentGradebookColumn={studentGradebookColumn}
                    onSuccess={() => setIsEditing(false)}
                    isAutoCalculated={column.score_expression !== null}
                  />
                )}
              </Popover.Body>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>
      <GradeCellOverlay studentId={studentId} />
    </Box>
  );
}

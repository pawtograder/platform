"use client";

//
import { useColorMode } from "@/components/ui/color-mode";
//
import { Tooltip } from "@/components/ui/tooltip";
import { useCanShowGradeFor } from "@/hooks/useCourseController";
import { useGradebookColumn, useGradebookColumnStudent, useGradebookController } from "@/hooks/useGradebook";
import { IncompleteValuesAdvice } from "@/hooks/useGradebookWhatIf";
import { Box, Float, HStack, Heading, Icon, Text, VStack } from "@chakra-ui/react";
import { memo, useCallback, useId, useRef, useState } from "react";
import { FaRobot } from "react-icons/fa6";
import { LuCalculator } from "react-icons/lu";
import { useGradebookPopover } from "./GradebookPopoverProvider";

/** Privacy blur; mount only when the cell should be hidden for the current staff view. */
export const GradeCellOverlay = memo(function GradeCellOverlay() {
  const { colorMode } = useColorMode();
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
  const studentGradebookColumn = useGradebookColumnStudent(columnId, studentId);
  const triggerId = useId();
  const contentId = useId();
  const { openAt } = useGradebookPopover();
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const canShowGradeFor = useCanShowGradeFor(studentId);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!canShowGradeFor) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (triggerRef.current) {
          openAt({ targetElement: triggerRef.current, columnId, studentId });
        }
      }
    },
    [canShowGradeFor, openAt, columnId, studentId]
  );

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
  if (canShowGradeFor) {
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
    if (studentGradebookColumn?.incomplete_values) {
      scoreAdvice = `${scoreAdvice ? scoreAdvice + "\n" : ""}This calculated column is missing these values: ${IncompleteValuesList(studentGradebookColumn.incomplete_values as IncompleteValuesAdvice)}`;
    }
  }
  const isSpecial =
    studentGradebookColumn?.score_override || studentGradebookColumn?.is_excused || !studentGradebookColumn;

  const hasRenderableScore =
    Boolean(
      studentGradebookColumn &&
        (studentGradebookColumn.score !== undefined || studentGradebookColumn.score_override !== undefined)
    ) && canShowGradeFor;

  const cellInner = (
    <Box
      ref={triggerRef}
      cursor="pointer"
      w="100%"
      h="100%"
      py={1}
      px={4}
      border="1px solid"
      borderColor="border.subtle"
      _hover={{ border: "2px solid border.info", borderColor: "border.info" }}
      _active={{ border: "2px solid border.info", borderColor: "border.info" }}
      position="relative"
      role="gridcell"
      data-gradebook-cell-trigger=""
      data-column-id={String(columnId)}
      data-student-id={studentId}
      aria-label={
        canShowGradeFor
          ? `Grade cell for ${column.name}: ${
              studentGradebookColumn &&
              (studentGradebookColumn.score !== undefined || studentGradebookColumn.score_override !== undefined)
                ? gradebookController.getRendererForColumn(column.id)({
                    ...studentGradebookColumn,
                    max_score: column.max_score
                  })
                : "Not available"
            }`
          : `Grade cell for ${column.name}: Grade not available`
      }
      aria-describedby={canShowGradeFor && scoreAdvice ? contentId : undefined}
      tabIndex={canShowGradeFor ? 0 : -1}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={canShowGradeFor ? onKeyDown : undefined}
    >
      {canShowGradeFor && isSpecial && (
        <Float placement="top-end" offset={3}>
          <Box color="red.500" fontWeight="bold" fontSize="lg" pointerEvents="none">
            *
          </Box>
        </Float>
      )}
      {canShowGradeFor && studentGradebookColumn?.is_recalculating && (
        <Float placement="bottom-end" offset={2}>
          <Box color="fg.info" pointerEvents="none" className="gradebook-cell-pulse">
            <Icon as={LuCalculator} size="sm" />
          </Box>
        </Float>
      )}
      {canShowGradeFor && studentGradebookColumn?.incomplete_values && (
        <Float placement="top-end" offset={3}>
          <Box color="blue.500" fontWeight="bold" fontSize="lg" pointerEvents="none">
            *
          </Box>
        </Float>
      )}
      <Text>
        {hasRenderableScore
          ? gradebookController.getRendererForColumn(column.id)({
              ...studentGradebookColumn,
              max_score: column.max_score
            })
          : canShowGradeFor
            ? "(N/A)"
            : "Hidden"}
      </Text>
    </Box>
  );

  return (
    <Box
      w="100%"
      textAlign="right"
      border="1px solid"
      borderColor="border.muted"
      position="relative"
      _hover={{ border: "2px solid border.info", borderColor: "border.info" }}
    >
      {hovered && canShowGradeFor && scoreAdvice ? (
        <Tooltip
          content={scoreAdvice}
          positioning={{ placement: "bottom" }}
          showArrow={true}
          ids={{ trigger: triggerId, content: contentId }}
          contentProps={{ style: { zIndex: 10000 } }}
        >
          {cellInner}
        </Tooltip>
      ) : (
        cellInner
      )}
      {!canShowGradeFor ? <GradeCellOverlay /> : null}
    </Box>
  );
}

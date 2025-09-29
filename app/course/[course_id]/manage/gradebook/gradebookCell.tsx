"use client";

//
import { useColorMode } from "@/components/ui/color-mode";
//
import { Tooltip } from "@/components/ui/tooltip";
import { useCanShowGradeFor } from "@/hooks/useCourseController";
import { useGradebookColumn, useGradebookColumnStudent, useGradebookController } from "@/hooks/useGradebook";
import { IncompleteValuesAdvice } from "@/hooks/useGradebookWhatIf";
import { Box, Float, HStack, Heading, Icon, Text, VStack } from "@chakra-ui/react";
import { memo, useId, useRef } from "react";
import { FaRobot } from "react-icons/fa6";
import { LuCalculator } from "react-icons/lu";
import { useGradebookPopover } from "./GradebookPopoverProvider";

// OverrideScoreForm moved to standalone file, keep cell lightweight
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
  const studentGradebookColumn = useGradebookColumnStudent(columnId, studentId);
  const triggerId = useId();
  const contentId = useId();
  const { openAt } = useGradebookPopover();
  const triggerRef = useRef<HTMLDivElement | null>(null);

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
        <Tooltip
          content={scoreAdvice}
          positioning={{ placement: "bottom" }}
          showArrow={true}
          ids={{ trigger: triggerId, content: contentId }}
          disabled={!scoreAdvice}
          contentProps={{ style: { zIndex: 10000 } }}
        >
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
            aria-label={`Grade cell for ${column.name}: ${
              studentGradebookColumn &&
              (studentGradebookColumn?.score !== undefined || studentGradebookColumn?.score_override !== undefined)
                ? gradebookController.getRendererForColumn(column.id)({
                    ...studentGradebookColumn,
                    max_score: column.max_score
                  })
                : "Not available"
            }`}
            aria-describedby={scoreAdvice ? contentId : undefined}
            tabIndex={0}
            onMouseDown={(e) => {
              // Open on mousedown to avoid initial outside-click closing
              e.preventDefault();
              e.stopPropagation();
              if (triggerRef.current) {
                openAt({ targetElement: triggerRef.current, columnId, studentId });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (triggerRef.current) {
                  openAt({ targetElement: triggerRef.current, columnId, studentId });
                }
              }
            }}
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
        </Tooltip>
        <GradeCellOverlay studentId={studentId} />
      </Box>
    </>
  );
}

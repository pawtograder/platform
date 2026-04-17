"use client";

import { Label } from "@/components/ui/label";
import { toaster } from "@/components/ui/toaster";
import { useAllStudentRoles } from "@/hooks/useCourseController";
import { useGradebookController, useGradebookColumns } from "@/hooks/useGradebook";
import {
  evaluateForStudent,
  formatValueForOverlay,
  type IntermediateValue,
  type ValidationResult
} from "@/lib/gradebookExpressionTester";
import { Badge, Box, Button, Code, Flex, HStack, Icon, Input, Text, Textarea, VStack } from "@chakra-ui/react";
import type * as MathJSType from "mathjs";
import React, { useEffect, useMemo, useState } from "react";
import { LuArrowLeftRight, LuCheck, LuCircleAlert, LuMaximize2, LuMinimize2, LuUser } from "react-icons/lu";

type MathJSNS = typeof MathJSType;

export type ExpressionBuilderMode = "modal" | "fullscreen";

type Props = {
  expression: string;
  onExpressionChange: (value: string) => void;
  editingColumnId: number | null;
  isExpanded: boolean;
  onExpandToggle: () => void;
  math: MathJSNS | null;
  /**
   * Called whenever the validation result changes. Parent can use this to
   * disable the Save button when validation fails.
   */
  onValidationChange?: (result: ValidationResult) => void;
};

function useLoadedMathJS() {
  const [math, setMath] = useState<MathJSNS | null>(null);
  useEffect(() => {
    let cancelled = false;
    import("mathjs").then((mod) => {
      if (!cancelled) setMath(mod);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return math;
}

/**
 * Expression builder panel. Provides:
 *  - Live parse / dependency validation of the entered score expression.
 *  - An optional full-screen mode which adds a student-picker and evaluates
 *    the expression against that student, overlaying intermediate values on
 *    every subexpression.
 */
export function ExpressionBuilder(props: Props) {
  const { expression, onExpressionChange, editingColumnId, isExpanded, onExpandToggle, onValidationChange } = props;
  const gradebookController = useGradebookController();
  const gradebookColumns = useGradebookColumns();
  const fallbackMath = useLoadedMathJS();
  const math = props.math ?? fallbackMath;
  const students = useAllStudentRoles();
  const [selectedStudentId, setSelectedStudentId] = useState<string>("");
  const [studentFilter, setStudentFilter] = useState<string>("");

  const sortedStudents = useMemo(() => {
    const sorted = [...students].sort((a, b) => {
      const aName = a.profiles?.name || a.profiles?.short_name || "";
      const bName = b.profiles?.name || b.profiles?.short_name || "";
      return aName.localeCompare(bName);
    });
    if (!studentFilter.trim()) return sorted;
    const q = studentFilter.toLowerCase();
    return sorted.filter((s) => {
      const name = (s.profiles?.name || s.profiles?.short_name || "").toLowerCase();
      const email = (s.users?.email || "").toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [students, studentFilter]);

  // Default to the first student when we enter full-screen mode.
  useEffect(() => {
    if (!isExpanded) return;
    if (!selectedStudentId && sortedStudents.length > 0) {
      setSelectedStudentId(sortedStudents[0].private_profile_id);
    }
  }, [isExpanded, sortedStudents, selectedStudentId]);

  // Recompute when the set of column slugs changes so dependency validation
  // stays current if another instructor adds/removes a column in the background.
  const gradebookColumnsKey = useMemo(
    () => gradebookColumns.map((c) => `${c.id}:${c.slug ?? ""}`).join("|"),
    [gradebookColumns]
  );
  const validation = useMemo<ValidationResult>(() => {
    if (!math) {
      return {
        isValid: true,
        isEmpty: expression.trim().length === 0,
        parseError: null,
        dependencyError: null,
        evaluation: null
      };
    }
    try {
      return evaluateForStudent({
        math,
        gradebookController,
        expression,
        studentId: isExpanded ? selectedStudentId : "",
        editingColumnId,
        captureIntermediates: isExpanded
      });
    } catch (e) {
      return {
        isValid: false,
        isEmpty: expression.trim().length === 0,
        parseError: e instanceof Error ? e.message : String(e),
        dependencyError: null,
        evaluation: null
      };
    }
    // gradebookColumnsKey is intentionally a dep so validation updates when
    // columns are added/removed in the background.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [math, gradebookController, expression, selectedStudentId, editingColumnId, isExpanded, gradebookColumnsKey]);

  useEffect(() => {
    onValidationChange?.(validation);
  }, [validation, onValidationChange]);

  const selectedStudent = students.find((s) => s.private_profile_id === selectedStudentId);

  if (!isExpanded) {
    return (
      <VStack align="stretch" gap={1}>
        <HStack justifyContent="space-between">
          <Label htmlFor="scoreExpression">Score Expression</Label>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={onExpandToggle}
            title="Open full-screen expression builder"
          >
            <Icon as={LuMaximize2} mr={1} /> Expression Builder
          </Button>
        </HStack>
        <Textarea
          id="scoreExpression"
          value={expression}
          onChange={(e) => onExpressionChange(e.target.value)}
          placeholder="Score Expression"
          rows={4}
          fontFamily="mono"
          fontSize="sm"
          borderColor={
            validation.parseError || validation.dependencyError || validation.evaluation?.error
              ? "red.500"
              : validation.isValid && !validation.isEmpty
                ? "green.500"
                : undefined
          }
        />
        <ValidationStatus validation={validation} expression={expression} />
      </VStack>
    );
  }

  return (
    <VStack align="stretch" gap={3} w="100%">
      <HStack justifyContent="space-between" wrap="wrap" gap={2}>
        <HStack gap={2}>
          <Icon as={LuArrowLeftRight} color="fg.muted" />
          <Text fontWeight="semibold">Expression Builder</Text>
          <Text fontSize="sm" color="fg.muted">
            Edit your expression, pick a student, and see intermediate values evaluated against their grade book.
          </Text>
        </HStack>
        <Button type="button" size="xs" variant="outline" onClick={onExpandToggle}>
          <Icon as={LuMinimize2} mr={1} /> Collapse
        </Button>
      </HStack>

      <Flex gap={4} direction={{ base: "column", lg: "row" }} align="stretch" flex={1}>
        {/* Left: Student picker */}
        <Box
          flex="0 0 280px"
          borderWidth="1px"
          borderColor="border.muted"
          rounded="md"
          p={3}
          bg="bg.muted"
          overflow="auto"
          maxH={{ base: "200px", lg: "65vh" }}
          data-testid="expression-builder-student-picker"
        >
          <HStack mb={2}>
            <Icon as={LuUser} color="fg.muted" />
            <Text fontSize="sm" fontWeight="semibold">
              Test against student
            </Text>
          </HStack>
          <Input
            placeholder="Search name or email…"
            value={studentFilter}
            onChange={(e) => setStudentFilter(e.target.value)}
            size="sm"
            mb={2}
          />
          <VStack align="stretch" gap={0.5}>
            {sortedStudents.length === 0 && (
              <Text color="fg.muted" fontSize="sm">
                No students match this search.
              </Text>
            )}
            {sortedStudents.map((s) => {
              const displayName = s.profiles?.name || s.profiles?.short_name || "Unknown";
              const isSelected = s.private_profile_id === selectedStudentId;
              return (
                <Button
                  key={s.private_profile_id}
                  onClick={() => setSelectedStudentId(s.private_profile_id)}
                  size="xs"
                  variant={isSelected ? "solid" : "ghost"}
                  colorPalette={isSelected ? "green" : "gray"}
                  justifyContent="flex-start"
                  textAlign="left"
                  title={s.users?.email ?? ""}
                >
                  {displayName}
                </Button>
              );
            })}
          </VStack>
        </Box>

        {/* Middle: Expression editor + overlay */}
        <VStack flex="1" align="stretch" gap={2} minW={0}>
          <Label htmlFor="scoreExpressionFull">Score Expression</Label>
          <Textarea
            id="scoreExpressionFull"
            value={expression}
            onChange={(e) => onExpressionChange(e.target.value)}
            placeholder="Score Expression"
            rows={10}
            fontFamily="mono"
            fontSize="sm"
            borderColor={
              validation.parseError || validation.dependencyError || validation.evaluation?.error
                ? "red.500"
                : validation.isValid && !validation.isEmpty
                  ? "green.500"
                  : undefined
            }
          />
          <ValidationStatus validation={validation} expression={expression} />

          <Box
            mt={2}
            borderWidth="1px"
            borderColor="border.muted"
            rounded="md"
            p={3}
            bg="bg.subtle"
            overflow="auto"
            maxH="40vh"
            data-testid="expression-builder-overlay"
          >
            <HStack mb={2} justifyContent="space-between" gap={2} wrap="wrap">
              <Text fontSize="sm" fontWeight="semibold">
                Annotated expression{" "}
                {selectedStudent && (
                  <Text as="span" color="fg.muted" fontWeight="normal">
                    — {selectedStudent.profiles?.name || selectedStudent.profiles?.short_name}
                  </Text>
                )}
              </Text>
              {validation.evaluation && !validation.evaluation.error && (
                <Badge colorPalette="green" variant="subtle">
                  Result: {validation.evaluation.result}
                </Badge>
              )}
            </HStack>
            <AnnotatedExpressionView validation={validation} expression={expression} />
          </Box>
        </VStack>

        {/* Right: List of intermediates */}
        <Box
          flex="0 0 320px"
          borderWidth="1px"
          borderColor="border.muted"
          rounded="md"
          p={3}
          bg="bg.muted"
          overflow="auto"
          maxH={{ base: "200px", lg: "65vh" }}
        >
          <Text fontSize="sm" fontWeight="semibold" mb={2}>
            Intermediate values
          </Text>
          {!selectedStudentId && (
            <Text fontSize="sm" color="fg.muted">
              Select a student to see live evaluation.
            </Text>
          )}
          {validation.evaluation &&
            validation.evaluation.intermediates.length === 0 &&
            !validation.evaluation.error && (
              <Text fontSize="sm" color="fg.muted">
                No intermediate subexpressions.
              </Text>
            )}
          {validation.evaluation?.error && (
            <Text fontSize="sm" color="red.500">
              Cannot evaluate: {validation.evaluation.error}
            </Text>
          )}
          {validation.evaluation && (
            <VStack align="stretch" gap={2}>
              {validation.evaluation.intermediates.slice(0, 80).map((iv, idx) => (
                <Box
                  key={`${iv.start}-${iv.end}-${idx}`}
                  borderWidth="1px"
                  borderColor={iv.error ? "red.300" : "border.muted"}
                  rounded="sm"
                  p={2}
                  bg="bg.panel"
                >
                  <Code fontSize="xs" wordBreak="break-all" whiteSpace="pre-wrap" bg="transparent" color="fg.muted">
                    {iv.source}
                  </Code>
                  <Text fontSize="xs" fontWeight="semibold" color={iv.error ? "red.500" : "fg"}>
                    = {iv.display}
                  </Text>
                </Box>
              ))}
            </VStack>
          )}
          {validation.evaluation?.incompleteValues && (
            <Box mt={3} borderWidth="1px" borderColor="orange.300" rounded="sm" p={2} bg="orange.50">
              <Text fontSize="xs" fontWeight="semibold" color="orange.700">
                Incomplete dependencies
              </Text>
              {(validation.evaluation.incompleteValues.missing?.gradebook_columns?.length ?? 0) > 0 && (
                <Text fontSize="xs" color="orange.700">
                  Missing: {validation.evaluation.incompleteValues.missing!.gradebook_columns!.join(", ")}
                </Text>
              )}
              {(validation.evaluation.incompleteValues.not_released?.gradebook_columns?.length ?? 0) > 0 && (
                <Text fontSize="xs" color="orange.700">
                  Not released: {validation.evaluation.incompleteValues.not_released!.gradebook_columns!.join(", ")}
                </Text>
              )}
            </Box>
          )}
        </Box>
      </Flex>
    </VStack>
  );
}

function ValidationStatus({ validation, expression }: { validation: ValidationResult; expression: string }) {
  if (validation.isEmpty) {
    return (
      <Text fontSize="xs" color="fg.muted">
        No expression set — this column can be hand-graded.
      </Text>
    );
  }
  if (validation.parseError) {
    return (
      <HStack gap={1} color="red.500" data-testid="expression-parse-error">
        <Icon as={LuCircleAlert} />
        <Text fontSize="xs" fontWeight="semibold">
          Parse error:
        </Text>
        <Text fontSize="xs">{validation.parseError}</Text>
      </HStack>
    );
  }
  if (validation.dependencyError) {
    return (
      <HStack gap={1} color="red.500" align="flex-start" data-testid="expression-dependency-error">
        <Icon as={LuCircleAlert} mt="2px" />
        <VStack align="stretch" gap={0}>
          <Text fontSize="xs" fontWeight="semibold">
            Dependency error:
          </Text>
          <Text fontSize="xs" whiteSpace="pre-wrap">
            {validation.dependencyError}
          </Text>
        </VStack>
      </HStack>
    );
  }
  if (validation.evaluation?.error) {
    return (
      <HStack gap={1} color="red.500" align="flex-start" data-testid="expression-eval-error">
        <Icon as={LuCircleAlert} mt="2px" />
        <VStack align="stretch" gap={0}>
          <Text fontSize="xs" fontWeight="semibold">
            Evaluation error for selected student:
          </Text>
          <Text fontSize="xs" whiteSpace="pre-wrap">
            {validation.evaluation.error}
          </Text>
        </VStack>
      </HStack>
    );
  }
  if (validation.evaluation && !validation.evaluation.error) {
    return (
      <HStack gap={1} color="green.600" data-testid="expression-ok">
        <Icon as={LuCheck} />
        <Text fontSize="xs">
          Evaluates to{" "}
          <Text as="span" fontWeight="semibold">
            {validation.evaluation.result}
          </Text>{" "}
          for the selected student.
        </Text>
      </HStack>
    );
  }
  return (
    <HStack gap={1} color="green.600" data-testid="expression-ok-syntax">
      <Icon as={LuCheck} />
      <Text fontSize="xs">
        Expression parses ({expression.length} chars). Open the Expression Builder to test on a real student.
      </Text>
    </HStack>
  );
}

/**
 * Renders the expression with every captured subexpression highlighted and
 * overlaid with its evaluated value.
 */
function AnnotatedExpressionView({ validation, expression }: { validation: ValidationResult; expression: string }) {
  const evaluation = validation.evaluation;

  if (!evaluation) {
    return (
      <Code whiteSpace="pre-wrap" wordBreak="break-all" fontSize="sm" bg="transparent">
        {expression || (
          <Text as="span" color="fg.muted">
            (empty expression)
          </Text>
        )}
      </Code>
    );
  }

  // Build a simple "line by intermediate" rendering: for each distinct
  // intermediate, show the source → value, indented by AST depth so nested
  // calls line up under their parents.
  // For the inline overlay, render the expression once then list the
  // intermediate values underneath, grouped by depth inferred from their
  // source length (longer = outer).
  const distinct = dedupeByStartEnd(evaluation.intermediates);
  const levels = assignLevels(distinct);

  return (
    <VStack align="stretch" gap={1}>
      <Code
        fontSize="sm"
        bg="transparent"
        whiteSpace="pre-wrap"
        wordBreak="break-all"
        borderWidth="1px"
        borderColor="border.subtle"
        rounded="sm"
        p={2}
      >
        {expression}
      </Code>
      <VStack align="stretch" gap={0.5}>
        {distinct.map((iv, idx) => (
          <HStack key={`${iv.start}-${iv.end}-${idx}`} gap={2} align="flex-start" pl={`${(levels[idx] ?? 0) * 12}px`}>
            <Text fontSize="xs" color="fg.muted" fontFamily="mono" flex="1" wordBreak="break-all">
              {iv.source}
            </Text>
            <Badge
              colorPalette={iv.error ? "red" : "blue"}
              variant="subtle"
              fontFamily="mono"
              whiteSpace="normal"
              maxW="50%"
              textAlign="right"
            >
              {iv.display}
            </Badge>
          </HStack>
        ))}
        {distinct.length === 0 && !evaluation.error && (
          <Text fontSize="xs" color="fg.muted">
            Final value: {evaluation.result}
          </Text>
        )}
      </VStack>
    </VStack>
  );
}

function dedupeByStartEnd(values: IntermediateValue[]): IntermediateValue[] {
  const seen = new Map<string, IntermediateValue>();
  for (const v of values) {
    const key = `${v.start}:${v.end}:${v.source}`;
    if (!seen.has(key)) seen.set(key, v);
  }
  return Array.from(seen.values()).sort((a, b) => {
    if (a.start === b.start) return b.end - a.end;
    return a.start - b.start;
  });
}

function assignLevels(values: IntermediateValue[]): number[] {
  // Greedy interval containment: level = deepest nesting of earlier entries
  // whose range strictly contains this one.
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let depth = 0;
    for (let j = 0; j < i; j++) {
      const a = values[j];
      const b = values[i];
      if (a.start <= b.start && a.end >= b.end && !(a.start === b.start && a.end === b.end)) {
        depth = Math.max(depth, (result[j] ?? 0) + 1);
      }
    }
    result.push(depth);
  }
  return result;
}

/**
 * Convenience helper used by parent dialogs when they want to guard their
 * onSubmit against invalid expressions. Returns `true` if the expression
 * should be blocked from saving.
 */
export function shouldBlockSave(validation: ValidationResult | null): boolean {
  if (!validation) return false;
  if (validation.isEmpty) return false;
  if (validation.parseError) return true;
  if (validation.dependencyError) return true;
  // Evaluation errors are only shown when a student is selected; don't block
  // save just because one student's data trips the expression, but do surface
  // the warning.
  return false;
}

export function useExpressionValidationToaster(validation: ValidationResult | null) {
  // Re-exported for parents that want to show a toast when the user
  // attempts to save an invalid expression.
  void validation;
  return (message: string) => {
    toaster.error({ title: "Invalid score expression", description: message });
  };
}

// Re-export helpers so consumers don't need to dip into the tester module.
export { formatValueForOverlay };

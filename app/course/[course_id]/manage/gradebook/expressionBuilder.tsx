"use client";

import { Label } from "@/components/ui/label";
import { useAllStudentRoles } from "@/hooks/useCourseController";
import { useGradebookColumns, useGradebookController, useGradebookExpressionPrefix } from "@/hooks/useGradebook";
import {
  evaluateForStudent,
  evaluateRenderExpression,
  formatValueForOverlay,
  type IntermediateValue,
  type RenderExpressionResult,
  type ValidationResult
} from "@/lib/gradebookExpressionTester";
import { Badge, Box, Button, Flex, HStack, Icon, Input, Text, Textarea, VStack } from "@chakra-ui/react";
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
   * Column-level context used by the preview. The render expression and max
   * score drive the "Rendered" preview below the editor; when both are
   * provided and non-empty we show the final evaluation result in both its
   * raw numeric form and the way the gradebook cell would actually render
   * (e.g. "B-", "✔️", a bespoke label).
   */
  renderExpression?: string | null;
  maxScore?: number | null;
  /**
   * Called whenever the validation result changes. Parent can use this to
   * disable the Save button when validation fails.
   */
  onValidationChange?: (result: ValidationResult) => void;
};

function useLoadedMathJS(): { math: MathJSNS | null; loadError: string | null } {
  const [math, setMath] = useState<MathJSNS | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    import("mathjs")
      .then((mod) => {
        if (!cancelled) setMath(mod);
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console -- surface chunk-load failures to the devtools console.
        console.error("Failed to load mathjs for expression builder", err);
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { math, loadError };
}

/**
 * Expression builder panel. Provides:
 *  - Live parse / dependency validation of the entered score expression.
 *  - An optional full-screen mode which adds a student-picker and evaluates
 *    the expression against that student, overlaying intermediate values on
 *    every subexpression.
 */
export function ExpressionBuilder(props: Props) {
  const {
    expression,
    onExpressionChange,
    editingColumnId,
    isExpanded,
    onExpandToggle,
    renderExpression,
    maxScore,
    onValidationChange
  } = props;
  const gradebookController = useGradebookController();
  const gradebookColumns = useGradebookColumns();
  const { math: fallbackMath, loadError: mathLoadError } = useLoadedMathJS();
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
    const isEmpty = expression.trim().length === 0;
    if (mathLoadError) {
      return {
        // A non-empty expression cannot be validated if mathjs failed to load,
        // so we block save to err on the safe side.
        isValid: isEmpty,
        isEmpty,
        parseError: `Unable to load expression evaluator: ${mathLoadError}`,
        dependencyError: null,
        evaluation: null
      };
    }
    if (!math) {
      return {
        // Same reasoning as above: treat "mathjs still loading" as blocking
        // for non-empty expressions rather than briefly showing Save enabled.
        isValid: isEmpty,
        isEmpty,
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
  }, [
    math,
    mathLoadError,
    gradebookController,
    expression,
    selectedStudentId,
    editingColumnId,
    isExpanded,
    gradebookColumnsKey
  ]);

  useEffect(() => {
    onValidationChange?.(validation);
  }, [validation, onValidationChange]);

  const selectedStudent = students.find((s) => s.private_profile_id === selectedStudentId);

  // Evaluate the render expression against the current final score so the
  // preview can show both forms side-by-side. Subscribe to
  // `gradebooks.expression_prefix` (prepended to every render expression) so
  // the preview re-renders if another instructor edits the prefix.
  const expressionPrefix = useGradebookExpressionPrefix();
  const rawScore =
    validation.evaluation && !validation.evaluation.error && typeof validation.evaluation.rawResult === "number"
      ? (validation.evaluation.rawResult as number)
      : undefined;
  const renderExpressionResult: RenderExpressionResult | null = useMemo(() => {
    if (!math) return null;
    return evaluateRenderExpression(math, expressionPrefix, renderExpression, rawScore, maxScore ?? undefined);
  }, [math, expressionPrefix, renderExpression, rawScore, maxScore]);

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

        {/* Right side: a unified editor — the textarea flows into the list of
            intermediate values directly below, with the final result (and its
            rendered form, if a render expression is set) surfaced right above
            the textarea so the reader's eye lands on it first. */}
        <VStack flex="1" align="stretch" gap={2} minW={0}>
          <HStack justifyContent="space-between" gap={2} wrap="wrap">
            <Label htmlFor="scoreExpressionFull">Score Expression</Label>
            {selectedStudent && (
              <Text fontSize="xs" color="fg.muted">
                Testing against {selectedStudent.profiles?.name || selectedStudent.profiles?.short_name}
              </Text>
            )}
          </HStack>

          <FinalResultBadges
            validation={validation}
            renderExpressionResult={renderExpressionResult}
            renderExpression={renderExpression}
          />

          {/* The editor + inline annotations share a border so they read as
              one surface — the textarea is the input row, and every captured
              subexpression is displayed below in source order with its value,
              visually tied to the code. */}
          <Box
            borderWidth="1px"
            borderColor={
              validation.parseError || validation.dependencyError || validation.evaluation?.error
                ? "red.500"
                : validation.isValid && !validation.isEmpty
                  ? "green.500"
                  : "border.muted"
            }
            rounded="md"
            bg="bg.subtle"
            overflow="hidden"
            data-testid="expression-builder-overlay"
          >
            <Textarea
              id="scoreExpressionFull"
              value={expression}
              onChange={(e) => onExpressionChange(e.target.value)}
              placeholder="Score Expression"
              rows={Math.max(6, Math.min(12, expression.split("\n").length + 2))}
              fontFamily="mono"
              fontSize="sm"
              border="none"
              borderBottomWidth="1px"
              borderBottomColor="border.subtle"
              rounded="none"
              bg="bg.panel"
              _focus={{ boxShadow: "none", outline: "none" }}
            />
            <InlineAnnotations
              validation={validation}
              hasStudent={Boolean(selectedStudentId)}
              expression={expression}
            />
          </Box>

          <ValidationStatus validation={validation} expression={expression} />

          {validation.evaluation?.incompleteValues && (
            <Box borderWidth="1px" borderColor="orange.300" rounded="sm" p={2} bg="orange.50">
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
        </VStack>
      </Flex>
    </VStack>
  );
}

/**
 * Renders two side-by-side badges showing the final score and, if a render
 * expression is set, its rendered form too (e.g. `81.5` and `B-`).
 */
function FinalResultBadges({
  validation,
  renderExpressionResult,
  renderExpression
}: {
  validation: ValidationResult;
  renderExpressionResult: RenderExpressionResult | null;
  renderExpression?: string | null;
}) {
  const hasScore = !!validation.evaluation && !validation.evaluation.error;
  const scoreText = hasScore ? validation.evaluation!.result : "—";
  const hasRender = Boolean((renderExpression ?? "").trim());
  return (
    <HStack gap={2} wrap="wrap" data-testid="expression-builder-result-badges">
      <Badge colorPalette={hasScore ? "green" : "gray"} variant="subtle" fontSize="sm" px={2} py={1}>
        <Text as="span" color="fg.muted" fontWeight="normal" mr={1}>
          Score
        </Text>
        <Text as="span" fontWeight="semibold" fontFamily="mono">
          {scoreText}
        </Text>
      </Badge>
      {hasRender && (
        <Badge
          colorPalette={
            renderExpressionResult?.kind === "ok" ? "purple" : renderExpressionResult?.kind === "error" ? "red" : "gray"
          }
          variant="subtle"
          fontSize="sm"
          px={2}
          py={1}
          data-testid="expression-builder-rendered-badge"
        >
          <Text as="span" color="fg.muted" fontWeight="normal" mr={1}>
            Rendered
          </Text>
          <Text as="span" fontWeight="semibold" fontFamily="mono">
            {renderExpressionResult?.kind === "ok"
              ? renderExpressionResult.rendered
              : renderExpressionResult?.kind === "error"
                ? `error: ${renderExpressionResult.message}`
                : "—"}
          </Text>
        </Badge>
      )}
    </HStack>
  );
}

/**
 * Inline annotations directly underneath the textarea. Each captured
 * subexpression renders as `source = value`, indented by AST containment
 * depth so nested calls read naturally as a breakdown of the expression
 * immediately above them.
 */
function InlineAnnotations({
  validation,
  hasStudent,
  expression
}: {
  validation: ValidationResult;
  hasStudent: boolean;
  expression: string;
}) {
  const evaluation = validation.evaluation;

  if (!hasStudent) {
    return (
      <Box p={2} bg="bg.subtle">
        <Text fontSize="xs" color="fg.muted">
          Select a student on the left to see intermediate values and the final score.
        </Text>
      </Box>
    );
  }
  if (!evaluation) return null;
  if (evaluation.error && evaluation.intermediates.length === 0) {
    return (
      <Box p={2} bg="bg.subtle">
        <Text fontSize="xs" color="red.500">
          Evaluation error: {evaluation.error}
        </Text>
      </Box>
    );
  }
  if (evaluation.intermediates.length === 0) {
    // Pure-arithmetic expression with no subexpressions worth labelling.
    return (
      <Box p={2} bg="bg.subtle">
        <Text fontSize="xs" color="fg.muted" fontFamily="mono">
          {expression.trim()} = {evaluation.result}
        </Text>
      </Box>
    );
  }
  const distinct = dedupeByStartEnd(evaluation.intermediates);
  const levels = assignLevels(distinct);
  const MAX_VISIBLE = 80;
  const visible = distinct.slice(0, MAX_VISIBLE);
  const hiddenCount = Math.max(0, distinct.length - MAX_VISIBLE);
  return (
    <VStack align="stretch" gap={0} bg="bg.subtle" maxH="40vh" overflow="auto">
      {visible.map((iv, idx) => (
        <HStack
          key={`${iv.start}-${iv.end}-${idx}`}
          gap={2}
          align="flex-start"
          px={2}
          py={1}
          borderBottomWidth={idx === visible.length - 1 && hiddenCount === 0 ? 0 : "1px"}
          borderColor="border.subtle"
          _hover={{ bg: "bg.muted" }}
        >
          <Text
            fontSize="xs"
            color="fg.muted"
            fontFamily="mono"
            flex="1"
            wordBreak="break-all"
            pl={`${(levels[idx] ?? 0) * 12}px`}
          >
            {iv.source}
          </Text>
          <Badge
            colorPalette={iv.error ? "red" : "blue"}
            variant="subtle"
            fontFamily="mono"
            whiteSpace="normal"
            maxW="55%"
            textAlign="right"
            fontSize="xs"
          >
            = {iv.display}
          </Badge>
        </HStack>
      ))}
      {hiddenCount > 0 && (
        <HStack px={2} py={1} justifyContent="center" bg="bg.muted">
          <Text fontSize="xs" color="fg.muted" fontStyle="italic">
            {hiddenCount} more intermediate {hiddenCount === 1 ? "value" : "values"} hidden
          </Text>
        </HStack>
      )}
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
  // `values` is already sorted by start asc, then end desc (longer spans
  // first), so a single-pass stack walk gives us the containment depth in
  // O(n). Whenever the top of the stack no longer strictly contains the
  // current entry, we pop it; the remaining stack size is the current depth.
  const result: number[] = [];
  const stack: IntermediateValue[] = [];
  for (const value of values) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const strictlyContains =
        top.start <= value.start && top.end >= value.end && !(top.start === value.start && top.end === value.end);
      if (strictlyContains) break;
      stack.pop();
    }
    result.push(stack.length);
    stack.push(value);
  }
  return result;
}

/**
 * Convenience helper used by parent dialogs when they want to guard their
 * onSubmit against invalid expressions. Returns `true` if the expression
 * should be blocked from saving.
 *
 * Pass the raw expression string so we can treat the "validation not yet
 * computed" case as blocking for non-empty expressions (otherwise Save would
 * briefly be enabled between the dialog opening and the first
 * `onValidationChange` from ExpressionBuilder).
 */
export function shouldBlockSave(validation: ValidationResult | null, expression?: string): boolean {
  if (!validation) {
    // No validation yet — block only if there is something to validate.
    const raw = expression?.trim() ?? "";
    return raw.length > 0;
  }
  if (validation.isEmpty) return false;
  if (validation.parseError) return true;
  if (validation.dependencyError) return true;
  // Cover the "math still loading / failed to load" case where the synthetic
  // result flags isValid=false with no parse/dependency error attached.
  if (!validation.isValid) return true;
  // Evaluation errors are only shown when a student is selected; don't block
  // save just because one student's data trips the expression, but do surface
  // the warning.
  return false;
}

// Re-export helpers so consumers don't need to dip into the tester module.
export { formatValueForOverlay };

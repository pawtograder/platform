"use client";

import { Field } from "@/components/ui/field";
import { Radio, RadioGroup } from "@/components/ui/radio";
import { HydratedRubricCheck, HydratedRubricCriteria } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Collapsible, Heading, HStack, IconButton, Input, Stack, Text, Textarea } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import { LuChevronDown, LuChevronRight, LuPlus, LuTrash2 } from "react-icons/lu";
import { CheckRow } from "./CheckRow";
import { SortableList } from "./SortableList";
import { ValidationError } from "./validation";

type ScoringMode = "additive" | "non-additive" | "deduction-only";

function getScoringMode(c: HydratedRubricCriteria): ScoringMode {
  if (c.is_deduction_only) return "deduction-only";
  if (c.is_additive) return "additive";
  return "non-additive";
}

function applyScoringMode(c: HydratedRubricCriteria, mode: ScoringMode): HydratedRubricCriteria {
  switch (mode) {
    case "additive":
      return { ...c, is_additive: true, is_deduction_only: false };
    case "non-additive":
      return { ...c, is_additive: false, is_deduction_only: false };
    case "deduction-only":
      return { ...c, is_additive: false, is_deduction_only: true };
  }
}

function errorFor(errors: ValidationError[], path: string): string | undefined {
  return errors.find((e) => e.path === path)?.message;
}

function blankCheck(name = "New check"): HydratedRubricCheck {
  return {
    id: -1,
    name,
    description: null,
    ordinal: 0,
    rubric_id: 0,
    assignment_id: 0,
    class_id: 0,
    created_at: "",
    data: null,
    rubric_criteria_id: 0,
    file: null,
    artifact: null,
    group: null,
    is_annotation: false,
    is_comment_required: false,
    is_required: false,
    max_annotations: null,
    points: 0,
    annotation_target: null,
    student_visibility: "always",
    kpi_category: null
  };
}

type CriterionCardProps = {
  criteria: HydratedRubricCriteria;
  onChange: (next: HydratedRubricCriteria) => void;
  onDelete: () => void;
  validationErrors: ValidationError[];
  pathPrefix: string;
};

export function CriterionCard({ criteria, onChange, onDelete, validationErrors, pathPrefix }: CriterionCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(
    criteria.min_checks_per_submission != null || criteria.max_checks_per_submission != null
  );

  const mode = getScoringMode(criteria);
  const nameError = errorFor(validationErrors, `${pathPrefix}.name`);
  const checksError = errorFor(validationErrors, `${pathPrefix}.checks`);
  const minError = errorFor(validationErrors, `${pathPrefix}.min_checks_per_submission`);

  const summedCheckPoints = useMemo(
    () => criteria.rubric_checks.reduce((acc, c) => acc + (c.points ?? 0), 0),
    [criteria.rubric_checks]
  );

  const handleChecksReorder = (next: HydratedRubricCheck[]) => {
    onChange({ ...criteria, rubric_checks: next });
  };

  const handleAddCheck = () => {
    const next = blankCheck();
    next.ordinal = criteria.rubric_checks.length;
    onChange({ ...criteria, rubric_checks: [...criteria.rubric_checks, next] });
  };

  const handleCheckChange = (idx: number, next: HydratedRubricCheck) => {
    const arr = criteria.rubric_checks.slice();
    arr[idx] = next;
    onChange({ ...criteria, rubric_checks: arr });
  };

  const handleCheckDelete = (idx: number) => {
    const arr = criteria.rubric_checks.filter((_, i) => i !== idx).map((c, i) => ({ ...c, ordinal: i }));
    onChange({ ...criteria, rubric_checks: arr });
  };

  return (
    <Box border="1px solid" borderColor={nameError ? "border.error" : "border.muted"} borderRadius="md" bg="bg.subtle">
      <HStack justify="space-between" p={2}>
        <HStack gap={2} flex="1" minW="0">
          <IconButton
            aria-label={expanded ? "Collapse criterion" : "Expand criterion"}
            size="xs"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <LuChevronDown /> : <LuChevronRight />}
          </IconButton>
          <Heading size="xs" truncate>
            {criteria.name || "(unnamed criterion)"}
          </Heading>
          <Text fontSize="xs" color="fg.muted">
            {mode} · {criteria.total_points ?? 0} pts · {criteria.rubric_checks.length} check
            {criteria.rubric_checks.length === 1 ? "" : "s"}
          </Text>
        </HStack>
        <IconButton aria-label="Delete criterion" size="xs" variant="ghost" colorPalette="red" onClick={onDelete}>
          <LuTrash2 />
        </IconButton>
      </HStack>
      {expanded && (
        <Stack gap={3} p={3} pt={0}>
          <Field label="Name" required invalid={!!nameError} errorText={nameError}>
            <Input value={criteria.name ?? ""} onChange={(e) => onChange({ ...criteria, name: e.target.value })} />
          </Field>
          <Field label="Description" helperText="Markdown supported.">
            <Textarea
              value={criteria.description ?? ""}
              onChange={(e) => onChange({ ...criteria, description: e.target.value || null })}
              rows={2}
            />
          </Field>
          <Field label="Scoring mode">
            <RadioGroup
              value={mode}
              onValueChange={(d) => d.value && onChange(applyScoringMode(criteria, d.value as ScoringMode))}
            >
              <HStack gap={4}>
                <Radio value="additive">Additive</Radio>
                <Radio value="non-additive">Non-additive</Radio>
                <Radio value="deduction-only">Deduction only</Radio>
              </HStack>
            </RadioGroup>
          </Field>
          <HStack gap={4} align="flex-end" wrap="wrap">
            <Field
              label="Total points"
              maxW="40"
              helperText={mode === "additive" ? `Auto-summed from checks (currently ${summedCheckPoints}).` : undefined}
            >
              <Input
                type="number"
                value={criteria.total_points ?? 0}
                onChange={(e) => onChange({ ...criteria, total_points: Number(e.target.value) })}
              />
            </Field>
            {mode === "additive" && criteria.total_points !== summedCheckPoints && (
              <Button
                size="xs"
                variant="surface"
                onClick={() => onChange({ ...criteria, total_points: summedCheckPoints })}
              >
                Recompute to {summedCheckPoints}
              </Button>
            )}
          </HStack>

          <Collapsible.Root open={advancedOpen} onOpenChange={(d) => setAdvancedOpen(d.open)}>
            <Collapsible.Trigger asChild>
              <Button size="2xs" variant="ghost">
                {advancedOpen ? <LuChevronDown /> : <LuChevronRight />} Advanced (min/max checks)
              </Button>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <HStack gap={4} mt={2} wrap="wrap">
                <Field label="Min checks per submission" maxW="48" invalid={!!minError} errorText={minError}>
                  <Input
                    type="number"
                    value={criteria.min_checks_per_submission ?? ""}
                    onChange={(e) =>
                      onChange({
                        ...criteria,
                        min_checks_per_submission: e.target.value === "" ? null : Number(e.target.value)
                      })
                    }
                  />
                </Field>
                <Field label="Max checks per submission" maxW="48">
                  <Input
                    type="number"
                    value={criteria.max_checks_per_submission ?? ""}
                    onChange={(e) =>
                      onChange({
                        ...criteria,
                        max_checks_per_submission: e.target.value === "" ? null : Number(e.target.value)
                      })
                    }
                  />
                </Field>
              </HStack>
            </Collapsible.Content>
          </Collapsible.Root>

          <Box>
            <HStack justify="space-between" mb={2}>
              <Heading size="xs">Checks</Heading>
              <Button size="2xs" variant="surface" onClick={handleAddCheck}>
                <LuPlus /> Add check
              </Button>
            </HStack>
            {checksError && (
              <Text fontSize="xs" color="fg.error" mb={2}>
                {checksError}
              </Text>
            )}
            <Stack gap={2}>
              <SortableList
                items={criteria.rubric_checks}
                onReorder={handleChecksReorder}
                getItemId={(check, idx) => `check-${check.id ?? "new"}-${idx}`}
                handleAriaLabel={(check) => `Drag check ${check.name || "unnamed"}`}
                renderItem={(check, idx) => (
                  <CheckRow
                    check={check}
                    onChange={(next) => handleCheckChange(idx, next)}
                    onDelete={() => handleCheckDelete(idx)}
                    validationErrors={validationErrors}
                    pathPrefix={`${pathPrefix}.checks[${idx}]`}
                  />
                )}
              />
            </Stack>
          </Box>
        </Stack>
      )}
    </Box>
  );
}

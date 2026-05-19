"use client";

import { Field } from "@/components/ui/field";
import { Radio, RadioGroup } from "@/components/ui/radio";
import { HydratedRubric, HydratedRubricCriteria, HydratedRubricPart } from "@/utils/supabase/DatabaseTypes";
import type { ReferenceEditorContext } from "@/components/rubric-editor/RubricEditorTree";
import {
  Box,
  Button,
  Heading,
  HStack,
  IconButton,
  Input,
  Menu,
  Portal,
  Stack,
  Text,
  Textarea,
  VStack
} from "@chakra-ui/react";
import { useState } from "react";
import { LuChevronDown, LuChevronRight, LuPlus, LuTrash2 } from "react-icons/lu";
import { CriterionCard } from "@/components/rubric-editor/CriterionCard";
import { SortableList } from "@/components/rubric-editor/SortableList";
import { CRITERIA_TEMPLATES, CriteriaTemplateKey } from "@/components/rubric-editor/templates";
import { ValidationError } from "@/components/rubric-editor/validation";

type PartMode = "standard" | "is_individual_grading" | "is_assign_to_student";

function getPartMode(part: HydratedRubricPart): PartMode {
  if (part.is_individual_grading) return "is_individual_grading";
  if (part.is_assign_to_student) return "is_assign_to_student";
  return "standard";
}

function applyPartMode(part: HydratedRubricPart, mode: PartMode): HydratedRubricPart {
  switch (mode) {
    case "standard":
      return { ...part, is_individual_grading: false, is_assign_to_student: false };
    case "is_individual_grading":
      return { ...part, is_individual_grading: true, is_assign_to_student: false };
    case "is_assign_to_student":
      return { ...part, is_individual_grading: false, is_assign_to_student: true };
  }
}

function errorFor(errors: ValidationError[], path: string): string | undefined {
  return errors.find((e) => e.path === path)?.message;
}

type PartCardProps = {
  part: HydratedRubricPart;
  // Display position within the parent rubric (0-indexed). Used for the data-testid so tests
  // can target parts by visible order rather than by raw DB ordinal.
  displayIndex: number;
  onChange: (next: HydratedRubricPart) => void;
  onDelete: () => void;
  validationErrors: ValidationError[];
  pathPrefix: string;
  currentRubricReviewRound?: HydratedRubric["review_round"];
  referenceContext?: ReferenceEditorContext;
};

const TEMPLATE_LABELS: Record<CriteriaTemplateKey, string> = {
  blank: "Blank checkbox criterion",
  metNotMet: "Met / not met (binary)",
  metPartialNotMet: "Met / partial / not met",
  fourTier: "Four-tier (excellent / good / fair / poor)",
  multiOption: "Multi-option check (single check with options)",
  annotationDeduction: "Code-quality deductions (multiple annotations)",
  deductionOnlyAnnotation: "Deduction-only annotation (single)"
};

export function PartCard({
  part,
  displayIndex,
  onChange,
  onDelete,
  validationErrors,
  pathPrefix,
  currentRubricReviewRound,
  referenceContext
}: PartCardProps) {
  const [expanded, setExpanded] = useState(true);

  const mode = getPartMode(part);
  const nameError = errorFor(validationErrors, `${pathPrefix}.name`);
  const modeError = errorFor(validationErrors, `${pathPrefix}.mode`);
  const criteriaError = errorFor(validationErrors, `${pathPrefix}.criteria`);

  const handleCriteriaReorder = (next: HydratedRubricCriteria[]) => {
    onChange({ ...part, rubric_criteria: next });
  };

  const handleAddTemplate = (key: CriteriaTemplateKey) => {
    const tpl = CRITERIA_TEMPLATES[key]();
    tpl.ordinal = part.rubric_criteria.length;
    onChange({ ...part, rubric_criteria: [...part.rubric_criteria, tpl] });
  };

  const handleCriteriaChange = (idx: number, next: HydratedRubricCriteria) => {
    const arr = part.rubric_criteria.slice();
    arr[idx] = next;
    onChange({ ...part, rubric_criteria: arr });
  };

  const handleCriteriaDelete = (idx: number) => {
    const arr = part.rubric_criteria.filter((_, i) => i !== idx).map((c, i) => ({ ...c, ordinal: i }));
    onChange({ ...part, rubric_criteria: arr });
  };

  return (
    <Box
      border="1px solid"
      borderColor={nameError ? "border.error" : "border.subtle"}
      borderRadius="md"
      bg="bg.panel"
      data-testid={`rubric-part-${displayIndex}`}
    >
      <HStack justify="space-between" p={2}>
        <HStack gap={2} flex="1" minW="0">
          <IconButton
            aria-label={expanded ? "Collapse part" : "Expand part"}
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <LuChevronDown /> : <LuChevronRight />}
          </IconButton>
          <Heading size="sm" truncate>
            {part.name || "(unnamed part)"}
          </Heading>
          <Text fontSize="xs" color="fg.muted">
            {mode === "standard" ? "" : mode.replace(/_/g, " ")} · {part.rubric_criteria.length}{" "}
            {part.rubric_criteria.length === 1 ? "criterion" : "criteria"}
          </Text>
        </HStack>
        <IconButton aria-label="Delete part" size="sm" variant="ghost" colorPalette="red" onClick={onDelete}>
          <LuTrash2 />
        </IconButton>
      </HStack>
      {expanded && (
        <Stack gap={3} p={3} pt={0}>
          <Text fontSize="xs" color="fg.muted">
            A part is the smallest unit that can be assigned to a grader. Use parts to break a rubric into chunks that
            different graders can tackle independently.
          </Text>
          <Field
            label="Name"
            required
            invalid={!!nameError}
            errorText={nameError}
            helperText="A logical section of the rubric. Often a question, problem, or deliverable."
          >
            <Input value={part.name ?? ""} onChange={(e) => onChange({ ...part, name: e.target.value })} />
          </Field>
          <Field
            label="Description"
            helperText="Optional. Markdown supported. Shown to graders above this part's criteria."
          >
            <Textarea
              value={part.description ?? ""}
              onChange={(e) => onChange({ ...part, description: e.target.value || null })}
              rows={2}
            />
          </Field>
          <Field label="Mode" invalid={!!modeError} errorText={modeError}>
            <RadioGroup
              value={mode}
              onValueChange={(d) => d.value && onChange(applyPartMode(part, d.value as PartMode))}
            >
              <Stack gap={2} align="stretch">
                <Radio value="standard" alignItems="flex-start">
                  <VStack align="start" gap={0}>
                    <Text>Standard</Text>
                    <Text fontSize="xs" color="fg.muted">
                      Graded once per submission by one assigned grader.
                    </Text>
                  </VStack>
                </Radio>
                <Radio value="is_individual_grading" alignItems="flex-start">
                  <VStack align="start" gap={0}>
                    <Text>Individual grading</Text>
                    <Text fontSize="xs" color="fg.muted">
                      The part is repeated once per student in the group, and each student is scored independently. Use
                      this when every group member has to do something (like a personal reflection) and earns their own
                      score rather than sharing one group score.
                    </Text>
                  </VStack>
                </Radio>
                <Radio value="is_assign_to_student" alignItems="flex-start">
                  <VStack align="start" gap={0}>
                    <Text>Assign to student</Text>
                    <Text fontSize="xs" color="fg.muted">
                      The part is assigned to a single student in the group, and points are applied only to that
                      student. Use this when one student owns a deliverable (e.g., a section of a group project) and
                      only they receive the score.
                    </Text>
                  </VStack>
                </Radio>
              </Stack>
            </RadioGroup>
          </Field>

          <Box>
            <HStack justify="space-between" mb={2}>
              <Heading size="xs">Criteria</Heading>
              <Menu.Root>
                <Menu.Trigger asChild>
                  <Button size="2xs" variant="surface" data-testid="rubric-add-criterion">
                    <LuPlus /> Add criterion
                  </Button>
                </Menu.Trigger>
                <Portal>
                  <Menu.Positioner>
                    <Menu.Content>
                      {(Object.keys(CRITERIA_TEMPLATES) as CriteriaTemplateKey[]).map((key) => (
                        <Menu.Item
                          key={key}
                          value={key}
                          onClick={() => handleAddTemplate(key)}
                          data-testid={`rubric-add-criterion-template-${key}`}
                        >
                          {TEMPLATE_LABELS[key]}
                        </Menu.Item>
                      ))}
                    </Menu.Content>
                  </Menu.Positioner>
                </Portal>
              </Menu.Root>
            </HStack>
            {criteriaError && (
              <Text fontSize="xs" color="fg.error" mb={2}>
                {criteriaError}
              </Text>
            )}
            <Stack gap={2}>
              <SortableList
                items={part.rubric_criteria}
                onReorder={handleCriteriaReorder}
                getItemId={(c, idx) => `crit-${c.id ?? "new"}-${idx}`}
                handleAriaLabel={(c) => `Drag criterion ${c.name || "unnamed"}`}
                renderItem={(c, idx) => (
                  <CriterionCard
                    criteria={c}
                    onChange={(next) => handleCriteriaChange(idx, next)}
                    onDelete={() => handleCriteriaDelete(idx)}
                    validationErrors={validationErrors}
                    pathPrefix={`${pathPrefix}.criteria[${idx}]`}
                    currentRubricReviewRound={currentRubricReviewRound}
                    referenceContext={referenceContext}
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

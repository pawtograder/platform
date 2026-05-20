"use client";

import { HydratedRubric, HydratedRubricPart } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Heading, HStack, Stack, Text } from "@chakra-ui/react";
import { LuPlus } from "react-icons/lu";
import { PartCard } from "@/components/rubric-editor/PartCard";
import { RubricHeaderForm } from "@/components/rubric-editor/RubricHeaderForm";
import { SortableList } from "@/components/rubric-editor/SortableList";
import { ValidationError, ValidationWarning } from "@/components/rubric-editor/validation";
import { Alert } from "@/components/ui/alert";

/**
 * Context the references UI inside CheckRow needs. The page passes the live set
 * of other rubrics (hydrated) plus the unsaved-status map per review-round tab so
 * the typeahead can gray out targets the user must save first.
 */
export type ReferenceEditorContext = {
  otherRubrics: HydratedRubric[];
  unsavedRoundTabs: Record<string, boolean>;
};

type RubricEditorTreeProps = {
  rubric: HydratedRubric;
  onChange: (next: HydratedRubric) => void;
  validationErrors: ValidationError[];
  validationWarnings?: ValidationWarning[];
  assignmentMaxPoints: number;
  autograderPoints: number;
  referenceContext?: ReferenceEditorContext;
};

function newBlankPart(ordinal: number): HydratedRubricPart {
  return {
    id: -1,
    name: `Part ${ordinal + 1}`,
    description: null,
    ordinal,
    rubric_id: 0,
    class_id: 0,
    created_at: "",
    data: undefined,
    assignment_id: 0,
    is_individual_grading: false,
    is_assign_to_student: false,
    rubric_criteria: []
  };
}

export function RubricEditorTree({
  rubric,
  onChange,
  validationErrors,
  validationWarnings = [],
  assignmentMaxPoints,
  autograderPoints,
  referenceContext
}: RubricEditorTreeProps) {
  const handleHeaderChange = (next: HydratedRubric) => onChange(next);

  const handlePartsReorder = (next: HydratedRubricPart[]) => {
    onChange({ ...rubric, rubric_parts: next });
  };

  const handlePartChange = (idx: number, next: HydratedRubricPart) => {
    const arr = rubric.rubric_parts.slice();
    arr[idx] = next;
    onChange({ ...rubric, rubric_parts: arr });
  };

  const handlePartDelete = (idx: number) => {
    const arr = rubric.rubric_parts.filter((_, i) => i !== idx).map((p, i) => ({ ...p, ordinal: i }));
    onChange({ ...rubric, rubric_parts: arr });
  };

  const handleAddPart = () => {
    const next = newBlankPart(rubric.rubric_parts.length);
    onChange({ ...rubric, rubric_parts: [...rubric.rubric_parts, next] });
  };

  return (
    <Stack gap={4} p={3} w="100%" minW="0">
      {validationWarnings.length > 0 && (
        <Alert status="warning" variant="surface" title="Points adjusted">
          <Stack gap={1} align="stretch">
            {validationWarnings.map((w) => (
              <Text key={w.path} fontSize="sm">
                <Text as="span" fontFamily="mono" fontSize="xs" color="fg.muted">
                  {w.path}:{" "}
                </Text>
                {w.message}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      <RubricHeaderForm rubric={rubric} onChange={handleHeaderChange} validationErrors={validationErrors} />
      {rubric.review_round === "grading-review" && (
        <Text fontSize="xs" color="fg.muted">
          Assignment max: {assignmentMaxPoints} · Autograder: {autograderPoints}
        </Text>
      )}
      <Box>
        <HStack justify="space-between" mb={2}>
          <Heading size="sm">Parts</Heading>
          <Button size="xs" variant="surface" onClick={handleAddPart}>
            <LuPlus /> Add part
          </Button>
        </HStack>
        <Stack gap={3}>
          <SortableList
            items={rubric.rubric_parts}
            onReorder={handlePartsReorder}
            getItemId={(part, idx) => `part-${part.id ?? "new"}-${idx}`}
            handleAriaLabel={(p) => `Drag part ${p.name || "unnamed"}`}
            renderItem={(part, idx) => (
              <PartCard
                part={part}
                displayIndex={idx}
                onChange={(next) => handlePartChange(idx, next)}
                onDelete={() => handlePartDelete(idx)}
                validationErrors={validationErrors}
                validationWarnings={validationWarnings}
                pathPrefix={`parts[${idx}]`}
                currentRubricReviewRound={rubric.review_round}
                referenceContext={referenceContext}
              />
            )}
          />
        </Stack>
        {rubric.rubric_parts.length === 0 && (
          <Text fontSize="sm" color="fg.muted">
            No parts yet. Add a part to start building your rubric.
          </Text>
        )}
      </Box>
    </Stack>
  );
}

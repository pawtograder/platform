import React, { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Box, Heading, HStack, RadioGroup, VStack, Text, Checkbox, Separator, Tag } from "@chakra-ui/react";
import {
  additiveVsSubtractive,
  optionsExample,
  visibilityExample,
  type SimpleRubric,
  type SimpleCriteria,
  type SimpleCheck
} from "./cannedRubrics";

function CriteriaPreview({ criteria }: { criteria: SimpleCriteria }) {
  const [selectedChecks, setSelectedChecks] = useState<number[]>([]);
  const [selectedOptionIndexByCheck, setSelectedOptionIndexByCheck] = useState<Record<number, number | undefined>>({});

  const subtotal = useMemo(() => {
    const raw = selectedChecks.reduce((sum, checkId) => {
      const check = criteria.checks.find((c) => c.id === checkId)!;
      const optIndex = selectedOptionIndexByCheck[checkId];
      const points =
        optIndex !== undefined && check.options ? check.options[optIndex].points : check.points ?? 0;
      return sum + Math.max(0, points);
    }, 0);
    if (criteria.is_additive) return Math.min(raw, criteria.total_points ?? raw);
    return Math.max(0, (criteria.total_points ?? 0) - raw);
  }, [criteria, selectedChecks, selectedOptionIndexByCheck]);

  const isSingle = criteria.max_checks_per_submission === 1;

  return (
    <Box borderWidth="1px" borderRadius="md" p={3} w="100%">
      <HStack justify="space-between" align="start">
        <Heading size="sm">{criteria.name}</Heading>
        <Tag.Root>
          <Tag.Label>
            {criteria.is_additive ? `${subtotal}/${criteria.total_points}` : `${subtotal}/${criteria.total_points}`}
          </Tag.Label>
        </Tag.Root>
      </HStack>
      {criteria.description && (
        <Text fontSize="sm" color="fg.muted" mt={1}>
          {criteria.description}
        </Text>
      )}
      <VStack align="start" mt={2} gap={2}>
        {criteria.checks.map((check) => {
          const isSelected = selectedChecks.includes(check.id);
          const control = isSingle ? (
            <RadioGroup.Root
              value={isSelected ? check.id.toString() : undefined}
              onValueChange={(v) => {
                const id = Number(v.value);
                setSelectedChecks([id]);
              }}
            >
              <RadioGroup.Item value={check.id.toString()} />
            </RadioGroup.Root>
          ) : (
            <Checkbox
              checked={isSelected}
              onCheckedChange={(v) => {
                setSelectedChecks((prev) =>
                  v.checked ? [...prev, check.id] : prev.filter((id) => id !== check.id)
                );
              }}
            />
          );
          const optionPicker =
            isSelected && check.options ? (
              <RadioGroup.Root
                value={selectedOptionIndexByCheck[check.id]?.toString()}
                onValueChange={(v) =>
                  setSelectedOptionIndexByCheck((prev) => ({ ...prev, [check.id]: Number(v.value) }))
                }
              >
                <HStack wrap="wrap" gap={2}>
                  {check.options.map((opt, idx) => (
                    <HStack key={idx}>
                      <RadioGroup.Item value={idx.toString()} />
                      <Text fontSize="sm">
                        {opt.label} ({opt.points} pts)
                      </Text>
                    </HStack>
                  ))}
                </HStack>
              </RadioGroup.Root>
            ) : null;

          const pointsText = check.options
            ? ""
            : check.points === 0
            ? ""
            : criteria.is_additive
            ? `+${check.points}`
            : `-${check.points}`;

          return (
            <Box key={check.id} borderWidth="1px" borderRadius="md" p={2} w="100%">
              <HStack gap={2} align="start">
                {control}
                <VStack align="start" gap={0} w="100%">
                  <HStack justify="space-between" w="100%">
                    <Text fontWeight="medium">
                      {pointsText} {check.name}
                    </Text>
                    {check.student_visibility && (
                      <Tag.Root size="sm" variant="outline">
                        <Tag.Label>{check.student_visibility}</Tag.Label>
                      </Tag.Root>
                    )}
                  </HStack>
                  {check.description && (
                    <Text fontSize="sm" color="fg.muted">
                      {check.description}
                    </Text>
                  )}
                  {check.is_annotation && (
                    <Text fontSize="xs" color="fg.muted">
                      Annotation target: {check.annotation_target ?? "file"}
                      {check.file ? ` • file: ${check.file}` : ""}
                      {check.artifact ? ` • artifact: ${check.artifact}` : ""}
                      {check.max_annotations ? ` • max ${check.max_annotations}` : ""}
                    </Text>
                  )}
                  {optionPicker}
                </VStack>
              </HStack>
            </Box>
          );
        })}
      </VStack>
    </Box>
  );
}

function RubricPreview({ rubric }: { rubric: SimpleRubric }) {
  return (
    <VStack align="start" gap={4} w="100%">
      <Heading size="md">{rubric.name}</Heading>
      {rubric.parts.map((part, idx) => (
        <VStack key={part.id} align="start" w="100%" gap={2}>
          <Heading size="sm">{part.name}</Heading>
          <VStack align="start" w="100%">
            {part.criteria.map((c) => (
              <CriteriaPreview key={c.id} criteria={c} />
            ))}
          </VStack>
          {idx < rubric.parts.length - 1 && <Separator />}
        </VStack>
      ))}
    </VStack>
  );
}

const meta: Meta<typeof RubricPreview> = {
  title: "Rubrics/Examples",
  component: RubricPreview
};
export default meta;

type Story = StoryObj<typeof RubricPreview>;

export const AdditiveVsSubtractive: Story = {
  args: { rubric: additiveVsSubtractive }
};

export const Options: Story = {
  args: { rubric: optionsExample }
};

export const Visibility: Story = {
  args: { rubric: visibilityExample }
};
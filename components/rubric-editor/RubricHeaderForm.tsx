"use client";

import { Field } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { HydratedRubric } from "@/utils/supabase/DatabaseTypes";
import { Heading, Input, Stack, Textarea } from "@chakra-ui/react";
import { ValidationError } from "./validation";

type RubricHeaderFormProps = {
  rubric: HydratedRubric;
  onChange: (next: HydratedRubric) => void;
  validationErrors: ValidationError[];
};

function errorFor(errors: ValidationError[], path: string): string | undefined {
  return errors.find((e) => e.path === path)?.message;
}

export function RubricHeaderForm({ rubric, onChange, validationErrors }: RubricHeaderFormProps) {
  const nameError = errorFor(validationErrors, "rubric.name");
  const showCapToggle = rubric.review_round === "grading-review";

  return (
    <Stack gap={3} p={3} border="1px solid" borderColor="border.subtle" borderRadius="md" bg="bg.subtle">
      <Heading size="sm">Rubric</Heading>
      <Field label="Name" required invalid={!!nameError} errorText={nameError}>
        <Input
          value={rubric.name ?? ""}
          onChange={(e) => onChange({ ...rubric, name: e.target.value })}
          placeholder="Rubric name"
        />
      </Field>
      <Field label="Description" helperText="Markdown supported.">
        <Textarea
          value={rubric.description ?? ""}
          onChange={(e) => onChange({ ...rubric, description: e.target.value || null })}
          placeholder="Describe what this rubric is for."
          rows={3}
        />
      </Field>
      {showCapToggle && (
        <Field>
          <Switch
            checked={rubric.cap_score_to_assignment_points ?? false}
            onCheckedChange={(details) => onChange({ ...rubric, cap_score_to_assignment_points: details.checked })}
          >
            Cap score to assignment points
          </Switch>
        </Field>
      )}
    </Stack>
  );
}

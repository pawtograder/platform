"use client";

import { Field } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { HydratedRubric } from "@/utils/supabase/DatabaseTypes";
import { Heading, Stack } from "@chakra-ui/react";
import { DebouncedInput, DebouncedTextarea } from "@/components/rubric-editor/DebouncedInput";
import { ValidationError } from "@/components/rubric-editor/validation";

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
      <Field
        label="Name"
        required
        invalid={!!nameError}
        errorText={nameError}
        helperText="Shown to graders and, if visibility allows, to students."
      >
        <DebouncedInput
          value={rubric.name ?? ""}
          onCommit={(next) => onChange({ ...rubric, name: next })}
          placeholder="Rubric name"
        />
      </Field>
      <Field label="Description" helperText="Optional context shown above the rubric. Markdown supported.">
        <DebouncedTextarea
          value={rubric.description ?? ""}
          onCommit={(next) => onChange({ ...rubric, description: next || null })}
          placeholder="Describe what this rubric is for."
          rows={3}
        />
      </Field>
      {showCapToggle && (
        <Field helperText="Hard-cap the final score at the assignment's max points. The cap applies to the sum of autograder points + manual rubric score + any score tweak - anything above the assignment total is truncated. Commonly used when manual grading is a fallback for autograder failures, so awarding full rubric points can never push a student over the assignment total.">
          <Switch
            checked={rubric.cap_score_to_assignment_points ?? false}
            onCheckedChange={(details) => onChange({ ...rubric, cap_score_to_assignment_points: details.checked })}
          >
            Cap score to assignment points
          </Switch>
        </Field>
      )}
      <Field helperText="When enabled, students cannot see this rubric's contents (parts, criteria, checks) until a review on it has been assigned to them. Use this for self-review rubrics where seeing the questions before submitting would bias the student's work.">
        <Switch
          checked={rubric.hide_unless_assigned ?? false}
          onCheckedChange={(details) => onChange({ ...rubric, hide_unless_assigned: details.checked })}
        >
          Hide from students until assigned
        </Switch>
      </Field>
    </Stack>
  );
}

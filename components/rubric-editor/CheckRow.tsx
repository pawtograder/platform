"use client";

import { Field } from "@/components/ui/field";
import { Radio, RadioGroup } from "@/components/ui/radio";
import { Switch } from "@/components/ui/switch";
import {
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCheckReference,
  RubricChecksDataType
} from "@/utils/supabase/DatabaseTypes";
import {
  Badge,
  Box,
  Button,
  Collapsible,
  HStack,
  IconButton,
  Input,
  NativeSelect,
  Stack,
  Text,
  Textarea,
  VStack
} from "@chakra-ui/react";
import { useMemo, useState } from "react";
import { LuChevronDown, LuChevronRight, LuPlus, LuTrash2, LuArrowUp, LuArrowDown, LuLink, LuX } from "react-icons/lu";
import { ValidationError } from "@/components/rubric-editor/validation";
import type { ReferenceEditorContext } from "@/components/rubric-editor/RubricEditorTree";

type CheckType = "checkbox" | "options" | "annotation";

type CheckRowProps = {
  check: HydratedRubricCheck;
  onChange: (next: HydratedRubricCheck) => void;
  onDelete: () => void;
  validationErrors: ValidationError[];
  pathPrefix: string;
  currentRubricReviewRound?: HydratedRubric["review_round"];
  referenceContext?: ReferenceEditorContext;
};

const VISIBILITY_OPTIONS: { value: NonNullable<HydratedRubricCheck["student_visibility"]>; label: string }[] = [
  { value: "always", label: "Always visible" },
  { value: "if_applied", label: "If applied" },
  { value: "if_released", label: "If released" },
  { value: "never", label: "Never" }
];

function getCheckType(check: HydratedRubricCheck): CheckType {
  if (check.is_annotation) return "annotation";
  if (
    typeof check.data === "object" &&
    check.data !== null &&
    "options" in check.data &&
    Array.isArray((check.data as { options?: unknown }).options)
  ) {
    return "options";
  }
  return "checkbox";
}

function getOptions(check: HydratedRubricCheck): RubricChecksDataType["options"] {
  if (
    typeof check.data === "object" &&
    check.data !== null &&
    "options" in check.data &&
    Array.isArray((check.data as { options?: unknown }).options)
  ) {
    return (check.data as RubricChecksDataType).options;
  }
  return [];
}

function errorFor(errors: ValidationError[], path: string): string | undefined {
  return errors.find((e) => e.path === path)?.message;
}

function errorsStartingWith(errors: ValidationError[], prefix: string): ValidationError[] {
  return errors.filter((e) => e.path.startsWith(prefix));
}

type CandidateTarget = {
  id: number;
  name: string;
  points: number;
  rubricName: string;
  reviewRound: string;
  rubricHasUnsavedChanges: boolean;
};

export function CheckRow({
  check,
  onChange,
  onDelete,
  validationErrors,
  pathPrefix,
  currentRubricReviewRound,
  referenceContext
}: CheckRowProps) {
  const [expanded, setExpanded] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [isAddingReference, setIsAddingReference] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState<string>("");

  const checkType = getCheckType(check);
  const options = getOptions(check);

  const nameError = errorFor(validationErrors, `${pathPrefix}.name`);
  const optionsErrors = errorsStartingWith(validationErrors, `${pathPrefix}.data.options`);
  const maxAnnotationsError = errorFor(validationErrors, `${pathPrefix}.max_annotations`);

  const existingRefs: HydratedRubricCheckReference[] = useMemo(() => check.references ?? [], [check.references]);
  const referenceCount = existingRefs.length;

  // All cross-round checks (unfiltered). Used to resolve labels for existing
  // references — including ones already referenced by this check.
  const allTargets: CandidateTarget[] = useMemo(() => {
    if (!referenceContext) return [];
    const out: CandidateTarget[] = [];
    for (const rubric of referenceContext.otherRubrics) {
      // Cross-round only — skip rubrics that share the current review round.
      if (currentRubricReviewRound && rubric.review_round === currentRubricReviewRound) continue;
      const round = rubric.review_round ?? "(no round)";
      const unsaved = !!referenceContext.unsavedRoundTabs[round];
      for (const part of rubric.rubric_parts) {
        for (const crit of part.rubric_criteria) {
          for (const ch of crit.rubric_checks) {
            if (ch.id <= 0) continue;
            out.push({
              id: ch.id,
              name: ch.name,
              points: ch.points ?? 0,
              rubricName: rubric.name,
              reviewRound: round,
              rubricHasUnsavedChanges: unsaved
            });
          }
        }
      }
    }
    return out;
  }, [referenceContext, currentRubricReviewRound]);

  // Filtered list for the "Add reference" typeahead — excludes targets already
  // referenced by this check so the user can't add a duplicate.
  const addCandidateTargets: CandidateTarget[] = useMemo(() => {
    const alreadyReferenced = new Set(existingRefs.map((r) => r.referenced_rubric_check_id));
    return allTargets.filter((c) => !alreadyReferenced.has(c.id));
  }, [allTargets, existingRefs]);

  const candidatesByRound: Record<string, CandidateTarget[]> = useMemo(() => {
    const grouped: Record<string, CandidateTarget[]> = {};
    for (const c of addCandidateTargets) {
      if (!grouped[c.reviewRound]) grouped[c.reviewRound] = [];
      grouped[c.reviewRound].push(c);
    }
    return grouped;
  }, [addCandidateTargets]);

  function lookupCandidate(id: number): CandidateTarget | undefined {
    return allTargets.find((c) => c.id === id);
  }

  function addReference(targetId: number) {
    const next = [...existingRefs, { referenced_rubric_check_id: targetId }];
    onChange({ ...check, references: next });
  }

  function removeReference(targetId: number) {
    const next = existingRefs.filter((r) => r.referenced_rubric_check_id !== targetId);
    onChange({ ...check, references: next });
  }

  const handleTypeChange = (next: CheckType) => {
    if (next === checkType) return;
    if (next === "checkbox") {
      onChange({ ...check, is_annotation: false, data: null });
    } else if (next === "options") {
      onChange({
        ...check,
        is_annotation: false,
        data: {
          options:
            options.length >= 2
              ? options
              : [
                  { label: "Option 1", points: check.points ?? 0 },
                  { label: "Option 2", points: 0 }
                ]
        }
      });
    } else {
      onChange({
        ...check,
        is_annotation: true,
        data: null,
        max_annotations: check.max_annotations ?? 1
      });
    }
  };

  const handleOptionChange = (idx: number, patch: Partial<RubricChecksDataType["options"][number]>) => {
    const next = options.map((opt, i) => (i === idx ? { ...opt, ...patch } : opt));
    onChange({ ...check, data: { options: next } });
  };

  const handleAddOption = () => {
    const next = [...options, { label: `Option ${options.length + 1}`, points: 0 }];
    onChange({ ...check, data: { options: next } });
  };

  const handleRemoveOption = (idx: number) => {
    const next = options.filter((_, i) => i !== idx);
    onChange({ ...check, data: { options: next } });
  };

  const handleMoveOption = (idx: number, delta: number) => {
    const target = idx + delta;
    if (target < 0 || target >= options.length) return;
    const next = options.slice();
    const [moved] = next.splice(idx, 1);
    next.splice(target, 0, moved);
    onChange({ ...check, data: { options: next } });
  };

  const headerSummary = useMemo(() => {
    const parts: string[] = [];
    parts.push(`${check.points ?? 0} pts`);
    parts.push(checkType);
    if (check.is_required) parts.push("required");
    return parts.join(" · ");
  }, [check.points, check.is_required, checkType]);

  return (
    <Box border="1px solid" borderColor={nameError ? "border.error" : "border.subtle"} borderRadius="md" bg="bg.panel">
      <HStack justify="space-between" p={2}>
        <HStack gap={2} flex="1" minW="0">
          <IconButton
            aria-label={expanded ? "Collapse check" : "Expand check"}
            size="2xs"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <LuChevronDown /> : <LuChevronRight />}
          </IconButton>
          <Text fontWeight="medium" truncate>
            {check.name || "(unnamed check)"}
          </Text>
          <Text fontSize="xs" color="fg.muted">
            {headerSummary}
          </Text>
        </HStack>
        <IconButton aria-label="Delete check" size="2xs" variant="ghost" colorPalette="red" onClick={onDelete}>
          <LuTrash2 />
        </IconButton>
      </HStack>
      {expanded && (
        <Stack gap={3} p={3} pt={0}>
          <Field
            label="Name"
            required
            invalid={!!nameError}
            errorText={nameError}
            helperText="Short label shown in the grading UI. Keep it concise — the description carries the details."
          >
            <Input
              value={check.name ?? ""}
              onChange={(e) => onChange({ ...check, name: e.target.value })}
              placeholder="Check name"
            />
          </Field>
          <Field
            label="Description"
            helperText="Markdown supported. Shown to graders, and to students when student visibility allows."
          >
            <Textarea
              value={check.description ?? ""}
              onChange={(e) => onChange({ ...check, description: e.target.value || null })}
              rows={2}
            />
          </Field>
          <HStack gap={4} align="flex-start" wrap="wrap">
            <Field label="Points" maxW="32" helperText="Awarded (additive) or deducted (deduction-only) when applied.">
              <Input
                type="number"
                value={check.points ?? 0}
                onChange={(e) => onChange({ ...check, points: Number(e.target.value) })}
              />
            </Field>
            <Field
              label="Student visibility"
              maxW="56"
              helperText="Controls when (or whether) this check appears to students. 'Always' publishes it in advance; 'If released' waits until grading is released; 'If applied' shows it only on submissions where it was used; 'Never' keeps it grader-only."
            >
              <NativeSelect.Root size="sm">
                <NativeSelect.Field
                  value={check.student_visibility ?? "always"}
                  onChange={(e) =>
                    onChange({
                      ...check,
                      student_visibility: e.target.value as NonNullable<HydratedRubricCheck["student_visibility"]>
                    })
                  }
                >
                  {VISIBILITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
            </Field>
            <VStack align="start" gap={0}>
              <Switch
                checked={check.is_required}
                onCheckedChange={(d) => onChange({ ...check, is_required: d.checked })}
              >
                Required
              </Switch>
              <Text fontSize="xs" color="fg.muted" mt={1}>
                Grader must apply or explicitly skip this check before submitting their review.
              </Text>
            </VStack>
            <VStack align="start" gap={0}>
              <Switch
                checked={check.is_comment_required}
                onCheckedChange={(d) => onChange({ ...check, is_comment_required: d.checked })}
              >
                Comment required
              </Switch>
              <Text fontSize="xs" color="fg.muted" mt={1}>
                Grader must add a written comment when applying this check.
              </Text>
            </VStack>
          </HStack>

          <Field label="Check type">
            <RadioGroup value={checkType} onValueChange={(d) => d.value && handleTypeChange(d.value as CheckType)}>
              <Stack gap={2} align="stretch">
                <Radio value="checkbox" alignItems="flex-start">
                  <VStack align="start" gap={0}>
                    <Text>Checkbox</Text>
                    <Text fontSize="xs" color="fg.muted">
                      Single yes/no check, worth its full point value when applied.
                    </Text>
                  </VStack>
                </Radio>
                <Radio value="options" alignItems="flex-start">
                  <VStack align="start" gap={0}>
                    <Text>Multi-option</Text>
                    <Text fontSize="xs" color="fg.muted">
                      Single-pick from a list of labels, each with its own point value. For tiered scoring like Met=5 /
                      Partial=3 / Not met=0, prefer separate Checkbox checks inside a criterion with min/max checks set
                      to 1 - that renders as radio buttons in the grading UI and is generally easier to work with.
                    </Text>
                  </VStack>
                </Radio>
                <Radio value="annotation" alignItems="flex-start">
                  <VStack align="start" gap={0}>
                    <Text>Annotation</Text>
                    <Text fontSize="xs" color="fg.muted">
                      Grader places this on a specific line or region of the submission. Useful for inline feedback such
                      as code-style violations or comment-on-this-paragraph.
                    </Text>
                  </VStack>
                </Radio>
              </Stack>
            </RadioGroup>
          </Field>

          {checkType === "options" && (
            <Box border="1px dashed" borderColor="border.subtle" borderRadius="md" p={2}>
              <HStack justify="space-between" mb={1}>
                <Text fontSize="sm" fontWeight="medium">
                  Options
                </Text>
                <Button size="2xs" variant="ghost" onClick={handleAddOption}>
                  <LuPlus /> Add option
                </Button>
              </HStack>
              <Text fontSize="xs" color="fg.muted" mb={2}>
                Label: what the grader sees in the picker. Points: how many points this option is worth when chosen.
              </Text>
              <Stack gap={2}>
                {options.map((opt, idx) => (
                  <HStack key={idx} gap={2} align="flex-end">
                    <Field label={idx === 0 ? "Label" : undefined} flex="1">
                      <Input
                        value={opt.label ?? ""}
                        onChange={(e) => handleOptionChange(idx, { label: e.target.value })}
                      />
                    </Field>
                    <Field label={idx === 0 ? "Points" : undefined} maxW="24">
                      <Input
                        type="number"
                        value={opt.points ?? 0}
                        onChange={(e) => handleOptionChange(idx, { points: Number(e.target.value) })}
                      />
                    </Field>
                    <IconButton
                      aria-label="Move option up"
                      size="2xs"
                      variant="ghost"
                      disabled={idx === 0}
                      onClick={() => handleMoveOption(idx, -1)}
                    >
                      <LuArrowUp />
                    </IconButton>
                    <IconButton
                      aria-label="Move option down"
                      size="2xs"
                      variant="ghost"
                      disabled={idx === options.length - 1}
                      onClick={() => handleMoveOption(idx, 1)}
                    >
                      <LuArrowDown />
                    </IconButton>
                    <IconButton
                      aria-label="Remove option"
                      size="2xs"
                      variant="ghost"
                      colorPalette="red"
                      onClick={() => handleRemoveOption(idx)}
                    >
                      <LuTrash2 />
                    </IconButton>
                  </HStack>
                ))}
              </Stack>
              {optionsErrors.length > 0 && (
                <Stack gap={1} mt={2}>
                  {optionsErrors.map((err) => (
                    <Text key={err.path} fontSize="xs" color="fg.error">
                      {err.message}
                    </Text>
                  ))}
                </Stack>
              )}
            </Box>
          )}

          {checkType === "annotation" && (
            <Stack gap={2}>
              <HStack gap={4} wrap="wrap" align="flex-start">
                <Field
                  label="File"
                  flex="1"
                  minW="60"
                  helperText="Optional. Restrict this annotation to a specific file path (e.g., 'src/main.ts'). Leave empty to allow it anywhere in the submission."
                >
                  <Input
                    value={check.file ?? ""}
                    onChange={(e) => onChange({ ...check, file: e.target.value || null })}
                    placeholder="src/path/to/File.ts"
                  />
                </Field>
                <Field
                  label="Max annotations"
                  maxW="40"
                  invalid={!!maxAnnotationsError}
                  errorText={maxAnnotationsError}
                  helperText="Max times a grader can apply this on one submission. Empty for unlimited."
                >
                  <Input
                    type="number"
                    value={check.max_annotations ?? ""}
                    onChange={(e) =>
                      onChange({
                        ...check,
                        max_annotations: e.target.value === "" ? null : Number(e.target.value)
                      })
                    }
                  />
                </Field>
              </HStack>
              <Collapsible.Root open={advancedOpen} onOpenChange={(d) => setAdvancedOpen(d.open)}>
                <Collapsible.Trigger asChild>
                  <Button size="2xs" variant="ghost">
                    {advancedOpen ? <LuChevronDown /> : <LuChevronRight />} Advanced annotation settings
                  </Button>
                </Collapsible.Trigger>
                <Collapsible.Content>
                  <HStack gap={4} mt={2} wrap="wrap" align="flex-start">
                    <Field
                      label="Artifact"
                      flex="1"
                      minW="48"
                      helperText="Optional. Restrict this annotation to a specific build artifact instead of a file."
                    >
                      <Input
                        value={check.artifact ?? ""}
                        onChange={(e) => onChange({ ...check, artifact: e.target.value || null })}
                      />
                    </Field>
                    <Field
                      label="Annotation target"
                      maxW="48"
                      helperText="Whether this annotation is placed on a file or on an artifact. Defaults based on whichever of File/Artifact is set."
                    >
                      <NativeSelect.Root size="sm">
                        <NativeSelect.Field
                          value={check.annotation_target ?? ""}
                          onChange={(e) =>
                            onChange({
                              ...check,
                              annotation_target: e.target.value === "" ? null : (e.target.value as "file" | "artifact")
                            })
                          }
                        >
                          <option value="">(default)</option>
                          <option value="file">file</option>
                          <option value="artifact">artifact</option>
                        </NativeSelect.Field>
                        <NativeSelect.Indicator />
                      </NativeSelect.Root>
                    </Field>
                  </HStack>
                </Collapsible.Content>
              </Collapsible.Root>
            </Stack>
          )}

          <Collapsible.Root open={referencesOpen} onOpenChange={(d) => setReferencesOpen(d.open)}>
            <Collapsible.Trigger asChild>
              <Button size="2xs" variant="ghost">
                {referencesOpen ? <LuChevronDown /> : <LuChevronRight />} References{" "}
                {referenceCount > 0 && <Badge ml={1}>{referenceCount}</Badge>}
              </Button>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <Box mt={2} p={2} border="1px dashed" borderColor="border.subtle" borderRadius="md">
                <Stack gap={2}>
                  <Text fontSize="xs" color="fg.muted">
                    Link this check to a check from another rubric on this assignment (e.g., a grading-review check that
                    refers to the matching self-review check). The grader sees the student&apos;s response to the linked
                    check while grading. References are cross-rubric only.
                  </Text>
                  {existingRefs.length === 0 && (
                    <Text fontSize="xs" color="fg.muted">
                      No references. Add a reference to link this check to a check in another review round.
                    </Text>
                  )}
                  {existingRefs.map((ref) => {
                    const target = lookupCandidate(ref.referenced_rubric_check_id);
                    return (
                      <HStack
                        key={ref.referenced_rubric_check_id}
                        gap={2}
                        p={1.5}
                        borderRadius="sm"
                        bg="bg.subtle"
                        fontSize="xs"
                      >
                        <LuLink />
                        <Text flex="1" truncate>
                          {target ? (
                            <>
                              → {target.name}{" "}
                              <Text as="span" color="fg.muted">
                                ({target.reviewRound} · {target.points} pts)
                              </Text>
                            </>
                          ) : (
                            <>
                              → check #{ref.referenced_rubric_check_id}{" "}
                              <Text as="span" color="fg.muted">
                                (target not found in loaded rubrics)
                              </Text>
                            </>
                          )}
                        </Text>
                        <IconButton
                          aria-label="Remove reference"
                          size="2xs"
                          variant="ghost"
                          colorPalette="red"
                          onClick={() => removeReference(ref.referenced_rubric_check_id)}
                        >
                          <LuX />
                        </IconButton>
                      </HStack>
                    );
                  })}

                  {!referenceContext && (
                    <Text fontSize="xs" color="fg.muted">
                      Reference editing requires loaded sibling rubrics.
                    </Text>
                  )}
                  {referenceContext && !isAddingReference && (
                    <Button
                      size="2xs"
                      variant="outline"
                      onClick={() => {
                        setIsAddingReference(true);
                        setSelectedTargetId("");
                      }}
                    >
                      <LuPlus /> Add reference
                    </Button>
                  )}
                  {referenceContext && isAddingReference && (
                    <Stack gap={2}>
                      <NativeSelect.Root size="sm">
                        <NativeSelect.Field
                          aria-label="Select reference target"
                          value={selectedTargetId}
                          onChange={(e) => setSelectedTargetId(e.target.value)}
                        >
                          <option value="">Select target check…</option>
                          {Object.entries(candidatesByRound).map(([round, items]) => (
                            <optgroup key={round} label={round}>
                              {items.map((c) => (
                                <option key={c.id} value={String(c.id)} disabled={c.rubricHasUnsavedChanges}>
                                  {c.name} ({c.points} pts) — {c.rubricName}
                                  {c.rubricHasUnsavedChanges ? " — save tab first" : ""}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </NativeSelect.Field>
                        <NativeSelect.Indicator />
                      </NativeSelect.Root>
                      {selectedTargetId &&
                        addCandidateTargets.find((c) => c.id === Number(selectedTargetId))?.rubricHasUnsavedChanges && (
                          <Text fontSize="xs" color="fg.warning">
                            Save the {addCandidateTargets.find((c) => c.id === Number(selectedTargetId))?.reviewRound}{" "}
                            tab first to reference this check.
                          </Text>
                        )}
                      <HStack gap={1}>
                        <Button
                          size="2xs"
                          colorPalette="green"
                          disabled={
                            !selectedTargetId ||
                            !!addCandidateTargets.find((c) => c.id === Number(selectedTargetId))
                              ?.rubricHasUnsavedChanges
                          }
                          onClick={() => {
                            const id = Number(selectedTargetId);
                            if (!id) return;
                            addReference(id);
                            setIsAddingReference(false);
                            setSelectedTargetId("");
                          }}
                        >
                          Add
                        </Button>
                        <Button
                          size="2xs"
                          variant="outline"
                          onClick={() => {
                            setIsAddingReference(false);
                            setSelectedTargetId("");
                          }}
                        >
                          Cancel
                        </Button>
                      </HStack>
                    </Stack>
                  )}
                </Stack>
              </Box>
            </Collapsible.Content>
          </Collapsible.Root>
        </Stack>
      )}
    </Box>
  );
}

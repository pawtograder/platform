"use client";

import { Field } from "@/components/ui/field";
import { Radio, RadioGroup } from "@/components/ui/radio";
import { Switch } from "@/components/ui/switch";
import { HydratedRubricCheck, RubricChecksDataType } from "@/utils/supabase/DatabaseTypes";
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
  Textarea
} from "@chakra-ui/react";
import { useMemo, useState } from "react";
import { LuChevronDown, LuChevronRight, LuPlus, LuTrash2, LuArrowUp, LuArrowDown } from "react-icons/lu";
import { ValidationError } from "./validation";

type CheckType = "checkbox" | "options" | "annotation";

type CheckRowProps = {
  check: HydratedRubricCheck;
  onChange: (next: HydratedRubricCheck) => void;
  onDelete: () => void;
  validationErrors: ValidationError[];
  pathPrefix: string;
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

export function CheckRow({ check, onChange, onDelete, validationErrors, pathPrefix }: CheckRowProps) {
  const [expanded, setExpanded] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [referencesOpen, setReferencesOpen] = useState(false);

  const checkType = getCheckType(check);
  const options = getOptions(check);

  const nameError = errorFor(validationErrors, `${pathPrefix}.name`);
  const optionsErrors = errorsStartingWith(validationErrors, `${pathPrefix}.data.options`);
  const maxAnnotationsError = errorFor(validationErrors, `${pathPrefix}.max_annotations`);

  // Phase 3 will wire actual references; for now show a stub count of 0.
  const referenceCount = 0;

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
          <Field label="Name" required invalid={!!nameError} errorText={nameError}>
            <Input
              value={check.name ?? ""}
              onChange={(e) => onChange({ ...check, name: e.target.value })}
              placeholder="Check name"
            />
          </Field>
          <Field label="Description" helperText="Markdown supported.">
            <Textarea
              value={check.description ?? ""}
              onChange={(e) => onChange({ ...check, description: e.target.value || null })}
              rows={2}
            />
          </Field>
          <HStack gap={4} align="flex-end" wrap="wrap">
            <Field label="Points" maxW="32">
              <Input
                type="number"
                value={check.points ?? 0}
                onChange={(e) => onChange({ ...check, points: Number(e.target.value) })}
              />
            </Field>
            <Field label="Student visibility" maxW="56">
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
            <Switch checked={check.is_required} onCheckedChange={(d) => onChange({ ...check, is_required: d.checked })}>
              Required
            </Switch>
            <Switch
              checked={check.is_comment_required}
              onCheckedChange={(d) => onChange({ ...check, is_comment_required: d.checked })}
            >
              Comment required
            </Switch>
          </HStack>

          <Field label="Check type">
            <RadioGroup value={checkType} onValueChange={(d) => d.value && handleTypeChange(d.value as CheckType)}>
              <HStack gap={4}>
                <Radio value="checkbox">Checkbox</Radio>
                <Radio value="options">Multi-option</Radio>
                <Radio value="annotation">Annotation</Radio>
              </HStack>
            </RadioGroup>
          </Field>

          {checkType === "options" && (
            <Box border="1px dashed" borderColor="border.subtle" borderRadius="md" p={2}>
              <HStack justify="space-between" mb={2}>
                <Text fontSize="sm" fontWeight="medium">
                  Options
                </Text>
                <Button size="2xs" variant="ghost" onClick={handleAddOption}>
                  <LuPlus /> Add option
                </Button>
              </HStack>
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
              <HStack gap={4} wrap="wrap">
                <Field label="File" flex="1" minW="60">
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
                  <HStack gap={4} mt={2} wrap="wrap">
                    <Field label="Artifact" flex="1" minW="48">
                      <Input
                        value={check.artifact ?? ""}
                        onChange={(e) => onChange({ ...check, artifact: e.target.value || null })}
                      />
                    </Field>
                    <Field label="Annotation target" maxW="48">
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
                <Text fontSize="xs" color="fg.muted">
                  References will be wired in phase 3.
                </Text>
              </Box>
            </Collapsible.Content>
          </Collapsible.Root>
        </Stack>
      )}
    </Box>
  );
}

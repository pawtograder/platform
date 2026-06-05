"use client";

import { Badge, Box, Button, HStack, IconButton, Input, NativeSelect, Text, VStack } from "@chakra-ui/react";
import { LuPlus, LuX } from "react-icons/lu";
import type { RubricFilter, RubricFilterLeaf } from "@/lib/rubricReport/filterSchema";

/** A rubric check, with the metadata the builder needs to render pickers. */
export type CheckOption = {
  id: number;
  name: string;
  criterionName: string;
  options: { index: number; label: string }[];
};

type GroupNode = { op: "and" | "or" | "not"; args: RubricFilter[] };

type LeafKind = "checkApplied" | "optionSelected" | "section" | "lab" | "scoreAtLeast" | "scoreAtMost";

const LEAF_LABELS: Record<LeafKind, string> = {
  checkApplied: "Check applied",
  optionSelected: "Option selected",
  section: "Class section",
  lab: "Lab section",
  scoreAtLeast: "Score ≥",
  scoreAtMost: "Score ≤"
};

const isGroup = (node: RubricFilter): node is GroupNode => "op" in node;

function leafKind(node: RubricFilterLeaf): LeafKind {
  if ("checkApplied" in node) return "checkApplied";
  if ("optionSelected" in node) return "optionSelected";
  if ("section" in node) return "section";
  if ("lab" in node) return "lab";
  if ("scoreAtLeast" in node) return "scoreAtLeast";
  return "scoreAtMost";
}

function defaultLeaf(kind: LeafKind, checks: CheckOption[], sections: string[], labs: string[]): RubricFilterLeaf {
  switch (kind) {
    case "checkApplied":
      return { checkApplied: checks[0]?.id ?? 0 };
    case "optionSelected": {
      const withOptions = checks.find((c) => c.options.length > 0);
      return { optionSelected: { checkId: withOptions?.id ?? checks[0]?.id ?? 0, optionIndex: 0 } };
    }
    case "section":
      return { section: sections[0] ?? "" };
    case "lab":
      return { lab: labs[0] ?? "" };
    case "scoreAtLeast":
      return { scoreAtLeast: 0 };
    case "scoreAtMost":
      return { scoreAtMost: 100 };
  }
}

function LeafEditor({
  node,
  onChange,
  onRemove,
  checks,
  sections,
  labs
}: {
  node: RubricFilterLeaf;
  onChange: (next: RubricFilterLeaf) => void;
  onRemove: () => void;
  checks: CheckOption[];
  sections: string[];
  labs: string[];
}) {
  const kind = leafKind(node);
  const checksWithOptions = checks.filter((c) => c.options.length > 0);
  const selectedOptionCheck =
    kind === "optionSelected"
      ? checks.find((c) => c.id === (node as { optionSelected: { checkId: number } }).optionSelected.checkId)
      : undefined;

  return (
    <HStack gap={2} wrap="wrap">
      <NativeSelect.Root size="sm" width="auto" minW="36">
        <NativeSelect.Field
          value={kind}
          onChange={(e) => onChange(defaultLeaf(e.target.value as LeafKind, checks, sections, labs))}
        >
          {(Object.keys(LEAF_LABELS) as LeafKind[]).map((k) => (
            <option key={k} value={k}>
              {LEAF_LABELS[k]}
            </option>
          ))}
        </NativeSelect.Field>
      </NativeSelect.Root>

      {kind === "checkApplied" && (
        <NativeSelect.Root size="sm" width="auto" minW="48">
          <NativeSelect.Field
            value={(node as { checkApplied: number }).checkApplied}
            onChange={(e) => onChange({ checkApplied: Number(e.target.value) })}
          >
            {checks.map((c) => (
              <option key={c.id} value={c.id}>
                {c.criterionName}: {c.name}
              </option>
            ))}
          </NativeSelect.Field>
        </NativeSelect.Root>
      )}

      {kind === "optionSelected" && (
        <>
          <NativeSelect.Root size="sm" width="auto" minW="40">
            <NativeSelect.Field
              value={(node as { optionSelected: { checkId: number } }).optionSelected.checkId}
              onChange={(e) => onChange({ optionSelected: { checkId: Number(e.target.value), optionIndex: 0 } })}
            >
              {checksWithOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect.Field>
          </NativeSelect.Root>
          <NativeSelect.Root size="sm" width="auto" minW="32">
            <NativeSelect.Field
              value={(node as { optionSelected: { optionIndex: number } }).optionSelected.optionIndex}
              onChange={(e) =>
                onChange({
                  optionSelected: {
                    checkId: (node as { optionSelected: { checkId: number } }).optionSelected.checkId,
                    optionIndex: Number(e.target.value)
                  }
                })
              }
            >
              {(selectedOptionCheck?.options ?? []).map((o) => (
                <option key={o.index} value={o.index}>
                  {o.label}
                </option>
              ))}
            </NativeSelect.Field>
          </NativeSelect.Root>
        </>
      )}

      {kind === "section" && (
        <NativeSelect.Root size="sm" width="auto" minW="40">
          <NativeSelect.Field
            value={(node as { section: string }).section}
            onChange={(e) => onChange({ section: e.target.value })}
          >
            {sections.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </NativeSelect.Field>
        </NativeSelect.Root>
      )}

      {kind === "lab" && (
        <NativeSelect.Root size="sm" width="auto" minW="40">
          <NativeSelect.Field value={(node as { lab: string }).lab} onChange={(e) => onChange({ lab: e.target.value })}>
            {labs.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </NativeSelect.Field>
        </NativeSelect.Root>
      )}

      {(kind === "scoreAtLeast" || kind === "scoreAtMost") && (
        <Input
          size="sm"
          type="number"
          width="24"
          value={(node as Record<string, number>)[kind]}
          onChange={(e) => onChange({ [kind]: Number(e.target.value) } as RubricFilterLeaf)}
        />
      )}

      <IconButton aria-label="Remove condition" size="xs" variant="ghost" onClick={onRemove}>
        <LuX />
      </IconButton>
    </HStack>
  );
}

function GroupEditor({
  node,
  onChange,
  onRemove,
  depth,
  checks,
  sections,
  labs
}: {
  node: GroupNode;
  onChange: (next: GroupNode) => void;
  onRemove?: () => void;
  depth: number;
  checks: CheckOption[];
  sections: string[];
  labs: string[];
}) {
  const setArg = (index: number, next: RubricFilter) =>
    onChange({ ...node, args: node.args.map((a, i) => (i === index ? next : a)) });
  const removeArg = (index: number) => onChange({ ...node, args: node.args.filter((_, i) => i !== index) });
  const addLeaf = () => onChange({ ...node, args: [...node.args, defaultLeaf("section", checks, sections, labs)] });
  const addGroup = () => onChange({ ...node, args: [...node.args, { op: "and", args: [] }] });

  const isNot = node.op === "not";
  const canAdd = !isNot || node.args.length === 0;

  return (
    <Box borderWidth="1px" borderColor="border.muted" borderRadius="md" p={3} bg={depth % 2 === 0 ? "bg.subtle" : "bg"}>
      <HStack justify="space-between" mb={2}>
        <HStack gap={2}>
          <NativeSelect.Root size="sm" width="auto" minW="20">
            <NativeSelect.Field
              value={node.op}
              onChange={(e) => {
                const op = e.target.value as GroupNode["op"];
                // NOT keeps a single arg.
                const args = op === "not" ? node.args.slice(0, 1) : node.args;
                onChange({ op, args });
              }}
            >
              <option value="and">ALL of (AND)</option>
              <option value="or">ANY of (OR)</option>
              <option value="not">NOT</option>
            </NativeSelect.Field>
          </NativeSelect.Root>
          <Badge variant="subtle">{node.args.length}</Badge>
        </HStack>
        {onRemove && (
          <IconButton aria-label="Remove group" size="xs" variant="ghost" onClick={onRemove}>
            <LuX />
          </IconButton>
        )}
      </HStack>

      <VStack align="stretch" gap={2} pl={2}>
        {node.args.length === 0 && (
          <Text fontSize="xs" color="fg.muted">
            No conditions — matches everyone.
          </Text>
        )}
        {node.args.map((arg, i) =>
          isGroup(arg) ? (
            <GroupEditor
              key={i}
              node={arg}
              depth={depth + 1}
              onChange={(next) => setArg(i, next)}
              onRemove={() => removeArg(i)}
              checks={checks}
              sections={sections}
              labs={labs}
            />
          ) : (
            <LeafEditor
              key={i}
              node={arg}
              onChange={(next) => setArg(i, next)}
              onRemove={() => removeArg(i)}
              checks={checks}
              sections={sections}
              labs={labs}
            />
          )
        )}
      </VStack>

      {canAdd && (
        <HStack mt={2} gap={2} pl={2}>
          <Button size="xs" variant="outline" onClick={addLeaf}>
            <LuPlus /> Condition
          </Button>
          <Button size="xs" variant="ghost" onClick={addGroup}>
            <LuPlus /> Group
          </Button>
        </HStack>
      )}
    </Box>
  );
}

/**
 * Builds a typed RubricFilter AST through nestable AND/OR/NOT groups and leaf predicates.
 * The top-level node is always a group. Emits the validated-by-construction AST via onChange.
 */
export default function RubricReportFilterBuilder({
  value,
  onChange,
  checks,
  sections,
  labs
}: {
  value: GroupNode;
  onChange: (next: GroupNode) => void;
  checks: CheckOption[];
  sections: string[];
  labs: string[];
}) {
  return <GroupEditor node={value} onChange={onChange} depth={0} checks={checks} sections={sections} labs={labs} />;
}

"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Box, Button, HStack, Text, VStack } from "@chakra-ui/react";

/** The rubric hierarchy (part → criteria → checks) the selector renders. */
export type RubricTreePart = {
  partId: number;
  partName: string;
  criteria: { critId: number; critName: string; checks: { id: number; name: string }[] }[];
};

type TriState = boolean | "indeterminate";

/**
 * Multi-tier include/exclude selector over the rubric hierarchy. Toggling a part or
 * criterion toggles all of its descendant checks. `included` is the effective set of
 * included check ids; `onChange` receives the next set.
 */
export default function RubricItemSelector({
  tree,
  included,
  onChange
}: {
  tree: RubricTreePart[];
  included: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  const allIds = tree.flatMap((p) => p.criteria.flatMap((c) => c.checks.map((ck) => ck.id)));

  const toggle = (ids: number[], include: boolean) => {
    const next = new Set(included);
    for (const id of ids) {
      if (include) next.add(id);
      else next.delete(id);
    }
    onChange(next);
  };

  const stateFor = (ids: number[]): TriState => {
    if (ids.length === 0) return false;
    const includedCount = ids.filter((id) => included.has(id)).length;
    if (includedCount === 0) return false;
    if (includedCount === ids.length) return true;
    return "indeterminate";
  };

  return (
    <Box>
      <HStack mb={2} gap={2}>
        <Button size="2xs" variant="outline" onClick={() => onChange(new Set(allIds))}>
          Select all
        </Button>
        <Button size="2xs" variant="outline" onClick={() => onChange(new Set())}>
          Clear
        </Button>
      </HStack>
      <VStack align="stretch" gap={2}>
        {tree.map((part) => {
          const partCheckIds = part.criteria.flatMap((c) => c.checks.map((ck) => ck.id));
          if (partCheckIds.length === 0) return null;
          return (
            <Box key={part.partId}>
              <Checkbox
                checked={stateFor(partCheckIds)}
                onCheckedChange={(d) => toggle(partCheckIds, d.checked === true)}
                fontWeight="medium"
              >
                {part.partName}
              </Checkbox>
              <VStack align="stretch" gap={1} pl={5} mt={1}>
                {part.criteria.map((crit) => {
                  const critCheckIds = crit.checks.map((ck) => ck.id);
                  if (critCheckIds.length === 0) return null;
                  return (
                    <Box key={crit.critId}>
                      <Checkbox
                        size="sm"
                        checked={stateFor(critCheckIds)}
                        onCheckedChange={(d) => toggle(critCheckIds, d.checked === true)}
                      >
                        <Text fontSize="sm" fontWeight="medium">
                          {crit.critName}
                        </Text>
                      </Checkbox>
                      <VStack align="stretch" gap={0.5} pl={5}>
                        {crit.checks.map((ck) => (
                          <Checkbox
                            key={ck.id}
                            size="sm"
                            checked={included.has(ck.id)}
                            onCheckedChange={(d) => toggle([ck.id], d.checked === true)}
                          >
                            <Text fontSize="sm" color="fg.muted">
                              {ck.name}
                            </Text>
                          </Checkbox>
                        ))}
                      </VStack>
                    </Box>
                  );
                })}
              </VStack>
            </Box>
          );
        })}
      </VStack>
    </Box>
  );
}

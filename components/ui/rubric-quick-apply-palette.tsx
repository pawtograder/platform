"use client";

import { RubricContextMenuAction } from "@/hooks/useRubricAnnotationActions";
import { Box, Flex, HStack, Icon, Input, Text, VStack } from "@chakra-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FaBolt } from "react-icons/fa";

// Subsequence fuzzy scorer (same heuristic as command-palette.tsx) over "<criteria> <label>".
function fuzzyMatch(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let qi = 0;
  let prevMatch = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += 1;
      if (i === prevMatch + 1) score += 0.5; // consecutive
      if (i === 0 || t[i - 1] === " " || t[i - 1] === "/" || t[i - 1] === ".") score += 1; // word boundary
      prevMatch = i;
      qi++;
    }
  }
  if (qi < q.length) return 0;
  if (t.includes(q)) score += 2;
  return score;
}

type RubricQuickApplyPaletteProps = {
  isOpen: boolean;
  onClose: () => void;
  actions: RubricContextMenuAction[];
  /** The line the palette will annotate (shown in the header for context). */
  lineNumber?: number | null;
  /** Invoked with the chosen action. The caller decides immediate-apply vs. comment dialog. */
  onPick: (action: RubricContextMenuAction) => void;
};

/**
 * Keyboard-first command palette for applying a rubric check to a line during grading (productivity
 * layer). Modeled on `command-palette.tsx`: fuzzy-filter, Arrow up/down to move, Enter to pick. It is
 * intentionally "dumb" — picking an action just calls `onPick`; the editor variant routes that through
 * its existing immediate-apply (for `!is_comment_required`) or comment-dialog handlers.
 */
export function RubricQuickApplyPalette({
  isOpen,
  onClose,
  actions,
  lineNumber,
  onPick
}: RubricQuickApplyPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const filtered = useMemo(() => {
    if (!query.trim()) return actions.map((action) => ({ action, score: 0 }));
    return actions
      .map((action) => ({ action, score: fuzzyMatch(query, `${action.criteria?.name ?? ""} ${action.label}`) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
  }, [query, actions]);

  useEffect(() => {
    if (selectedIndex >= filtered.length) setSelectedIndex(Math.max(0, filtered.length - 1));
  }, [filtered.length, selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = filtered[selectedIndex];
      if (selected) {
        onPick(selected.action);
        onClose();
      }
    } else if (/^[1-9]$/.test(e.key)) {
      // Number keys 1-9 directly apply the Nth visible check (the digit is consumed, not typed into
      // the filter — rubric checks are picked by name, not by number). Always consume the digit,
      // even when out of range, so it never leaks into the filter input.
      e.preventDefault();
      const idx = Number(e.key) - 1;
      if (idx < filtered.length) {
        onPick(filtered[idx].action);
        onClose();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <Box
      position="fixed"
      top={0}
      left={0}
      right={0}
      bottom={0}
      bg="blackAlpha.600"
      zIndex={10000}
      onClick={onClose}
      display="flex"
      alignItems="flex-start"
      justifyContent="center"
      pt="20vh"
      role="dialog"
      aria-label="Quick-apply rubric check"
      data-rubric-quick-apply=""
    >
      <Box
        w="600px"
        maxW="90vw"
        bg="bg.panel"
        border="1px solid"
        borderColor="border.emphasized"
        borderRadius="md"
        boxShadow="xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Flex p={3} borderBottom="1px solid" borderColor="border.emphasized" alignItems="center" gap={2}>
          <Icon as={FaBolt} color="fg.muted" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={lineNumber != null ? `Apply a check to line ${lineNumber}…` : "Apply a check…"}
            border="none"
            _focus={{ outline: "none" }}
            fontSize="md"
            aria-label="Search rubric checks"
          />
        </Flex>
        <Box maxH="400px" overflowY="auto">
          {filtered.length === 0 ? (
            <Box p={4} textAlign="center" color="fg.muted">
              <Text>No matching checks</Text>
            </Box>
          ) : (
            <VStack align="stretch" gap={0}>
              {filtered.map(({ action }, index) => {
                const isSelected = index === selectedIndex;
                return (
                  <HStack
                    key={action.id}
                    p={3}
                    bg={isSelected ? "bg.info" : "transparent"}
                    _hover={{ bg: isSelected ? "bg.info" : "bg.muted" }}
                    cursor="pointer"
                    onClick={() => {
                      onPick(action);
                      onClose();
                    }}
                    gap={2}
                    data-selected={isSelected ? "true" : undefined}
                  >
                    <Icon as={FaBolt} color={isSelected ? "fg.info" : "fg.muted"} flexShrink={0} />
                    {index < 9 && (
                      <Box
                        as="kbd"
                        flexShrink={0}
                        minW="5"
                        textAlign="center"
                        px="1"
                        borderWidth="1px"
                        borderColor="border.emphasized"
                        borderBottomWidth="2px"
                        borderRadius="sm"
                        bg="bg.muted"
                        fontSize="xs"
                        fontFamily="mono"
                        color="fg.muted"
                      >
                        {index + 1}
                      </Box>
                    )}
                    <VStack align="stretch" gap={0} flex={1} minW={0}>
                      <Text fontSize="sm" fontWeight={isSelected ? "semibold" : "normal"} lineClamp={1}>
                        {action.label}
                      </Text>
                      {action.criteria?.name && (
                        <Text fontSize="xs" color="fg.muted" lineClamp={1}>
                          {action.criteria.name}
                          {action.check?.is_comment_required ? " • comment required" : ""}
                        </Text>
                      )}
                    </VStack>
                  </HStack>
                );
              })}
            </VStack>
          )}
        </Box>
      </Box>
    </Box>
  );
}

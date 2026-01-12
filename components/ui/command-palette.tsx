"use client";

import { SubmissionFile } from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, HStack, Icon, Input, Text, VStack } from "@chakra-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FaFile, FaSearch } from "react-icons/fa";

type CommandPaletteProps = {
  files: SubmissionFile[];
  isOpen: boolean;
  onClose: () => void;
  onSelectFile: (fileId: number) => void;
  mode?: "file" | "symbol";
  symbols?: Array<{ name: string; fileId: number; line: number; kind: string }>;
  onSelectSymbol?: (fileId: number, line: number) => void;
};

// Simple fuzzy match scoring
function fuzzyMatch(query: string, text: string): { score: number; matches: number[] } {
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();
  let score = 0;
  const matches: number[] = [];
  let queryIndex = 0;

  for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIndex]) {
      matches.push(i);
      score += 1;
      // Bonus for consecutive matches
      if (matches.length > 1 && matches[matches.length - 1] === matches[matches.length - 2] + 1) {
        score += 0.5;
      }
      // Bonus for matches at word boundaries
      if (i === 0 || lowerText[i - 1] === "/" || lowerText[i - 1] === ".") {
        score += 1;
      }
      queryIndex++;
    }
  }

  // Penalize if not all query characters matched
  if (queryIndex < lowerQuery.length) {
    score = 0;
  }

  // Bonus for exact substring match
  if (lowerText.includes(lowerQuery)) {
    score += 2;
  }

  return { score, matches };
}

export function CommandPalette({
  files,
  isOpen,
  onClose,
  onSelectFile,
  mode = "file",
  symbols = [],
  onSelectSymbol
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      // Focus input after a brief delay to ensure modal is rendered
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  const filteredItems = useMemo(() => {
    if (!query.trim()) {
      if (mode === "file") {
        return files.map((f) => ({ type: "file" as const, file: f, score: 0, matches: [] }));
      } else {
        return symbols.map((s) => ({ type: "symbol" as const, symbol: s, score: 0, matches: [] }));
      }
    }

    if (mode === "file") {
      const results = files
        .map((file) => {
          const match = fuzzyMatch(query, file.name);
          return {
            type: "file" as const,
            file,
            score: match.score,
            matches: match.matches
          };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score);

      return results;
    } else {
      const results = symbols
        .map((symbol) => {
          const match = fuzzyMatch(query, symbol.name);
          return {
            type: "symbol" as const,
            symbol,
            score: match.score,
            matches: match.matches
          };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score);

      return results;
    }
  }, [query, files, symbols, mode]);

  useEffect(() => {
    if (selectedIndex >= filteredItems.length) {
      setSelectedIndex(Math.max(0, filteredItems.length - 1));
    }
  }, [filteredItems.length, selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filteredItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = filteredItems[selectedIndex];
      if (selected) {
        if (selected.type === "file") {
          onSelectFile(selected.file.id);
        } else if (selected.type === "symbol" && onSelectSymbol) {
          onSelectSymbol(selected.symbol.fileId, selected.symbol.line);
        }
        onClose();
      }
    }
  };

  if (!isOpen) return null;

  const highlightText = (text: string, matches: number[]) => {
    const parts: Array<{ text: string; highlight: boolean }> = [];
    let lastIndex = 0;

    for (const matchIndex of matches) {
      if (matchIndex > lastIndex) {
        parts.push({ text: text.slice(lastIndex, matchIndex), highlight: false });
      }
      parts.push({ text: text[matchIndex], highlight: true });
      lastIndex = matchIndex + 1;
    }

    if (lastIndex < text.length) {
      parts.push({ text: text.slice(lastIndex), highlight: false });
    }

    return (
      <>
        {parts.map((part, i) =>
          part.highlight ? (
            <Text as="span" key={i} fontWeight="bold" bg="bg.info">
              {part.text}
            </Text>
          ) : (
            <Text as="span" key={i}>
              {part.text}
            </Text>
          )
        )}
      </>
    );
  };

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
    >
      <Box
        w="600px"
        maxW="90vw"
        bg="bg.default"
        border="1px solid"
        borderColor="border.emphasized"
        borderRadius="md"
        boxShadow="xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Flex p={3} borderBottom="1px solid" borderColor="border.emphasized" alignItems="center" gap={2}>
          <Icon as={mode === "file" ? FaFile : FaSearch} color="fg.muted" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={mode === "file" ? "Type to search files..." : "Type to search symbols..."}
            border="none"
            _focus={{ outline: "none" }}
            fontSize="md"
          />
        </Flex>
        <Box maxH="400px" overflowY="auto">
          {filteredItems.length === 0 ? (
            <Box p={4} textAlign="center" color="fg.muted">
              <Text>No results found</Text>
            </Box>
          ) : (
            <VStack align="stretch" gap={0}>
              {filteredItems.map((item, index) => {
                const isSelected = index === selectedIndex;
                return (
                  <HStack
                    key={item.type === "file" ? item.file.id : `${item.symbol.fileId}-${item.symbol.line}`}
                    p={3}
                    bg={isSelected ? "bg.info" : "transparent"}
                    _hover={{ bg: isSelected ? "bg.info" : "bg.muted" }}
                    cursor="pointer"
                    onClick={() => {
                      if (item.type === "file") {
                        onSelectFile(item.file.id);
                      } else if (item.type === "symbol" && onSelectSymbol) {
                        onSelectSymbol(item.symbol.fileId, item.symbol.line);
                      }
                      onClose();
                    }}
                    gap={2}
                  >
                    <Icon
                      as={item.type === "file" ? FaFile : FaSearch}
                      color={isSelected ? "fg.info" : "fg.muted"}
                      flexShrink={0}
                    />
                    <VStack align="stretch" gap={0} flex={1} minW={0}>
                      {item.type === "file" ? (
                        <>
                          <Text fontSize="sm" fontWeight={isSelected ? "semibold" : "normal"} noOfLines={1}>
                            {highlightText(item.file.name, item.matches)}
                          </Text>
                          <Text fontSize="xs" color="fg.muted" noOfLines={1}>
                            {item.file.name}
                          </Text>
                        </>
                      ) : (
                        <>
                          <Text fontSize="sm" fontWeight={isSelected ? "semibold" : "normal"}>
                            {highlightText(item.symbol.name, item.matches)}
                          </Text>
                          <Text fontSize="xs" color="fg.muted">
                            {item.symbol.kind} • Line {item.symbol.line}
                          </Text>
                        </>
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

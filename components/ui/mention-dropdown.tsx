"use client";
import React from "react";
import { Box, Text, VStack, HStack, Badge } from "@chakra-ui/react";
import { MentionableThread } from "@/hooks/useMentions";

interface MentionDropdownProps {
  threads: MentionableThread[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  position: { top: number; left: number };
  visible: boolean;
}

export function MentionDropdown({ threads, selectedIndex, onSelect, position, visible }: MentionDropdownProps) {
  if (!visible || threads.length === 0) {
    return null;
  }

  return (
    <Box
      position="absolute"
      top={`${position.top}px`}
      left={`${position.left}px`}
      zIndex={1000}
      bg="bg.panel"
      border="1px solid"
      borderColor="border.subtle"
      borderRadius="md"
      boxShadow="lg"
      maxW="400px"
      maxH="300px"
      overflow="auto"
      py="2"
    >
      <VStack align="stretch" gap="0">
        {threads.map((thread, index) => (
          <Box
            key={thread.id}
            px="3"
            py="2"
            cursor="pointer"
            bg={index === selectedIndex ? "bg.muted" : "transparent"}
            _hover={{ bg: "bg.muted" }}
            onMouseDown={(event: React.MouseEvent) => {
              event.preventDefault();
              onSelect(index);
            }}
            borderRadius="sm"
            mx="1"
          >
            <HStack justify="space-between" align="flex-start">
              <VStack align="flex-start" gap="1" flex="1" minW="0">
                <HStack gap="2" align="center">
                  <Badge colorPalette="blue" size="sm">
                    #{thread.ordinal}
                  </Badge>
                  <Text fontSize="sm" fontWeight="medium" truncate>
                    {thread.subject}
                  </Text>
                </HStack>
                <Text fontSize="xs" color="text.muted" lineHeight="short" truncate>
                  {thread.body}
                </Text>
              </VStack>
            </HStack>
          </Box>
        ))}
      </VStack>
      {threads.length === 0 && (
        <Text px="3" py="2" fontSize="sm" color="text.muted">
          No matching discussion threads found
        </Text>
      )}
    </Box>
  );
}

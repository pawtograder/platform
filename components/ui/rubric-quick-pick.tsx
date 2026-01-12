"use client";
import { Box, VStack, HStack, Text, Button } from "@chakra-ui/react";
import { RubricContextMenuAction } from "./monaco-rubric-context-menu";

export type RubricQuickPickProps = {
  isOpen: boolean;
  title: string;
  items: RubricContextMenuAction[];
  onSelect: (action: RubricContextMenuAction) => void;
  onClose: () => void;
  position?: { top: number; left: number };
};

export function RubricQuickPick({
  isOpen,
  title,
  items,
  onSelect,
  onClose,
  position
}: RubricQuickPickProps) {
  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <Box
        position="fixed"
        top={0}
        left={0}
        right={0}
        bottom={0}
        zIndex={999}
        onClick={onClose}
      />
      {/* Quick pick menu - centered at mouse position */}
      <Box
        position="fixed"
        top={position ? `${position.top}px` : "50vh"}
        left={position ? `${position.left}px` : "50vw"}
        transform="translate(-50%, -50%)"
        zIndex={1000}
        bg="bg.subtle"
        border="1px solid"
        borderColor="border.emphasized"
        borderRadius="md"
        boxShadow="lg"
        minW="300px"
        maxW="500px"
        maxH="400px"
        overflowY="auto"
      >
        <VStack gap={0} align="stretch">
          <Box p={3} borderBottom="1px solid" borderColor="border.emphasized">
            <Text fontSize="sm" fontWeight="semibold" color="fg.default">
              {title}
            </Text>
          </Box>
          {items.map((action, index) => (
            <Button
              key={action.id}
              variant="ghost"
              justifyContent="flex-start"
              textAlign="left"
              p={3}
              borderRadius={0}
              onClick={() => {
                onSelect(action);
                onClose();
              }}
              _hover={{ bg: "bg.emphasized" }}
            >
              <VStack align="flex-start" gap={0} w="100%">
                <Text fontSize="sm" fontWeight="medium">
                  {action.label}
                </Text>
                {action.check?.is_comment_required && (
                  <Text fontSize="xs" color="fg.muted">
                    Comment required
                  </Text>
                )}
              </VStack>
            </Button>
          ))}
        </VStack>
      </Box>
    </>
  );
}

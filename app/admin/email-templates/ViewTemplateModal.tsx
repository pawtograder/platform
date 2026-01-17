"use client";

import {
  Box,
  Button,
  HStack,
  Text,
  VStack,
  Badge,
  Code,
  Separator
} from "@chakra-ui/react";
import type { EmailTemplate } from "./page";
import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogCloseTrigger
} from "@/components/ui/dialog";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  template: EmailTemplate | null;
};

export function ViewTemplateModal({ isOpen, onClose, template }: Props) {
  if (!template) return null;

  return (
    <DialogRoot open={isOpen} onOpenChange={(e) => !e.open && onClose()} size="xl">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Template: {template.name}</DialogTitle>
          <DialogCloseTrigger />
        </DialogHeader>

        <DialogBody>
          <VStack gap={4} align="stretch">
            {/* Status and Metadata */}
            <HStack gap={2} flexWrap="wrap">
              <Badge colorPalette={template.is_active ? "green" : "gray"}>
                {template.is_active ? "Active" : "Inactive"}
              </Badge>
              <Badge colorPalette="blue">Scope: {template.scope}</Badge>
              {template.requires_assignment && (
                <Badge colorPalette="purple">Requires Assignment</Badge>
              )}
              {template.requires_lab_section && (
                <Badge colorPalette="green">Requires Lab Section</Badge>
              )}
            </HStack>

            {/* Description */}
            {template.description && (
              <Box>
                <Text fontWeight="medium" fontSize="sm" mb={1}>
                  Description
                </Text>
                <Text color="fg.muted">{template.description}</Text>
              </Box>
            )}

            <Separator />

            {/* RPC Function */}
            <Box>
              <Text fontWeight="medium" fontSize="sm" mb={1}>
                Recipient Query Function
              </Text>
              <Code p={2} display="block" borderRadius="md">
                {template.rpc_function_name}
              </Code>
              {template.rpc_description && (
                <Text fontSize="xs" color="fg.muted" mt={1}>
                  {template.rpc_description}
                </Text>
              )}
            </Box>

            <Separator />

            {/* Available Variables */}
            <Box>
              <Text fontWeight="medium" fontSize="sm" mb={2}>
                Available Variables ({template.available_variables?.length || 0})
              </Text>
              <Box
                p={3}
                borderWidth="1px"
                borderRadius="md"
                bg="bg.subtle"
                maxH="200px"
                overflowY="auto"
              >
                <VStack gap={2} align="stretch">
                  {template.available_variables?.map((variable) => (
                    <HStack key={variable} justify="space-between">
                      <Code fontSize="sm">{`{${variable}}`}</Code>
                      <Text fontSize="xs" color="fg.muted">
                        {template.variable_descriptions?.[variable] || "No description"}
                      </Text>
                    </HStack>
                  ))}
                </VStack>
              </Box>
            </Box>

            <Separator />

            {/* Subject Template */}
            <Box>
              <Text fontWeight="medium" fontSize="sm" mb={1}>
                Subject Template
              </Text>
              <Box p={3} borderWidth="1px" borderRadius="md" bg="bg.subtle">
                <Text fontFamily="mono" fontSize="sm">
                  {template.subject_template}
                </Text>
              </Box>
            </Box>

            {/* Body Template */}
            <Box>
              <Text fontWeight="medium" fontSize="sm" mb={1}>
                Body Template
              </Text>
              <Box
                p={3}
                borderWidth="1px"
                borderRadius="md"
                bg="bg.subtle"
                maxH="300px"
                overflowY="auto"
              >
                <Text
                  fontFamily="mono"
                  fontSize="sm"
                  whiteSpace="pre-wrap"
                  wordBreak="break-word"
                >
                  {template.body_template}
                </Text>
              </Box>
            </Box>

            {/* Metadata */}
            <Box>
              <Text fontSize="xs" color="fg.muted">
                Created: {new Date(template.created_at).toLocaleString()}
                {template.updated_at !== template.created_at && (
                  <> | Updated: {new Date(template.updated_at).toLocaleString()}</>
                )}
              </Text>
            </Box>
          </VStack>
        </DialogBody>

        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

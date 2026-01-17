"use client";

import {
  Box,
  Button,
  Field,
  Fieldset,
  HStack,
  Input,
  Text,
  Textarea,
  VStack,
  Badge,
  Flex
} from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import { useEffect, useState } from "react";
import type { EmailTemplate, AvailableRpc } from "./page";
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
  availableRpcs: AvailableRpc[];
  onSave: (data: Partial<EmailTemplate>, isEdit: boolean) => Promise<boolean>;
};

export function CreateEditTemplateModal({ isOpen, onClose, template, availableRpcs, onSave }: Props) {
  const isEdit = template !== null;
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [subjectTemplate, setSubjectTemplate] = useState("");
  const [bodyTemplate, setBodyTemplate] = useState("");
  const [selectedRpc, setSelectedRpc] = useState<AvailableRpc | null>(null);
  const [variableDescriptions, setVariableDescriptions] = useState<Record<string, string>>({});

  // Reset form when modal opens/closes or template changes
  useEffect(() => {
    if (template) {
      setName(template.name);
      setDescription(template.description || "");
      setSubjectTemplate(template.subject_template);
      setBodyTemplate(template.body_template);
      setVariableDescriptions(template.variable_descriptions || {});

      const rpc = availableRpcs.find((r) => r.rpc_name === template.rpc_function_name);
      setSelectedRpc(rpc || null);
    } else {
      setName("");
      setDescription("");
      setSubjectTemplate("");
      setBodyTemplate("");
      setSelectedRpc(null);
      setVariableDescriptions({});
    }
  }, [template, availableRpcs, isOpen]);

  // Update variable descriptions when RPC changes
  useEffect(() => {
    if (selectedRpc && !isEdit) {
      // Initialize variable descriptions from RPC
      const newDescriptions: Record<string, string> = {};
      selectedRpc.available_variables?.forEach((v) => {
        newDescriptions[v] = "";
      });
      // Add course_name as it's always available
      newDescriptions["course_name"] = "Name of the course";
      setVariableDescriptions(newDescriptions);
    }
  }, [selectedRpc, isEdit]);

  const handleSave = async () => {
    if (!name || !subjectTemplate || !bodyTemplate || !selectedRpc) {
      return;
    }

    setIsSaving(true);
    try {
      // Combine RPC variables with course_name
      const allVariables = [...(selectedRpc.available_variables || [])];
      if (!allVariables.includes("course_name")) {
        allVariables.push("course_name");
      }

      const success = await onSave(
        {
          name,
          description: description || null,
          subject_template: subjectTemplate,
          body_template: bodyTemplate,
          rpc_function_name: selectedRpc.rpc_name,
          rpc_description: selectedRpc.description,
          available_variables: allVariables,
          variable_descriptions: variableDescriptions,
          requires_assignment: selectedRpc.requires_assignment,
          requires_lab_section: selectedRpc.requires_lab_section,
          is_active: template?.is_active ?? true
        },
        isEdit
      );

      if (success) {
        onClose();
      }
    } finally {
      setIsSaving(false);
    }
  };

  const insertVariable = (variable: string, target: "subject" | "body") => {
    const varText = `{${variable}}`;
    if (target === "subject") {
      setSubjectTemplate((prev) => prev + varText);
    } else {
      setBodyTemplate((prev) => prev + varText);
    }
  };

  // Get all available variables including course_name
  const availableVariables = selectedRpc
    ? [...(selectedRpc.available_variables || []), "course_name"].filter(
        (v, i, arr) => arr.indexOf(v) === i
      )
    : ["course_name"];

  return (
    <DialogRoot open={isOpen} onOpenChange={(e) => !e.open && onClose()} size="xl">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Template" : "Create New Template"}</DialogTitle>
          <DialogCloseTrigger />
        </DialogHeader>

        <DialogBody>
          <VStack gap={4} align="stretch">
            <Fieldset.Root>
              <Fieldset.Content>
                {/* Basic Info */}
                <Field.Root required>
                  <Field.Label>Template Name</Field.Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g., Students with Failing Tests"
                  />
                </Field.Root>

                <Field.Root>
                  <Field.Label>Description</Field.Label>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Brief description of when to use this template"
                    rows={2}
                  />
                </Field.Root>

                {/* RPC Selection */}
                <Field.Root required>
                  <Field.Label>Recipient Query Function (RPC)</Field.Label>
                  <Select
                    value={
                      selectedRpc
                        ? { label: selectedRpc.rpc_name, value: selectedRpc.rpc_name }
                        : null
                    }
                    onChange={(option) => {
                      const rpc = availableRpcs.find((r) => r.rpc_name === option?.value);
                      setSelectedRpc(rpc || null);
                    }}
                    options={availableRpcs.map((rpc) => ({
                      label: rpc.rpc_name,
                      value: rpc.rpc_name
                    }))}
                    placeholder="Select an RPC function..."
                  />
                  {selectedRpc && (
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      {selectedRpc.description}
                    </Text>
                  )}
                </Field.Root>

                {/* Requirements Badge */}
                {selectedRpc && (
                  <Field.Root>
                    <Field.Label>Requirements</Field.Label>
                    <HStack gap={2}>
                      {selectedRpc.requires_assignment && (
                        <Badge colorPalette="purple">Requires Assignment Selection</Badge>
                      )}
                      {selectedRpc.requires_lab_section && (
                        <Badge colorPalette="green">Requires Lab Section Selection</Badge>
                      )}
                      {!selectedRpc.requires_assignment && !selectedRpc.requires_lab_section && (
                        <Badge colorPalette="gray">No special requirements</Badge>
                      )}
                    </HStack>
                  </Field.Root>
                )}

                {/* Available Variables */}
                <Field.Root>
                  <Field.Label>Available Template Variables</Field.Label>
                  <Box
                    p={3}
                    borderWidth="1px"
                    borderRadius="md"
                    bg="bg.subtle"
                    maxH="150px"
                    overflowY="auto"
                  >
                    <Text fontSize="xs" color="fg.muted" mb={2}>
                      Click to insert into subject or body. Use {"{variable_name}"} syntax.
                    </Text>
                    <Flex wrap="wrap" gap={2}>
                      {availableVariables.map((variable) => (
                        <HStack key={variable} gap={1}>
                          <Badge
                            size="sm"
                            colorPalette="blue"
                            cursor="pointer"
                            onClick={() => insertVariable(variable, "subject")}
                            title="Click to insert into subject"
                          >
                            {`{${variable}}`}
                          </Badge>
                        </HStack>
                      ))}
                    </Flex>
                  </Box>
                </Field.Root>

                {/* Subject Template */}
                <Field.Root required>
                  <Field.Label>Subject Template</Field.Label>
                  <Input
                    value={subjectTemplate}
                    onChange={(e) => setSubjectTemplate(e.target.value)}
                    placeholder="e.g., [{course_name}] Your {assignment_title} submission"
                  />
                  <Text fontSize="xs" color="fg.muted">
                    Use {"{variable_name}"} to insert dynamic content
                  </Text>
                </Field.Root>

                {/* Body Template */}
                <Field.Root required>
                  <Field.Label>Body Template</Field.Label>
                  <Textarea
                    value={bodyTemplate}
                    onChange={(e) => setBodyTemplate(e.target.value)}
                    placeholder={`Hi {student_name},\n\nYour submission for {assignment_title}...\n\nBest regards,\n{course_name} Staff`}
                    rows={10}
                    fontFamily="mono"
                    fontSize="sm"
                  />
                  <Text fontSize="xs" color="fg.muted">
                    Supports Markdown formatting. Use {"{variable_name}"} for dynamic content.
                  </Text>
                </Field.Root>
              </Fieldset.Content>
            </Fieldset.Root>
          </VStack>
        </DialogBody>

        <DialogFooter>
          <HStack gap={2}>
            <Button variant="ghost" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button
              colorPalette="blue"
              onClick={handleSave}
              loading={isSaving}
              disabled={!name || !subjectTemplate || !bodyTemplate || !selectedRpc}
            >
              {isEdit ? "Save Changes" : "Create Template"}
            </Button>
          </HStack>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

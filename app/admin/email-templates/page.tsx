"use client";

import { Button } from "@/components/ui/button";
import { toaster, Toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import {
  Card,
  Flex,
  Heading,
  HStack,
  Icon,
  Table,
  Text,
  VStack,
  Badge,
  IconButton,
  Spinner
} from "@chakra-ui/react";
import { Plus, Mail, Edit2, Trash2, Eye, EyeOff, Code } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CreateEditTemplateModal } from "./CreateEditTemplateModal";
import { ViewTemplateModal } from "./ViewTemplateModal";

export type EmailTemplate = {
  id: number;
  created_at: string;
  updated_at: string;
  name: string;
  description: string | null;
  subject_template: string;
  body_template: string;
  rpc_function_name: string;
  rpc_description: string | null;
  available_variables: string[];
  variable_descriptions: Record<string, string>;
  is_active: boolean;
  requires_assignment: boolean;
  requires_lab_section: boolean;
  scope: "global" | "course";
  class_id: number | null;
  created_by: string | null;
};

export type AvailableRpc = {
  rpc_name: string;
  description: string;
  requires_assignment: boolean;
  requires_lab_section: boolean;
  available_variables: string[];
  parameter_schema: Record<string, { type: string; description: string }>;
};

export default function EmailTemplatesPage() {
  const supabase = useMemo(() => createClient(), []);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [availableRpcs, setAvailableRpcs] = useState<AvailableRpc[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null);
  const [viewingTemplate, setViewingTemplate] = useState<EmailTemplate | null>(null);

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from("email_templates")
        .select("*")
        .eq("scope", "global")
        .order("name");

      if (error) throw error;
      setTemplates((data as EmailTemplate[]) || []);
    } catch (error) {
      toaster.error({
        title: "Error loading templates",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      setIsLoading(false);
    }
  }, [supabase]);

  const fetchAvailableRpcs = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("emailer_list_available_rpcs");
      if (error) throw error;
      setAvailableRpcs((data as AvailableRpc[]) || []);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Error fetching available RPCs:", error);
    }
  }, [supabase]);

  useEffect(() => {
    fetchTemplates();
    fetchAvailableRpcs();
  }, [fetchTemplates, fetchAvailableRpcs]);

  const handleToggleActive = async (template: EmailTemplate) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from("email_templates")
        .update({ is_active: !template.is_active, updated_at: new Date().toISOString() })
        .eq("id", template.id);

      if (error) throw error;

      toaster.success({
        title: template.is_active ? "Template deactivated" : "Template activated"
      });
      fetchTemplates();
    } catch (error) {
      toaster.error({
        title: "Error updating template",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    }
  };

  const handleDelete = async (template: EmailTemplate) => {
    if (!confirm(`Are you sure you want to delete "${template.name}"?`)) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).from("email_templates").delete().eq("id", template.id);

      if (error) throw error;

      toaster.success({ title: "Template deleted" });
      fetchTemplates();
    } catch (error) {
      toaster.error({
        title: "Error deleting template",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    }
  };

  const handleSaveTemplate = async (
    templateData: Partial<EmailTemplate>,
    isEdit: boolean
  ): Promise<boolean> => {
    try {
      if (isEdit && editingTemplate) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any)
          .from("email_templates")
          .update({
            ...templateData,
            updated_at: new Date().toISOString()
          })
          .eq("id", editingTemplate.id);

        if (error) throw error;
        toaster.success({ title: "Template updated" });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any).from("email_templates").insert({
          ...templateData,
          scope: "global"
        });

        if (error) throw error;
        toaster.success({ title: "Template created" });
      }

      fetchTemplates();
      return true;
    } catch (error) {
      toaster.error({
        title: "Error saving template",
        description: error instanceof Error ? error.message : "Unknown error"
      });
      return false;
    }
  };

  return (
    <VStack align="stretch" gap={6}>
      {/* Header */}
      <Flex justify="space-between" align="center">
        <VStack align="start" gap={1}>
          <HStack gap={2}>
            <Icon color="blue.500">
              <Mail size={24} />
            </Icon>
            <Heading size="2xl">Email Templates</Heading>
          </HStack>
          <Text color="fg.muted">
            Manage global email templates for the instructor emailer system
          </Text>
        </VStack>
        <Button onClick={() => setIsCreateModalOpen(true)}>
          <HStack gap={2}>
            <Plus size={16} />
            <Text>New Template</Text>
          </HStack>
        </Button>
      </Flex>

      {/* Info Card */}
      <Card.Root>
        <Card.Body p={4}>
          <HStack gap={3}>
            <Icon color="blue.500">
              <Code size={20} />
            </Icon>
            <VStack align="start" gap={0}>
              <Text fontWeight="medium">RPC-Based Recipient Querying</Text>
              <Text fontSize="sm" color="fg.muted">
                Each template is linked to an RPC function that queries specific recipients. Variables
                from the RPC results can be used in the template using {"{variable_name}"} syntax.
              </Text>
            </VStack>
          </HStack>
        </Card.Body>
      </Card.Root>

      {/* Templates Table */}
      <Card.Root>
        <Card.Header>
          <HStack justify="space-between">
            <Card.Title>Global Templates</Card.Title>
            <Badge colorPalette="blue">{templates.length} templates</Badge>
          </HStack>
        </Card.Header>
        <Card.Body p={0}>
          {isLoading ? (
            <Flex justify="center" align="center" py={12}>
              <Spinner size="lg" />
            </Flex>
          ) : templates.length === 0 ? (
            <Flex justify="center" align="center" py={12}>
              <VStack gap={2}>
                <Mail size={48} color="gray" />
                <Text color="fg.muted">No templates found</Text>
                <Button size="sm" onClick={() => setIsCreateModalOpen(true)}>
                  Create your first template
                </Button>
              </VStack>
            </Flex>
          ) : (
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Name</Table.ColumnHeader>
                  <Table.ColumnHeader>RPC Function</Table.ColumnHeader>
                  <Table.ColumnHeader>Requirements</Table.ColumnHeader>
                  <Table.ColumnHeader>Variables</Table.ColumnHeader>
                  <Table.ColumnHeader>Status</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="right">Actions</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {templates.map((template) => (
                  <Table.Row key={template.id}>
                    <Table.Cell>
                      <VStack align="start" gap={0}>
                        <Text fontWeight="medium">{template.name}</Text>
                        {template.description && (
                          <Text fontSize="xs" color="fg.muted" maxW="300px" truncate>
                            {template.description}
                          </Text>
                        )}
                      </VStack>
                    </Table.Cell>
                    <Table.Cell>
                      <Text fontSize="sm" fontFamily="mono">
                        {template.rpc_function_name}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <HStack gap={1}>
                        {template.requires_assignment && (
                          <Badge size="sm" colorPalette="purple">
                            Assignment
                          </Badge>
                        )}
                        {template.requires_lab_section && (
                          <Badge size="sm" colorPalette="green">
                            Lab Section
                          </Badge>
                        )}
                        {!template.requires_assignment && !template.requires_lab_section && (
                          <Badge size="sm" colorPalette="gray">
                            None
                          </Badge>
                        )}
                      </HStack>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="sm" colorPalette="blue">
                        {template.available_variables?.length || 0} vars
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge colorPalette={template.is_active ? "green" : "gray"}>
                        {template.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell textAlign="right">
                      <HStack gap={1} justify="flex-end">
                        <IconButton
                          variant="ghost"
                          size="sm"
                          onClick={() => setViewingTemplate(template)}
                          title="View template"
                        >
                          <Eye size={16} />
                        </IconButton>
                        <IconButton
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingTemplate(template)}
                          title="Edit template"
                        >
                          <Edit2 size={16} />
                        </IconButton>
                        <IconButton
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggleActive(template)}
                          title={template.is_active ? "Deactivate" : "Activate"}
                        >
                          {template.is_active ? <EyeOff size={16} /> : <Eye size={16} />}
                        </IconButton>
                        <IconButton
                          variant="ghost"
                          size="sm"
                          colorPalette="red"
                          onClick={() => handleDelete(template)}
                          title="Delete template"
                        >
                          <Trash2 size={16} />
                        </IconButton>
                      </HStack>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </Card.Body>
      </Card.Root>

      {/* Available RPCs Reference */}
      <Card.Root>
        <Card.Header>
          <Card.Title>Available RPC Functions</Card.Title>
          <Text color="fg.muted" fontSize="sm">
            Reference for available email recipient query functions
          </Text>
        </Card.Header>
        <Card.Body p={0}>
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Function Name</Table.ColumnHeader>
                <Table.ColumnHeader>Description</Table.ColumnHeader>
                <Table.ColumnHeader>Requirements</Table.ColumnHeader>
                <Table.ColumnHeader>Available Variables</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {availableRpcs.map((rpc) => (
                <Table.Row key={rpc.rpc_name}>
                  <Table.Cell>
                    <Text fontSize="sm" fontFamily="mono">
                      {rpc.rpc_name}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Text fontSize="sm">{rpc.description}</Text>
                  </Table.Cell>
                  <Table.Cell>
                    <HStack gap={1}>
                      {rpc.requires_assignment && (
                        <Badge size="sm" colorPalette="purple">
                          Assignment
                        </Badge>
                      )}
                      {rpc.requires_lab_section && (
                        <Badge size="sm" colorPalette="green">
                          Lab Section
                        </Badge>
                      )}
                    </HStack>
                  </Table.Cell>
                  <Table.Cell>
                    <Text fontSize="xs" color="fg.muted" maxW="300px">
                      {rpc.available_variables?.join(", ")}
                    </Text>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Card.Body>
      </Card.Root>

      {/* Modals */}
      <CreateEditTemplateModal
        isOpen={isCreateModalOpen || editingTemplate !== null}
        onClose={() => {
          setIsCreateModalOpen(false);
          setEditingTemplate(null);
        }}
        template={editingTemplate}
        availableRpcs={availableRpcs}
        onSave={handleSaveTemplate}
      />

      <ViewTemplateModal
        isOpen={viewingTemplate !== null}
        onClose={() => setViewingTemplate(null)}
        template={viewingTemplate}
      />

      <Toaster />
    </VStack>
  );
}

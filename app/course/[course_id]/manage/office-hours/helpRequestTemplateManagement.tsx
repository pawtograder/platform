"use client";

import { Box, Flex, HStack, Stack, Text, Heading, Icon, Badge } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useList, useDelete, useUpdate } from "@refinedev/core";
import { useParams } from "next/navigation";
import { BsPlus, BsPencil, BsTrash, BsEye, BsEyeSlash, BsFileText } from "react-icons/bs";
import { formatDistanceToNow } from "date-fns";
import { Alert } from "@/components/ui/alert";
import useModalManager from "@/hooks/useModalManager";
import CreateHelpRequestTemplateModal from "./modals/createHelpRequestTemplateModal";
import EditHelpRequestTemplateModal from "./modals/editHelpRequestTemplateModal";
import type { HelpRequestTemplate } from "@/utils/supabase/DatabaseTypes";

/**
 * Component for managing help request templates.
 * Allows instructors and graders to create, edit, and manage templates
 * that students can use when creating help requests.
 */
export default function HelpRequestTemplateManagement() {
  const { course_id } = useParams();

  // Modal management
  const createModal = useModalManager();
  const editModal = useModalManager<HelpRequestTemplate>();

  // Fetch all templates for the course
  const {
    data: templatesResponse,
    isLoading: templatesLoading,
    error: templatesError,
    refetch: refetchTemplates
  } = useList<HelpRequestTemplate>({
    resource: "help_request_templates",
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    sorters: [
      { field: "is_active", order: "desc" },
      { field: "category", order: "asc" },
      { field: "name", order: "asc" }
    ]
  });

  const { mutate: updateTemplate } = useUpdate();
  const { mutate: deleteTemplate } = useDelete();

  const handleToggleActive = (templateId: number, currentState: boolean) => {
    updateTemplate({
      resource: "help_request_templates",
      id: templateId,
      values: {
        is_active: !currentState
      },
      successNotification: {
        message: `Template ${!currentState ? "activated" : "deactivated"} successfully`,
        type: "success"
      },
      errorNotification: {
        message: "Failed to update template status",
        type: "error"
      }
    });
  };

  const handleDeleteTemplate = (templateId: number, templateName: string) => {
    if (
      window.confirm(`Are you sure you want to delete the template "${templateName}"? This action cannot be undone.`)
    ) {
      deleteTemplate({
        resource: "help_request_templates",
        id: templateId,
        successNotification: {
          message: "Template deleted successfully",
          type: "success"
        },
        errorNotification: {
          message: "Failed to delete template",
          type: "error"
        }
      });
    }
  };

  const handleCreateSuccess = () => {
    createModal.closeModal();
    refetchTemplates();
  };

  const handleEditSuccess = () => {
    editModal.closeModal();
    refetchTemplates();
  };

  if (templatesLoading) return <Text>Loading help request templates...</Text>;
  if (templatesError) return <Alert status="error" title={`Error: ${templatesError.message}`} />;

  const templates = templatesResponse?.data ?? [];
  const activeTemplates = templates.filter((t) => t.is_active);
  const inactiveTemplates = templates.filter((t) => !t.is_active);

  // Group templates by category
  const templatesByCategory = templates.reduce(
    (acc, template) => {
      const category = template.category || "Uncategorized";
      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push(template);
      return acc;
    },
    {} as Record<string, HelpRequestTemplate[]>
  );

  const getCategoryColor = (category: string) => {
    const colors = ["blue", "green", "purple", "orange", "red", "teal"];
    const index = category.length % colors.length;
    return colors[index];
  };

  const TemplateCard = ({ template }: { template: HelpRequestTemplate }) => (
    <Box p={4} borderWidth="1px" borderRadius="md">
      <Flex justify="space-between" align="flex-start">
        <Box flex="1">
          <Flex align="center" gap={3} mb={2}>
            <Text fontWeight="semibold">{template.name}</Text>
            <Badge colorPalette={getCategoryColor(template.category)} size="sm">
              {template.category}
            </Badge>
            {!template.is_active && (
              <Badge colorPalette="gray" size="sm">
                Inactive
              </Badge>
            )}
            {template.usage_count > 0 && (
              <Badge colorPalette="blue" size="sm">
                Used {template.usage_count} times
              </Badge>
            )}
          </Flex>

          {template.description && (
            <Text mb={2} fontSize="sm">
              {template.description}
            </Text>
          )}

          <Text
            fontSize="sm"
            mb={2}
            css={{
              wordBreak: "break-word",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden"
            }}
          >
            {template.template_content}
          </Text>

          <HStack spaceX={4} fontSize="sm">
            <Text>Created {formatDistanceToNow(new Date(template.created_at), { addSuffix: true })}</Text>
          </HStack>
        </Box>

        <HStack spaceX={2}>
          <Button
            size="sm"
            variant="outline"
            colorPalette={template.is_active ? "orange" : "green"}
            onClick={() => handleToggleActive(template.id, template.is_active)}
            title={template.is_active ? "Deactivate template" : "Activate template"}
          >
            <Icon as={template.is_active ? BsEyeSlash : BsEye} />
            {template.is_active ? "Deactivate" : "Activate"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => editModal.openModal(template)}>
            <Icon as={BsPencil} />
            Edit
          </Button>
          <Button
            size="sm"
            variant="outline"
            colorPalette="red"
            onClick={() => handleDeleteTemplate(template.id, template.name)}
          >
            <Icon as={BsTrash} />
            Delete
          </Button>
        </HStack>
      </Flex>
    </Box>
  );

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">Help Request Templates</Heading>
        <Button onClick={() => createModal.openModal()}>
          <Icon as={BsPlus} />
          Create New Template
        </Button>
      </Flex>

      {templates.length === 0 ? (
        <Box textAlign="center" py={8}>
          <Icon as={BsFileText} boxSize={12} mb={4} />
          <Text mb={4}>No help request templates have been created yet.</Text>
          <Button onClick={() => createModal.openModal()}>
            <Icon as={BsPlus} />
            Create Your First Template
          </Button>
        </Box>
      ) : (
        <Stack spaceY={6}>
          {/* Active Templates */}
          <Box>
            <Heading size="md" mb={4}>
              Active Templates ({activeTemplates.length})
            </Heading>
            {activeTemplates.length === 0 ? (
              <Box textAlign="center" py={6} borderWidth="1px" borderRadius="md">
                <Text>No active templates available.</Text>
              </Box>
            ) : (
              <Stack spaceY={3}>
                {Object.entries(templatesByCategory)
                  .filter(([, templates]) => templates.some((t) => t.is_active))
                  .map(([category, categoryTemplates]) => (
                    <Box key={category}>
                      <Text fontWeight="medium" mb={2}>
                        {category}
                      </Text>
                      <Stack spaceY={3} ml={4}>
                        {categoryTemplates
                          .filter((t) => t.is_active)
                          .map((template) => (
                            <TemplateCard key={template.id} template={template} />
                          ))}
                      </Stack>
                    </Box>
                  ))}
              </Stack>
            )}
          </Box>

          {/* Inactive Templates */}
          {inactiveTemplates.length > 0 && (
            <Box>
              <Heading size="md" mb={4}>
                Inactive Templates ({inactiveTemplates.length})
              </Heading>
              <Stack spaceY={3}>
                {inactiveTemplates.map((template) => (
                  <TemplateCard key={template.id} template={template} />
                ))}
              </Stack>
            </Box>
          )}
        </Stack>
      )}

      {/* Modals */}
      <CreateHelpRequestTemplateModal
        isOpen={createModal.isOpen}
        onClose={createModal.closeModal}
        onSuccess={handleCreateSuccess}
      />

      <EditHelpRequestTemplateModal
        isOpen={editModal.isOpen}
        onClose={editModal.closeModal}
        onSuccess={handleEditSuccess}
        template={editModal.modalData}
      />
    </Box>
  );
}

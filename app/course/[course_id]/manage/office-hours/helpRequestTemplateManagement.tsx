"use client";

import { Box, Flex, HStack, Stack, Text, Heading, Icon, Badge } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useDelete, useUpdate } from "@refinedev/core";
import { useParams } from "next/navigation";
import { BsPlus, BsPencil, BsTrash, BsEye, BsEyeSlash, BsFileText } from "react-icons/bs";
import { formatDistanceToNow } from "date-fns";
import useModalManager from "@/hooks/useModalManager";
import CreateHelpRequestTemplateModal from "./modals/createHelpRequestTemplateModal";
import EditHelpRequestTemplateModal from "./modals/editHelpRequestTemplateModal";
import { useHelpRequestTemplates } from "@/hooks/useOfficeHoursRealtime";
import type { HelpRequestTemplate } from "@/utils/supabase/DatabaseTypes";
import { useMemo } from "react";

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

  // Get all templates from realtime data and filter by class_id
  const allTemplates = useHelpRequestTemplates();
  const templates = useMemo(() => {
    return allTemplates.filter((template) => template.class_id === parseInt(course_id as string));
  }, [allTemplates, course_id]);

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
    // No need to refetch - realtime data will update automatically
  };

  const handleEditSuccess = () => {
    editModal.closeModal();
    // No need to refetch - realtime data will update automatically
  };

  // Sort templates for display
  const sortedTemplates = useMemo(() => {
    return [...templates].sort((a, b) => {
      // Sort by active status (active first), then category, then name
      if (a.is_active !== b.is_active) {
        return b.is_active ? 1 : -1;
      }
      const categoryCompare = (a.category || "").localeCompare(b.category || "");
      if (categoryCompare !== 0) {
        return categoryCompare;
      }
      return a.name.localeCompare(b.name);
    });
  }, [templates]);

  const activeTemplates = useMemo(() => sortedTemplates.filter((t) => t.is_active), [sortedTemplates]);
  const inactiveTemplates = useMemo(() => sortedTemplates.filter((t) => !t.is_active), [sortedTemplates]);

  // Group templates by category
  const templatesByCategory = useMemo(() => {
    return sortedTemplates.reduce(
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
  }, [sortedTemplates]);

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

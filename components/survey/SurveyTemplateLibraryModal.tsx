"use client";

import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogCloseTrigger,
  DialogFooter
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Box,
  Input,
  VStack,
  HStack,
  Text,
  Badge,
  createListCollection,
  Textarea,
  Fieldset,
  Icon
} from "@chakra-ui/react";
import { SelectRoot, SelectTrigger, SelectValueText, SelectContent, SelectItem } from "@/components/ui/select";
import { MenuRoot, MenuTrigger, MenuContent, MenuItem } from "@/components/ui/menu";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { useCallback, useEffect, useState, useMemo } from "react";
import { createClient } from "@/utils/supabase/client";
import { useRouter } from "next/navigation";
import { SurveyPreviewModal } from "@/components/survey-preview-modal";
import { formatInTimeZone } from "date-fns-tz";
import { TZDate } from "@date-fns/tz";
import { HiOutlineDotsHorizontal } from "react-icons/hi";
import { useClassProfiles } from "@/hooks/useClassProfiles";

type SurveyTemplate = {
  id: string;
  title: string;
  description: string | null;
  template: Record<string, unknown> | null;
  created_by: string;
  scope: "course" | "global";
  class_id: number | null;
  created_at: string;
  updated_at: string;
};

const stringifyTemplate = (template: Record<string, unknown> | null) => JSON.stringify(template ?? {});

interface SurveyTemplateLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  courseId: string;
  isEditMode?: boolean; // If true, cloning will update current survey instead of creating new
  onTemplateLoad?: (templateJson: string, templateTitle?: string, templateDescription?: string) => void; // Callback for edit mode
}

export function SurveyTemplateLibraryModal({
  isOpen,
  onClose,
  courseId,
  isEditMode = false,
  onTemplateLoad
}: SurveyTemplateLibraryModalProps) {
  const router = useRouter();
  const { allOfMyRoles } = useClassProfiles();

  const [templates, setTemplates] = useState<SurveyTemplate[]>([]);
  const [filteredTemplates, setFilteredTemplates] = useState<SurveyTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [visibilityFilter, setVisibilityFilter] = useState<"all" | "course" | "global">("all");
  const [ownershipFilter, setOwnershipFilter] = useState<"all" | "my">("all");
  const [previewTemplate, setPreviewTemplate] = useState<SurveyTemplate | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<SurveyTemplate | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [deleteConfirmTemplate, setDeleteConfirmTemplate] = useState<SurveyTemplate | null>(null);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);

  // Edit form state
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editScope, setEditScope] = useState<"course" | "global">("course");

  // Fetch templates
  useEffect(() => {
    if (isOpen) {
      fetchTemplates();
    }
  }, [isOpen, courseId]);

  const fetchTemplates = async () => {
    setIsLoading(true);
    try {
      const supabase = createClient();

      // Fetch all templates - RLS will filter based on:
      // 1. Course templates: only if user is authorized for that class_id
      // 2. Global templates: only if user is staff in any class
      const { data: allTemplatesData, error: templatesError } = await supabase
        .from("survey_templates")
        .select("*")
        .order("updated_at", { ascending: false });

      if (templatesError) {
        console.error("Error fetching templates:", templatesError);
        toaster.create({
          title: "Failed to load templates",
          description: templatesError.message,
          type: "error"
        });
        return;
      }

      // RLS already filtered by authorization, but we can do additional client-side filtering
      // for the visibility filter UI
      const allTemplates = allTemplatesData || [];

      // Sort by updated_at descending
      allTemplates.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

      setTemplates(allTemplates as unknown as SurveyTemplate[]);
      setFilteredTemplates(allTemplates as unknown as SurveyTemplate[]);
    } catch (error) {
      console.error("Error fetching templates:", error);
      toaster.create({
        title: "Failed to load templates",
        description: error instanceof Error ? error.message : "Please try again.",
        type: "error"
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Filter templates based on search, visibility, and ownership
  useEffect(() => {
    let filtered = [...templates];

    // Always filter course-scoped templates to only show those for the current course
    filtered = filtered.filter((t) => {
      if (t.scope === "course") {
        return t.class_id === Number(courseId);
      }
      // Global templates are shown for all courses
      return true;
    });

    // Apply ownership filter
    if (ownershipFilter === "my") {
      filtered = filtered.filter((t) =>
        allOfMyRoles.some((role: { private_profile_id: string }) => role.private_profile_id === t.created_by)
      );
    }

    // Apply visibility filter
    if (visibilityFilter === "course") {
      filtered = filtered.filter((t) => t.scope === "course" && t.class_id === Number(courseId));
    } else if (visibilityFilter === "global") {
      filtered = filtered.filter((t) => t.scope === "global");
    }
    // "all" shows everything (already filtered by course above)

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (t) => t.title.toLowerCase().includes(query) || t.description?.toLowerCase().includes(query)
      );
    }

    setFilteredTemplates(filtered);
  }, [templates, searchQuery, visibilityFilter, ownershipFilter, courseId, allOfMyRoles]);

  const handlePreview = useCallback((template: SurveyTemplate) => {
    setPreviewTemplate(template);
    setIsPreviewOpen(true);
  }, []);

  const handleClone = useCallback(
    (template: SurveyTemplate) => {
      if (isEditMode && onTemplateLoad) {
        // In edit mode, load template into current survey
        const templateJson = stringifyTemplate(template.template);
        onTemplateLoad(templateJson, template.title, template.description || undefined);
        onClose();
      } else {
        // In new survey mode, navigate to new survey page with template_id
        router.push(`/course/${courseId}/manage/surveys/new?template_id=${template.id}`);
        onClose();
      }
    },
    [router, courseId, onClose, isEditMode, onTemplateLoad]
  );

  const handleEdit = useCallback((template: SurveyTemplate) => {
    setEditingTemplate(template);
    setEditTitle(template.title);
    setEditDescription(template.description || "");
    setEditScope(template.scope);
    setIsEditModalOpen(true);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingTemplate) return;

    const loadingToast = toaster.create({
      title: "Updating Template",
      description: "Saving your changes...",
      type: "loading"
    });

    try {
      const supabase = createClient();

      const { error } = await supabase
        .from("survey_templates")
        .update({
          title: editTitle,
          description: editDescription || undefined,
          scope: editScope,
          class_id: editScope === "course" ? Number(courseId) : undefined,
          updated_at: new Date().toISOString()
        })
        .eq("id", editingTemplate.id);

      toaster.dismiss(loadingToast);

      if (error) {
        toaster.create({
          title: "Error Updating Template",
          description: error.message,
          type: "error"
        });
        return;
      }

      toaster.create({
        title: "Template Updated",
        description: "Your template has been successfully updated.",
        type: "success"
      });

      setIsEditModalOpen(false);
      setEditingTemplate(null);
      fetchTemplates(); // Refresh the list
    } catch {
      toaster.dismiss(loadingToast);
      toaster.create({
        title: "Error",
        description: "An unexpected error occurred.",
        type: "error"
      });
    }
  }, [editingTemplate, editTitle, editDescription, editScope, courseId]);

  const handleDeleteClick = useCallback((template: SurveyTemplate) => {
    setDeleteConfirmTemplate(template);
    setIsDeleteConfirmOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirmTemplate) return;

    const loadingToast = toaster.create({
      title: "Deleting Template",
      description: "Removing template from library...",
      type: "loading"
    });

    try {
      const supabase = createClient();

      const { error } = await supabase.from("survey_templates").delete().eq("id", deleteConfirmTemplate.id);

      toaster.dismiss(loadingToast);

      if (error) {
        toaster.create({
          title: "Error Deleting Template",
          description: error.message,
          type: "error"
        });
        return;
      }

      toaster.create({
        title: "Template Deleted",
        description: "The template has been removed from the library.",
        type: "success"
      });

      setIsDeleteConfirmOpen(false);
      setDeleteConfirmTemplate(null);
      fetchTemplates(); // Refresh the list
    } catch {
      toaster.dismiss(loadingToast);
      toaster.create({
        title: "Error",
        description: "An unexpected error occurred.",
        type: "error"
      });
    }
  }, [deleteConfirmTemplate]);

  const formatDate = (dateString: string) => {
    try {
      return formatInTimeZone(new TZDate(dateString), "America/New_York", "MMM d, yyyy");
    } catch {
      return new Date(dateString).toLocaleDateString();
    }
  };

  const isOwner = useCallback(
    (template: SurveyTemplate) => {
      // Check if the template's creator (private_profile_id) matches any of my roles' private_profile_id
      return allOfMyRoles.some(
        (role: { private_profile_id: string }) => role.private_profile_id === template.created_by
      );
    },
    [allOfMyRoles]
  );

  // Create collection for visibility filter
  const visibilityCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { label: "All", value: "all" },
          { label: "Class-Only", value: "course" },
          { label: "Global", value: "global" }
        ]
      }),
    []
  );

  // Create collection for scope (edit modal)
  const scopeCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { label: "Course Only", value: "course" },
          { label: "Global (Shared)", value: "global" }
        ]
      }),
    []
  );

  return (
    <>
      <DialogRoot
        open={isOpen}
        onOpenChange={({ open }) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          maxW="6xl"
          w="90vw"
          h="90vh"
          bg="bg.subtle"
          borderColor="border.default"
          borderRadius="lg"
          className="flex flex-col"
        >
          <DialogHeader bg="bg.muted" p={4} borderRadius="lg">
            <DialogTitle color="fg.default" fontSize="xl" fontWeight="bold">
              Survey Template Library
            </DialogTitle>
            <DialogCloseTrigger />
          </DialogHeader>

          <DialogBody p={6} overflow="auto">
            {/* Filter Tabs */}
            <HStack gap={2} mb={4}>
              <Button
                size="sm"
                variant={ownershipFilter === "all" ? "solid" : "outline"}
                bg={ownershipFilter === "all" ? "blue.500" : "transparent"}
                color={ownershipFilter === "all" ? "white" : "fg.default"}
                borderColor="border.default"
                _hover={{ bg: ownershipFilter === "all" ? "blue.600" : "bg.muted" }}
                onClick={() => setOwnershipFilter("all")}
              >
                All Templates
              </Button>
              <Button
                size="sm"
                variant={ownershipFilter === "my" ? "solid" : "outline"}
                bg={ownershipFilter === "my" ? "blue.500" : "transparent"}
                color={ownershipFilter === "my" ? "white" : "fg.default"}
                borderColor="border.default"
                _hover={{ bg: ownershipFilter === "my" ? "blue.600" : "bg.muted" }}
                onClick={() => setOwnershipFilter("my")}
              >
                My Templates
              </Button>
            </HStack>

            {/* Search and Filter Controls */}
            <VStack align="stretch" gap={4} mb={6}>
              <HStack gap={4}>
                <Input
                  placeholder="Search by name, or description"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  bg="bg.subtle"
                  borderColor="border.default"
                  color="fg.default"
                  _placeholder={{ color: "fg.muted" }}
                  flex={1}
                />
                <Box width="200px">
                  <SelectRoot
                    collection={visibilityCollection}
                    value={[visibilityFilter]}
                    onValueChange={(details: { value: string[] }) =>
                      setVisibilityFilter((details.value[0] as "all" | "course" | "global") || "all")
                    }
                  >
                    <SelectTrigger
                      bg="bg.subtle"
                      borderColor="border.default"
                      color="fg.default"
                      style={{ cursor: "pointer" }}
                    >
                      <SelectValueText placeholder="Filter by visibility" />
                    </SelectTrigger>
                    <SelectContent style={{ zIndex: 9999 }}>
                      {visibilityCollection.items.map((item) => (
                        <SelectItem key={item.value} item={item} style={{ cursor: "pointer" }}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </SelectRoot>
                </Box>
              </HStack>
            </VStack>

            {/* Loading State */}
            {isLoading && (
              <Box textAlign="center" py={8}>
                <Text color="fg.default">Loading templates...</Text>
              </Box>
            )}

            {/* Empty State */}
            {!isLoading && filteredTemplates.length === 0 && (
              <Box textAlign="center" py={8}>
                <Text color="fg.default">
                  {searchQuery || visibilityFilter !== "all"
                    ? "No templates match your filters."
                    : "No templates available."}
                </Text>
              </Box>
            )}

            {/* Template Grid */}
            {!isLoading && filteredTemplates.length > 0 && (
              <Box
                display="grid"
                gridTemplateColumns={{ base: "1fr", md: "repeat(2, 1fr)", lg: "repeat(3, 1fr)" }}
                gap={4}
              >
                {filteredTemplates.map((template) => (
                  <Box
                    key={template.id}
                    bg="bg.subtle"
                    border="1px solid"
                    borderColor="border.default"
                    borderRadius="lg"
                    p={4}
                  >
                    <VStack align="stretch" gap={3}>
                      {/* Title and Visibility Badge */}
                      <HStack justify="space-between" align="start">
                        <Text fontWeight="semibold" fontSize="md" color="fg.default" lineClamp={2} flex={1}>
                          {template.title}
                        </Text>
                        <Badge
                          px={2}
                          py={1}
                          borderRadius="md"
                          fontSize="xs"
                          fontWeight="medium"
                          bg={template.scope === "global" ? "blue.subtle" : "green.subtle"}
                          color={template.scope === "global" ? "blue.500" : "green.500"}
                          textTransform="capitalize"
                        >
                          {template.scope === "global" ? "Shared" : "Class-Only"}
                        </Badge>
                      </HStack>

                      {/* Description */}
                      {template.description && (
                        <Text fontSize="sm" color="fg.default" opacity={0.8} lineClamp={2}>
                          {template.description}
                        </Text>
                      )}

                      {/* Creator and Date */}
                      <VStack align="start" gap={1}>
                        <Text fontSize="xs" color="fg.default" opacity={0.7}>
                          Last modified: {formatDate(template.updated_at)}
                        </Text>
                      </VStack>

                      {/* Actions */}
                      <HStack gap={2} mt={2}>
                        <Button
                          size="sm"
                          variant="outline"
                          bg="transparent"
                          borderColor="border.default"
                          color="fg.default"
                          _hover={{ bg: "bg.muted" }}
                          onClick={() => handlePreview(template)}
                          flex={1}
                        >
                          Preview
                        </Button>
                        <Button
                          size="sm"
                          bg="green.500"
                          color="white"
                          _hover={{ bg: "green.600" }}
                          onClick={() => handleClone(template)}
                          flex={1}
                        >
                          Clone
                        </Button>

                        {/* Show three-dot menu for owned templates */}
                        {isOwner(template) && (
                          <MenuRoot>
                            <MenuTrigger asChild>
                              <Button
                                size="sm"
                                variant="ghost"
                                border="1px solid"
                                borderColor="border.default"
                                color="fg.default"
                                _hover={{ bg: "bg.muted" }}
                                _focus={{ borderColor: "border.default", boxShadow: "none", outline: "none" }}
                                _active={{ borderColor: "border.default", boxShadow: "none", outline: "none" }}
                                px={2}
                                cursor="pointer"
                              >
                                <Icon as={HiOutlineDotsHorizontal} />
                              </Button>
                            </MenuTrigger>
                            <MenuContent style={{ zIndex: 10000 }}>
                              <MenuItem value="edit" onClick={() => handleEdit(template)} style={{ cursor: "pointer" }}>
                                Edit Info
                              </MenuItem>
                              <MenuItem
                                value="delete"
                                color="red.500"
                                onClick={() => handleDeleteClick(template)}
                                style={{ cursor: "pointer" }}
                              >
                                Delete
                              </MenuItem>
                            </MenuContent>
                          </MenuRoot>
                        )}
                      </HStack>
                    </VStack>
                  </Box>
                ))}
              </Box>
            )}
          </DialogBody>
        </DialogContent>
      </DialogRoot>

      {/* Preview Modal */}
      {previewTemplate && (
        <SurveyPreviewModal
          isOpen={isPreviewOpen}
          onClose={() => {
            setIsPreviewOpen(false);
            setPreviewTemplate(null);
          }}
          surveyJson={stringifyTemplate(previewTemplate.template)}
          surveyTitle={previewTemplate.title}
        />
      )}

      {/* Edit Template Modal */}
      <DialogRoot open={isEditModalOpen} onOpenChange={(e) => setIsEditModalOpen(e.open)}>
        <DialogContent maxW="2xl" bg="bg.subtle" borderColor="border.default" borderRadius="lg">
          <DialogHeader bg="bg.muted" p={4} borderRadius="lg">
            <DialogTitle color="fg.default" fontSize="xl" fontWeight="bold">
              Edit Template Info
            </DialogTitle>
            <DialogCloseTrigger />
          </DialogHeader>

          <DialogBody p={6}>
            <Fieldset.Root>
              <VStack align="stretch" gap={4}>
                {/* Title */}
                <Fieldset.Content>
                  <Field label="Title" required>
                    <Input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      bg="bg.subtle"
                      borderColor="border.default"
                      color="fg.default"
                      _placeholder={{ color: "fg.muted" }}
                      placeholder="Template title"
                    />
                  </Field>
                </Fieldset.Content>

                {/* Description */}
                <Fieldset.Content>
                  <Field label="Description">
                    <Textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      bg="bg.subtle"
                      borderColor="border.default"
                      color="fg.default"
                      _placeholder={{ color: "fg.muted" }}
                      placeholder="Template description"
                      rows={3}
                    />
                  </Field>
                </Fieldset.Content>

                {/* Scope */}
                <Fieldset.Content>
                  <Field label="Visibility" required>
                    <SelectRoot
                      collection={scopeCollection}
                      value={[editScope]}
                      onValueChange={(details: { value: string[] }) =>
                        setEditScope((details.value[0] as "course" | "global") || "course")
                      }
                    >
                      <SelectTrigger
                        bg="bg.subtle"
                        borderColor="border.default"
                        color="fg.default"
                        style={{ cursor: "pointer" }}
                      >
                        <SelectValueText placeholder="Select visibility" />
                      </SelectTrigger>
                      <SelectContent style={{ zIndex: 10000 }}>
                        {scopeCollection.items.map((item) => (
                          <SelectItem key={item.value} item={item} style={{ cursor: "pointer" }}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </SelectRoot>
                  </Field>
                </Fieldset.Content>

                <Text fontSize="sm" color="fg.default" opacity={0.7}>
                  Note: Editing only updates the template metadata (title, description, visibility). The survey JSON
                  content will not be modified.
                </Text>
              </VStack>
            </Fieldset.Root>
          </DialogBody>

          <DialogFooter p={4}>
            <HStack gap={3}>
              <Button
                variant="outline"
                borderColor="border.default"
                color="fg.default"
                _hover={{ bg: "bg.muted" }}
                onClick={() => setIsEditModalOpen(false)}
              >
                Cancel
              </Button>
              <Button bg="green.500" color="white" _hover={{ bg: "green.600" }} onClick={handleSaveEdit}>
                Save Changes
              </Button>
            </HStack>
          </DialogFooter>
        </DialogContent>
      </DialogRoot>

      {/* Delete Confirmation Dialog */}
      <DialogRoot open={isDeleteConfirmOpen} onOpenChange={(e) => setIsDeleteConfirmOpen(e.open)}>
        <DialogContent maxW="md" bg="bg.subtle" borderColor="border.default" borderRadius="lg">
          <DialogHeader bg="bg.muted" p={4} borderRadius="lg">
            <DialogTitle color="fg.default" fontSize="xl" fontWeight="bold">
              Delete Template
            </DialogTitle>
            <DialogCloseTrigger />
          </DialogHeader>

          <DialogBody p={6}>
            <Text color="fg.default">
              Are you sure you want to delete &quot;{deleteConfirmTemplate?.title}&quot;? This action cannot be undone.
            </Text>
          </DialogBody>

          <DialogFooter p={4}>
            <HStack gap={3}>
              <Button
                variant="outline"
                borderColor="border.default"
                color="fg.default"
                _hover={{ bg: "bg.muted" }}
                onClick={() => setIsDeleteConfirmOpen(false)}
              >
                Cancel
              </Button>
              <Button bg="red.500" color="white" _hover={{ bg: "red.600" }} onClick={handleConfirmDelete}>
                Delete
              </Button>
            </HStack>
          </DialogFooter>
        </DialogContent>
      </DialogRoot>
    </>
  );
}

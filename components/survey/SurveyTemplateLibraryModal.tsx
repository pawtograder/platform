"use client";

import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogCloseTrigger
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useColorModeValue } from "@/components/ui/color-mode";
import { Box, Input, VStack, HStack, Text, Badge, createListCollection } from "@chakra-ui/react";
import { SelectRoot, SelectTrigger, SelectValueText, SelectContent, SelectItem } from "@/components/ui/select";
import { useCallback, useEffect, useState, useMemo } from "react";
import { createClient } from "@/utils/supabase/client";
import { useRouter } from "next/navigation";
import { SurveyPreviewModal } from "@/components/survey-preview-modal";
import { formatInTimeZone } from "date-fns-tz";
import { TZDate } from "@date-fns/tz";

type SurveyTemplate = {
  id: string;
  title: string;
  description: string | null;
  template: any; // JSONB
  created_by: string;
  scope: "course" | "global";
  class_id: number | null;
  created_at: string;
  updated_at: string;
};

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
  const [templates, setTemplates] = useState<SurveyTemplate[]>([]);
  const [filteredTemplates, setFilteredTemplates] = useState<SurveyTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [visibilityFilter, setVisibilityFilter] = useState<"all" | "course" | "global">("all");
  const [previewTemplate, setPreviewTemplate] = useState<SurveyTemplate | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  // Color mode values - matching survey components
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const bgColor = useColorModeValue("#FFFFFF", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const headerBgColor = useColorModeValue("#F8F9FA", "#2D2D2D");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");
  const placeholderColor = useColorModeValue("#8A8A8A", "#757575");

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

      // Fetch global templates
      const { data: globalData, error: globalError } = await supabase
        .from("survey_templates" as any)
        .select(
          `
          *,
          profiles:created_by (
            name
          )
        `
        )
        .eq("scope", "global")
        .order("updated_at", { ascending: false });

      // Fetch course-specific templates (matching class_id)
      const { data: courseData, error: courseError } = await supabase
        .from("survey_templates" as any)
        .select(
          `
          *,
          profiles:created_by (
            name
          )
        `
        )
        .eq("scope", "course")
        .eq("class_id", Number(courseId))
        .order("updated_at", { ascending: false });

      if (globalError || courseError) {
        console.error("Error fetching templates:", globalError || courseError);
        return;
      }

      // Combine and deduplicate templates
      const allTemplates = [...(globalData || []), ...(courseData || [])];

      // Type assertion for the joined data
      const typedData = allTemplates.map((item: any) => ({
        ...item,
        profiles: Array.isArray(item.profiles) ? item.profiles[0] : item.profiles
      })) as SurveyTemplate[];

      // Sort by updated_at descending
      typedData.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

      setTemplates(typedData);
      setFilteredTemplates(typedData);
    } catch (error) {
      console.error("Error fetching templates:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // Filter templates based on search and visibility
  useEffect(() => {
    let filtered = [...templates];

    // Apply visibility filter
    if (visibilityFilter === "course") {
      filtered = filtered.filter((t) => t.scope === "course" && t.class_id === Number(courseId));
    } else if (visibilityFilter === "global") {
      filtered = filtered.filter((t) => t.scope === "global");
    }
    // "all" shows everything

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (t) =>
          t.title.toLowerCase().includes(query) ||
          t.description?.toLowerCase().includes(query)
      );
    }

    setFilteredTemplates(filtered);
  }, [templates, searchQuery, visibilityFilter, courseId]);

  const handlePreview = useCallback((template: SurveyTemplate) => {
    setPreviewTemplate(template);
    setIsPreviewOpen(true);
  }, []);

  const handleClone = useCallback(
    (template: SurveyTemplate) => {
      if (isEditMode && onTemplateLoad) {
        // In edit mode, load template into current survey
        const templateJson =
          typeof template.template === "string" ? template.template : JSON.stringify(template.template);
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

  const formatDate = (dateString: string) => {
    try {
      return formatInTimeZone(new TZDate(dateString), "America/New_York", "MMM d, yyyy");
    } catch {
      return new Date(dateString).toLocaleDateString();
    }
  };

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

  return (
    <>
      <DialogRoot open={isOpen} onOpenChange={onClose}>
        <DialogContent
          maxW="6xl"
          w="90vw"
          h="90vh"
          bg={bgColor}
          borderColor={borderColor}
          borderRadius="lg"
          className="flex flex-col"
        >
          <DialogHeader bg={headerBgColor} p={4} borderRadius="lg">
            <DialogTitle color={textColor} fontSize="xl" fontWeight="bold">
              Survey Template Library
            </DialogTitle>
            <DialogCloseTrigger />
          </DialogHeader>

          <DialogBody p={6} overflow="auto">
            {/* Search and Filter Controls */}
            <VStack align="stretch" gap={4} mb={6}>
              <HStack gap={4}>
                <Input
                  placeholder="Search by name, or description"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  bg={cardBgColor}
                  borderColor={borderColor}
                  color={textColor}
                  _placeholder={{ color: placeholderColor }}
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
                      bg={cardBgColor}
                      borderColor={borderColor}
                      color={textColor}
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
                <Text color={textColor}>Loading templates...</Text>
              </Box>
            )}

            {/* Empty State */}
            {!isLoading && filteredTemplates.length === 0 && (
              <Box textAlign="center" py={8}>
                <Text color={textColor}>
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
                    bg={cardBgColor}
                    border="1px solid"
                    borderColor={borderColor}
                    borderRadius="lg"
                    p={4}
                  >
                    <VStack align="stretch" gap={3}>
                      {/* Title and Visibility Badge */}
                      <HStack justify="space-between" align="start">
                        <Text fontWeight="semibold" fontSize="md" color={textColor} lineClamp={2} flex={1}>
                          {template.title}
                        </Text>
                        <Badge
                          px={2}
                          py={1}
                          borderRadius="md"
                          fontSize="xs"
                          fontWeight="medium"
                          bg={template.scope === "global" ? "rgba(59, 130, 246, 0.2)" : "rgba(34, 197, 94, 0.2)"}
                          color={template.scope === "global" ? "#3B82F6" : "#22C55E"}
                          textTransform="capitalize"
                        >
                          {template.scope === "global" ? "Shared" : "Class-Only"}
                        </Badge>
                      </HStack>

                      {/* Description */}
                      {template.description && (
                        <Text fontSize="sm" color={textColor} opacity={0.8} lineClamp={2}>
                          {template.description}
                        </Text>
                      )}

                      {/* Creator and Date */}
                      <VStack align="start" gap={1}>
                        <Text fontSize="xs" color={textColor} opacity={0.7}>
                          Last modified: {formatDate(template.updated_at)}
                        </Text>
                      </VStack>

                      {/* Actions */}
                      <HStack gap={2} mt={2}>
                        <Button
                          size="sm"
                          variant="outline"
                          bg="transparent"
                          borderColor={buttonBorderColor}
                          color={buttonTextColor}
                          _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                          onClick={() => handlePreview(template)}
                          flex={1}
                        >
                          Preview
                        </Button>
                        <Button
                          size="sm"
                          bg="#22C55E"
                          color="white"
                          _hover={{ bg: "#16A34A" }}
                          onClick={() => handleClone(template)}
                          flex={1}
                        >
                          Clone
                        </Button>
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
          surveyJson={JSON.stringify(previewTemplate.template)}
          surveyTitle={previewTemplate.title}
        />
      )}
    </>
  );
}

"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { SelectContent, SelectItem, SelectRoot, SelectTrigger, SelectValueText } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { Box, Grid, HStack, Input, Text, VStack, createListCollection } from "@chakra-ui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import MdEditor from "../ui/md-editor";

export interface NotificationFormData {
  title: string;
  message: string;
  display: "default" | "modal" | "banner";
  severity: "info" | "success" | "warning" | "error";
  icon: string;
  persistent: boolean;
  expires_at: string;
  roles: string[];
  course_ids: number[];
  user_ids: string;
  campaign_id: string;
  track_engagement: boolean;
  max_width: string;
  position: "top" | "bottom" | "center";
  backdrop_dismiss: boolean;
}

interface ClassOption {
  id: number;
  name: string | null;
  slug: string | null;
}

interface NotificationFormProps {
  initialData?: Partial<NotificationFormData>;
  onSubmit: (data: NotificationFormData) => Promise<void>;
  submitButtonText?: string;
  showAudienceTargeting?: boolean;
  isSubmitting?: boolean;
}

export const defaultNotificationFormData: NotificationFormData = {
  title: "",
  message: "",
  display: "default",
  severity: "info",
  icon: "",
  persistent: false,
  expires_at: "",
  roles: [],
  course_ids: [],
  user_ids: "",
  campaign_id: "",
  track_engagement: false,
  max_width: "",
  position: "bottom",
  backdrop_dismiss: true
};

export default function NotificationForm({
  initialData = {},
  onSubmit,
  showAudienceTargeting = true,
  isSubmitting = false
}: NotificationFormProps) {
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [loadingClasses, setLoadingClasses] = useState(false);
  const [formData, setFormData] = useState<NotificationFormData>({
    ...defaultNotificationFormData,
    ...initialData
  });

  const fetchClasses = useCallback(async () => {
    setLoadingClasses(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.from("classes").select("id, name, slug").order("name");

      if (error) throw error;
      setClasses(data || []);
    } catch {
      toaster.error({
        title: "Failed to load classes",
        description: "Could not fetch class list from database"
      });
    } finally {
      setLoadingClasses(false);
    }
  }, []);

  // Fetch classes when component mounts (only if audience targeting is shown)
  useEffect(() => {
    if (showAudienceTargeting && classes.length === 0) {
      fetchClasses();
    }
  }, [showAudienceTargeting, classes, fetchClasses]);

  // Create collections for select dropdowns
  const displayModeCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { value: "default", label: "Default (in notification box)" },
          { value: "modal", label: "Modal (popup dialog)" },
          { value: "banner", label: "Banner (visible under notification box)" }
        ],
        itemToString: (item) => item.label,
        itemToValue: (item) => item.value
      }),
    []
  );

  const severityCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { value: "info", label: "Info" },
          { value: "success", label: "Success" },
          { value: "warning", label: "Warning" },
          { value: "error", label: "Error" }
        ],
        itemToString: (item) => item.label,
        itemToValue: (item) => item.value
      }),
    []
  );

  const positionCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { value: "top", label: "Top" },
          { value: "bottom", label: "Bottom" },
          { value: "center", label: "Center" }
        ],
        itemToString: (item) => item.label,
        itemToValue: (item) => item.value
      }),
    []
  );

  const classCollection = useMemo(
    () =>
      createListCollection({
        items: classes.map((cls) => ({
          value: cls.id.toString(),
          label: cls.slug ? `${cls.name || "Unnamed Class"} (${cls.slug})` : cls.name || "Unnamed Class",
          id: cls.id
        })),
        itemToString: (item) => item.label,
        itemToValue: (item) => item.value
      }),
    [classes]
  );

  const handleInputChange = useCallback(
    (field: keyof NotificationFormData, value: string | string[] | number[] | boolean) => {
      setFormData((prev) => ({
        ...prev,
        [field]: value
      }));
    },
    [setFormData]
  );

  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setValidationError(null);

      // Trim all string fields
      const sanitizedData = {
        ...formData,
        title: formData.title.trim(),
        message: formData.message.trim(),
        icon: formData.icon.trim(),
        expires_at: formData.expires_at.trim(),
        campaign_id: formData.campaign_id.trim(),
        max_width: formData.max_width.trim(),
        user_ids: formData.user_ids.trim()
      };

      // Validate title is non-empty
      if (!sanitizedData.title) {
        setValidationError("Title is required");
        return;
      }

      // Validate message is not blank (strip HTML/markdown and check plain text length)
      const plainTextMessage = sanitizedData.message
        .replace(/<[^>]*>/g, "")
        .replace(/[#*`~]/g, "")
        .trim();
      if (!plainTextMessage) {
        setValidationError("Message is required");
        return;
      }

      // Normalize user_ids: filter out falsy values, convert to canonical type, and deduplicate
      const normalizedUserIds = sanitizedData.user_ids
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
        .filter((id, index, arr) => arr.indexOf(id) === index); // Remove duplicates

      // Dedupe course_ids: remove duplicates and falsy entries
      const normalizedCourseIds = sanitizedData.course_ids
        .filter((id) => id && id > 0) // Remove falsy and invalid IDs
        .filter((id, index, arr) => arr.indexOf(id) === index); // Remove duplicates

      const finalData = {
        ...sanitizedData,
        user_ids: normalizedUserIds.join(", "),
        course_ids: normalizedCourseIds
      };

      await onSubmit(finalData);
    },
    [formData, onSubmit]
  );

  return (
    <form id="notification-form" onSubmit={handleSubmit}>
      {validationError && (
        <Box p={3} bg="red.50" border="1px solid" borderColor="red.200" borderRadius="md">
          <Text color="red.600" fontSize="sm">
            {validationError}
          </Text>
        </Box>
      )}
      <VStack gap={4} align="stretch">
        {/* Basic Information */}
        <Box>
          <Text fontSize="md" fontWeight="semibold" mb={3}>
            Basic Information
          </Text>
          <VStack gap={3} align="stretch">
            <Field label="Title" required>
              <Input
                value={formData.title}
                onChange={(e) => handleInputChange("title", e.target.value)}
                placeholder="Enter notification title"
                required
                disabled={isSubmitting}
              />
            </Field>

            <Field label="Message" required>
              <MdEditor
                value={formData.message}
                style={{ minWidth: "100%", width: "100%" }}
                onChange={(value) => {
                  if (isSubmitting) return;
                  handleInputChange("message", value || "");
                }}
                preview={isSubmitting ? "preview" : "edit"}
              />
            </Field>

            <Grid templateColumns="1fr 1fr" gap={3}>
              <Field label="Display Mode">
                <SelectRoot
                  collection={displayModeCollection}
                  value={[formData.display]}
                  onValueChange={(details: { value: string[] }) =>
                    handleInputChange("display", details.value[0] as "default" | "modal" | "banner")
                  }
                  size="md"
                  disabled={isSubmitting}
                >
                  <SelectTrigger>
                    <SelectValueText placeholder="Select display mode" />
                  </SelectTrigger>
                  <SelectContent style={{ zIndex: 9999 }}>
                    {displayModeCollection.items.map((item) => (
                      <SelectItem key={item.value} item={item}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              </Field>

              <Field label="Severity">
                <SelectRoot
                  collection={severityCollection}
                  value={[formData.severity]}
                  onValueChange={(details: { value: string[] }) =>
                    handleInputChange("severity", details.value[0] as "info" | "success" | "warning" | "error")
                  }
                  size="md"
                  disabled={isSubmitting}
                >
                  <SelectTrigger>
                    <SelectValueText placeholder="Select severity" />
                  </SelectTrigger>
                  <SelectContent style={{ zIndex: 9999 }}>
                    {severityCollection.items.map((item) => (
                      <SelectItem key={item.value} item={item}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              </Field>
            </Grid>

            <Field label="Custom Icon" helperText="Optional emoji or icon (e.g., 🎉, ⚠️)">
              <Input
                value={formData.icon}
                onChange={(e) => handleInputChange("icon", e.target.value)}
                placeholder="🎉"
                disabled={isSubmitting}
              />
            </Field>
          </VStack>
        </Box>

        {/* Targeting - Only show if enabled */}
        {showAudienceTargeting && (
          <Box>
            <Text fontSize="md" fontWeight="semibold" mb={3}>
              Audience Targeting
            </Text>
            <VStack gap={3} align="stretch">
              <Box>
                <Text fontSize="sm" fontWeight="medium" mb={2}>
                  Roles
                </Text>
                <Text fontSize="xs" color="fg.muted" mb={3}>
                  Leave empty to target all users
                </Text>
                <VStack align="start" gap={3}>
                  <Field>
                    <Checkbox
                      checked={formData.roles.includes("student")}
                      onCheckedChange={(newState) => {
                        if (newState.checked) {
                          handleInputChange("roles", [...formData.roles, "student"]);
                        } else {
                          handleInputChange(
                            "roles",
                            formData.roles.filter((r) => r !== "student")
                          );
                        }
                      }}
                    >
                      Student
                    </Checkbox>
                  </Field>
                  <Field>
                    <Checkbox
                      checked={formData.roles.includes("instructor")}
                      onCheckedChange={(newState) => {
                        if (newState.checked) {
                          handleInputChange("roles", [...formData.roles, "instructor"]);
                        } else {
                          handleInputChange(
                            "roles",
                            formData.roles.filter((r) => r !== "instructor")
                          );
                        }
                      }}
                    >
                      Instructor
                    </Checkbox>
                  </Field>
                  <Field>
                    <Checkbox
                      checked={formData.roles.includes("admin")}
                      onCheckedChange={(newState) => {
                        if (newState.checked) {
                          handleInputChange("roles", [...formData.roles, "admin"]);
                        } else {
                          handleInputChange(
                            "roles",
                            formData.roles.filter((r) => r !== "admin")
                          );
                        }
                      }}
                    >
                      Admin
                    </Checkbox>
                  </Field>
                </VStack>
              </Box>

              <Field label="Classes" helperText="Select specific classes to target (optional)">
                <SelectRoot
                  collection={classCollection}
                  multiple
                  value={formData.course_ids.map((id) => id.toString())}
                  onValueChange={(details: { value: string[] }) =>
                    handleInputChange(
                      "course_ids",
                      details.value.map((id) => parseInt(id))
                    )
                  }
                  size="md"
                >
                  <SelectTrigger>
                    <SelectValueText placeholder={loadingClasses ? "Loading classes..." : "Select classes"} />
                  </SelectTrigger>
                  <SelectContent style={{ zIndex: 9999 }}>
                    {classCollection.items.map((item) => (
                      <SelectItem key={item.value} item={item}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              </Field>

              <Field label="Specific User IDs" helperText="Comma-separated list of user IDs (optional)">
                <Input
                  value={formData.user_ids}
                  onChange={(e) => handleInputChange("user_ids", e.target.value)}
                  placeholder="user1, user2, user3"
                />
              </Field>
            </VStack>
          </Box>
        )}

        {/* Behavior Options */}
        <Box>
          <Text fontSize="md" fontWeight="semibold" mb={3}>
            Behavior Options
          </Text>
          <VStack gap={3} align="stretch">
            <HStack justify="space-between">
              <VStack align="start" gap={0}>
                <Text fontSize="sm">Persistent</Text>
                <Text fontSize="xs" color="fg.muted">
                  Show again after dismissal
                </Text>
              </VStack>
              <Switch
                checked={formData.persistent}
                onCheckedChange={(details: { checked: boolean }) => handleInputChange("persistent", details.checked)}
                disabled={isSubmitting}
              />
            </HStack>

            <Field label="Expires At" helperText="Auto-dismiss after this date/time (optional)">
              <Input
                type="datetime-local"
                value={formData.expires_at}
                onChange={(e) => handleInputChange("expires_at", e.target.value)}
              />
            </Field>

            <HStack justify="space-between">
              <VStack align="start" gap={0}>
                <Text fontSize="sm">Track Engagement</Text>
                <Text fontSize="xs" color="fg.muted">
                  Track clicks and dismissals
                </Text>
              </VStack>
              <Switch
                checked={formData.track_engagement}
                onCheckedChange={(details: { checked: boolean }) =>
                  handleInputChange("track_engagement", details.checked)
                }
              />
            </HStack>

            <Field label="Campaign ID" helperText="For grouping related notifications (optional)">
              <Input
                value={formData.campaign_id}
                onChange={(e) => handleInputChange("campaign_id", e.target.value)}
                placeholder="welcome-2024, maintenance-alert"
              />
            </Field>
          </VStack>
        </Box>

        {/* Display Options */}
        {(formData.display === "modal" || formData.display === "banner") && (
          <Box>
            <Text fontSize="md" fontWeight="semibold" mb={3}>
              Advanced Display Options
            </Text>
            <VStack gap={3} align="stretch">
              <Field label="Max Width" helperText="CSS width value (e.g., 400px, 50%)">
                <Input
                  value={formData.max_width}
                  onChange={(e) => handleInputChange("max_width", e.target.value)}
                  placeholder="500px"
                />
              </Field>

              {formData.display === "banner" && (
                <Field label="Position">
                  <SelectRoot
                    collection={positionCollection}
                    value={[formData.position]}
                    onValueChange={(details: { value: string[] }) =>
                      handleInputChange("position", details.value[0] as "top" | "bottom" | "center")
                    }
                    size="md"
                  >
                    <SelectTrigger>
                      <SelectValueText placeholder="Select position" />
                    </SelectTrigger>
                    <SelectContent style={{ zIndex: 9999 }}>
                      {positionCollection.items.map((item) => (
                        <SelectItem key={item.value} item={item}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </SelectRoot>
                </Field>
              )}

              {formData.display === "modal" && (
                <HStack justify="space-between">
                  <VStack align="start" gap={0}>
                    <Text fontSize="sm">Backdrop Dismiss</Text>
                    <Text fontSize="xs" color="fg.muted">
                      Allow clicking outside to close
                    </Text>
                  </VStack>
                  <Switch
                    checked={formData.backdrop_dismiss}
                    onCheckedChange={(details: { checked: boolean }) =>
                      handleInputChange("backdrop_dismiss", details.checked)
                    }
                  />
                </HStack>
              )}
            </VStack>
          </Box>
        )}
      </VStack>
    </form>
  );
}

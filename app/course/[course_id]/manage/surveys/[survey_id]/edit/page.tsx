"use client";

import { toaster } from "@/components/ui/toaster";
import { useTrackEvent } from "@/hooks/useTrackEvent";
import { createClient } from "@/utils/supabase/client";
import { useForm } from "@refinedev/react-hook-form";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useRef } from "react";
import SurveyForm from "../../new/form";
import { Box, Heading, Text } from "@chakra-ui/react";
import { FieldValues } from "react-hook-form";
import { useClassProfiles } from "@/hooks/useClassProfiles";

type SurveyFormData = {
  title: string;
  description?: string;
  json: string;
  status: "draft" | "published";
  due_date?: string;
  allow_response_editing: boolean;
};

export default function EditSurveyPage() {
  const { course_id, survey_id } = useParams();
  const router = useRouter();
  const trackEvent = useTrackEvent();
  const { private_profile_id } = useClassProfiles();
  const [isLoading, setIsLoading] = useState(true);
  const [surveyData, setSurveyData] = useState<any>(null);
  const { role } = useClassProfiles();

  const form = useForm<SurveyFormData>({
    refineCoreProps: { resource: "surveys", action: "edit", id: survey_id as string },
    defaultValues: {
      title: "",
      description: "",
      json: "",
      status: "draft",
      due_date: "",
      allow_response_editing: false
    }
  });

  const { getValues, setValue, reset } = form;
  const hasLoadedSurvey = useRef(false);
  const loadingPromise = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (role.role === "grader") {
      toaster.create({
        title: "Access Denied",
        description: "Graders cannot edit surveys. Only instructors have this permission.",
        type: "error"
      });
      router.push(`/course/${course_id}/manage/surveys`);
    }
  }, [role, router, course_id]);

  // Load the survey data when component mounts
  useEffect(() => {
    console.log("[EditSurvey] useEffect triggered", {
      hasLoadedSurvey: hasLoadedSurvey.current,
      survey_id,
      course_id,
      hasLoadingPromise: !!loadingPromise.current
    });

    if (hasLoadedSurvey.current || loadingPromise.current) {
      console.log("[EditSurvey] Skipping load - already loaded or loading");
      return; // Prevent duplicate loading
    }

    const loadSurveyData = async () => {
      try {
        console.log("[EditSurvey] Starting to load survey data");
        setIsLoading(true);
        const supabase = createClient();
        const { data, error } = await supabase
          .from("surveys" as any)
          .select("*")
          .eq("id", survey_id)
          .eq("class_id", Number(course_id))
          .single();

        if (error || !data) {
          console.log("[EditSurvey] Survey not found:", error);
          toaster.create({
            title: "Survey Not Found",
            description: "The survey you're trying to edit could not be found.",
            type: "error"
          });
          router.push(`/course/${course_id}/manage/surveys`);
          return;
        }

        console.log("[EditSurvey] Survey data loaded successfully:", (data as any).id);
        setSurveyData(data);

        // Convert due_date from ISO string to datetime-local format
        let dueDateFormatted = "";
        if ((data as any).due_date) {
          const date = new Date((data as any).due_date);
          // Convert to datetime-local format (YYYY-MM-DDTHH:MM)
          dueDateFormatted = date.toISOString().slice(0, 16);
        }

        // Load the survey data into the form
        reset({
          title: (data as any).title || "",
          description: (data as any).description || "",
          json: (data as any).json || "",
          status: (data as any).status || "draft",
          due_date: dueDateFormatted,
          allow_response_editing: Boolean((data as any).allow_response_editing)
        });

        hasLoadedSurvey.current = true; // Mark as loaded to prevent duplicate toasts
        console.log("[EditSurvey] Survey loaded and form reset completed");

        toaster.create({
          title: "Survey Loaded",
          description: "Survey data has been loaded for editing.",
          type: "success"
        });
      } catch (error) {
        console.error("[EditSurvey] Error loading survey:", error);
        toaster.create({
          title: "Error Loading Survey",
          description: "An error occurred while loading the survey data.",
          type: "error"
        });
        router.push(`/course/${course_id}/manage/surveys`);
      } finally {
        setIsLoading(false);
        loadingPromise.current = null; // Clear the promise ref
      }
    };

    // Store the promise to prevent duplicate calls
    loadingPromise.current = loadSurveyData();
  }, [course_id, survey_id]); // Removed reset and router from dependencies

  const saveDraftOnly = useCallback(
    async (values: FieldValues, shouldRedirect: boolean = true) => {
      // This function saves as draft without validation - for back navigation
      async function updateDraft() {
        try {
          const supabase = createClient();

          // For drafts, we'll store the JSON as-is without validation
          // If JSON is empty or invalid, we'll store it as empty string
          let jsonToStore = "";
          if (values.json && values.json.trim()) {
            try {
              JSON.parse(values.json as string);
              jsonToStore = values.json as string;
            } catch (error) {
              // For drafts, store invalid JSON as-is (user can fix later)
              jsonToStore = values.json as string;
            }
          }

          const { data, error } = await supabase
            .from("surveys" as any)
            .update({
              title: (values.title as string) || "Untitled Survey",
              description: (values.description as string) || null,
              json: jsonToStore,
              status: "draft",
              allow_response_editing: values.allow_response_editing as boolean,
              due_date: (values.due_date as string) || null,
              validation_errors: null // No validation errors for draft saves
            })
            .eq("id", survey_id)
            .select("id, survey_id")
            .single();

          if (error || !data) {
            console.error("Draft save error:", error);
            throw new Error(error?.message || "Failed to save draft");
          }

          trackEvent("survey_updated" as any, {
            course_id: Number(course_id),
            survey_id: (data as any).survey_id,
            status: "draft",
            has_due_date: !!values.due_date,
            allow_response_editing: values.allow_response_editing
          });

          // Only show success toast and redirect if shouldRedirect is true
          if (shouldRedirect) {
            // Show success toast
            toaster.create({
              title: "Draft Saved",
              description: "Your survey has been saved as a draft.",
              type: "success"
            });

            // Redirect to manage surveys page
            router.push(`/course/${course_id}/manage/surveys`);
          }
          // If shouldRedirect is false, we don't show any toast (used for preview auto-save)
        } catch (error) {
          throw error;
        }
      }
      await updateDraft();
    },
    [course_id, trackEvent, router, survey_id]
  );

  const onSubmit = useCallback(
    async (values: FieldValues) => {
      async function update() {
        // Validate due date if trying to publish
        if (values.status === "published" && values.due_date) {
          const dueDate = new Date(values.due_date as string);
          const now = new Date();
          
          if (dueDate < now) {
            toaster.create({
              title: "Cannot Publish Survey",
              description: "The due date must be in the future. Please update the due date or save as a draft.",
              type: "error"
            });
            return;
          }
        }

        // Show loading toast before starting the process
        const loadingToast = toaster.create({
          title: "Updating Survey",
          description: "Saving your survey configuration...",
          type: "loading"
        });

        try {
          const supabase = createClient();

          // Parse the JSON to ensure it's valid (only for active updates)
          let parsedJson;
          let validationErrors = null;
          try {
            parsedJson = JSON.parse(values.json as string);
          } catch (error) {
            // Instead of throwing, create a draft with validation errors
            validationErrors = `Invalid JSON configuration: ${error instanceof Error ? error.message : "Unknown error"}`;
            parsedJson = values.json as string; // Store the invalid JSON as-is
          }

          // Update the survey
          const { data, error } = await supabase
            .from("surveys" as any)
            .update({
              title: values.title as string,
              description: (values.description as string) || null,
              json: parsedJson,
              status: validationErrors ? "draft" : (values.status as string), // Force to draft if validation errors
              allow_response_editing: values.allow_response_editing as boolean,
              due_date: (values.due_date as string) || null,
              validation_errors: validationErrors
            })
            .eq("id", survey_id)
            .select("id, survey_id")
            .single();

          if (error || !data) {
            // If database error, try to save as draft with error flag
            try {
              const fallbackData = await supabase
                .from("surveys" as any)
                .update({
                  title: values.title as string,
                  description: (values.description as string) || null,
                  questions: values.json as string,
                  status: "draft",
                  allow_response_editing: values.allow_response_editing as boolean,
                  due_date: (values.due_date as string) || null,
                  validation_errors: `Database error: ${error?.message || "Unknown error"}`
                })
                .eq("id", survey_id)
                .select("id, survey_id")
                .single();

              if (fallbackData.error) {
                throw new Error(fallbackData.error.message);
              }
            } catch (fallbackError) {
              throw new Error(`Failed to update survey: ${error?.message || "Unknown error"}`);
            }
            return;
          }

          // Track survey update
          trackEvent("survey_updated" as any, {
            course_id: Number(course_id),
            survey_id: (data as any).survey_id,
            status: validationErrors ? "draft" : values.status,
            has_due_date: !!values.due_date,
            allow_response_editing: values.allow_response_editing,
            has_validation_errors: !!validationErrors
          });

          // Dismiss loading toast and show success
          toaster.dismiss(loadingToast);

          // Show appropriate success message
          if (validationErrors) {
            toaster.create({
              title: "Survey Saved as Draft",
              description:
                "Your survey was saved as a draft due to validation issues. Please review and fix the errors.",
              type: "warning"
            });
          } else if (values.status === "draft") {
            toaster.create({
              title: "Draft Saved",
              description: "Your survey has been saved as a draft.",
              type: "success"
            });
          } else {
            toaster.create({
              title: "Survey Published",
              description: "Your survey has been published and is now available to students.",
              type: "success"
            });
          }

          // Redirect to manage surveys page
          router.push(`/course/${course_id}/manage/surveys`);
        } catch (error) {
          // Dismiss loading toast and show error
          toaster.dismiss(loadingToast);
          toaster.error({
            title: "Error updating survey",
            description: error instanceof Error ? error.message : "An unexpected error occurred"
          });
        }
      }
      await update();
    },
    [course_id, router, trackEvent, survey_id]
  );

  if (isLoading) {
    return (
      <Box py={8} maxW="1200px" my={2} mx="auto">
        <Box display="flex" alignItems="center" justifyContent="center" p={8}>
          <Text>Loading survey data...</Text>
        </Box>
      </Box>
    );
  }

  if (!surveyData) {
    return (
      <Box py={8} maxW="1200px" my={2} mx="auto">
        <Box display="flex" alignItems="center" justifyContent="center" p={8}>
          <Text>Survey not found.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box py={8} maxW="1200px" my={2} mx="auto">
      <SurveyForm 
        form={form} 
        onSubmit={onSubmit} 
        saveDraftOnly={saveDraftOnly} 
        isEdit={true} 
        privateProfileId={private_profile_id}
      />
    </Box>
  );
}

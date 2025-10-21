"use client";

import { toaster } from "@/components/ui/toaster";
import { useTrackEvent } from "@/hooks/useTrackEvent";
import { createClient } from "@/utils/supabase/client";
import { useForm } from "@refinedev/react-hook-form";
import { useParams, useRouter } from "next/navigation";
import { useCallback } from "react";
import SurveyForm from "./form";
import { Box, Heading, Text } from "@chakra-ui/react";
import { FieldValues } from "react-hook-form";

type SurveyFormData = {
  title: string;
  description?: string;
  json: string;
  status: "draft" | "published";
  due_date?: string;
  allow_response_editing: boolean;
};

export default function NewSurveyPage() {
  const { course_id } = useParams();
  const router = useRouter();
  const trackEvent = useTrackEvent();

  const form = useForm<SurveyFormData>({
    refineCoreProps: { resource: "surveys", action: "create" },
    defaultValues: {
      title: "",
      description: "",
      json: "",
      status: "draft",
      due_date: "",
      allow_response_editing: false
    }
  });

  const { getValues } = form;

  const saveDraftOnly = useCallback(
    async (values: FieldValues) => {
      // This function saves as draft without validation - for back navigation
      async function createDraft() {
        try {
          const supabase = createClient();
          const survey_id = crypto.randomUUID();

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
            .insert({
              survey_id: survey_id,
              version: 1,
              class_id: Number(course_id),
              created_by: "current_user", // TODO: Get actual user ID from auth
              title: (values.title as string) || "Untitled Survey",
              description: (values.description as string) || null,
              json: jsonToStore,
              status: "draft",
              created_at: new Date().toISOString(),
              allow_response_editing: values.allow_response_editing as boolean,
              due_date: (values.due_date as string) || null,
              validation_errors: null // No validation errors for draft saves
            })
            .select("id, survey_id")
            .single();

          if (error || !data) {
            console.error("Draft save error:", error);
            throw new Error(error?.message || "Failed to save draft");
          }

          trackEvent("survey_created" as any, {
            course_id: Number(course_id),
            survey_id: (data as any).survey_id,
            status: "draft",
            has_due_date: !!values.due_date,
            allow_response_editing: values.allow_response_editing
          });

          // Show success toast
          toaster.create({
            title: "Draft Saved",
            description: "Your survey has been saved as a draft.",
            type: "success"
          });

          // Redirect to manage surveys page
          router.push(`/course/${course_id}/manage/surveys`);
        } catch (error) {
          throw error;
        }
      }
      await createDraft();
    },
    [course_id, trackEvent, router]
  );

  const onSubmit = useCallback(
    async (values: FieldValues) => {
      async function create() {
        // Show loading toast before starting the process
        const loadingToast = toaster.create({
          title: "Creating Survey",
          description: "Saving your survey configuration...",
          type: "loading"
        });

        try {
          const supabase = createClient();

          // Generate new survey_id using crypto.randomUUID()
          const survey_id = crypto.randomUUID();

          // Parse the JSON to ensure it's valid (only for active creation)
          let parsedJson;
          let validationErrors = null;
          try {
            parsedJson = JSON.parse(values.json as string);
          } catch (error) {
            // Instead of throwing, create a draft with validation errors
            validationErrors = `Invalid JSON configuration: ${error instanceof Error ? error.message : "Unknown error"}`;
            parsedJson = values.json as string; // Store the invalid JSON as-is
          }

          // Insert into surveys table
          const { data, error } = await supabase
            .from("surveys" as any)
            .insert({
              survey_id: survey_id,
              version: 1,
              class_id: Number(course_id),
              created_by: "current_user", // TODO: Get actual user ID from auth
              title: values.title as string,
              description: (values.description as string) || null,
              json: parsedJson,
              status: validationErrors ? "draft" : (values.status as string), // Force to draft if validation errors
              created_at: new Date().toISOString(),
              allow_response_editing: values.allow_response_editing as boolean,
              due_date: (values.due_date as string) || null,
              validation_errors: validationErrors
            })
            .select("id, survey_id")
            .single();

          if (error || !data) {
            // If database error, try to save as draft with error flag
            try {
              const fallbackData = await supabase
                .from("surveys" as any)
                .insert({
                  survey_id: survey_id,
                  version: 1,
                  class_id: Number(course_id),
                  created_by: "current_user",
                  title: values.title as string,
                  description: (values.description as string) || null,
                  json: values.json as string,
                  status: "draft",
                  created_at: new Date().toISOString(),
                  allow_response_editing: values.allow_response_editing as boolean,
                  due_date: (values.due_date as string) || null,
                  validation_errors: `Database error: ${error?.message || "Unknown error"}`
                })
                .select("id, survey_id")
                .single();

              if (fallbackData.error) {
                throw new Error(fallbackData.error.message);
              }
            } catch (fallbackError) {
              throw new Error(`Failed to save survey: ${error?.message || "Unknown error"}`);
            }
            return;
          }

          // Track survey creation
          trackEvent("survey_created" as any, {
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
            title: "Error creating survey",
            description: error instanceof Error ? error.message : "An unexpected error occurred"
          });
        }
      }
      await create();
    },
    [course_id, router, trackEvent]
  );

  return (
    <Box py={8} maxW="1200px" my={2} mx="auto">
      <SurveyForm form={form} onSubmit={onSubmit} saveDraftOnly={saveDraftOnly} />
    </Box>
  );
}

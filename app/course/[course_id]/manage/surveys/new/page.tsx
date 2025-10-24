"use client";

import { toaster } from "@/components/ui/toaster";
import { useTrackEvent } from "@/hooks/useTrackEvent";
import { createClient } from "@/utils/supabase/client";
import { useForm } from "@refinedev/react-hook-form";
import { useParams, useRouter } from "next/navigation";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCallback } from "react";
import SurveyForm from "./form";
import { Box } from "@chakra-ui/react";
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

  // 🚨 THIS is where we’re allowed to call hooks like useClassProfiles
  const { private_profile_id } = useClassProfiles();

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

  // -------- SAVE DRAFT ONLY --------
  const saveDraftOnly = useCallback(
    async (values: FieldValues) => {
      const supabase = createClient();

      const survey_id = crypto.randomUUID();

      // Accept possibly invalid JSON for drafts
      let jsonToStore = "";
      if (values.json && (values.json as string).trim()) {
        try {
          JSON.parse(values.json as string); // just a check
          jsonToStore = values.json as string;
        } catch {
          jsonToStore = values.json as string; // keep raw
        }
      }

      const insertPayload = {
        survey_id,
        version: 1,
        class_id: Number(course_id),
        created_by: private_profile_id, // ✅ profile UUID, not auth.user.id
        title: (values.title as string) || "Untitled Survey",
        description: (values.description as string) || null,
        json: jsonToStore,
        status: "draft",
        created_at: new Date().toISOString(),
        allow_response_editing: values.allow_response_editing as boolean,
        due_date: (values.due_date as string) || null,
        validation_errors: null
      };

      console.log("[saveDraftOnly] inserting survey payload =", insertPayload);

      const { data, error } = await supabase
        .from("surveys" as any)
        .insert(insertPayload)
        .select("id, survey_id")
        .single();

      if (error || !data) {
        console.error("[saveDraftOnly] insert error:", error);
        toaster.error({
          title: "Error saving draft",
          description: error?.message || "Failed to save draft"
        });
        throw new Error(error?.message || "Failed to save draft");
      }

      trackEvent("survey_created" as any, {
        course_id: Number(course_id),
        survey_id: (data as any).survey_id,
        status: "draft",
        has_due_date: !!values.due_date,
        allow_response_editing: values.allow_response_editing
      });

      toaster.create({
        title: "Draft Saved",
        description: "Your survey has been saved as a draft.",
        type: "success"
      });

      router.push(`/course/${course_id}/manage/surveys`);
    },
    [course_id, private_profile_id, router, trackEvent]
  );

  // -------- FULL SUBMIT (PUBLISH OR DRAFT WITH VALIDATION) --------
  const onSubmit = useCallback(
    async (values: FieldValues) => {
      const supabase = createClient();

      // toast: loading
      const loadingToast = toaster.create({
        title: "Creating Survey",
        description: "Saving your survey configuration...",
        type: "loading"
      });

      try {
        const survey_id = crypto.randomUUID();

        // Validate JSON if they're trying to publish
        let parsedJson: any;
        let validationErrors: string | null = null;
        try {
          parsedJson = JSON.parse(values.json as string);
        } catch (err) {
          validationErrors = `Invalid JSON configuration: ${
            err instanceof Error ? err.message : "Unknown error"
          }`;
          parsedJson = values.json as string; // keep raw
        }

        const insertPayload = {
          survey_id,
          version: 1,
          class_id: Number(course_id),
          created_by: private_profile_id, // ✅ correct identity
          title: values.title as string,
          description: (values.description as string) || null,
          json: parsedJson,
          status: validationErrors ? "draft" : (values.status as string), // force draft on error
          created_at: new Date().toISOString(),
          allow_response_editing: values.allow_response_editing as boolean,
          due_date: (values.due_date as string) || null,
          validation_errors: validationErrors
        };

        console.log("[onSubmit] inserting survey payload =", insertPayload);

        const { data, error } = await supabase
          .from("surveys" as any)
          .insert(insertPayload)
          .select("id, survey_id")
          .single();

        if (error || !data) {
          console.error("[onSubmit] insert error:", error);
          throw new Error(error.message || "Failed to save survey");
        }

        // Track analytics
        trackEvent("survey_created" as any, {
          course_id: Number(course_id),
          survey_id: (data as any).survey_id,
          status: validationErrors ? "draft" : values.status,
          has_due_date: !!values.due_date,
          allow_response_editing: values.allow_response_editing,
          has_validation_errors: !!validationErrors
        });

        // Kill loading toast
        toaster.dismiss(loadingToast);

        // Show user-facing toast
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
            description:
              "Your survey has been published and is now available to students.",
            type: "success"
          });
        }

        // Redirect
        router.push(`/course/${course_id}/manage/surveys`);
      } catch (err: any) {
        console.error("[onSubmit] final error:", err);
        toaster.dismiss(loadingToast);
        toaster.error({
          title: "Error creating survey",
          description:
            err instanceof Error
              ? err.message
              : "An unexpected error occurred"
        });
      }
    },
    [course_id, private_profile_id, router, trackEvent]
  );

  return (
    <Box py={8} maxW="1200px" my={2} mx="auto">
      <SurveyForm
        form={form}
        onSubmit={onSubmit}
        saveDraftOnly={saveDraftOnly}
      />
    </Box>
  );
}

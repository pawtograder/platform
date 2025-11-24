"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { toaster } from "@/components/ui/toaster";
import { useTrackEvent } from "@/hooks/useTrackEvent";
import { createClient } from "@/utils/supabase/client";
import { useForm } from "@refinedev/react-hook-form";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import SurveyForm from "./form";
import { Box } from "@chakra-ui/react";
import { FieldValues } from "react-hook-form";
import type { Tables } from "@/utils/supabase/SupabaseTypes";
import { PostgrestError } from "@supabase/supabase-js";
import { TZDate } from "@date-fns/tz";
import { formatInTimeZone } from "date-fns-tz";

type SurveyFormData = {
  title: string;
  description?: string;
  json: string;
  status: "draft" | "published";
  due_date?: string;
  allow_response_editing: boolean;
};

type SurveyStatus = Tables<"surveys">["status"]; // "draft" | "published" | "closed"
type SurveyIds = Pick<Tables<"surveys">, "id" | "survey_id">;

export default function NewSurveyPage() {
  const { course_id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const trackEvent = useTrackEvent();

  // 🚨 THIS is where we're allowed to call hooks like useClassProfiles
  const { private_profile_id, role } = useClassProfiles();
  const [isReturningFromPreview, setIsReturningFromPreview] = useState(false);
  const [currentSurveyId, setCurrentSurveyId] = useState<string | null>(null);
  const timezone = role.classes?.time_zone || "America/New_York";

  // Helper function to convert datetime-local string to ISO timestamp with timezone
  const convertDueDateToISO = (dueDateString: string | null | undefined): string | null => {
    if (!dueDateString) return null;
    // Parse datetime-local format (YYYY-MM-DDTHH:MM)
    const [date, time] = dueDateString.split("T");
    if (!date || !time) return null;
    const [year, month, day] = date.split("-");
    const [hour, minute] = time.split(":");
    // Create TZDate with these exact values in course timezone
    const tzDate = new TZDate(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hour),
      parseInt(minute),
      0,
      0,
      timezone
    );
    return tzDate.toISOString();
  };

  useEffect(() => {
    if (role.role === "grader") {
      toaster.create({
        title: "Access Denied",
        description: "Graders cannot create surveys. Only instructors have this permission.",
        type: "error"
      });
      router.push(`/course/${course_id}/manage/surveys`);
    }
  }, [role, router, course_id]);

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

  const { setValue, reset } = form;
  const hasLoadedDraft = useRef(false);
  const hasLoadedTemplate = useRef(false);

  // Load template if template_id query parameter is present
  useEffect(() => {
    const templateId = searchParams.get("template_id");

    if (templateId && !hasLoadedTemplate.current) {
      hasLoadedTemplate.current = true; // Mark as loaded to prevent duplicate loading

      const loadTemplate = async () => {
        try {
          const supabase = createClient();
          const { data, error } = await supabase.from("survey_templates").select("*").eq("id", templateId).single();

          if (data && !error) {
            // Cast data to expected type
            const templateData = data;

            // Load the template JSON into the form
            const templateJson =
              typeof templateData.template === "string" ? templateData.template : JSON.stringify(templateData.template);

            setValue("json", templateJson, { shouldDirty: true });

            // Optionally set title and description from template
            if (templateData.title) {
              setValue("title", `${templateData.title} (Copy)`, { shouldDirty: true });
            }
            if (templateData.description) {
              setValue("description", templateData.description, { shouldDirty: true });
            }

            toaster.create({
              title: "Template Loaded",
              description: `Template "${templateData.title}" has been loaded.`,
              type: "success"
            });

            // Clean up the URL parameter
            const url = new URL(window.location.href);
            url.searchParams.delete("template_id");
            window.history.replaceState({}, "", url.toString());
          } else {
            toaster.create({
              title: "Template Not Found",
              description: "The requested template could not be found.",
              type: "error"
            });
          }
        } catch (error) {
          console.error("Error loading template:", error);
          toaster.create({
            title: "Error Loading Template",
            description: "An error occurred while loading the template.",
            type: "error"
          });
        }
      };

      loadTemplate();
    }
  }, [searchParams, setValue]);

  // Only load draft if returning from preview (indicated by URL parameter)
  useEffect(() => {
    const isReturningFromPreview = searchParams.get("from") === "preview";

    if (isReturningFromPreview && !hasLoadedDraft.current) {
      hasLoadedDraft.current = true; // Mark as loaded to prevent duplicate loading
      setIsReturningFromPreview(true); // Set state for save functions to use

      const loadLatestDraft = async () => {
        try {
          const supabase = createClient();
          const { data, error } = await supabase
            .from("surveys")
            .select("*")
            .eq("class_id", Number(course_id))
            .eq("created_by", private_profile_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

          if (data && !error) {
            console.log("[loadLatestDraft] Raw data from DB:", data);
            console.log("[loadLatestDraft] due_date:", data.due_date);
            console.log("[loadLatestDraft] allow_response_editing:", data.allow_response_editing);
            console.log("[loadLatestDraft] status:", data.status);

            // Convert due_date from ISO string to datetime-local format in course timezone
            let dueDateFormatted = "";
            if (data.due_date) {
              // Convert ISO timestamp to datetime-local format in course timezone
              dueDateFormatted = formatInTimeZone(new Date(data.due_date), timezone, "yyyy-MM-dd'T'HH:mm");
            }

            // Load the draft data into the form
            const formData = {
              title: data.title || "",
              description: data.description || "",
              json: data.json || "",
              status: data.status || "draft",
              due_date: dueDateFormatted,
              allow_response_editing: Boolean(data.allow_response_editing)
            };

            console.log("[loadLatestDraft] Form data being loaded:", formData);
            reset(formData);
            setCurrentSurveyId(data.id);

            toaster.create({
              title: "Draft Restored",
              description: "Your previous work has been restored.",
              type: "info"
            });
          }
        } catch (error) {
          // Silently fail - this is just for convenience
          console.log("No draft found or error loading draft:", error);
        }
      };

      loadLatestDraft();

      // Clean up the URL parameter
      const url = new URL(window.location.href);
      url.searchParams.delete("from");
      window.history.replaceState({}, "", url.toString());
    }
  }, [course_id, reset, searchParams, private_profile_id]);

  // -------- CENTRALIZED SAVE FUNCTION --------
  const saveSurvey = useCallback(
    async (
      values: FieldValues,
      options: {
        shouldRedirect?: boolean;
        validateJson?: boolean;
        showToast?: boolean;
        toastTitle?: string;
        toastDescription?: string;
      } = {}
    ) => {
      const {
        shouldRedirect = true,
        validateJson = false,
        showToast = true
        //toastTitle = "Survey Saved",
        //toastDescription = "Your survey has been saved."
      } = options;

      console.log("[saveSurvey] Input values:", values);
      console.log("[saveSurvey] due_date:", values.due_date);
      console.log("[saveSurvey] allow_response_editing:", values.allow_response_editing);
      console.log("[saveSurvey] status:", values.status);

      const supabase = createClient();

      // Process JSON based on validation requirement
      let jsonToStore = "";
      let validationErrors: string | null = null;

      if (values.json && (values.json as string).trim()) {
        try {
          const parsedJson = JSON.parse(values.json as string);
          jsonToStore = validateJson ? JSON.stringify(parsedJson) : (values.json as string);
        } catch (err) {
          validationErrors = validateJson
            ? `Invalid JSON configuration: ${err instanceof Error ? err.message : "Unknown error"}`
            : null;
          jsonToStore = values.json as string; // keep raw for drafts
        }
      }

      // Determine final status
      const allowedStatuses: SurveyStatus[] = ["draft", "published", "closed"];
      const finalStatus: SurveyStatus = validationErrors
        ? "draft"
        : allowedStatuses.includes(values.status as SurveyStatus)
          ? (values.status as SurveyStatus)
          : "draft";

      // Check if we're returning from preview (indicates continuing work on same survey)
      console.log("[saveSurvey] isReturningFromPreview state:", isReturningFromPreview);
      console.log("[saveSurvey] currentSurveyId:", currentSurveyId);

      let data: Pick<Tables<"surveys">, "id" | "survey_id"> | null;
      let error: PostgrestError | null;

      if (currentSurveyId) {
        // Update existing survey
        console.log("[saveSurvey] updating existing survey:", currentSurveyId);

        const updatePayload = {
          title: (values.title as string) || "Untitled Survey",
          description: (values.description as string) || null,
          json: jsonToStore,
          status: finalStatus,
          allow_response_editing: values.allow_response_editing?.checked ?? Boolean(values.allow_response_editing),
          due_date: convertDueDateToISO(values.due_date as string),
          validation_errors: validationErrors,
          updated_at: new Date().toISOString()
        };

        const result = await supabase
          .from("surveys")
          .update(updatePayload)
          .eq("id", currentSurveyId)
          .select("id, survey_id")
          .single()
          .returns<SurveyIds>();

        data = result.data;
        error = result.error;
      } else if (isReturningFromPreview) {
        // Fallback for returning from preview if currentSurveyId wasn't set (e.g. network race condition)
        // Try to find the latest draft
        const { data: existingSurvey, error: surveyError } = await supabase
          .from("surveys")
          .select("id, survey_id")
          .eq("class_id", Number(course_id))
          .eq("created_by", private_profile_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .single()
          .returns<SurveyIds>();

        if (existingSurvey && !surveyError) {
          // Update existing survey found by query
          console.log("[saveSurvey] updating existing survey found by query:", existingSurvey.id);
          setCurrentSurveyId(existingSurvey.id); // Set it for next time

          const updatePayload = {
            title: (values.title as string) || "Untitled Survey",
            description: (values.description as string) || null,
            json: jsonToStore,
            status: finalStatus,
            allow_response_editing: values.allow_response_editing?.checked ?? Boolean(values.allow_response_editing),
            due_date: convertDueDateToISO(values.due_date as string),
            validation_errors: validationErrors,
            updated_at: new Date().toISOString()
          };

          const result = await supabase
            .from("surveys")
            .update(updatePayload)
            .eq("id", existingSurvey.id)
            .select("id, survey_id")
            .single()
            .returns<SurveyIds>();

          data = result.data;
          error = result.error;
        } else {
          // Should not happen if logic is correct, but treat as new
          const survey_id = crypto.randomUUID();
          const insertPayload = {
            survey_id,
            version: 1,
            class_id: Number(course_id),
            created_by: private_profile_id,
            title: (values.title as string) || "Untitled Survey",
            description: (values.description as string) || null,
            json: jsonToStore,
            status: finalStatus,
            created_at: new Date().toISOString(),
            allow_response_editing: Boolean(values.allow_response_editing?.checked ?? values.allow_response_editing),
            due_date: convertDueDateToISO(values.due_date as string),
            validation_errors: validationErrors
          };

          const result = await supabase
            .from("surveys")
            .insert(insertPayload)
            .select("id, survey_id")
            .single()
            .returns<SurveyIds>();

          data = result.data;
          error = result.error;
          if (data) setCurrentSurveyId(data.id);
        }
      } else {
        // Not returning from preview and no current ID - always create new survey
        const survey_id = crypto.randomUUID();

        const insertPayload = {
          survey_id,
          version: 1,
          class_id: Number(course_id),
          created_by: private_profile_id,
          title: (values.title as string) || "Untitled Survey",
          description: (values.description as string) || null,
          json: jsonToStore,
          status: finalStatus,
          created_at: new Date().toISOString(),
          allow_response_editing: Boolean(values.allow_response_editing?.checked ?? values.allow_response_editing),
          due_date: convertDueDateToISO(values.due_date as string),
          validation_errors: validationErrors
        };

        console.log("[saveSurvey] creating new survey:", insertPayload);

        const result = await supabase
          .from("surveys")
          .insert(insertPayload)
          .select("id, survey_id")
          .single()
          .returns<SurveyIds>();

        data = result.data;
        error = result.error;
        if (data) setCurrentSurveyId(data.id);
      }

      if (error || !data) {
        console.error("[saveSurvey] save error:", error);
        toaster.error({
          title: "Error saving survey",
          description: error?.message || "Failed to save survey"
        });
        throw new Error(error?.message || "Failed to save survey");
      }

      // Track analytics
      trackEvent("survey_created", {
        course_id: Number(course_id),
        survey_id: data.survey_id,
        status: finalStatus,
        has_due_date: !!values.due_date,
        allow_response_editing: Boolean(values.allow_response_editing?.checked ?? values.allow_response_editing),
        has_validation_errors: !!validationErrors,
        is_update: isReturningFromPreview
      });

      // Show toast if requested
      if (showToast) {
        if (validationErrors) {
          toaster.create({
            title: "Survey Saved as Draft",
            description: "Your survey was saved as a draft due to validation issues. Please review and fix the errors.",
            type: "warning"
          });
        } else if (finalStatus === "draft") {
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
      }

      // Redirect if requested
      if (shouldRedirect) {
        router.push(`/course/${course_id}/manage/surveys`);
      }

      return { data, error };
    },
    [course_id, private_profile_id, router, trackEvent, isReturningFromPreview, timezone]
  );

  // -------- SAVE DRAFT ONLY (WRAPPER) --------
  const saveDraftOnly = useCallback(
    async (values: FieldValues, shouldRedirect: boolean = true) => {
      return saveSurvey(values, {
        shouldRedirect,
        validateJson: false,
        showToast: shouldRedirect,
        toastTitle: "Draft Saved",
        toastDescription: "Your survey has been saved as a draft."
      });
    },
    [saveSurvey]
  );

  // -------- FULL SUBMIT (WRAPPER) --------
  const onSubmit = useCallback(
    async (values: FieldValues) => {
      // Validate due date if trying to publish
      if (values.status === "published" && values.due_date) {
        const dueDateISO = convertDueDateToISO(values.due_date as string);
        if (dueDateISO) {
          const dueDate = new Date(dueDateISO);
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
      }

      // Show loading toast
      const loadingToast = toaster.create({
        title: "Creating Survey",
        description: "Saving your survey configuration...",
        type: "loading"
      });

      try {
        const result = await saveSurvey(values, {
          shouldRedirect: true,
          validateJson: true,
          showToast: true
        });

        // Dismiss loading toast
        toaster.dismiss(loadingToast);

        return result;
      } catch (err: unknown) {
        console.error("[onSubmit] final error:", err);
        toaster.dismiss(loadingToast);
        toaster.error({
          title: "Error creating survey",
          description: err instanceof Error ? err.message : "An unexpected error occurred"
        });
        throw err;
      }
    },
    [saveSurvey]
  );

  return (
    <Box py={8} maxW="1200px" my={2} mx="auto">
      <SurveyForm form={form} onSubmit={onSubmit} saveDraftOnly={saveDraftOnly} privateProfileId={private_profile_id} />
    </Box>
  );
}

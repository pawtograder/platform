"use client";

import { Button } from "@/components/ui/button";
import { createClient } from "@/utils/supabase/client";
import type { SurveySeriesRow } from "@/types/survey-analytics";
import { Dialog, Field, HStack, Icon, Input, Stack, Text, Textarea, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { BsChevronDown, BsChevronUp, BsX } from "react-icons/bs";
import { useForm } from "react-hook-form";
import { toaster } from "@/components/ui/toaster";
import { useSurveysInSeries } from "@/hooks/useCourseController";
import { useCallback, useEffect } from "react";

type SeriesFormData = {
  name: string;
  description: string;
};

type SeriesManagementModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  classId: number;
  existingSeries?: SurveySeriesRow | null;
};

export default function SeriesManagementModal({
  isOpen,
  onClose,
  onSuccess,
  classId,
  existingSeries
}: SeriesManagementModalProps) {
  const { course_id } = useParams();
  const courseId = Number(course_id ?? classId);
  const { surveys, isLoading } = useSurveysInSeries(existingSeries?.id);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<SeriesFormData>({
    defaultValues: {
      name: "",
      description: ""
    }
  });

  useEffect(() => {
    if (existingSeries) {
      reset({
        name: existingSeries.name,
        description: existingSeries.description ?? ""
      });
    } else {
      reset({ name: "", description: "" });
    }
  }, [existingSeries, reset, isOpen]);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const onSubmit = async (data: SeriesFormData) => {
    const supabase = createClient();
    try {
      if (existingSeries) {
        const { error } = await supabase
          .from("survey_series")
          .update({
            name: data.name.trim(),
            description: data.description.trim() || null
          })
          .eq("id", existingSeries.id);
        if (error) throw error;
        toaster.success({ title: "Success", description: "Series updated successfully" });
      } else {
        const { data: authData } = await supabase.auth.getUser();
        const { error } = await supabase.from("survey_series").insert({
          class_id: courseId,
          name: data.name.trim(),
          description: data.description.trim() || null,
          created_by: authData?.user?.id ?? null
        });
        if (error) throw error;
        toaster.success({ title: "Success", description: "Series created successfully" });
      }
      handleClose();
      onSuccess();
    } catch (err) {
      toaster.error({
        title: "Error",
        description: `Failed to ${existingSeries ? "update" : "create"} series: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  };

  const moveSurvey = async (surveyId: string, direction: "up" | "down") => {
    const idx = surveys.findIndex((s) => s.id === surveyId);
    if (idx < 0) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= surveys.length) return;
    if (!existingSeries?.id) return;

    const reordered = [...surveys];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];

    const ordinalUpdates = reordered.map((s, i) => ({
      id: s.id,
      series_ordinal: i + 1
    }));

    const supabase = createClient();
    const { error } = await supabase.rpc(
      "reorder_surveys_in_series" as never,
      {
        p_series_id: existingSeries.id,
        p_ordinal_updates: ordinalUpdates
      } as never
    );
    if (error) {
      toaster.error({ title: "Error", description: `Failed to reorder: ${error.message}` });
      return;
    }
    toaster.success({ title: "Success", description: "Survey order updated" });
    onSuccess();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && handleClose()} size="lg">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>{existingSeries ? "Edit Survey Series" : "Create Survey Series"}</Dialog.Title>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" colorPalette="red" size="sm">
                <Icon as={BsX} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Header>

          <Dialog.Body>
            <form id="series-form" onSubmit={handleSubmit(onSubmit)}>
              <Stack spaceY={4}>
                <Field.Root invalid={!!errors.name}>
                  <Field.Label>Series Name</Field.Label>
                  <Input
                    {...register("name", {
                      required: "Name is required",
                      minLength: { value: 1, message: "Name is required" }
                    })}
                    placeholder="e.g., Weekly Team Collaboration Surveys"
                  />
                  <Field.ErrorText>{errors.name?.message}</Field.ErrorText>
                </Field.Root>

                <Field.Root>
                  <Field.Label>Description</Field.Label>
                  <Textarea {...register("description")} placeholder="Optional description..." rows={3} />
                </Field.Root>

                {existingSeries && (
                  <Field.Root>
                    <Field.Label>Surveys in Series</Field.Label>
                    {isLoading ? (
                      <Text color="fg.muted">Loading...</Text>
                    ) : surveys.length === 0 ? (
                      <Text color="fg.muted">No surveys in this series yet.</Text>
                    ) : (
                      <VStack align="stretch" gap={2}>
                        {surveys.map((survey, idx) => (
                          <HStack
                            key={survey.id}
                            justify="space-between"
                            p={2}
                            borderRadius="md"
                            bg="bg.subtle"
                            borderWidth="1px"
                            borderColor="border"
                          >
                            <Text fontSize="sm" fontWeight="medium">
                              {survey.series_ordinal ?? idx + 1}. {survey.title}
                            </Text>
                            <HStack gap={1}>
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => moveSurvey(survey.id, "up")}
                                disabled={idx === 0}
                              >
                                <Icon as={BsChevronUp} />
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => moveSurvey(survey.id, "down")}
                                disabled={idx === surveys.length - 1}
                              >
                                <Icon as={BsChevronDown} />
                              </Button>
                            </HStack>
                          </HStack>
                        ))}
                      </VStack>
                    )}
                    <Field.HelperText>Use arrow buttons to reorder surveys in the series.</Field.HelperText>
                  </Field.Root>
                )}
              </Stack>
            </form>
          </Dialog.Body>

          <Dialog.Footer>
            <HStack justify="end" gap={3}>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button colorPalette="blue" type="submit" form="series-form" loading={isSubmitting}>
                {existingSeries ? "Save Changes" : "Create Series"}
              </Button>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

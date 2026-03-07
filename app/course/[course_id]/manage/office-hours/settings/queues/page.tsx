"use client";

import HelpQueueManagement from "../../helpQueueManagement";
import { Box, Button, Field, Heading, Stack, Textarea } from "@chakra-ui/react";
import { useCourseController } from "@/hooks/useCourseController";
import { useUpdate } from "@refinedev/core";
import { useForm } from "react-hook-form";
import { useEffect } from "react";

type OfficeHoursDescriptionFormData = {
  office_hours_description: string;
};

export default function QueuesSettingsPage() {
  const courseController = useCourseController();
  const course = courseController?.course;

  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting }
  } = useForm<OfficeHoursDescriptionFormData>();

  const { mutateAsync: updateCourse } = useUpdate();

  // Reset form when course data loads
  useEffect(() => {
    if (course) {
      reset(
        {
          office_hours_description: course.office_hours_description || ""
        },
        {
          keepDirtyValues: true
        }
      );
    }
  }, [course, reset]);

  const onSubmit = async (data: OfficeHoursDescriptionFormData) => {
    if (!course) return;

    await updateCourse({
      resource: "classes",
      id: course.id,
      values: {
        office_hours_description: data.office_hours_description || null
      },
      successNotification: {
        message: "Office hours description updated successfully",
        type: "success"
      },
      errorNotification: {
        message: "Failed to update office hours description",
        type: "error"
      }
    });
  };

  return (
    <Stack spaceY={6}>
      <Box>
        <Heading size="lg" mb={4}>
          Queue Settings
        </Heading>
        <Box mb={6} p={4} borderWidth="1px" borderColor="border.muted" rounded="md" bg="bg.panel">
          <Field.Root>
            <Field.Label>Office Hours Description</Field.Label>
            <form onSubmit={handleSubmit(onSubmit)}>
              <Stack spaceY={3}>
                <Textarea
                  {...register("office_hours_description")}
                  placeholder="Enter a description that will be shown to students when they access office hours..."
                  rows={6}
                />
                <Field.HelperText>
                  This description will be displayed at the top of the office hours page for all students. Use markdown
                  formatting.
                </Field.HelperText>
                <Box>
                  <Button type="submit" colorPalette="green" loading={isSubmitting}>
                    Save Description
                  </Button>
                </Box>
              </Stack>
            </form>
          </Field.Root>
        </Box>
      </Box>

      <Box>
        <Heading size="lg" mb={4}>
          Help Queues
        </Heading>
        <HelpQueueManagement />
      </Box>
    </Stack>
  );
}

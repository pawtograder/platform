"use client";

import HelpQueueManagement from "../../helpQueueManagement";
import { Box, Button, Field, Heading, HStack, Input, Stack, Text, Textarea } from "@chakra-ui/react";
import { useCourseController } from "@/hooks/useCourseController";
import { useUpdate } from "@refinedev/core";
import { useForm } from "react-hook-form";
import { useEffect, useState } from "react";
import { DEFAULT_QUEUE_HEALTH_THRESHOLDS } from "@/hooks/useQueueHealth";
import { parseQueueHealthThresholds } from "@/lib/queueHealthThresholds";
import { useCourse } from "@/hooks/useCourseController";
import { toaster } from "@/components/ui/toaster";

type OfficeHoursDescriptionFormData = {
  office_hours_description: string;
};

type QueueHealthFormData = {
  waiting_red: number;
  oldest_wait_red_minutes: number;
};

/**
 * Instructor-set thresholds for the red numbers on the staff queue cards. Each class has its own.
 */
function QueueHealthColorsSection({ classId }: { classId: number | undefined }) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting, isDirty, errors }
  } = useForm<QueueHealthFormData>({ defaultValues: DEFAULT_QUEUE_HEALTH_THRESHOLDS });
  const { mutateAsync: updateCourse } = useUpdate();
  const [loaded, setLoaded] = useState(false);

  // The limits come from the course, which the classes realtime update keeps current.
  const course = useCourse();
  useEffect(() => {
    if (!course) return;
    reset(parseQueueHealthThresholds(course.office_hours_health_thresholds), { keepDirtyValues: true });
    setLoaded(true);
  }, [course, reset]);

  const onSubmit = async (data: QueueHealthFormData) => {
    if (classId === undefined) return;
    try {
      await updateCourse({
        resource: "classes",
        id: classId,
        values: {
          office_hours_health_thresholds: {
            waiting_red: Number(data.waiting_red),
            oldest_wait_red_minutes: Number(data.oldest_wait_red_minutes)
          }
        }
      });
      reset(data);
      toaster.success({ title: "Queue health colors saved" });
    } catch {
      toaster.error({ title: "Could not save queue health colors" });
    }
  };

  const rule = {
    required: "Required",
    min: { value: 1, message: "Must be at least 1" },
    max: { value: 10000, message: "Too large" }
  };

  return (
    <Box mb={6} p={4} borderWidth="1px" borderColor="border.muted" rounded="md" bg="bg.panel">
      <Heading size="md" mb={1}>
        Queue Health Colors
      </Heading>
      <Text fontSize="sm" color="fg.muted" mb={4}>
        On the staff queue cards, a number turns red when it reaches these limits.
      </Text>
      <form noValidate onSubmit={handleSubmit(onSubmit)}>
        <Stack spaceY={3}>
          <HStack gap={4} align="flex-start" wrap="wrap">
            <Field.Root invalid={!!errors.waiting_red} w="auto">
              <Field.Label>Students waiting</Field.Label>
              <Input
                type="number"
                min={1}
                width="120px"
                disabled={!loaded}
                {...register("waiting_red", { ...rule, valueAsNumber: true })}
              />
              <Field.HelperText>Turns red at this many or more.</Field.HelperText>
              <Field.ErrorText>{errors.waiting_red?.message}</Field.ErrorText>
            </Field.Root>
            <Field.Root invalid={!!errors.oldest_wait_red_minutes} w="auto">
              <Field.Label>Oldest wait (minutes)</Field.Label>
              <Input
                type="number"
                min={1}
                width="120px"
                disabled={!loaded}
                {...register("oldest_wait_red_minutes", { ...rule, valueAsNumber: true })}
              />
              <Field.HelperText>Turns red at this long or more.</Field.HelperText>
              <Field.ErrorText>{errors.oldest_wait_red_minutes?.message}</Field.ErrorText>
            </Field.Root>
          </HStack>
          <Box>
            <Button type="submit" colorPalette="green" loading={isSubmitting} disabled={!isDirty || !loaded}>
              Save Colors
            </Button>
          </Box>
        </Stack>
      </form>
    </Box>
  );
}

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

      <QueueHealthColorsSection classId={course?.id} />

      <Box>
        <Heading size="lg" mb={4}>
          Help Queues
        </Heading>
        <HelpQueueManagement />
      </Box>
    </Stack>
  );
}

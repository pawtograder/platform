"use client";

import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { createClient } from "@/utils/supabase/client";
import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Card, Heading, HStack, Input, Link, Skeleton, Text, VStack } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { useParams } from "next/navigation";
import { useState } from "react";
import { FaClock } from "react-icons/fa";

interface ClassLateTokenUpdateFormData {
  late_tokens_per_student: number;
}

export default function DueDateExceptionsManagement() {
  const { course_id } = useParams();
  const { role } = useClassProfiles();
  const [isEditingTokens, setIsEditingTokens] = useState(false);
  const [course, setCourse] = useState<Course | undefined>(role.classes);

  // Custom function to update class late tokens using our secure database function

  const {
    handleSubmit,
    register,
    reset,
    formState: { isSubmitting, errors }
  } = useForm<ClassLateTokenUpdateFormData>({
    mode: "onSubmit"
  });

  const { data: assignments, isLoading: assignmentsLoading } = useList<Assignment>({
    resource: "assignments",
    pagination: { pageSize: 1000 },
    filters: [{ field: "class_id", operator: "eq", value: Number.parseInt(course_id as string) }],
    sorters: [{ field: "due_date", order: "asc" }]
  });

  const onSubmitTokens = handleSubmit(async (data) => {
    try {
      const supabase = createClient();

      // Call our SECURITY DEFINER PostgreSQL function directly
      const { error } = await supabase.rpc("update_class_late_tokens_per_student", {
        p_class_id: Number.parseInt(course_id as string),
        p_late_tokens_per_student: data.late_tokens_per_student
      });

      if (error) {
        throw new Error(error.message || "Failed to update late tokens");
      }

      const { data: courseData } = await supabase
        .from("classes")
        .select("*")
        .eq("id", Number.parseInt(course_id as string))
        .single();
      if (courseData) {
        // Invalidate self
        setCourse(courseData);
      }

      setIsEditingTokens(false);

      toaster.success({
        title: "Success",
        description: "Late tokens updated successfully"
      });
    } catch (err) {
      // Log the full error for debugging
      console.error("Error updating late tokens:", err);

      // Surface error to user with RPC error details
      const errorMessage = err instanceof Error ? err.message : "Failed to update late tokens";
      toaster.error({
        title: "Failed to update late tokens",
        description: errorMessage
      });
    }
  });

  // Verify instructor access
  if (role.role !== "instructor") {
    return (
      <Box p={6}>
        <Text>Access denied. This page is only available to instructors.</Text>
      </Box>
    );
  }

  if (!course || assignmentsLoading || !assignments) {
    return <Skeleton height="400px" width="100%" />;
  }

  return (
    <Box maxW="6xl">
      <VStack gap={8} align="stretch">
        {/* Header */}
        <Box>
          <Heading size="lg">Due Date Exceptions Management</Heading>
          <Text color="fg.muted" mt={2}>
            Manage late tokens and due date exceptions for {course.name}
          </Text>
        </Box>

        {/* Class Late Token Settings */}
        <Card.Root>
          <Card.Header>
            <Card.Title>
              <HStack>
                <FaClock />
                <Text>Class Late Token Settings</Text>
              </HStack>
            </Card.Title>
            <Card.Description>Configure how many late tokens each student gets in this class.</Card.Description>
          </Card.Header>
          <Card.Body>
            {isEditingTokens ? (
              <form onSubmit={onSubmitTokens}>
                <VStack gap={4} align="start">
                  <Field
                    label="Late Tokens Per Student"
                    errorText={errors.late_tokens_per_student?.message?.toString()}
                    invalid={!!errors.late_tokens_per_student}
                    helperText="Number of late tokens each student receives for the entire class"
                  >
                    <Input
                      type="number"
                      min="0"
                      defaultValue={course.late_tokens_per_student}
                      {...register("late_tokens_per_student", {
                        required: "Late tokens per student is required",
                        min: { value: 0, message: "Must be 0 or greater" },
                        valueAsNumber: true
                      })}
                      width="200px"
                    />
                  </Field>
                  <HStack>
                    <Button type="submit" loading={isSubmitting} colorPalette="green">
                      Save Changes
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setIsEditingTokens(false);
                        reset();
                      }}
                    >
                      Cancel
                    </Button>
                  </HStack>
                </VStack>
              </form>
            ) : (
              <VStack gap={3} align="start">
                <Text>
                  <Text as="span" fontWeight="semibold">
                    Current Setting:
                  </Text>{" "}
                  Each student receives{" "}
                  <Text as="span" fontWeight="bold" fontSize="lg">
                    {course.late_tokens_per_student}
                  </Text>{" "}
                  late token{course.late_tokens_per_student !== 1 ? "s" : ""}
                </Text>
                <Button size="sm" onClick={() => setIsEditingTokens(true)}>
                  Edit Late Token Allocation
                </Button>
              </VStack>
            )}
          </Card.Body>
        </Card.Root>

        {/* Coming Soon Features */}
        <Card.Root>
          <Card.Header>
            <Card.Title>Coming Soon</Card.Title>
            <Card.Description>Additional features planned for Due Date Extension Management:</Card.Description>
          </Card.Header>
          <Card.Body>
            <VStack align="start" gap={2}>
              <Text fontSize="sm" color="fg.muted">
                • Bulk due date exception creation across multiple assignments
              </Text>
              <Text fontSize="sm" color="fg.muted">
                • Analytics and reporting on late token usage
              </Text>
              <Text fontSize="sm" color="fg.muted">
                Follow along at <Link href="https://github.com/pawtograder/platform/issues/178">Pawtograder #178</Link>
              </Text>
            </VStack>
          </Card.Body>
        </Card.Root>
      </VStack>
    </Box>
  );
}

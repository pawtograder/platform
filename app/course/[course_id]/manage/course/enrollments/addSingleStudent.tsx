"use client";

import { Icon, Button, Input, Dialog, Field, NativeSelect } from "@chakra-ui/react";
import { FaPlus } from "react-icons/fa";
import { useForm } from "react-hook-form";
import { useParams } from "next/navigation";
import { useInvalidate } from "@refinedev/core";
import { useCallback } from "react";
import { enrollmentAdd } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { toaster } from "@/components/ui/toaster";

type FormData = {
  email: string;
  name: string;
  role: "student" | "grader" | "instructor";
};

export default function AddSingleStudent() {
  const { course_id } = useParams();
  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm<FormData>();
  const invalidate = useInvalidate();
  const onSubmit = useCallback(
    async (data: FormData) => {
      toaster.loading({
        title: "Adding student",
        description: "Please wait while we add the student to the course"
      });
      const supabase = createClient();
      try {
        await enrollmentAdd(
          { courseId: Number(course_id), email: data.email, name: data.name, role: data.role },
          supabase
        );
        toaster.create({
          title: "Student added",
          description: "Refreshing user_roles",
          type: "info"
        });
        invalidate({ resource: "user_roles", invalidates: ["list"] });
      } catch (error) {
        toaster.error({
          title: "Error adding student",
          description: error instanceof Error ? error.message : "An unexpected error occurred."
        });
      }
    },
    [course_id, invalidate]
  );
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button marginLeft="auto">
          <Icon as={FaPlus} />
          Add Course Member
        </Button>
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.CloseTrigger />
          <Dialog.Header>
            <Dialog.Title>Add Course Member</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body mb={2}>
            <form onSubmit={handleSubmit(onSubmit)}>
              <Field.Root invalid={!!errors.email}>
                <Field.Label>Email</Field.Label>
                <Input placeholder="Email" {...register("email", { required: true })} />
                <Field.ErrorText>{errors.email?.message}</Field.ErrorText>
              </Field.Root>
              <Field.Root invalid={!!errors.name}>
                <Field.Label>Name</Field.Label>
                <Input placeholder="Name" {...register("name", { required: true })} />
                <Field.ErrorText>{errors.name?.message}</Field.ErrorText>
              </Field.Root>
              <Field.Root invalid={!!errors.role}>
                <Field.Label>Role</Field.Label>
                <NativeSelect.Root>
                  <NativeSelect.Field {...register("role", { required: true })}>
                    <option value="student">Student</option>
                    <option value="grader">Grader</option>
                    <option value="instructor">Instructor</option>
                  </NativeSelect.Field>
                </NativeSelect.Root>
                <Field.ErrorText>{errors.role?.message}</Field.ErrorText>
              </Field.Root>
              <Button type="submit" mt={2}>
                Add Student
              </Button>
            </form>
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

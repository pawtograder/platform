"use client";

import { Icon, Button, Input, Dialog, Field, NativeSelect, Text } from "@chakra-ui/react";
import { FaPlus } from "react-icons/fa";
import { useForm } from "react-hook-form";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import { enrollmentAdd } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { toaster } from "@/components/ui/toaster";

type FormData = {
  email: string;
  name: string;
  role: "student" | "grader" | "instructor";
};

export default function AddSingleCourseMember() {
  const [open, setOpen] = useState(false);
  const { course_id } = useParams();
  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm<FormData>();
  const onSubmit = useCallback(
    async (data: FormData) => {
      toaster.create({
        title: "Adding course member",
        description: "Please wait while we add the member to the course",
        type: "info"
      });
      const supabase = createClient();
      try {
        await enrollmentAdd(
          { courseId: Number(course_id), email: data.email, name: data.name, role: data.role },
          supabase
        );
        setOpen(false);
        toaster.create({
          title: "Course member added successfully",
          description: "The new member will appear in the enrollments table automatically",
          type: "success"
        });
      } catch (error) {
        toaster.error({
          title: "Error adding course member",
          description: error instanceof Error ? error.message : "An unexpected error occurred."
        });
      }
    },
    [course_id]
  );
  return (
    <Dialog.Root aria-label="Add Course Member Dialog" lazyMount open={open} onOpenChange={(e) => setOpen(e.open)}>
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
            <Text fontSize="sm" color="fg.muted">
              Add a single user to the course by email. Specify an @northeastern.edu email address to allow the user to
              sign in with their Northeastern credentials. Otherwise, the user will be invited to create a new
              Pawtograder account with an email and password.
            </Text>
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
                Add
              </Button>
            </form>
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

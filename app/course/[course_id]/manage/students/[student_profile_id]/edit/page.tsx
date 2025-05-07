"use client";

import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import {
  Heading,
  Input,
  VStack,
  Skeleton,
  Container,
  Fieldset,
  NativeSelectRoot,
  NativeSelectField
} from "@chakra-ui/react";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { useForm } from "react-hook-form";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { toaster, Toaster } from "@/components/ui/toaster";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { useInvalidate } from "@refinedev/core";

type ProfileUpdate = Database["public"]["Tables"]["profiles"]["Update"];

interface StudentProfileFormData {
  name: string | null | undefined;
  avatar_url: string | null | undefined;
  flair: string | null | undefined;
  flair_color: string | null | undefined;
}

export default function EditStudentProfilePage() {
  const params = useParams();
  const router = useRouter();
  const supabase = createClient();
  const invalidate = useInvalidate();

  const studentProfileId = params.student_profile_id as string;
  const courseId = params.course_id as string;

  const profileDataFromHook = useUserProfile(studentProfileId);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<StudentProfileFormData>();

  const allowedFlairColors = [
    "gray",
    "red",
    "orange",
    "yellow",
    "green",
    "teal",
    "blue",
    "cyan",
    "purple",
    "pink"
  ] as const;

  // Fetch existing profile data
  useEffect(() => {
    if (profileDataFromHook) {
      reset({
        name: profileDataFromHook.name,
        avatar_url: profileDataFromHook.avatar_url,
        flair: profileDataFromHook.flair,
        flair_color: profileDataFromHook.flair_color
      });
    }
  }, [profileDataFromHook, reset]);

  const onSubmit = useCallback(
    async (values: StudentProfileFormData) => {
      if (!studentProfileId) {
        toaster.create({
          title: "Submission Error",
          description: "Unable to submit the form. Missing student profile ID.",
          type: "error"
        });
        return;
      }

      const updatePayload: ProfileUpdate = {
        name: values.name,
        avatar_url: values.avatar_url,
        flair: values.flair,
        flair_color: values.flair_color
      };

      try {
        const { error } = await supabase.from("profiles").update(updatePayload).eq("id", studentProfileId);

        if (error) {
          throw error;
        }

        toaster.create({
          title: "Profile Updated",
          description: "The student\'s profile has been successfully updated.",
          type: "success"
        });

        // Invalidate the profiles resource to trigger a refetch
        invalidate({
          resource: "profiles",
          invalidates: ["list", "detail"],
          id: studentProfileId
        });

        router.push(`/course/${courseId}/manage/course/enrollments`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        toaster.create({
          title: "Update Error",
          description: `Failed to update student profile: ${errorMessage}`,
          type: "error"
        });
      }
    },
    [studentProfileId, supabase, router, courseId, invalidate]
  );

  if (!profileDataFromHook) {
    return (
      <Container py={8}>
        <VStack gap={4} align="stretch">
          <Skeleton height="40px" w="50%" mb={4} />
          <Skeleton height="60px" />
          <Skeleton height="60px" />
          <Skeleton height="60px" />
          <Skeleton height="60px" />
          <Skeleton height="40px" w="120px" mt={2} />
        </VStack>
      </Container>
    );
  }

  return (
    <Container py={8}>
      <Toaster />
      <Heading size="lg" mb={6}>
        Edit Profile: {profileDataFromHook.name || "Student"}
      </Heading>
      <form onSubmit={handleSubmit(onSubmit)}>
        <Fieldset.Root maxW="lg">
          <Fieldset.Content>
            <Field label="Name" errorText={errors.name?.message?.toString()} invalid={!!errors.name} required>
              <Input
                id="name"
                placeholder="Student\'s full name"
                {...register("name", { required: "Name is required." })}
              />
            </Field>
          </Fieldset.Content>

          <Fieldset.Content>
            <Field label="Avatar URL" errorText={errors.avatar_url?.message?.toString()} invalid={!!errors.avatar_url}>
              <Input
                id="avatar_url"
                type="url"
                placeholder="http://example.com/avatar.png"
                {...register("avatar_url")}
              />
            </Field>
          </Fieldset.Content>

          <Fieldset.Content>
            <Field label="Flair Text" errorText={errors.flair?.message?.toString()} invalid={!!errors.flair}>
              <Input id="flair" placeholder="e.g., Helpful Mentor, Debug Wizard" {...register("flair")} />
            </Field>
          </Fieldset.Content>

          <Fieldset.Content>
            <Field
              label="Flair Color"
              errorText={errors.flair_color?.message?.toString()}
              invalid={!!errors.flair_color}
            >
              <NativeSelectRoot {...register("flair_color")} id="flair_color">
                <NativeSelectField placeholder="Select a color">
                  {allowedFlairColors.map((color) => (
                    <option key={color} value={color}>
                      {color.charAt(0).toUpperCase() + color.slice(1)}
                    </option>
                  ))}
                </NativeSelectField>
              </NativeSelectRoot>
            </Field>
          </Fieldset.Content>

          <Fieldset.Content>
            <Button mt={4} colorScheme="blue" loading={isSubmitting} type="submit">
              Update Profile
            </Button>
            <Button mt={2} variant="outline" onClick={() => router.back()} disabled={isSubmitting}>
              Cancel
            </Button>
          </Fieldset.Content>
        </Fieldset.Root>
      </form>
    </Container>
  );
}

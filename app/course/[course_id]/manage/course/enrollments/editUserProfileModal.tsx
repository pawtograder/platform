"use client";

import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import {
  Heading,
  Input,
  VStack,
  Skeleton,
  NativeSelectRoot,
  NativeSelectField,
  HStack,
  Text,
  Box,
  Avatar,
  Badge
} from "@chakra-ui/react";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { useForm } from "react-hook-form";
import { useCallback, useEffect } from "react";
import { toaster } from "@/components/ui/toaster";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { useInvalidate } from "@refinedev/core";

type ProfileUpdate = Database["public"]["Tables"]["profiles"]["Update"];

interface UserProfileFormData {
  name: string | null | undefined;
  avatar_url: string | null | undefined;
  flair: string | null | undefined;
  flair_color: string | null | undefined;
}

interface EditUserProfileModalProps {
  userId: string;
  onClose: () => void;
}

export default function EditUserProfileModal({ userId, onClose }: EditUserProfileModalProps) {
  const supabase = createClient();
  const invalidate = useInvalidate();
  const profileDataFromHook = useUserProfile(userId);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<UserProfileFormData>();

  const watchedName = watch("name", profileDataFromHook?.name);
  const watchedAvatarUrl = watch("avatar_url", profileDataFromHook?.avatar_url);
  const watchedFlair = watch("flair", profileDataFromHook?.flair);
  const watchedFlairColor = watch("flair_color", profileDataFromHook?.flair_color);

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
    async (values: UserProfileFormData) => {
      if (!userId) {
        toaster.create({
          title: "Submission Error",
          description: "Missing user profile ID.",
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
        const { error } = await supabase.from("profiles").update(updatePayload).eq("id", userId);

        if (error) {
          throw error;
        }

        toaster.create({
          title: "Profile Updated",
          description: "The user\'s profile has been successfully updated.",
          type: "success"
        });

        invalidate({
          resource: "profiles",
          invalidates: ["list", "detail"],
          id: userId
        });
        invalidate({
          resource: "user_roles",
          invalidates: ["list"]
        });

        onClose();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        toaster.create({
          title: "Update Error",
          description: `Failed to update user profile: ${errorMessage}`,
          type: "error"
        });
      }
    },
    [userId, supabase, invalidate, onClose]
  );

  if (!profileDataFromHook) {
    return (
      <VStack gap={4} align="stretch" py={4}>
        <Skeleton height="30px" w="60%" mb={2} />
        <Skeleton height="50px" />
        <Skeleton height="50px" />
        <Skeleton height="50px" />
        <Skeleton height="50px" />
        <Skeleton height="35px" w="100px" mt={1} />
      </VStack>
    );
  }

  return (
    <>
      <Heading size="md" mb={4} textAlign="start">
        Editing: {profileDataFromHook.name || "User"}
      </Heading>
      <Text fontSize="sm" color="fg.muted" mb={4}>
        Note: This form updates the user&apos;s private profile information (name, avatar, flair). It does not affect
        any anonymous profiles used in discussions or other areas.
      </Text>
      <Box borderWidth="1px" borderRadius="lg" p={4} mb={6} mt={2}>
        <Heading size="sm" mb={3}>
          Live Preview
        </Heading>
        <HStack gap={4} align="center">
          <Avatar.Root size="lg">
            <Avatar.Fallback name={watchedName || "Username"} />
            {watchedAvatarUrl && <Avatar.Image src={watchedAvatarUrl} alt={watchedName || "User Avatar"} />}
          </Avatar.Root>
          <VStack align="start" gap={1}>
            <Text fontWeight="bold" fontSize="xl">
              {watchedName || "Username"}
            </Text>
            {watchedFlair && (
              <Badge colorPalette={watchedFlairColor ?? "gray"} variant="solid">
                {watchedFlair}
              </Badge>
            )}
            {!watchedFlair && (
              <Text fontSize="sm" color="fg.muted">
                No flair text
              </Text>
            )}
          </VStack>
        </HStack>
      </Box>

      <form onSubmit={handleSubmit(onSubmit)}>
        <VStack gap={4} align="stretch">
          <Field label="Name" errorText={errors.name?.message?.toString()} invalid={!!errors.name} required>
            <Input
              id="modal-name"
              placeholder="User\'s full name"
              {...register("name", { required: "Name is required." })}
            />
          </Field>

          <Field label="Avatar URL" errorText={errors.avatar_url?.message?.toString()} invalid={!!errors.avatar_url}>
            <Input
              id="modal-avatar_url"
              type="url"
              placeholder="http://example.com/avatar.png"
              {...register("avatar_url")}
            />
          </Field>

          <Field label="Flair Text" errorText={errors.flair?.message?.toString()} invalid={!!errors.flair}>
            <Input id="modal-flair" placeholder="e.g., Helpful Mentor, Debug Wizard" {...register("flair")} />
          </Field>

          <Field label="Flair Color" errorText={errors.flair_color?.message?.toString()} invalid={!!errors.flair_color}>
            <NativeSelectRoot {...register("flair_color")} id="modal-flair_color">
              <NativeSelectField placeholder="Select a color" name="flair_color">
                {allowedFlairColors.map((color) => (
                  <option key={color} value={color}>
                    {color.charAt(0).toUpperCase() + color.slice(1)}
                  </option>
                ))}
              </NativeSelectField>
            </NativeSelectRoot>
          </Field>

          <HStack gap={3} mt={3} justify="flex-end">
            <Button colorPalette="red" variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button colorPalette="green" loading={isSubmitting} type="submit">
              Update Profile
            </Button>
          </HStack>
        </VStack>
      </form>
    </>
  );
}

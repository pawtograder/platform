"use client";

import type { Database } from "@/utils/supabase/SupabaseTypes";
import { Heading, VStack, NativeSelect, HStack, Text } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useForm } from "react-hook-form";
import { useCallback, useEffect } from "react";
import { toaster } from "@/components/ui/toaster";
import { useUpdate, useInvalidate } from "@refinedev/core";

type UserRole = Database["public"]["Tables"]["user_roles"]["Row"]["role"];

interface UserRoleFormData {
  role: UserRole;
}

interface EditUserRoleModalProps {
  userRoleId: string;
  currentRole: UserRole;
  userName: string | null | undefined;
  onClose: () => void;
}

const availableRoles: UserRole[] = ["student", "grader", "instructor"];

export default function EditUserRoleModal({ userRoleId, currentRole, userName, onClose }: EditUserRoleModalProps) {
  const invalidate = useInvalidate();
  const { mutate, isLoading } = useUpdate();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors }
  } = useForm<UserRoleFormData>({
    defaultValues: {
      role: currentRole
    }
  });

  useEffect(() => {
    reset({ role: currentRole });
  }, [currentRole, reset]);

  const onSubmit = useCallback(
    async (values: UserRoleFormData) => {
      if (!userRoleId) {
        toaster.create({
          title: "Submission Error",
          description: "Missing user role ID.",
          type: "error"
        });
        return;
      }

      mutate(
        {
          resource: "user_roles",
          id: userRoleId,
          values: {
            role: values.role
          }
        },
        {
          onSuccess: () => {
            toaster.create({
              title: "Role Updated",
              description: `${userName || "User"}'s role has been successfully updated to ${values.role}.`,
              type: "success"
            });
            invalidate({
              resource: "user_roles",
              invalidates: ["list"] // To refresh the table
            });
            onClose();
          },
          onError: (error) => {
            toaster.create({
              title: "Update Error",
              description: `Failed to update role: ${error.message}`,
              type: "error"
            });
          }
        }
      );
    },
    [userRoleId, userName, mutate, invalidate, onClose]
  );

  return (
    <>
      <Heading size="md" mb={4} textAlign="start">
        Edit Role for: {userName || "User"}
      </Heading>
      <Text fontSize="sm" color="fg.muted" mb={6}>
        Current role: {currentRole}
      </Text>

      <form onSubmit={handleSubmit(onSubmit)}>
        <VStack gap={4} align="stretch">
          <Field label="New Role" errorText={errors.role?.message?.toString()} invalid={!!errors.role} required>
            <NativeSelect.Root id="role" disabled={currentRole === "instructor"}>
              <NativeSelect.Field
                {...register("role", {
                  required: "Role is required."
                })}
              >
                {availableRoles.map((roleOption) => (
                  <option key={roleOption} value={roleOption}>
                    {roleOption.charAt(0).toUpperCase() + roleOption.slice(1)}
                  </option>
                ))}
              </NativeSelect.Field>
            </NativeSelect.Root>
          </Field>

          <HStack gap={3} mt={3} justify="flex-end">
            <Button variant="outline" onClick={onClose} disabled={isLoading} colorPalette="red">
              Cancel
            </Button>
            <Button colorPalette="green" loading={isLoading} type="submit">
              Update Role
            </Button>
          </HStack>
        </VStack>
      </form>
    </>
  );
}

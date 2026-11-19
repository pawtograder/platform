"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { ROLE_NAME_MAX_LENGTH, roleNameProblem } from "@/lib/classRoles";
import { Dialog, HStack, Input, Portal } from "@chakra-ui/react";
import { useState } from "react";
import type { ClassRole } from "./useClassRolesData";

/**
 * Names a new role, or renames one. `onSave` returns an error sentence to show under the field, or
 * undefined when the name was saved (the dialog then closes).
 */
export function RoleNameDialog({
  mode,
  role,
  existingRoles,
  onSave,
  onClose
}: {
  mode: "create" | "rename";
  role?: ClassRole;
  existingRoles: ClassRole[];
  onSave: (name: string) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const [name, setName] = useState(role?.name ?? "");
  const [problem, setProblem] = useState<string | undefined>();
  const [isSaving, setIsSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = roleNameProblem(name, existingRoles, role?.id);
    if (found) {
      setProblem(found);
      return;
    }
    setIsSaving(true);
    const saveError = await onSave(name.trim());
    setIsSaving(false);
    if (saveError) {
      setProblem(saveError);
      return;
    }
    onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(details) => !details.open && onClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <form onSubmit={submit} noValidate>
              <Dialog.Header>
                <Dialog.Title>{mode === "create" ? "New role" : `Rename ${role?.name}`}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Field
                  label="Role name"
                  required
                  invalid={!!problem}
                  errorText={problem}
                  helperText={
                    mode === "create"
                      ? "For example, Head TA. The role starts with everything a Grader can do, and you choose what to turn on or off."
                      : undefined
                  }
                >
                  <Input
                    value={name}
                    maxLength={ROLE_NAME_MAX_LENGTH}
                    autoComplete="off"
                    onChange={(event) => {
                      setName(event.target.value);
                      setProblem(undefined);
                    }}
                  />
                </Field>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack gap={3} justify="flex-end">
                  <Button variant="outline" onClick={onClose} disabled={isSaving}>
                    Cancel
                  </Button>
                  <Button type="submit" colorPalette="green" loading={isSaving}>
                    {mode === "create" ? "Create role" : "Rename"}
                  </Button>
                </HStack>
              </Dialog.Footer>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** Confirms deleting a custom role. A role people (or removed graders) are on can't be deleted. */
export function DeleteRoleDialog({
  role,
  copy,
  onDelete,
  onClose
}: {
  role: ClassRole;
  copy: { blocked: boolean; description: string };
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const [isDeleting, setIsDeleting] = useState(false);
  const { blocked, description } = copy;

  return (
    <Dialog.Root open onOpenChange={(details) => !details.open && onClose()} role="alertdialog">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Delete {role.name}?</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Dialog.Description>{description}</Dialog.Description>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={3} justify="flex-end">
                <Button variant="outline" onClick={onClose} disabled={isDeleting}>
                  {blocked ? "Close" : "Cancel"}
                </Button>
                {!blocked && (
                  <Button
                    colorPalette="red"
                    loading={isDeleting}
                    onClick={async () => {
                      setIsDeleting(true);
                      await onDelete();
                      setIsDeleting(false);
                      onClose();
                    }}
                  >
                    Delete role
                  </Button>
                )}
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

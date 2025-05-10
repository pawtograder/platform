"use client";

import { Button } from "@/components/ui/button";
import { Dialog, Portal } from "@chakra-ui/react";
import { Text, VStack, HStack } from "@chakra-ui/react";

type RemoveStudentModalProps = {
  isOpen: boolean;
  onClose: () => void;
  studentName?: string | null;
  userRoleId?: string;
  onConfirmRemove: (userRoleId: string) => void;
  isLoading?: boolean;
};

export default function RemoveStudentModal({
  isOpen,
  onClose,
  studentName,
  userRoleId,
  onConfirmRemove,
  isLoading
}: RemoveStudentModalProps) {
  const handleConfirm = () => {
    if (userRoleId) {
      onConfirmRemove(userRoleId);
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(details) => !details.open && onClose()} role="alertdialog">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Remove User from Course?</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack gap={2} align="start">
                <Text>
                  Are you sure you want to remove <strong>{studentName || "this user"}</strong> from the course?
                </Text>
                <Text>
                  This action will remove their enrollment and associated permissions. It cannot be undone directly,
                  though they could be re-added later.
                </Text>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={3} justify="flex-end">
                <Button variant="outline" colorPalette="gray" onClick={onClose} disabled={isLoading}>
                  Cancel
                </Button>
                <Button
                  colorPalette="red"
                  onClick={handleConfirm}
                  loading={isLoading}
                  disabled={!userRoleId || isLoading}
                >
                  Remove User
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

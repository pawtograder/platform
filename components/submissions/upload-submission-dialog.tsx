"use client";

import UploadSubmission from "@/components/submissions/upload-submission";
import { Button, CloseButton, Dialog, Icon, Portal } from "@chakra-ui/react";
import { useState } from "react";
import { FaUpload } from "react-icons/fa";

/**
 * A button that opens a dialog wrapping {@link UploadSubmission} for a known
 * target. Used on the submission detail page so a student can upload a new
 * submission for themselves (omit `target`) or staff can upload on behalf of
 * the submission's owner/group (pass `target`).
 */
export default function UploadSubmissionDialog({
  assignmentId,
  target,
  triggerLabel,
  helperText,
  buttonLabel,
  onUploaded
}: {
  assignmentId: number;
  target?: { profile_id?: string; assignment_group_id?: number };
  triggerLabel: string;
  helperText?: string;
  buttonLabel?: string;
  onUploaded?: (submissionId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={(d) => setOpen(d.open)}>
      <Dialog.Trigger asChild>
        <Button size="sm" variant="outline">
          <Icon as={FaUpload} /> {triggerLabel}
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>{triggerLabel}</Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body>
              <UploadSubmission
                assignmentId={assignmentId}
                target={target}
                helperText={helperText}
                buttonLabel={buttonLabel}
                onUploaded={(id) => {
                  setOpen(false);
                  onUploaded?.(id);
                }}
              />
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

"use client";

import { Button } from "@/components/ui/button";
import { ESCALATION_NOTE_MAX_LENGTH, isValidEscalationNote } from "@/lib/helpRequestEscalation";
import { Dialog, Field, HStack, Icon, Stack, Text, Textarea } from "@chakra-ui/react";
import { useState } from "react";
import { BsArrowUpCircle, BsX } from "react-icons/bs";

export function EscalationNoteField({
  label,
  placeholder,
  note,
  setNote,
  showError
}: {
  label: string;
  placeholder: string;
  note: string;
  setNote: (note: string) => void;
  showError: boolean;
}) {
  return (
    <Field.Root required invalid={showError && !isValidEscalationNote(note)}>
      <Field.Label>
        {label}
        <Field.RequiredIndicator />
      </Field.Label>
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={placeholder}
        rows={4}
        resize="vertical"
        maxLength={ESCALATION_NOTE_MAX_LENGTH}
        autoFocus
      />
      <Field.ErrorText>Add a short note on what is still unresolved.</Field.ErrorText>
      <Field.HelperText>
        {note.length}/{ESCALATION_NOTE_MAX_LENGTH}. Course staff working this queue will see this note.
      </Field.HelperText>
    </Field.Root>
  );
}

/** Opened by the assigned staff member while helping. */
export function StaffEscalateDialog({
  isOpen,
  studentLabel,
  onClose,
  onEscalate
}: {
  isOpen: boolean;
  studentLabel: string;
  onClose: () => void;
  onEscalate: (note: string) => Promise<boolean>;
}) {
  const [note, setNote] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleClose = () => {
    setNote("");
    setAttempted(false);
    onClose();
  };

  const handleSubmit = async () => {
    setAttempted(true);
    if (!isValidEscalationNote(note)) return;
    setSubmitting(true);
    const ok = await onEscalate(note);
    setSubmitting(false);
    if (ok) handleClose();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && handleClose()} size="md">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Escalate {studentLabel}</Dialog.Title>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Close">
                <Icon as={BsX} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Header>
          <Dialog.Body>
            <Stack gap="4">
              <Text fontSize="sm" color="fg.muted">
                The request goes back to the queue ahead of normal requests, and you stop helping. The next staff member
                sees your note and how long the student has already waited.
              </Text>
              <EscalationNoteField
                label="What's still unresolved?"
                placeholder="What you tried, and what's still broken..."
                note={note}
                setNote={setNote}
                showError={attempted}
              />
            </Stack>
          </Dialog.Body>
          <Dialog.Footer>
            <HStack justify="end" gap={3}>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button colorPalette="purple" onClick={handleSubmit} loading={submitting}>
                <Icon as={BsArrowUpCircle} />
                Escalate
              </Button>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

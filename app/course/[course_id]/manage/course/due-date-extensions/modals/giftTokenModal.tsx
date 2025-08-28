"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { useAllStudentProfiles, useCourseController } from "@/hooks/useCourseController";
import { createClient } from "@/utils/supabase/client";
import { Assignment, UserProfile } from "@/utils/supabase/DatabaseTypes";
import { Dialog, HStack, Input, Portal, Textarea, VStack } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { Select } from "chakra-react-select";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

export type GiftTokenDefaults = {
  assignmentId?: number;
  studentId?: string;
};

/**
 * Modal to gift late tokens to a student for a specific assignment.
 * Triggers the RPC that creates a negative tokens_consumed entry in assignment_due_date_exceptions.
 */
export default function GiftTokenModal({
  isOpen,
  onClose,
  defaults
}: {
  isOpen: boolean;
  onClose: () => void;
  defaults?: GiftTokenDefaults;
}) {
  const { course_id } = useParams<{ course_id: string }>();
  const supabase = createClient();

  const students = useAllStudentProfiles();
  const { data: assignmentsData } = useList<Assignment>({
    resource: "assignments",
    filters: [{ field: "class_id", operator: "eq", value: Number(course_id) }],
    pagination: { pageSize: 1000 },
    sorters: [
      { field: "due_date", order: "asc" },
      { field: "id", order: "asc" }
    ]
  });

  const assignmentOptions = useMemo(
    () =>
      (assignmentsData?.data || []).map((a) => ({
        value: a.id,
        label: a.title || `Assignment #${a.id}`
      })),
    [assignmentsData?.data]
  );
  const studentOptions = useMemo(
    () =>
      (students || []).map((s: UserProfile) => ({
        value: s.id,
        label: s.name || s.id
      })),
    [students]
  );

  const [selectedAssignmentId, setSelectedAssignmentId] = useState<number | undefined>(defaults?.assignmentId);
  const [selectedStudentId, setSelectedStudentId] = useState<string | undefined>(defaults?.studentId);
  const [tokensToGift, setTokensToGift] = useState<number>(1);
  const [note, setNote] = useState<string>("Tokens gifted by instructor");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { assignmentDueDateExceptions } = useCourseController();

  useEffect(() => {
    setSelectedAssignmentId(defaults?.assignmentId);
    setSelectedStudentId(defaults?.studentId);
  }, [defaults?.assignmentId, defaults?.studentId]);

  const onCloseInternal = () => {
    setTokensToGift(1);
    setNote("Tokens gifted by instructor");
    onClose();
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAssignmentId || !selectedStudentId) {
      toaster.error({
        title: "Missing data",
        description: !selectedAssignmentId ? "Please select an assignment." : "Please select a student."
      });
      return;
    }
    if (tokensToGift <= 0) {
      toaster.error({ title: "Invalid amount", description: "Tokens to gift must be greater than 0." });
      return;
    }
    setIsSubmitting(true);
    try {
      const { error, data: newExceptionId } = await supabase.rpc("gift_tokens_to_student", {
        p_student_id: selectedStudentId,
        p_class_id: Number(course_id),
        p_assignment_id: selectedAssignmentId,
        p_tokens_to_gift: tokensToGift,
        p_note: note
      });
      if (newExceptionId) {
        await assignmentDueDateExceptions.getByIdAsync(newExceptionId);
      }
      if (error) throw error;
      toaster.create({ title: "Tokens gifted", description: "Late tokens have been granted.", type: "success" });
      onCloseInternal();
    } catch (err) {
      toaster.error({
        title: "Failed to gift tokens",
        description: err instanceof Error ? err.message : "An unknown error occurred."
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(d) => !d.open && onCloseInternal()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={onSubmit}>
            <Dialog.Header>
              <Dialog.Title>Gift Late Tokens</Dialog.Title>
              <Dialog.CloseTrigger onClick={onCloseInternal} />
            </Dialog.Header>
            <Dialog.Body>
              <VStack gap={4} align="stretch">
                <Field label="Assignment" required>
                  <Select
                    options={assignmentOptions}
                    value={assignmentOptions.find((o) => o.value === selectedAssignmentId) || null}
                    onChange={(opt) => setSelectedAssignmentId((opt as { value: number } | null)?.value)}
                    placeholder="Select assignment"
                  />
                </Field>
                <Field label="Student" required>
                  <Select
                    options={studentOptions}
                    value={studentOptions.find((o) => o.value === selectedStudentId) || null}
                    onChange={(opt) => setSelectedStudentId((opt as { value: string } | null)?.value)}
                    placeholder="Select student"
                  />
                </Field>
                <HStack gap={3} alignItems="flex-start">
                  <Field label="Tokens to gift" required>
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      value={tokensToGift}
                      onChange={(e) => setTokensToGift(parseInt(e.target.value || "1", 10))}
                    />
                  </Field>
                </HStack>
                <Field label="Note">
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={3} justifyContent="flex-end">
                <Button variant="outline" colorPalette="red" onClick={onCloseInternal} disabled={isSubmitting}>
                  Cancel
                </Button>
                <Button colorPalette="green" type="submit" loading={isSubmitting}>
                  Gift Tokens
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

"use client";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourse, useCourseController } from "@/hooks/useCourseController";
import { createClient } from "@/utils/supabase/client";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Button, Dialog, Fieldset, Heading, HStack, Input, Text, Textarea } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { differenceInMinutes } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { useCallback, useEffect, useMemo, useState } from "react";

type DueDateExceptionInsert = Database["public"]["Tables"]["assignment_due_date_exceptions"]["Insert"];

/**
 * One student or one group that a bulk action writes a single exception for. Selected rows are
 * collapsed to targets because group exceptions are stored once per group, not once per member.
 */
export type BulkExceptionTarget = {
  key: string;
  student_id: string | null;
  assignment_group_id: number | null;
  currentFinalDueDate: Date | null;
  /** Group members whose lab sections give them different current deadlines. */
  hasMixedMemberDeadlines: boolean;
};

/** Split a signed minute count into hours and minutes that share its sign, so hours*60+minutes round-trips. */
function splitMinutes(totalMinutes: number) {
  const hours = Math.trunc(totalMinutes / 60);
  return { hours, minutes: totalMinutes - hours * 60 };
}

function useInsertExceptions(assignment: Assignment) {
  const supabase = useMemo(() => createClient(), []);
  const { assignmentDueDateExceptions } = useCourseController();
  const { private_profile_id } = useClassProfiles();

  return useCallback(
    async (
      rows: { target: BulkExceptionTarget; totalMinutes: number }[],
      { note, tokensConsumed }: { note: string; tokensConsumed: number }
    ) => {
      const inserts: DueDateExceptionInsert[] = rows.map(({ target, totalMinutes }) => ({
        ...splitMinutes(totalMinutes),
        tokens_consumed: tokensConsumed,
        note: note.trim() || null,
        class_id: assignment.class_id,
        assignment_id: assignment.id,
        student_id: target.assignment_group_id ? null : target.student_id,
        assignment_group_id: target.assignment_group_id,
        creator_id: private_profile_id!
      }));
      // One insert so the batch is all-or-nothing.
      const { data, error } = await supabase.from("assignment_due_date_exceptions").insert(inserts).select("id");
      if (error) throw error;
      // Pull the new rows in now rather than waiting on the realtime broadcast. The rows are
      // already saved, so a failed refresh must not report failure and invite a duplicate retry;
      // the realtime broadcast still delivers them.
      await assignmentDueDateExceptions.refetchByIds(data.map((row) => row.id)).catch(() => {});
      return data.length;
    },
    [supabase, assignmentDueDateExceptions, assignment.class_id, assignment.id, private_profile_id]
  );
}

function targetSummary(targets: BulkExceptionTarget[]) {
  const groups = targets.filter((t) => t.assignment_group_id).length;
  const students = targets.length - groups;
  const parts = [];
  if (students > 0) parts.push(`${students} student${students === 1 ? "" : "s"}`);
  if (groups > 0) parts.push(`${groups} group${groups === 1 ? "" : "s"}`);
  return parts.join(" and ");
}

function TokensAndNotesFields({
  tokensConsumed,
  setTokensConsumed,
  note,
  setNote,
  tokensHelperText
}: {
  tokensConsumed: number;
  setTokensConsumed: (tokens: number) => void;
  note: string;
  setNote: (note: string) => void;
  tokensHelperText: string;
}) {
  const tokensInvalid = !Number.isInteger(tokensConsumed) || tokensConsumed < 0;
  return (
    <>
      <Field
        orientation="horizontal"
        label="Tokens to Consume"
        errorText={tokensInvalid ? "Tokens consumed is required" : undefined}
        invalid={tokensInvalid}
        helperText={tokensHelperText}
      >
        <Input
          size="sm"
          w="120px"
          type="number"
          min={0}
          value={Number.isFinite(tokensConsumed) ? tokensConsumed : ""}
          onChange={(e) => setTokensConsumed(e.target.valueAsNumber)}
        />
      </Field>
      <Field orientation="horizontal" label="Notes" helperText="Visible to the students and the staff.">
        <Textarea size="sm" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </>
  );
}

const isValidTokenCount = (tokens: number) => Number.isInteger(tokens) && tokens >= 0;

export function BulkAddExtensionDialog({
  open,
  setOpen,
  targets,
  assignment,
  onApplied
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  targets: BulkExceptionTarget[];
  assignment: Assignment;
  onApplied: () => void;
}) {
  const insertExceptions = useInsertExceptions(assignment);
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [tokensConsumed, setTokensConsumed] = useState(0);
  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setHours(0);
      setMinutes(0);
      setTokensConsumed(0);
      setNote("");
    }
  }, [open]);

  const safeHours = Number.isFinite(hours) ? hours : 0;
  const safeMinutes = Number.isFinite(minutes) ? minutes : 0;
  const sumIsInvalid = safeHours * 60 + safeMinutes <= 0;
  const hoursInvalid = sumIsInvalid || safeHours < 0;
  const minutesInvalid = sumIsInvalid || safeMinutes < 0 || safeMinutes > 59;
  const isInvalid = hoursInvalid || minutesInvalid || !isValidTokenCount(tokensConsumed);
  const hasGroups = targets.some((t) => t.assignment_group_id);
  const hasLabScheduling = assignment.minutes_due_after_lab !== null;

  const onSubmit = async () => {
    setIsSubmitting(true);
    try {
      const count = await insertExceptions(
        targets.map((target) => ({ target, totalMinutes: safeHours * 60 + safeMinutes })),
        { note, tokensConsumed }
      );
      toaster.create({
        title: "Due date exceptions added",
        description: `The due date exception has been added for ${count} ${count === 1 ? "student or group" : "students and groups"}.`,
        type: "success"
      });
      onApplied();
      setOpen(false);
    } catch (error) {
      toaster.error({
        title: "Error adding due date exceptions",
        description:
          error instanceof Error
            ? `${error.message} No exceptions were added.`
            : "An error occurred while adding the due date exceptions. No exceptions were added."
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog.Root size="xl" open={open} onOpenChange={(details) => setOpen(details.open)} lazyMount>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content p={4}>
          <Dialog.Header>
            <Dialog.Title>
              Add an Extension for {targetSummary(targets)} on {assignment.title}
            </Dialog.Title>
            <Dialog.CloseTrigger />
          </Dialog.Header>
          <Dialog.Description>
            Enter hours and minutes to add the same extension for every selected{" "}
            {hasGroups ? "student or group" : "student"}. The extension is added on top of each current due date,
            including any extensions already granted, and on top of the {hasLabScheduling ? "lab-based" : "original"}{" "}
            due date.
            {hasGroups && " An extension for a group member applies to their whole group."}
          </Dialog.Description>
          <Dialog.Body>
            <Heading size="md">Add an Exception</Heading>
            <Fieldset.Root bg="surface" size="sm">
              <Fieldset.Content maxW="md" gap={2}>
                <HStack align="start" gap={4}>
                  <Field
                    orientation="horizontal"
                    label="Hours Extended"
                    errorText={hoursInvalid ? "Enter hours or minutes greater than 0" : undefined}
                    invalid={hoursInvalid}
                  >
                    <Input
                      size="sm"
                      w="110px"
                      type="number"
                      min={0}
                      value={Number.isFinite(hours) ? hours : ""}
                      onChange={(e) => setHours(e.target.valueAsNumber)}
                    />
                  </Field>
                  <Field
                    orientation="horizontal"
                    label="Minutes Extended"
                    errorText={minutesInvalid ? "Enter hours or minutes greater than 0" : undefined}
                    invalid={minutesInvalid}
                    helperText="Additional time to extend the due date."
                  >
                    <Input
                      size="sm"
                      w="110px"
                      type="number"
                      min={0}
                      max={59}
                      value={Number.isFinite(minutes) ? minutes : ""}
                      onChange={(e) => setMinutes(e.target.valueAsNumber)}
                    />
                  </Field>
                </HStack>
                <TokensAndNotesFields
                  tokensConsumed={tokensConsumed}
                  setTokensConsumed={setTokensConsumed}
                  note={note}
                  setNote={setNote}
                  tokensHelperText="Deducted from each selected student's token balance. For a group, from each member's."
                />
                <Box
                  mb={2}
                  w="100%"
                  p={2}
                  bg={sumIsInvalid ? "bg.error" : "bg.info"}
                  borderWidth="1px"
                  borderColor={sumIsInvalid ? "border.error" : "border.info"}
                  borderRadius="md"
                >
                  {sumIsInvalid ? (
                    <Text fontSize="sm" color="fg.error">
                      Enter hours or minutes greater than 0
                    </Text>
                  ) : (
                    <Text fontSize="sm" color="fg.info">
                      <strong>New Due Date:</strong> each current due date moves {safeHours}h {safeMinutes}m later.
                    </Text>
                  )}
                </Box>
              </Fieldset.Content>
            </Fieldset.Root>
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button colorPalette="green" loading={isSubmitting} disabled={isInvalid} onClick={onSubmit}>
              Add Due Date Exceptions
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

export function BulkSetDeadlineDialog({
  open,
  setOpen,
  targets,
  assignment,
  onApplied
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  targets: BulkExceptionTarget[];
  assignment: Assignment;
  onApplied: () => void;
}) {
  const insertExceptions = useInsertExceptions(assignment);
  const { time_zone } = useCourse();
  const [deadline, setDeadline] = useState("");
  const [tokensConsumed, setTokensConsumed] = useState(0);
  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setDeadline("");
      setTokensConsumed(0);
      setNote("");
    }
  }, [open]);

  // datetime-local has no zone; read it as course time so staff in other zones set the same deadline.
  const targetDate = useMemo(() => {
    const [datePart, timePart] = deadline.split("T");
    if (!datePart || !timePart) return null;
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute] = timePart.split(":").map(Number);
    return new TZDate(year, month - 1, day, hour, minute, time_zone);
  }, [deadline, time_zone]);

  // Same rule as the single-student Target Due Date, applied to every selected student: the
  // target must be after each current due date, so it must be after the latest of them.
  const latestCurrentDueDate = useMemo(() => {
    const times = targets.filter((t) => t.currentFinalDueDate).map((t) => t.currentFinalDueDate!.getTime());
    return times.length > 0 ? new Date(Math.max(...times)) : null;
  }, [targets]);
  const minDateTimeLocal = latestCurrentDueDate
    ? formatInTimeZone(latestCurrentDueDate, time_zone, "yyyy-MM-dd'T'HH:mm")
    : undefined;

  const plan = useMemo(() => {
    if (!targetDate) return [];
    return targets
      .filter((t) => t.currentFinalDueDate)
      .map((target) => ({
        target,
        totalMinutes: differenceInMinutes(targetDate, target.currentFinalDueDate!)
      }));
  }, [targets, targetDate]);

  // A group gets one exception, so members with different current due dates cannot all land on
  // the target. Block rather than save a due date that is wrong for some of them.
  const mixedGroups = targets.filter((t) => t.hasMixedMemberDeadlines).length;
  const targetDateError =
    mixedGroups > 0
      ? `Cannot set one due date for ${mixedGroups} group${mixedGroups === 1 ? " whose" : "s whose"} members have different current due dates`
      : !targetDate
        ? "Select a target due date"
        : latestCurrentDueDate && targetDate <= latestCurrentDueDate
          ? "Target date must be after current due date"
          : plan.some((p) => p.totalMinutes <= 0)
            ? "Enter hours or minutes greater than 0"
            : "";
  const hasGroups = targets.some((t) => t.assignment_group_id);
  const hasLabScheduling = assignment.minutes_due_after_lab !== null;

  const onSubmit = async () => {
    if (targetDateError) {
      toaster.error({
        title: "Invalid target date",
        description: targetDateError,
        type: "error"
      });
      return;
    }
    setIsSubmitting(true);
    try {
      const count = await insertExceptions(plan, { note, tokensConsumed });
      toaster.create({
        title: "Due date exceptions added",
        description: `The due date exception has been added for ${count} ${count === 1 ? "student or group" : "students and groups"}.`,
        type: "success"
      });
      onApplied();
      setOpen(false);
    } catch (error) {
      toaster.error({
        title: "Error adding due date exceptions",
        description:
          error instanceof Error
            ? `${error.message} No exceptions were added.`
            : "An error occurred while adding the due date exceptions. No exceptions were added."
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog.Root size="xl" open={open} onOpenChange={(details) => setOpen(details.open)} lazyMount>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content p={4}>
          <Dialog.Header>
            <Dialog.Title>
              Set Due Date for {targetSummary(targets)} on {assignment.title}
            </Dialog.Title>
            <Dialog.CloseTrigger />
          </Dialog.Header>
          <Dialog.Description>
            Select a target date to give every selected {hasGroups ? "student or group" : "student"} the same final due
            date. For each one, an exception is added for the difference between their current due date and the target
            date, applied on top of the {hasLabScheduling ? "lab-based" : "original"} due date and any existing
            extensions. The target date must be after every selected current due date.
            {hasGroups && " The due date for a group member applies to their whole group."}
          </Dialog.Description>
          <Dialog.Body>
            <Heading size="md">Add an Exception</Heading>
            <Fieldset.Root bg="surface" size="sm">
              <Fieldset.Content maxW="md" gap={2}>
                <Field
                  orientation="horizontal"
                  label="Target Due Date"
                  errorText={targetDateError && targetDate ? targetDateError : undefined}
                  invalid={!!targetDateError && !!targetDate}
                  helperText={`Select a specific date and time for the new due date, in the course time zone (${time_zone}). Hours and minutes will be calculated automatically for each ${hasGroups ? "student or group" : "student"}.`}
                >
                  <Input
                    size="sm"
                    type="datetime-local"
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                    min={minDateTimeLocal}
                  />
                </Field>
                {latestCurrentDueDate && (
                  <Text fontSize="sm" color="fg.muted">
                    Latest current due date among the selection:{" "}
                    <TimeZoneAwareDate date={latestCurrentDueDate} format="MMM d, h:mm a" />
                  </Text>
                )}
                <TokensAndNotesFields
                  tokensConsumed={tokensConsumed}
                  setTokensConsumed={setTokensConsumed}
                  note={note}
                  setNote={setNote}
                  tokensHelperText="Deducted from each selected student's token balance. For a group, from each member's."
                />
                <Box
                  mb={2}
                  w="100%"
                  p={2}
                  bg={targetDateError ? "bg.error" : "bg.info"}
                  borderWidth="1px"
                  borderColor={targetDateError ? "border.error" : "border.info"}
                  borderRadius="md"
                >
                  {targetDateError ? (
                    <Text fontSize="sm" color="fg.error">
                      {targetDateError}
                    </Text>
                  ) : (
                    <Text fontSize="sm" color="fg.info">
                      <strong>New Due Date:</strong> <TimeZoneAwareDate date={targetDate!} format="MMM d, h:mm a" />
                    </Text>
                  )}
                  {mixedGroups > 0 && (
                    <Text fontSize="sm" color="fg.error">
                      A group gets one exception, so its members cannot all reach the target due date. Deselect{" "}
                      {mixedGroups === 1 ? "that group" : "those groups"} and adjust {mixedGroups === 1 ? "it" : "them"}{" "}
                      with Adjust Due Date, or use Add Extension to add the same time to everyone.
                    </Text>
                  )}
                </Box>
              </Fieldset.Content>
            </Fieldset.Root>
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              colorPalette="green"
              loading={isSubmitting}
              disabled={!!targetDateError || !isValidTokenCount(tokensConsumed)}
              onClick={onSubmit}
            >
              Set Due Date
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

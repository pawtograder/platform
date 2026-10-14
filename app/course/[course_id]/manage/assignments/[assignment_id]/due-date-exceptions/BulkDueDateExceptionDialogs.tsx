"use client";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogCloseTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import PersonName from "@/components/ui/person-name";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useAssignmentGroupWithMembers, useCourse, useCourseController } from "@/hooks/useCourseController";
import { useListTableControllerValues } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { Assignment, AssignmentDueDateException } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Button, Dialog, Fieldset, Heading, HStack, Input, Text, Textarea } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
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
  /** Every student whose due date this target's exception moves: the group's members, or the student. */
  member_student_ids: string[];
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

/**
 * Whole minutes from `from` to `target`, rounding a partial minute up. Current due dates can carry
 * seconds (a lab end_time defaults to 23:59:59), and truncating would land the new due date just
 * before the target.
 */
export function minutesUntil(target: Date, from: Date) {
  return Math.ceil((target.getTime() - from.getTime()) / 60_000);
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

/** Title the dialog with the targets it will write for, or the whole selection if that is none. */
function titleSummary(written: BulkExceptionTarget[], targets: BulkExceptionTarget[]) {
  return targetSummary(written.length > 0 ? written : targets);
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

/** List at most this many finalized targets by name; past it, the warning gives only the count. */
const MAX_NAMED_FINALIZED = 5;

/**
 * Split targets into those a bulk action writes for and those skipped because they finalized
 * early. `finalize_submission_early` records finalization as a negative exception on the student,
 * or on the group for a group member, and the autograder only honors it once the due date has
 * passed. An extension moves the due date back out, so it would silently reopen submissions.
 * A group target also counts as finalized when any member holds their own negative exception
 * (for example, one recorded before they joined the group): calculate_final_due_date adds the
 * group's exceptions to the member's own, so a group extension would move that member's due date.
 */
function useFinalizedTargets(targets: BulkExceptionTarget[], assignmentId: number, includeFinalized: boolean) {
  const { assignmentDueDateExceptions } = useCourseController();
  const predicate = useCallback(
    (exception: AssignmentDueDateException) =>
      exception.assignment_id === assignmentId && (exception.hours < 0 || exception.minutes < 0),
    [assignmentId]
  );
  const negativeExceptions = useListTableControllerValues(assignmentDueDateExceptions, predicate);
  return useMemo(() => {
    const students = new Set<string>();
    const groups = new Set<number>();
    for (const exception of negativeExceptions) {
      if (exception.assignment_group_id) groups.add(exception.assignment_group_id);
      else if (exception.student_id) students.add(exception.student_id);
    }
    const isFinalized = (t: BulkExceptionTarget) =>
      (!!t.assignment_group_id && groups.has(t.assignment_group_id)) ||
      t.member_student_ids.some((id) => students.has(id));
    const finalized = targets.filter(isFinalized);
    const eligible = includeFinalized ? targets : targets.filter((t) => !isFinalized(t));
    return { finalized, eligible };
  }, [negativeExceptions, targets, includeFinalized]);
}

function TargetName({ target }: { target: BulkExceptionTarget }) {
  const group = useAssignmentGroupWithMembers({ assignment_group_id: target.assignment_group_id });
  if (target.assignment_group_id) return <>{group?.name ?? "Unknown group"}</>;
  return target.student_id ? <PersonName uid={target.student_id} showAvatar={false} /> : null;
}

function FinalizedTargetsNotice({
  finalized,
  includeFinalized,
  setIncludeFinalized,
  includeLabel
}: {
  finalized: BulkExceptionTarget[];
  /** Completes "Also … that finalized early", e.g. "extend" or "set the due date for". */
  includeLabel: string;
  includeFinalized: boolean;
  setIncludeFinalized: (include: boolean) => void;
}) {
  if (finalized.length === 0) return null;
  const summary = targetSummary(finalized);
  const verb = finalized.length === 1 ? "has" : "have";
  return (
    <Box
      w="100%"
      p={2}
      bg="bg.warning"
      borderWidth="1px"
      borderColor="border.warning"
      borderRadius="md"
      data-testid="bulk-finalized-warning"
    >
      <Text fontSize="sm" color="fg.warning">
        {summary} {verb} finalized early and {includeFinalized ? "will be included" : "will be skipped"}
        {finalized.length <= MAX_NAMED_FINALIZED ? (
          <>
            {": "}
            {finalized.map((target, index) => (
              <span key={target.key}>
                {index > 0 && ", "}
                <TargetName target={target} />
              </span>
            ))}
            .
          </>
        ) : (
          "."
        )}
      </Text>
      <Checkbox
        mt={2}
        size="sm"
        checked={includeFinalized}
        onCheckedChange={(details) => setIncludeFinalized(details.checked === true)}
      >
        Also {includeLabel} {summary} that finalized early (this reopens submissions for them)
      </Checkbox>
    </Box>
  );
}

const ALL_FINALIZED_MESSAGE =
  "Every selected student or group finalized early. Check the box above to include them anyway, or change the selection.";

/** Toast text for a completed bulk insert, noting any finalized targets left out. */
function appliedDescription(count: number, skippedFinalized: number) {
  const added = `The due date exception has been added for ${count} ${count === 1 ? "student or group" : "students and groups"}.`;
  return skippedFinalized > 0 ? `${added} Skipped ${skippedFinalized} that finalized early.` : added;
}

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
  const [includeFinalized, setIncludeFinalized] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setHours(0);
      setMinutes(0);
      setTokensConsumed(0);
      setNote("");
      setIncludeFinalized(false);
    }
  }, [open]);

  const { finalized, eligible } = useFinalizedTargets(targets, assignment.id, includeFinalized);
  const skippedFinalized = targets.length - eligible.length;

  const safeHours = Number.isFinite(hours) ? hours : 0;
  const safeMinutes = Number.isFinite(minutes) ? minutes : 0;
  // The columns are integers, so a fractional value would fail the whole batch on insert.
  const hoursError = !Number.isInteger(safeHours) || safeHours < 0 ? "Enter a whole number of hours" : undefined;
  const minutesError =
    !Number.isInteger(safeMinutes) || safeMinutes < 0 || safeMinutes > 59
      ? "Enter a whole number of minutes from 0 to 59"
      : undefined;
  const sumIsInvalid = !hoursError && !minutesError && safeHours * 60 + safeMinutes <= 0;
  const extensionError =
    eligible.length === 0 && finalized.length > 0
      ? ALL_FINALIZED_MESSAGE
      : (hoursError ?? minutesError ?? (sumIsInvalid ? "Enter hours or minutes greater than 0" : ""));
  const isInvalid = !!extensionError || eligible.length === 0 || !isValidTokenCount(tokensConsumed);
  const hasGroups = targets.some((t) => t.assignment_group_id);
  const hasLabScheduling = assignment.minutes_due_after_lab !== null;

  const onSubmit = async () => {
    setIsSubmitting(true);
    try {
      const count = await insertExceptions(
        eligible.map((target) => ({ target, totalMinutes: safeHours * 60 + safeMinutes })),
        { note, tokensConsumed }
      );
      toaster.create({
        title: "Due date exceptions added",
        description: appliedDescription(count, skippedFinalized),
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
              Add an Extension for {titleSummary(eligible, targets)} on {assignment.title}
            </Dialog.Title>
            <DialogCloseTrigger />
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
                    errorText={hoursError ?? (sumIsInvalid ? "Enter hours or minutes greater than 0" : undefined)}
                    invalid={!!hoursError || sumIsInvalid}
                  >
                    <Input
                      size="sm"
                      w="110px"
                      type="number"
                      min={0}
                      step={1}
                      value={Number.isFinite(hours) ? hours : ""}
                      onChange={(e) => setHours(e.target.valueAsNumber)}
                    />
                  </Field>
                  <Field
                    orientation="horizontal"
                    label="Minutes Extended"
                    errorText={minutesError ?? (sumIsInvalid ? "Enter hours or minutes greater than 0" : undefined)}
                    invalid={!!minutesError || sumIsInvalid}
                    helperText="Additional time to extend the due date."
                  >
                    <Input
                      size="sm"
                      w="110px"
                      type="number"
                      min={0}
                      max={59}
                      step={1}
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
                <FinalizedTargetsNotice
                  finalized={finalized}
                  includeFinalized={includeFinalized}
                  setIncludeFinalized={setIncludeFinalized}
                  includeLabel="extend"
                />
                <Box
                  mb={2}
                  w="100%"
                  p={2}
                  bg={extensionError ? "bg.error" : "bg.info"}
                  borderWidth="1px"
                  borderColor={extensionError ? "border.error" : "border.info"}
                  borderRadius="md"
                >
                  {extensionError ? (
                    <Text fontSize="sm" color="fg.error">
                      {extensionError}
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
  const [includeFinalized, setIncludeFinalized] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setDeadline("");
      setTokensConsumed(0);
      setNote("");
      setIncludeFinalized(false);
    }
  }, [open]);

  const { finalized, eligible } = useFinalizedTargets(targets, assignment.id, includeFinalized);
  // Without a current due date there is nothing to measure the difference from.
  const datedTargets = useMemo(() => eligible.filter((t) => t.currentFinalDueDate), [eligible]);
  const undatedCount = eligible.length - datedTargets.length;

  // datetime-local has no zone; read it as course time so staff in other zones set the same deadline.
  const targetDate = useMemo(() => {
    const [datePart, timePart] = deadline.split("T");
    if (!datePart || !timePart) return null;
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute] = timePart.split(":").map(Number);
    return new TZDate(year, month - 1, day, hour, minute, time_zone);
  }, [deadline, time_zone]);

  // Same rule as the single-student Target Due Date, applied to every selected student: the
  // target must be after each current due date, so it must be after the latest of them. Skipped
  // finalized targets do not count.
  const latestCurrentDueDate = useMemo(() => {
    const times = datedTargets.map((t) => t.currentFinalDueDate!.getTime());
    return times.length > 0 ? new Date(Math.max(...times)) : null;
  }, [datedTargets]);
  const minDateTimeLocal = latestCurrentDueDate
    ? formatInTimeZone(latestCurrentDueDate, time_zone, "yyyy-MM-dd'T'HH:mm")
    : undefined;

  const plan = useMemo(() => {
    if (!targetDate) return [];
    return datedTargets.map((target) => ({
      target,
      totalMinutes: minutesUntil(targetDate, target.currentFinalDueDate!)
    }));
  }, [datedTargets, targetDate]);

  // A group gets one exception, so members with different current due dates cannot all land on
  // the target. Block rather than save a due date that is wrong for some of them.
  const mixedGroups = datedTargets.filter((t) => t.hasMixedMemberDeadlines).length;
  const targetDateError =
    eligible.length === 0 && finalized.length > 0
      ? ALL_FINALIZED_MESSAGE
      : eligible.length > 0 && datedTargets.length === 0
        ? "None of the selected students or groups has a current due date to change"
        : mixedGroups > 0
          ? `Cannot set one due date for ${mixedGroups} group${mixedGroups === 1 ? " whose" : "s whose"} members have different current due dates`
          : !targetDate
            ? "Select a target due date"
            : latestCurrentDueDate && targetDate <= latestCurrentDueDate
              ? "Target date must be later than the latest current due date"
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
      const skippedFinalized = targets.length - eligible.length;
      toaster.create({
        title: "Due date exceptions added",
        description:
          appliedDescription(count, skippedFinalized) +
          (undatedCount > 0 ? ` Skipped ${undatedCount} with no current due date.` : ""),
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
              Set Due Date for {titleSummary(datedTargets, targets)} on {assignment.title}
            </Dialog.Title>
            <DialogCloseTrigger />
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
                <FinalizedTargetsNotice
                  finalized={finalized}
                  includeFinalized={includeFinalized}
                  setIncludeFinalized={setIncludeFinalized}
                  includeLabel="set the due date for"
                />
                {undatedCount > 0 && datedTargets.length > 0 && (
                  <Text fontSize="sm" color="fg.warning" data-testid="bulk-undated-warning">
                    {undatedCount} selected {undatedCount === 1 ? "has" : "have"} no due date and will be skipped.
                  </Text>
                )}
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
              disabled={!!targetDateError || plan.length === 0 || !isValidTokenCount(tokensConsumed)}
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

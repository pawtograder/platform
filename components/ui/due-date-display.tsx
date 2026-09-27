"use client";

import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Tooltip } from "@/components/ui/tooltip";
import { Flex, Icon, IconButton, Text } from "@chakra-ui/react";
import type { ComponentProps, ReactNode } from "react";
import { LuInfo } from "react-icons/lu";

type DateFormat = NonNullable<ComponentProps<typeof TimeZoneAwareDate>["format"]>;

// Deliberately framed as a course expectation, not a system rule. Submission enforcement
// (`autograder-create-submission` -> `calculate_final_due_date`) only ever consults the hard
// `due_date`. Nothing in the platform rejects or down-ranks a submission for arriving after the
// suggested date, so promising that late work loses the right to resubmit would be false. The
// second sentence stops short of "after that your work is final" for the same reason in the other
// direction: a late token adds an exception on top of the hard date and reopens submissions.
export const RESUBMISSION_WINDOW_TOOLTIP =
  "Your course asks you to submit by the due date above so your work can be graded and returned with time to resubmit. You can keep submitting and resubmitting until this later date.";

/**
 * Shared student-facing rendering of an assignment's deadline.
 *
 * The advisory suggested due date is shown only when `showSuggested` is set, which callers drive
 * from the `suggested-due-date` course feature flag. A course that has not opted in never sees the
 * date at all, on any surface — a half-emphasized "suggested" line was the confusing middle ground
 * this flag exists to remove.
 *
 * When it is shown, the suggested date IS the due date: primary, larger and semibold, with the hard
 * deadline demoted beneath it as the close of the resubmission window. That is the mastery-grading
 * reading, where submitting by the suggested date is what earns a student feedback in time to
 * resubmit.
 *
 * `showSuggested` defaults to `false` so a caller that forgets to pass it fails safe (hidden)
 * rather than leaking the date into a course that never enabled the feature.
 */
export function DueDateDisplay({
  suggestedDueDate,
  suggestedDueDateNode,
  dueDate,
  dueDateNode,
  showDueLabel = false,
  dateFormat = "MMM d, h:mm a",
  showSuggested = false,
  trailing
}: {
  /** Raw advisory suggested due date (display-only). Rendered only when `showSuggested` is true. */
  suggestedDueDate?: string | null;
  /** Pre-built node for the suggested date, mirroring `dueDateNode`. Overrides how it renders. */
  suggestedDueDateNode?: ReactNode;
  /**
   * The effective hard deadline. `dueDateNode` overrides how it is *rendered*, but pass this
   * alongside it anyway: it is what tells the component whether the suggested date really is the
   * earlier of the two.
   */
  dueDate?: Date | string | null;
  /** Pre-built node for the hard due date (e.g. a TimeZoneAwareDate with visual-test attrs). Overrides `dueDate`. */
  dueDateNode?: ReactNode;
  /** Prefix the primary date with "Due: ". */
  showDueLabel?: boolean;
  dateFormat?: DateFormat;
  /** Course opted in to suggested due dates. Without it the suggested date is not rendered at all. */
  showSuggested?: boolean;
  /** Inline content rendered after the hard due date (e.g. extension note, late-token button). */
  trailing?: ReactNode;
}) {
  const dueContent =
    dueDateNode ??
    (dueDate ? (
      <Text minWidth={0}>
        <TimeZoneAwareDate date={dueDate} format={dateFormat} />
      </Text>
    ) : (
      <Text minWidth={0}>-</Text>
    ));

  // The emphasized layout only makes sense while the suggested date really precedes the deadline
  // shown beneath it, and the DB constraint does not guarantee that: it compares the suggested date
  // against the raw `assignments.due_date`, whereas the date rendered here is the student's
  // effective deadline, which lab scheduling and negative extensions (finalizing early) can pull
  // earlier. Rather than render "Due: Mar 18" above "Resubmit until Mar 15", fall back to the plain
  // layout for the inverted case.
  const hardDeadlineMs = dueDate ? new Date(dueDate).getTime() : NaN;
  const suggestedMs = suggestedDueDate ? new Date(suggestedDueDate).getTime() : NaN;
  const suggestedIsAfterDeadline =
    Number.isFinite(hardDeadlineMs) && Number.isFinite(suggestedMs) && suggestedMs > hardDeadlineMs;

  // Suggested date on top as the due date, hard deadline demoted below it. The wording carries the
  // distinction on its own, so the meaning survives without the size/weight cues (screen readers,
  // forced-colors, zoomed reflow).
  if (showSuggested && suggestedDueDate && !suggestedIsAfterDeadline) {
    return (
      <Flex direction="column" gap={0.5} maxWidth="100%" minWidth={0}>
        <Flex alignItems="center" gap={1} minWidth={0} wrap="wrap" fontSize="lg" fontWeight="semibold">
          {showDueLabel && <Text flexShrink={0}>Due:</Text>}
          <Text minWidth={0}>
            {suggestedDueDateNode ?? <TimeZoneAwareDate date={suggestedDueDate} format={dateFormat} />}
          </Text>
        </Flex>
        <Flex alignItems="center" gap={1} wrap="wrap" minWidth={0} color="fg.muted" fontSize="sm">
          <Text flexShrink={0}>Resubmit until</Text>
          {dueContent}
          <Tooltip content={RESUBMISSION_WINDOW_TOOLTIP} showArrow positioning={{ placement: "top" }}>
            <IconButton
              aria-label="When do resubmissions close?"
              variant="ghost"
              size="2xs"
              color="fg.muted"
              flexShrink={0}
            >
              <Icon as={LuInfo} boxSize={3.5} />
            </IconButton>
          </Tooltip>
          {trailing}
        </Flex>
      </Flex>
    );
  }

  return (
    <Flex alignItems="center" gap={1} wrap="wrap" minWidth={0} maxWidth="100%">
      {showDueLabel && <Text flexShrink={0}>Due: </Text>}
      {dueContent}
      {trailing}
    </Flex>
  );
}

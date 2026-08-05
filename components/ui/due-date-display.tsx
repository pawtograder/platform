"use client";

import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Tooltip } from "@/components/ui/tooltip";
import { Flex, Icon, IconButton, Text } from "@chakra-ui/react";
import type { ComponentProps, ReactNode } from "react";
import { LuInfo } from "react-icons/lu";

type DateFormat = NonNullable<ComponentProps<typeof TimeZoneAwareDate>["format"]>;

export const SUGGESTED_DUE_DATE_TOOLTIP =
  "The suggested due date is a recommended target to aim for. The due date below is the hard deadline — you can keep submitting and resubmitting until then.";

// Deliberately framed as a course expectation, not a system rule. Submission enforcement
// (`autograder-create-submission` -> `calculate_final_due_date`) only ever consults the hard
// `due_date`; nothing in the platform rejects or down-ranks a submission for arriving after the
// suggested date. Promising that late work loses the right to resubmit would be false.
export const RESUBMISSION_WINDOW_TOOLTIP =
  "Your course asks you to submit by the due date above so your work can be graded and returned with time to resubmit. Submissions stay open until this later date; after it passes you can no longer change your work.";

/**
 * Shared student-facing rendering of an assignment's deadline.
 *
 * Two layouts, chosen by `emphasizeSuggested` (driven by the `suggested-due-date` course
 * feature flag at the call sites):
 *
 * - Default: the hard `due_date` is primary, with the advisory suggested date above it in
 *   smaller muted text.
 * - Emphasized: the suggested date IS the due date — primary, larger and semibold — and the
 *   hard deadline drops below it as the close of the resubmission window. This is the
 *   mastery-grading reading, where submitting by the suggested date is what earns a student
 *   feedback and the right to resubmit.
 *
 * When there is no suggested date, both layouts collapse to just the hard due date, so
 * enabling the flag changes nothing for assignments that do not set one.
 */
export function DueDateDisplay({
  suggestedDueDate,
  dueDate,
  dueDateNode,
  showDueLabel = false,
  dateFormat = "MMM d, h:mm a",
  emphasizeSuggested = false,
  trailing
}: {
  /** Raw advisory suggested due date (display-only). When falsy, the suggested line is omitted. */
  suggestedDueDate?: string | null;
  /** The effective hard deadline. Ignored when `dueDateNode` is provided. */
  dueDate?: Date | string | null;
  /** Pre-built node for the hard due date (e.g. a TimeZoneAwareDate with visual-test attrs). Overrides `dueDate`. */
  dueDateNode?: ReactNode;
  /** Prefix the primary date with "Due: ". */
  showDueLabel?: boolean;
  dateFormat?: DateFormat;
  /** Promote the suggested date to primary and demote the hard deadline. No effect without `suggestedDueDate`. */
  emphasizeSuggested?: boolean;
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

  const infoButton = (label: string, tooltip: string) => (
    <Tooltip content={tooltip} showArrow positioning={{ placement: "top" }}>
      <IconButton aria-label={label} variant="ghost" size="2xs" color="fg.muted" flexShrink={0}>
        <Icon as={LuInfo} boxSize={3.5} />
      </IconButton>
    </Tooltip>
  );

  // Emphasized: suggested date on top as the due date, hard deadline demoted below it.
  // The wording carries the distinction on its own, so the meaning survives without the
  // size/weight cues (screen readers, forced-colors, zoomed reflow).
  if (emphasizeSuggested && suggestedDueDate) {
    return (
      <Flex direction="column" gap={0.5} maxWidth="100%" minWidth={0}>
        <Flex alignItems="center" gap={1} minWidth={0} wrap="wrap" fontSize="lg" fontWeight="semibold">
          {showDueLabel && <Text flexShrink={0}>Due:</Text>}
          <Text minWidth={0}>
            <TimeZoneAwareDate date={suggestedDueDate} format={dateFormat} />
          </Text>
        </Flex>
        <Flex alignItems="center" gap={1} wrap="wrap" minWidth={0} color="fg.muted" fontSize="sm">
          <Text flexShrink={0}>Resubmit until</Text>
          {dueContent}
          {infoButton("When do resubmissions close?", RESUBMISSION_WINDOW_TOOLTIP)}
          {trailing}
        </Flex>
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap={0.5} maxWidth="100%" minWidth={0}>
      {suggestedDueDate && (
        <Flex alignItems="center" gap={1} color="fg.muted" minWidth={0} width="fit-content">
          <Text fontSize="sm" minWidth={0}>
            Suggested due: <TimeZoneAwareDate date={suggestedDueDate} format={dateFormat} />
          </Text>
          {infoButton("What is the suggested due date?", SUGGESTED_DUE_DATE_TOOLTIP)}
        </Flex>
      )}
      <Flex alignItems="center" gap={1} wrap="wrap" minWidth={0}>
        {showDueLabel && <Text flexShrink={0}>Due: </Text>}
        {dueContent}
        {trailing}
      </Flex>
    </Flex>
  );
}

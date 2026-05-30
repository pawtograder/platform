"use client";

import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Tooltip } from "@/components/ui/tooltip";
import { Flex, Icon, Text } from "@chakra-ui/react";
import type { ComponentProps, ReactNode } from "react";
import { LuInfo } from "react-icons/lu";

type DateFormat = NonNullable<ComponentProps<typeof TimeZoneAwareDate>["format"]>;

export const SUGGESTED_DUE_DATE_TOOLTIP =
  "The suggested due date is a recommended target to aim for. The due date below is the hard deadline — you can keep submitting and resubmitting until then.";

/**
 * Shared student-facing rendering of an assignment's deadline.
 * When an advisory suggested due date is set, it is shown FIRST (above), with a tooltip
 * explaining the difference, and the hard due date is stacked below it. When there is no
 * suggested date, only the hard due date renders (no behavioral or layout change).
 */
export function DueDateDisplay({
  suggestedDueDate,
  dueDate,
  dueDateNode,
  showDueLabel = false,
  dateFormat = "MMM d, h:mm a",
  trailing
}: {
  /** Raw advisory suggested due date (display-only). When falsy, the suggested line is omitted. */
  suggestedDueDate?: string | null;
  /** The effective hard deadline. Ignored when `dueDateNode` is provided. */
  dueDate?: Date | string | null;
  /** Pre-built node for the hard due date (e.g. a TimeZoneAwareDate with visual-test attrs). Overrides `dueDate`. */
  dueDateNode?: ReactNode;
  /** Prefix the hard due date with "Due: ". */
  showDueLabel?: boolean;
  dateFormat?: DateFormat;
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

  return (
    <Flex direction="column" gap={0.5} maxWidth="100%" minWidth={0}>
      {suggestedDueDate && (
        <Tooltip content={SUGGESTED_DUE_DATE_TOOLTIP} showArrow positioning={{ placement: "top" }}>
          <Flex alignItems="center" gap={1} color="fg.muted" minWidth={0} cursor="help" width="fit-content">
            <Text fontSize="sm" minWidth={0}>
              Suggested due: <TimeZoneAwareDate date={suggestedDueDate} format={dateFormat} />
            </Text>
            <Icon as={LuInfo} boxSize={3.5} flexShrink={0} aria-label="What is the suggested due date?" />
          </Flex>
        </Tooltip>
      )}
      <Flex alignItems="center" gap={1} wrap="wrap" minWidth={0}>
        {showDueLabel && <Text flexShrink={0}>Due: </Text>}
        {dueContent}
        {trailing}
      </Flex>
    </Flex>
  );
}

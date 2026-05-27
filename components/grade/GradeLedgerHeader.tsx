"use client";

import { Alert } from "@/components/ui/alert";
import { Box, Heading, HStack, Progress, Text, VStack } from "@chakra-ui/react";
import { formatRelative } from "date-fns";

export type GradeLedgerHeaderProps = {
  assignmentTitle: string;
  submissionOrdinal: number | null;
  submittedAt: string | null;
  released: boolean;
  /** Authoritative displayed grade (null if not graded/released). */
  total: number | null;
  totalPossible: number | null;
  /** Autograder contribution (null if no autograder or not released). */
  autoEarned: number | null;
  autoMax: number | null;
  /** Hand-grading contribution, derived so total = auto + hand + tweak (null if no hand grading). */
  handContribution: number | null;
  tweak: number;
  hasAutograder: boolean;
  hasHandGrading: boolean;
};

/** Renders the small "Submission #N · submitted X" meta line, omitting parts that are absent. */
function SubmissionMeta({
  submissionOrdinal,
  submittedAt
}: {
  submissionOrdinal: number | null;
  submittedAt: string | null;
}) {
  if (submissionOrdinal === null && !submittedAt) {
    return null;
  }
  return (
    <Text fontSize="sm" color="fg.muted">
      {submissionOrdinal !== null && <>Submission #{submissionOrdinal}</>}
      {submissionOrdinal !== null && submittedAt && " · "}
      {submittedAt && (
        <>
          submitted{" "}
          <Text as="span" data-visual-test="transparent" data-visual-placeholder="relative-time">
            {formatRelative(new Date(submittedAt), new Date())}
          </Text>
        </>
      )}
    </Text>
  );
}

/**
 * The headline "grade ledger" card for a submission. When the grade is released and graded it
 * shows the total over the possible points with a progress bar and a single-line breakdown of
 * the contributing terms (autograder + hand grading + adjustment). Otherwise it shows a status
 * banner explaining the grade isn't available yet.
 */
export default function GradeLedgerHeader({
  assignmentTitle,
  submissionOrdinal,
  submittedAt,
  released,
  total,
  totalPossible,
  autoEarned,
  handContribution,
  tweak,
  hasAutograder,
  hasHandGrading
}: GradeLedgerHeaderProps) {
  const isGraded = released && total !== null;

  // Build the breakdown terms that actually apply to this submission.
  const breakdownTerms: string[] = [];
  if (hasAutograder && autoEarned !== null) {
    breakdownTerms.push(`${autoEarned} autograder`);
  }
  if (hasHandGrading && handContribution !== null) {
    breakdownTerms.push(`${handContribution} hand grading`);
  }
  if (tweak !== 0) {
    breakdownTerms.push(`${tweak < 0 ? "−" : "+"} ${Math.abs(tweak)} adjustment`);
  }
  // Only show the breakdown line when more than one source contributes; with a single source the
  // headline already conveys the full story.
  const showBreakdown = breakdownTerms.length > 1;

  const isCapped = isGraded && totalPossible !== null && (total as number) > totalPossible;

  const progressValue =
    isGraded && totalPossible !== null && totalPossible > 0
      ? Math.min(100, ((total as number) / totalPossible) * 100)
      : null;

  return (
    <Box borderWidth="1px" borderColor="border.subtle" borderRadius="md" bg="bg.subtle" p={4} w="100%">
      <VStack align="stretch" gap={3}>
        <VStack align="start" gap={1}>
          <Heading as="h2" size="md">
            {assignmentTitle}
          </Heading>
          <SubmissionMeta submissionOrdinal={submissionOrdinal} submittedAt={submittedAt} />
        </VStack>

        {isGraded ? (
          <VStack align="stretch" gap={2}>
            <HStack align="baseline" gap={2}>
              <Text fontSize="3xl" fontWeight="bold" lineHeight="1">
                {total}
              </Text>
              <Text fontSize="xl" color="fg.muted" lineHeight="1">
                / {totalPossible ?? "?"}
              </Text>
            </HStack>

            {progressValue !== null ? (
              <Progress.Root value={progressValue} size="sm" colorPalette="green">
                <Progress.Track>
                  <Progress.Range />
                </Progress.Track>
              </Progress.Root>
            ) : (
              <Box h="8px" bg="bg.muted" borderRadius="full" overflow="hidden">
                <Box h="100%" w="100%" bg="green.solid" />
              </Box>
            )}

            {isCapped && (
              <Text fontSize="xs" color="fg.muted">
                capped at {totalPossible}
              </Text>
            )}

            {showBreakdown && (
              <Text fontSize="sm" color="fg.muted">
                = {breakdownTerms.join(" + ")}
              </Text>
            )}
          </VStack>
        ) : (
          <VStack align="stretch" gap={2}>
            <Alert status="info" title="Grade not released yet">
              Your grade for this assignment hasn&apos;t been released yet.
            </Alert>
            {hasAutograder && (
              <Text fontSize="sm" color="fg.muted">
                Autograder results below are visible now; hand-grading will appear once released.
              </Text>
            )}
            {autoEarned !== null && (
              <Text fontSize="sm" color="fg.muted">
                Autograder subtotal:{" "}
                <Text as="span" fontWeight="semibold" color="fg.default">
                  {autoEarned}
                </Text>
              </Text>
            )}
          </VStack>
        )}
      </VStack>
    </Box>
  );
}

"use client";

import { Box, Heading, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import { FaCheck, FaTimes } from "react-icons/fa";
import { useMemo, useState } from "react";

import { Switch } from "@/components/ui/switch";
import { ErrorPinCallout } from "@/components/discussion/ErrorPinCallout";
import { TestResultOutput } from "@/components/submission-results/TestResultOutput";
import { GenericBuildError } from "@/components/submission-results/GenericBuildError";
import type { ErrorPinMatch } from "@/hooks/useErrorPinMatches";
import type { GraderResultTestExtraData, SubmissionWithGraderResultsAndErrors } from "@/utils/supabase/DatabaseTypes";

export type AutograderSectionProps = {
  graderResults: SubmissionWithGraderResultsAndErrors["grader_results"] | null;
  errorPinMatches: Map<number | null, ErrorPinMatch[]>;
  submissionId: number;
  classId: number;
  assignmentId: number;
};

type GraderTest = NonNullable<SubmissionWithGraderResultsAndErrors["grader_results"]>["grader_result_tests"][number];

function isPassing(test: GraderTest): boolean {
  if (test.max_score === null || test.max_score === undefined) return true;
  return (test.score ?? 0) >= test.max_score;
}

/** A test has expandable detail only if there's something to show: output, a feedbot hint, or a pinned discussion. */
function testHasDetail(test: GraderTest, pinCount: number): boolean {
  const extra = (test.extra_data ?? undefined) as GraderResultTestExtraData | undefined;
  return Boolean(test.output) || Boolean(extra?.llm?.prompt) || pinCount > 0;
}

/**
 * One test row: a collapsed one-liner (status, name, score) that expands — only when it has
 * detail — into the test output + feedbot hint (TestResultOutput) and any pinned discussion
 * links (ErrorPinCallout). Failing tests with detail start expanded.
 */
function TestRow({
  test,
  pinMatches,
  submissionId,
  classId
}: {
  test: GraderTest;
  pinMatches: ErrorPinMatch[];
  submissionId: number;
  classId: number;
}) {
  const passed = isPassing(test);
  const hasDetail = testHasDetail(test, pinMatches.length);
  const [open, setOpen] = useState(!passed && hasDetail);
  const extra = (test.extra_data ?? undefined) as GraderResultTestExtraData | undefined;

  const header = (
    <HStack
      justify="space-between"
      align="center"
      gap={2}
      px={2}
      py={1.5}
      cursor={hasDetail ? "pointer" : "default"}
      _hover={hasDetail ? { bg: "bg.muted" } : undefined}
      onClick={hasDetail ? () => setOpen((o) => !o) : undefined}
      role={hasDetail ? "button" : undefined}
      tabIndex={hasDetail ? 0 : undefined}
      aria-expanded={hasDetail ? open : undefined}
      onKeyDown={
        hasDetail
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpen((o) => !o);
              }
            }
          : undefined
      }
    >
      <HStack gap={2} minW={0}>
        {hasDetail ? (
          <Icon as={open ? ChevronDown : ChevronRight} boxSize={3} color="fg.muted" flexShrink={0} />
        ) : (
          <Box w="12px" flexShrink={0} />
        )}
        <Icon as={passed ? FaCheck : FaTimes} color={passed ? "green.solid" : "red.solid"} boxSize={3} flexShrink={0} />
        <Text fontSize="sm" wordBreak="break-word">
          {test.name}
        </Text>
      </HStack>
      <Text fontSize="sm" color="fg.muted" flexShrink={0}>
        {test.score ?? 0}/{test.max_score ?? 0}
      </Text>
    </HStack>
  );

  return (
    <Box borderTopWidth="1px" borderColor="border.subtle">
      {header}
      {hasDetail && open && (
        <Box px={3} pb={2} pl={7}>
          <TestResultOutput
            result={{ output: test.output, output_format: test.output_format }}
            testId={test.id}
            extraData={extra}
            submissionId={submissionId}
            classId={classId}
          />
          {pinMatches.length > 0 && (
            <Box mt={2}>
              <ErrorPinCallout matches={pinMatches} />
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

/**
 * The autograder portion of the grade ledger. Renders a build-error callout (if the build failed),
 * submission-level pinned discussions, and an adaptive, density-following list of tests grouped by
 * part. Compact by default (one line per test); rich on demand (output + feedbot + pinned posts).
 */
export default function AutograderSection({
  graderResults,
  errorPinMatches,
  submissionId,
  classId,
  assignmentId
}: AutograderSectionProps) {
  const [onlyFailing, setOnlyFailing] = useState(false);

  const allTests = useMemo(() => graderResults?.grader_result_tests ?? [], [graderResults]);

  // Student-visible tests only; tests flagged hide_score or not released are summarized as "hidden".
  const visibleTests = useMemo(
    () =>
      allTests.filter((t) => {
        const extra = (t.extra_data ?? undefined) as GraderResultTestExtraData | undefined;
        return extra?.hide_score !== "true" && t.is_released;
      }),
    [allTests]
  );
  const hiddenCount = allTests.length - visibleTests.length;

  const shownTests = onlyFailing ? visibleTests.filter((t) => !isPassing(t)) : visibleTests;
  const failingCount = visibleTests.filter((t) => !isPassing(t)).length;

  // Group consecutive tests by `part`, preserving the order they were produced in.
  const groups = useMemo(() => {
    const out: { part: string | null; tests: GraderTest[] }[] = [];
    for (const t of shownTests) {
      const last = out[out.length - 1];
      if (last && last.part === (t.part ?? null)) {
        last.tests.push(t);
      } else {
        out.push({ part: t.part ?? null, tests: [t] });
      }
    }
    return out;
  }, [shownTests]);

  if (!graderResults) return null;

  const hasBuildError = graderResults.lint_output === "Gradle build failed";
  const buildOutput = graderResults.grader_result_output?.[0]?.output || graderResults.lint_output || "";
  const submissionLevelPins = errorPinMatches.get(null) ?? [];

  return (
    <Box borderWidth="1px" borderColor="border.subtle" borderRadius="md" p={4} w="100%">
      <VStack align="stretch" gap={3}>
        <HStack justify="space-between" align="center" gap={2} flexWrap="wrap">
          <Heading as="h3" size="sm">
            Autograder
          </Heading>
          <HStack gap={3}>
            {failingCount > 0 && (
              <Switch checked={onlyFailing} onCheckedChange={(e) => setOnlyFailing(e.checked)} size="sm">
                Only failing
              </Switch>
            )}
            <Text fontWeight="semibold" fontSize="sm">
              {graderResults.score ?? 0} / {graderResults.max_score ?? 0}
            </Text>
          </HStack>
        </HStack>

        {hasBuildError && (
          <GenericBuildError
            errorPinMatches={errorPinMatches}
            buildOutput={buildOutput}
            assignmentId={assignmentId}
            classId={classId}
            submissionId={submissionId}
          />
        )}

        {!hasBuildError && submissionLevelPins.length > 0 && <ErrorPinCallout matches={submissionLevelPins} />}

        {visibleTests.length > 0 ? (
          <Box borderWidth="1px" borderColor="border.subtle" borderRadius="md" overflow="hidden">
            {groups.map((group, gi) => (
              <Box key={`${group.part ?? "ungrouped"}-${gi}`}>
                {group.part && (
                  <Box px={2} py={1} bg="bg.muted">
                    <Text fontSize="xs" fontWeight="bold" color="fg.muted">
                      {group.part}
                    </Text>
                  </Box>
                )}
                {group.tests.map((test) => (
                  <TestRow
                    key={test.id}
                    test={test}
                    pinMatches={errorPinMatches.get(test.id) ?? []}
                    submissionId={submissionId}
                    classId={classId}
                  />
                ))}
              </Box>
            ))}
          </Box>
        ) : (
          !hasBuildError && (
            <Text fontSize="sm" color="fg.muted">
              No autograder tests to show yet.
            </Text>
          )
        )}

        {hiddenCount > 0 && (
          <HStack gap={1} color="fg.muted" fontSize="xs">
            <Icon as={Lock} boxSize={3} />
            <Text>
              {hiddenCount} {hiddenCount === 1 ? "test is" : "tests are"} hidden
            </Text>
          </HStack>
        )}
      </VStack>
    </Box>
  );
}

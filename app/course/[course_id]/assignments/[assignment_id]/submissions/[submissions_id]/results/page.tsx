"use client";
import { Alert } from "@/components/ui/alert";
import Link from "@/components/ui/link";
import { Switch } from "@/components/ui/switch";
import { useObfuscatedGradesMode } from "@/hooks/useCourseController";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { GraderResultOutput, SubmissionWithGraderResultsAndErrors } from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  CardBody,
  CardHeader,
  CardRoot,
  Container,
  Heading,
  HStack,
  Skeleton,
  Spinner,
  Table,
  Tabs,
  Text
} from "@chakra-ui/react";
import { useShow } from "@refinedev/core";
import { formatDistanceToNow } from "date-fns";
import { useParams } from "next/navigation";
import { makeEmbed } from "@ironm00n/pyret-embed/api";
import { Fragment, useEffect, useRef, useState, useId } from "react";
import { FaRobot } from "react-icons/fa";

import { GraderResultTestExtraData, PyretReplConfig } from "@/utils/supabase/DatabaseTypes";
import { useErrorPinMatches } from "@/hooks/useErrorPinMatches";
import { ErrorPinCallout } from "@/components/discussion/ErrorPinCallout";
import { AIHelpSubmissionErrorButton } from "@/components/ai-help/AIHelpSubmissionErrorButton";
import { getStudentFacingErrorMessage } from "@/lib/studentFacingErrorMessages";
import { TestResultOutput, format_basic_output } from "@/components/submission-results/TestResultOutput";
import { GenericBuildError } from "@/components/submission-results/GenericBuildError";

/** When create-submission already recorded a user-visible message (e.g. grade.yml mismatch), hide the generic missing-grader-result row. */
function filterWorkflowRunErrorsForDisplay<
  T extends { data?: unknown; is_private?: boolean | null; id?: string | number }
>(errors: T[]): T[] {
  const hasUserVisibleType = errors.some((e) => {
    const d = e.data;
    return d !== null && typeof d === "object" && "type" in d && (d as { type?: string }).type === "user_visible_error";
  });
  if (!hasUserVisibleType) return errors;
  return errors.filter((e) => {
    const d = e.data;
    if (d !== null && typeof d === "object" && "error_type" in d) {
      return (d as { error_type?: string }).error_type !== "missing_grader_result";
    }
    return true;
  });
}

function format_output(output: GraderResultOutput) {
  return format_basic_output({ output: output.output, output_format: output.format as "text" | "markdown" });
}

function PyretRepl({
  testId,
  config,
  hidden
}: {
  testId: number;
  config: NonNullable<PyretReplConfig>;
  hidden?: boolean;
}) {
  const instanceId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const embedRef = useRef<Awaited<ReturnType<typeof makeEmbed>> | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const embedId = `pyret-repl-${testId}${hidden ? "-hidden" : ""}-${instanceId}`;
  const regionId = `pyret-repl-region-${testId}${hidden ? "-instructor" : "-student"}-${instanceId}`;

  const handleExpand = () => {
    setIsExpanded((prev) => {
      if (prev) {
        // Collapsing: reset embed so it will re-initialize on next expand
        embedRef.current = null;
        if (containerRef.current) {
          containerRef.current.innerHTML = "";
        }
      }
      return !prev;
    });
  };

  useEffect(() => {
    if (!isExpanded) return;
    if (!containerRef.current) return;
    if (embedRef.current && containerRef.current.childElementCount > 0) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    (async () => {
      try {
        containerRef.current!.innerHTML = "";
        const embed = await makeEmbed(embedId, containerRef.current!, undefined);
        if (cancelled) return;
        embedRef.current = embed;
        if (config.initial_code != null || config.initial_interactions != null || config.repl_contents != null) {
          const code = config.initial_code ?? "use context starter2024";
          embed.sendReset({
            definitionsAtLastRun: code,
            interactionsSinceLastRun: config.initial_interactions || [],
            editorContents: code,
            replContents: config.repl_contents ?? ""
          });
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        if (!cancelled) {
          console.error("Failed to initialize Pyret REPL:", e);
          setError(e?.message || "Failed to load REPL");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isExpanded, testId, config.initial_code, config.initial_interactions, config.repl_contents, embedId]);

  return (
    <Box borderWidth="1px" borderRadius="md" borderColor="border.default" overflow="hidden">
      <Box
        as="button"
        onClick={handleExpand}
        aria-expanded={isExpanded}
        // `aria-controls` must point at an element that exists in the DOM. The
        // controlled region is only mounted when expanded, so only advertise
        // the relationship while it's mounted (avoids WAVE "broken ARIA
        // reference" / axe `aria-valid-attr-value`).
        aria-controls={isExpanded ? regionId : undefined}
        width="100%"
        textAlign="left"
        bg="bg.muted"
        _hover={{ bg: "bg.muted" }}
        _focusVisible={{ outline: "2px solid", outlineColor: "focus" }}
        px={3}
        py={2}
        cursor="pointer"
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        gap={3}
      >
        <HStack gap={3} align="center">
          <Text fontWeight="semibold" color="fg.emphasized">
            {hidden && (
              <Text as="span" color="fg.muted">
                (Instructor-Only){" "}
              </Text>
            )}
            Interactive Pyret REPL
          </Text>
          {isLoading && (
            <HStack gap={1} color="fg.muted">
              <Spinner size="xs" />
              <Text fontSize="xs">Loading...</Text>
            </HStack>
          )}
          {error && !isLoading && (
            <Text fontSize="xs" color="red.600">
              {error}
            </Text>
          )}
        </HStack>
        <Text fontSize="lg" color="fg.muted" userSelect="none">
          {isExpanded ? "−" : "+"}
        </Text>
      </Box>
      {isExpanded && (
        <Box id={regionId} borderTopWidth="1px" borderColor="border.default">
          <Box height="400px" width="100%" position="relative" bg="bg.canvas" _dark={{ bg: "bg.subtle" }}>
            <Box ref={containerRef} height="100%" width="100%" />
            {isLoading && (
              <Box
                position="absolute"
                inset={0}
                display="flex"
                alignItems="center"
                justifyContent="center"
                bg="bg.overlay"
                backdropFilter="blur(2px)"
              >
                <HStack gap={2}>
                  <Spinner size="sm" />
                  <Text fontSize="sm" color="fg.muted">
                    Initializing REPL...
                  </Text>
                </HStack>
              </Box>
            )}
            {error && !isLoading && (
              <Box position="absolute" inset={0} display="flex" alignItems="center" justifyContent="center">
                <Text fontSize="sm" color="red.600">
                  {error} (click header to retry)
                </Text>
              </Box>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

export default function GraderResults() {
  const { submissions_id } = useParams();
  const { query } = useShow<SubmissionWithGraderResultsAndErrors>({
    resource: "submissions",
    id: Number(submissions_id),
    meta: {
      select:
        "*, assignments(*), grader_results!grader_results_submission_id_fkey(*, grader_result_tests(*, grader_result_test_output(*)), grader_result_output(*)), workflow_run_error(*)"
    }
  });
  const isObfuscatedGradesMode = useObfuscatedGradesMode();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const { matches: errorPinMatches } = useErrorPinMatches(Number(submissions_id));
  // Default to hidden-output on for staff (the actual instructor identity) and off for
  // students. In view-as student, isGraderOrInstructor flips to false so the toggle
  // starts off and the toggle itself is hidden below — preventing the masquerader from
  // surfacing instructor-only debug output or unreleased test stdout.
  const [showHiddenOutput, setShowHiddenOutput] = useState(isGraderOrInstructor && !isObfuscatedGradesMode);
  useEffect(() => {
    setShowHiddenOutput(isGraderOrInstructor && !isObfuscatedGradesMode);
  }, [isObfuscatedGradesMode, isGraderOrInstructor]);
  if (query.isLoading) {
    return (
      <Box>
        <Skeleton height="100px" />
      </Box>
    );
  }
  if (query.error) {
    return (
      <Box p={4}>
        <Alert status="error" title="Could not load results">
          {getStudentFacingErrorMessage(query.error)}
        </Alert>
      </Box>
    );
  }
  if (!query.data) {
    return <Box>No grader results found</Box>;
  }
  if (query.data.data.workflow_run_error && query.data.data.workflow_run_error.length > 0) {
    const errors = filterWorkflowRunErrorsForDisplay(query.data.data.workflow_run_error);

    // Check if any errors are user-visible
    const hasUserVisibleErrors = errors.some((error) => !error.is_private);
    const userVisibleErrors = errors.filter((error) => !error.is_private);
    const privateErrors = errors.filter((error) => error.is_private);

    return (
      <Container>
        <Box p={4} margin={{ base: "2", lg: "4" }}>
          {hasUserVisibleErrors ? (
            <Alert title="Submission Error" status="error" p={4} mb={4}>
              An error occurred while processing your submission. Your code has been submitted to{" "}
              <Link href={`https://github.com/${query.data.data.repository}`}>your GitHub repository</Link>, but the
              autograder encountered issues.
              {userVisibleErrors.map((error) => {
                const errorMessage = error.name;
                let errorDetails = null;
                if (error.data && error.data !== "{}") {
                  errorDetails = error.data;
                }

                return (
                  <Box
                    key={error.id}
                    mt={3}
                    p={3}
                    bg="bg.error"
                    borderRadius="md"
                    border="1px solid"
                    borderColor="border.error"
                  >
                    <Text fontWeight="bold" color="fg.error" fontSize="sm">
                      Error: {errorMessage}
                    </Text>
                    {errorDetails && (
                      <Box mt={2} p={2} bg="bg.error" borderRadius="sm">
                        <Text fontSize="xs" fontFamily="mono" color="fg.error">
                          {typeof errorDetails === "string" ? errorDetails : JSON.stringify(errorDetails, null, 2)}
                        </Text>
                      </Box>
                    )}
                    <Text fontSize="xs" color="fg.error" mt={2}>
                      Error occurred {formatDistanceToNow(new Date(error.created_at), { addSuffix: true })}
                    </Text>
                  </Box>
                );
              })}
              <Box mt={4}>
                <Text fontSize="sm" color="fg.error">
                  Please check{" "}
                  <Link
                    href={`https://github.com/${query.data.data.repository}/actions/runs/${query.data.data.run_number}/attempts/${query.data.data.run_attempt}`}
                  >
                    the GitHub Actions run for this submission
                  </Link>{" "}
                  for more details, or contact your instructor for assistance.
                </Text>
              </Box>
            </Alert>
          ) : (
            <Alert title="Submission Processing Error" status="warning" p={4} mb={4}>
              The autograder reported a problem, but the detailed message is only visible to course staff. Your code was
              still pushed to{" "}
              <Link href={`https://github.com/${query.data.data.repository}`}>your GitHub repository</Link>.
              <Box mt={4}>
                <Text fontSize="sm">
                  Open{" "}
                  <Link
                    href={`https://github.com/${query.data.data.repository}/actions/runs/${query.data.data.run_number}/attempts/${query.data.data.run_attempt}`}
                  >
                    the GitHub Actions run log
                  </Link>{" "}
                  to see the full error output, or ask your instructor or TA—they can see the same details in
                  Pawtograder and in GitHub.
                </Text>
              </Box>
            </Alert>
          )}

          {/* Debug information for instructors - only show if there are private errors */}
          {privateErrors.length > 0 && (
            <Alert title="Debug Information (Instructor Only)" status="info" p={4}>
              <Text fontSize="sm" mb={3}>
                The following errors are marked as private and not visible to students:
              </Text>

              {privateErrors.map((error) => (
                <Box
                  key={error.id}
                  mt={2}
                  p={3}
                  bg="blue.50"
                  borderRadius="md"
                  border="1px solid"
                  borderColor="blue.200"
                >
                  <Text fontWeight="bold" color="blue.700" fontSize="sm">
                    {error.name}
                  </Text>
                  {error.data && error.data !== "{}" && (
                    <Box mt={2} p={2} bg="blue.25" borderRadius="sm">
                      <Text fontSize="xs" fontFamily="mono" color="blue.600">
                        {typeof error.data === "string" ? error.data : JSON.stringify(error.data, null, 2)}
                      </Text>
                    </Box>
                  )}
                  <Text fontSize="xs" color="blue.500" mt={2}>
                    Error occurred {formatDistanceToNow(new Date(error.created_at), { addSuffix: true })}
                  </Text>
                </Box>
              ))}
            </Alert>
          )}
        </Box>
      </Container>
    );
  }
  if (!query.data.data.grader_results) {
    // No autograder result for this submission. has_autograder is maintained as a
    // reliable signal — set from grader-repo provisioning at create time and
    // backfilled for existing rows — so when it's false the autograder will never
    // produce a result: show a "manual grading" notice instead of "autograder
    // hasn't finished". This only picks the empty-state copy; a submission that DOES
    // have grader_results always renders them (below), regardless of the flag.
    if (query.data.data.assignments && query.data.data.assignments.has_autograder === false) {
      return (
        <Container>
          <Box p={4} margin={{ base: "2", lg: "4" }}>
            <Alert title="Manual / rubric grading" status="info">
              This assignment is graded manually — there is no autograder feedback for this submission. See the Grade
              tab for rubric scores and comments.
            </Alert>
          </Box>
        </Container>
      );
    }
    return (
      <Container>
        <Box p={4} margin={{ base: "2", lg: "4" }}>
          <Alert title="Autograder has not finished running">
            The autograder started running {formatDistanceToNow(query.data.data.created_at, { addSuffix: true })}, and
            has not completed yet. Please check{" "}
            <Link
              href={`https://github.com/${query.data.data.repository}/actions/runs/${query.data.data.run_number}/attempts/${query.data.data.run_attempt}`}
            >
              the GitHub Actions run for this submission
            </Link>{" "}
            if you want to see live output from the grading script. How long the autograder takes to run depends
            primarily on how the assignment is configured.
          </Alert>
        </Box>
      </Container>
    );
  }
  const hasHiddenOutput = query.data.data.grader_results.grader_result_tests.some(
    (result) => result.grader_result_test_output.length > 0 || !result.is_released
  );
  const hasBuildError = query.data.data.grader_results.lint_output === "Gradle build failed";
  const data = query.data.data;
  // Outputs the current viewer can see (students don't see instructor-only debug output).
  // Hoisted so the tab label's `.length === 1` check counts the *visible* tabs, not the
  // raw list — otherwise a student with one visible + one instructor-only output gets a
  // single tab mislabeled "Student Visible Output" instead of just "Output".
  const visibleOutputs = (data.grader_results?.grader_result_output ?? []).filter(
    (output) => isGraderOrInstructor || output.visibility === "visible"
  );
  // Get build output for AI analysis
  const buildOutput = data.grader_results?.grader_result_output?.[0]?.output || data.grader_results?.lint_output || "";
  return (
    <Box>
      {hasBuildError && (
        <GenericBuildError
          errorPinMatches={errorPinMatches}
          buildOutput={buildOutput}
          assignmentId={data.assignment_id}
          classId={data.class_id}
          submissionId={data.id}
        />
      )}
      <Tabs.Root
        m={3}
        defaultValue={hasBuildError ? data.grader_results?.grader_result_output[0]?.visibility : "tests"}
      >
        <Tabs.List>
          {!hasBuildError && <Tabs.Trigger value="tests">Test Results</Tabs.Trigger>}
          {visibleOutputs.map((output) => (
            <Tabs.Trigger key={output.id} value={output.visibility}>
              {visibleOutputs.length === 1
                ? "Output"
                : output.visibility === "visible"
                  ? "Student Visible Output"
                  : "Instructor-Only Debug Output"}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {visibleOutputs.map((output) => (
          <Tabs.Content key={output.id} value={output.visibility}>
            {format_output(output)}
          </Tabs.Content>
        ))}
        {!hasBuildError && (
          <Tabs.Content value="tests">
            {/* Show submission-level error pins (not tied to specific tests) */}
            {errorPinMatches.has(null) && errorPinMatches.get(null)!.length > 0 && (
              <Box mb={4}>
                <ErrorPinCallout matches={errorPinMatches.get(null)!} />
              </Box>
            )}
            <Heading size="md">Lint Results: {data.grader_results?.lint_passed ? "Passed" : "Failed"}</Heading>
            {data.grader_results?.lint_output && (
              <Box borderWidth="1px" borderRadius="md" p={2}>
                <Heading size="sm">Lint Output</Heading>
                <Box maxH="400px" overflow="auto">
                  {format_basic_output({
                    output: data.grader_results?.lint_output,
                    output_format: data.grader_results?.lint_output_format
                  })}
                </Box>
              </Box>
            )}
            <Heading size="md">Test Results</Heading>
            <HStack w="100%" justifyContent="flex-end">
              {hasHiddenOutput && isGraderOrInstructor && (
                <Switch
                  checked={showHiddenOutput}
                  onChange={() => setShowHiddenOutput(!showHiddenOutput)}
                  colorPalette="green"
                >
                  Instructor View
                </Switch>
              )}
            </HStack>
            <Table.Root maxW="2xl">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Status</Table.ColumnHeader>
                  <Table.ColumnHeader>Name</Table.ColumnHeader>
                  <Table.ColumnHeader>Score</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.grader_results?.grader_result_tests &&
                  data.grader_results?.grader_result_tests.length > 0 &&
                  data.grader_results?.grader_result_tests[0]?.part && (
                    <Table.Row>
                      <Table.Cell bg="bg.muted" colSpan={3} fontWeight="bold" textAlign="center">
                        {data.grader_results?.grader_result_tests[0]?.part}
                      </Table.Cell>
                    </Table.Row>
                  )}
                {data.grader_results?.grader_result_tests
                  ?.filter(
                    (r) =>
                      (r.extra_data as GraderResultTestExtraData)?.hide_score !== "true" &&
                      (showHiddenOutput || r.is_released)
                  )
                  .map((result, index) => {
                    const isNewPart =
                      index > 0 && result.part !== data.grader_results?.grader_result_tests[index - 1].part;
                    return (
                      <Fragment key={result.id}>
                        {isNewPart && (
                          <Table.Row>
                            <Table.Cell colSpan={3} textAlign="center" bg="bg.muted" fontWeight="bold">
                              {result.part}
                            </Table.Cell>
                          </Table.Row>
                        )}
                        <Table.Row>
                          <Table.Cell>
                            {(() => {
                              const extraData = result.extra_data as GraderResultTestExtraData;
                              if (extraData?.llm?.prompt || extraData?.llm?.result) {
                                return <FaRobot />;
                              }
                              return result.score === result.max_score ? "✅" : "❌";
                            })()}
                          </Table.Cell>
                          <Table.Cell>
                            <Link variant="underline" href={`#test-${result.id}`}>
                              {result.name}
                            </Link>
                          </Table.Cell>
                          <Table.Cell>
                            {result.score}/{result.max_score}
                          </Table.Cell>
                        </Table.Row>
                      </Fragment>
                    );
                  })}
              </Table.Body>
            </Table.Root>
            {data.grader_results?.grader_result_tests
              ?.filter((result) => result.is_released || showHiddenOutput)
              .map((result) => {
                const hasInstructorOutput = showHiddenOutput && result.grader_result_test_output.length > 0;
                const extraData = result.extra_data as GraderResultTestExtraData | undefined;
                const maybeWrappedResult = (content: React.ReactNode) => {
                  if (hasInstructorOutput) {
                    return (
                      <CardRoot key={result.id} m={2}>
                        <CardHeader bg="bg.muted" p={2}>
                          <Heading size="md">Student-Visible Output</Heading>
                        </CardHeader>
                        <CardBody>{content}</CardBody>
                      </CardRoot>
                    );
                  }
                  return <CardBody>{content}</CardBody>;
                };
                const style = result.max_score === 0 ? "info" : result.score === result.max_score ? "success" : "error";
                const showScore = result.max_score !== 0;
                const isFailing = (result.max_score ?? 0) > 0 && (result.score ?? 0) < (result.max_score ?? 0);

                const testMatches = errorPinMatches.get(result.id) || [];

                return (
                  <CardRoot key={result.id} id={`test-${result.id}`} mt={4}>
                    <CardHeader bg={`bg.${style}`} p={2}>
                      <HStack justify="space-between">
                        <Heading size="lg" color={`fg.${style}`}>
                          {result.name} {showScore ? result.score + "/" + result.max_score : ""}
                        </Heading>
                        {isFailing && result.output && (
                          <AIHelpSubmissionErrorButton
                            errorType="test_failure"
                            testName={result.name}
                            testPart={result.part}
                            score={result.score ?? undefined}
                            maxScore={result.max_score ?? undefined}
                            errorOutput={result.output}
                            assignmentId={data.assignment_id}
                            classId={data.class_id}
                            submissionId={data.id}
                          />
                        )}
                      </HStack>
                    </CardHeader>
                    {testMatches.length > 0 && (
                      <Box px={4} pt={2}>
                        <ErrorPinCallout matches={testMatches} />
                      </Box>
                    )}
                    {maybeWrappedResult(
                      <TestResultOutput
                        result={result}
                        testId={result.id}
                        extraData={result.extra_data as GraderResultTestExtraData}
                        submissionId={data.id}
                        classId={data.class_id}
                      />
                    )}
                    {extraData?.pyret_repl && (
                      <Box mt={3}>
                        <PyretRepl testId={result.id} config={extraData.pyret_repl} />
                      </Box>
                    )}
                    {hasInstructorOutput &&
                      result.grader_result_test_output.map((output) => {
                        const hiddenExtraData = output.extra_data as GraderResultTestExtraData | undefined;
                        return (
                          <CardRoot key={output.id} m={2}>
                            <CardHeader bg="bg.muted" p={2}>
                              <Heading size="md">Instructor-Only Output</Heading>
                            </CardHeader>
                            <CardBody>
                              {format_basic_output({
                                output: output.output,
                                output_format: output.output_format as "text" | "markdown"
                              })}
                            </CardBody>
                            {hiddenExtraData?.pyret_repl && (
                              <Box mt={3}>
                                <PyretRepl testId={result.id} config={hiddenExtraData.pyret_repl} hidden />
                              </Box>
                            )}
                          </CardRoot>
                        );
                      })}
                  </CardRoot>
                );
              })}
          </Tabs.Content>
        )}
      </Tabs.Root>
    </Box>
  );
}

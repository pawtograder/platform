"use client";
import { Alert } from "@/components/ui/alert";
import Link from "@/components/ui/link";
import Markdown from "@/components/ui/markdown";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useObfuscatedGradesMode } from "@/hooks/useCourseController";
import { GraderResultOutput, SubmissionWithGraderResultsAndErrors } from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  CardBody,
  CardHeader,
  CardRoot,
  Container,
  Heading,
  HStack,
  Icon,
  Skeleton,
  Table,
  Tabs,
  Text,
  Textarea,
  VStack
} from "@chakra-ui/react";
import { useShow } from "@refinedev/core";
import { formatDistanceToNow } from "date-fns";
import { useParams } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { FaInfo, FaRobot, FaSpinner } from "react-icons/fa";
import * as Sentry from "@sentry/nextjs";
import { Tooltip } from "@/components/ui/tooltip";

import { GraderResultTestExtraData, GraderResultTestsHintFeedback } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
import { useClassProfiles } from "@/hooks/useClassProfiles";
function LLMHintButton({ testId, onHintGenerated }: { testId: number; onHintGenerated: (hint: string) => void }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGetHint = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/llm-hint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          testId
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to get Feedbot response");
      }

      onHintGenerated(data.response);

      // If this was cached, we could show a different message
      if (data.cached) {
        console.log("Feedbot response was retrieved from cache");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get Feedbot response");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <VStack align="stretch" gap={2}>
      <Button onClick={handleGetHint} disabled={isLoading} colorPalette="blue" variant="outline" size="sm">
        {isLoading ? (
          <>
            <FaSpinner className="animate-spin" />
            Getting Feedbot Response...
          </>
        ) : (
          <>
            <FaRobot />
            Get Feedbot Response
          </>
        )}
      </Button>
      {error && (
        <Alert status="error" size="sm">
          {error}
        </Alert>
      )}
    </VStack>
  );
}

function HintFeedbackForm({
  testId,
  submissionId,
  classId,
  hintText,
  onFeedbackSubmitted
}: {
  testId: number;
  submissionId: number;
  classId: number;
  hintText: string;
  onFeedbackSubmitted?: () => void;
}) {
  const [useful, setUseful] = useState<boolean | null>(null);
  const [comment, setComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [existingFeedback, setExistingFeedback] = useState<GraderResultTestsHintFeedback | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const { private_profile_id } = useClassProfiles();

  // Fetch existing feedback on mount
  useEffect(() => {
    const fetchExistingFeedback = async () => {
      try {
        const supabase = createClient();

        const { data: feedback, error: fetchError } = await supabase
          .from("grader_result_tests_hint_feedback")
          .select("*")
          .eq("grader_result_tests_id", testId)
          .eq("created_by", private_profile_id)
          .maybeSingle();

        if (feedback && !fetchError) {
          const typedFeedback = feedback;
          setExistingFeedback(typedFeedback);
          setUseful(typedFeedback.useful);
          setComment(typedFeedback.comment || "");
          setHasSubmitted(true);
        }
      } finally {
        setIsLoading(false);
      }
    };

    fetchExistingFeedback();
  }, [testId, classId]);

  const handleSubmit = async () => {
    if (useful === null) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const supabase = createClient();

      if (existingFeedback) {
        // Update existing feedback
        const { data: updatedFeedback, error: updateError } = await supabase
          .from("grader_result_tests_hint_feedback")
          .update({
            useful: useful,
            comment: comment.trim() || null
          })
          .eq("id", existingFeedback.id)
          .select()
          .single();

        if (updateError) {
          setError("Failed to update feedback: " + updateError.message);
          return;
        }

        // Update the existing feedback state with the new values
        if (updatedFeedback) {
          setExistingFeedback(updatedFeedback as unknown as GraderResultTestsHintFeedback);
        }
      } else {
        // Insert new feedback
        const { data: newFeedback, error: insertError } = await supabase
          .from("grader_result_tests_hint_feedback")
          .insert({
            class_id: classId,
            grader_result_tests_id: testId,
            submission_id: submissionId,
            hint: hintText,
            useful: useful,
            comment: comment.trim() || null,
            created_by: private_profile_id
          })
          .select()
          .single();

        if (insertError) {
          setError("Failed to submit feedback: " + insertError.message);
          return;
        }

        // Set the existing feedback state with the newly created feedback
        if (newFeedback) {
          setExistingFeedback(newFeedback as unknown as GraderResultTestsHintFeedback);
        }
      }

      setHasSubmitted(true);
      setIsEditing(false);
      onFeedbackSubmitted?.();
    } catch (err) {
      Sentry.captureException(err);
      setError("An error occurred while submitting feedback");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <Box mt={4} p={3} bg="bg.muted" borderRadius="md" border="1px solid" borderColor="border.emphasized">
        <Text fontSize="sm" color="fg.muted">
          Loading feedback...
        </Text>
      </Box>
    );
  }

  if (hasSubmitted && !isEditing) {
    return (
      <Box mt={4} p={3} bg="bg.subtle" borderRadius="md" borderLeft="4px solid" borderColor="border.emphasized">
        <HStack justify="space-between" align="start">
          <Box>
            <Text fontSize="sm" color="fg.muted" fontWeight="medium">
              Your feedback: {useful ? "👍 Helpful" : "👎 Not helpful"}
            </Text>
            {comment && (
              <Text fontSize="sm" color="fg.muted" mt={1}>
                &quot;{comment}&quot;
              </Text>
            )}
            <Text fontSize="xs" color="fg.muted" mt={1}>
              Thank you for helping us improve Feedbot!
            </Text>
          </Box>
          <Button size="xs" variant="ghost" onClick={() => setIsEditing(true)}>
            Edit
          </Button>
        </HStack>
      </Box>
    );
  }

  return (
    <Box mt={4} p={3} bg="bg.muted" borderRadius="md" border="1px solid" borderColor="border.emphasized">
      <Text fontSize="sm" fontWeight="medium" mb={3}>
        {existingFeedback ? "Update your feedback:" : "Was this Feedbot response helpful?"}
      </Text>

      <HStack mb={3}>
        <Button
          size="sm"
          variant={useful === true ? "surface" : "outline"}
          colorPalette={useful === true ? "green" : "gray"}
          onClick={() => setUseful(true)}
        >
          👍 Yes
        </Button>
        <Button
          size="sm"
          variant={useful === false ? "surface" : "outline"}
          colorPalette={useful === false ? "red" : "gray"}
          onClick={() => setUseful(false)}
        >
          👎 No
        </Button>
      </HStack>

      <Textarea
        placeholder="Optional: Tell us more about your experience with this hint to help us improve..."
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        size="sm"
        mb={3}
        maxLength={500}
      />

      <HStack>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={useful === null || isSubmitting}
          loading={isSubmitting}
          colorPalette="green"
          variant="solid"
        >
          {existingFeedback ? "Update Feedback" : "Submit Feedback"}
        </Button>
        {isEditing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setIsEditing(false);
              setUseful(existingFeedback?.useful ?? null);
              setComment(existingFeedback?.comment || "");
            }}
          >
            Cancel
          </Button>
        )}
        {error && (
          <Text fontSize="xs" color="red.500">
            {error}
          </Text>
        )}
      </HStack>
    </Box>
  );
}

function TestResultOutput({
  result,
  testId,
  extraData,
  submissionId,
  classId
}: {
  result: {
    output: string | null | undefined;
    output_format: string | null | undefined;
  };
  testId?: number;
  extraData?: GraderResultTestExtraData;
  submissionId?: number;
  classId?: number;
}) {
  const [hintContent, setHintContent] = useState<string | null>(null);

  // Check if there's already a stored LLM hint result
  const storedHintResult = extraData?.llm?.result;
  const displayHint = hintContent || storedHintResult;

  // If we have a feedbot response (either newly generated or stored), show it instead of the original output
  if (displayHint) {
    return (
      <Box fontSize="sm" overflowX="auto" border="1px solid" borderColor="border.emphasized" borderRadius="md" p={0}>
        <HStack
          p={2}
          w="100%"
          bg="bg.info"
          borderTopRadius="md"
          color="fg.info"
          fontWeight="bold"
          justify="space-between"
        >
          <HStack>
            {" "}
            <Icon as={FaRobot} />
            Response from Feedbot
          </HStack>
          <Tooltip
            content="Feedbot is an AI-powered assistant that is currently in research & development. We welcome feedback to help us improve!"
            openDelay={0}
          >
            <Icon as={FaInfo} />
          </Tooltip>
        </HStack>
        <Box p={2}>
          <Markdown>{displayHint}</Markdown>
          {testId && submissionId && classId && (
            <HintFeedbackForm testId={testId} submissionId={submissionId} classId={classId} hintText={displayHint} />
          )}
        </Box>
      </Box>
    );
  }

  // If there's an LLM hint prompt but no result yet, show the hint button instead of output
  if (extraData?.llm?.prompt && testId && !storedHintResult) {
    return (
      <Box fontSize="sm">
        <Text color="text.muted" mb={3}>
          Click below to generate response from Feedbot.
        </Text>
        <LLMHintButton testId={testId} onHintGenerated={setHintContent} />
      </Box>
    );
  }

  // Default output formatting
  return format_basic_output(result);
}

function format_basic_output(result: { output: string | null | undefined; output_format: string | null | undefined }) {
  if (result.output === undefined && result.output_format === undefined) {
    return (
      <Text textStyle="sm" color="text.muted">
        No output
      </Text>
    );
  }
  if (result.output_format === "text" || result.output_format === null) {
    return (
      <Box fontSize="sm" overflowX="auto">
        <pre>{result.output}</pre>
      </Box>
    );
  }
  if (result.output_format === "markdown") {
    return (
      <Box fontSize="sm" overflowX="auto">
        <Markdown>{result.output}</Markdown>
      </Box>
    );
  }
  return <Text fontSize="sm">{result.output}</Text>;
}

function format_output(output: GraderResultOutput) {
  return format_basic_output({ output: output.output, output_format: output.format as "text" | "markdown" });
}

export default function GraderResults() {
  const { submissions_id } = useParams();
  const { query } = useShow<SubmissionWithGraderResultsAndErrors>({
    resource: "submissions",
    id: Number(submissions_id),
    meta: {
      select:
        "*, assignments(*), grader_results(*, grader_result_tests(*, grader_result_test_output(*)), grader_result_output(*)), workflow_run_error(*)"
    }
  });
  const isObfuscatedGradesMode = useObfuscatedGradesMode();
  const [showHiddenOutput, setShowHiddenOutput] = useState(!isObfuscatedGradesMode);
  useEffect(() => {
    setShowHiddenOutput(!isObfuscatedGradesMode);
  }, [isObfuscatedGradesMode]);
  if (query.isLoading) {
    return (
      <Box>
        <Skeleton height="100px" />
      </Box>
    );
  }
  if (query.error) {
    return (
      <Box>
        Error loading grader results
        {query.error.message}
      </Box>
    );
  }
  if (!query.data) {
    return <Box>No grader results found</Box>;
  }
  // Remove when we are certain we like the new error handling
  // if (query.data.data.grader_results?.errors) {
  //   const errors = query.data.data.grader_results.errors;
  //   const userVisibleMessage =
  //     typeof errors === "object" && "user_visible_message" in errors ? errors.user_visible_message : null;
  //   return (
  //     <Box>
  //       <Alert title="Submission Error" status="error" p={4} m={4}>
  //         An error occurred while creating the submission. Your code has not been submitted, although a record will
  //         still exist <Link href={`https://github.com/${query.data.data.repository}`}>in your GitHub repository</Link>.
  //         {userVisibleMessage && (
  //           <Box p={2} fontWeight="bold">
  //             Error: {String(userVisibleMessage)}
  //           </Box>
  //         )}
  //       </Alert>
  //     </Box>
  //   );
  // }
  if (query.data.data.workflow_run_error && query.data.data.workflow_run_error.length > 0) {
    const errors = query.data.data.workflow_run_error;

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
              An error occurred while processing your submission, but no user-visible error details are available. Your
              code has been submitted to{" "}
              <Link href={`https://github.com/${query.data.data.repository}`}>your GitHub repository</Link>.
              <Box mt={4}>
                <Text fontSize="sm">
                  Please check{" "}
                  <Link
                    href={`https://github.com/${query.data.data.repository}/actions/runs/${query.data.data.run_number}/attempts/${query.data.data.run_attempt}`}
                  >
                    the GitHub Actions run for this submission
                  </Link>{" "}
                  or contact your instructor for assistance.
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
            to see if it has completed, and share the link with your instructor.
          </Alert>
        </Box>
      </Container>
    );
  }
  const hasHiddenOutput = query.data.data.grader_results.grader_result_tests.some(
    (result) => result.grader_result_test_output.length > 0 || !result.is_released
  );
  const data = query.data.data;
  return (
    <Tabs.Root m={3} defaultValue="tests">
      <Tabs.List>
        <Tabs.Trigger value="tests">Test Results</Tabs.Trigger>
        {data.grader_results?.grader_result_output?.map((output) => (
          <Tabs.Trigger key={output.id} value={output.visibility}>
            {data.grader_results?.grader_result_output.length === 1
              ? "Output"
              : output.visibility === "visible"
                ? "Student Visible Output"
                : "Instructor-Only Debug Output"}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {data.grader_results?.grader_result_output?.map((output) => (
        <Tabs.Content key={output.id} value={output.visibility}>
          {format_output(output)}
        </Tabs.Content>
      ))}
      <Tabs.Content value="tests">
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
          {hasHiddenOutput && (
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
                const isNewPart = index > 0 && result.part !== data.grader_results?.grader_result_tests[index - 1].part;
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
            return (
              <CardRoot key={result.id} id={`test-${result.id}`} mt={4}>
                <CardHeader bg={`bg.${style}`} p={2}>
                  <Heading size="lg" color={`fg.${style}`}>
                    {result.name} {showScore ? result.score + "/" + result.max_score : ""}
                  </Heading>
                </CardHeader>
                {maybeWrappedResult(
                  <TestResultOutput
                    result={result}
                    testId={result.id}
                    extraData={result.extra_data as GraderResultTestExtraData}
                    submissionId={data.id}
                    classId={data.class_id}
                  />
                )}
                {hasInstructorOutput &&
                  result.grader_result_test_output.map((output) => (
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
                    </CardRoot>
                  ))}
              </CardRoot>
            );
          })}
      </Tabs.Content>
    </Tabs.Root>
  );
}

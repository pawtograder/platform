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
  Spinner,
  Table,
  Tabs,
  Text,
  Textarea,
  VStack
} from "@chakra-ui/react";
import { useShow } from "@refinedev/core";
import { formatDistanceToNow } from "date-fns";
import { useParams } from "next/navigation";
import { makeEmbed } from "@ironm00n/pyret-embed/api";
import { Fragment, useCallback, useEffect, useRef, useState, useId } from "react";
import { FaInfo, FaRobot, FaSpinner } from "react-icons/fa";
import * as Sentry from "@sentry/nextjs";
import { Tooltip } from "@/components/ui/tooltip";

import {
  GraderResultTestExtraData,
  GraderResultTestsHintFeedback,
  PyretReplConfig
} from "@/utils/supabase/DatabaseTypes";
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

      if (!response.ok) {
        // Try to parse JSON error response
        let errorMessage = "Failed to get Feedbot response";
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch {
          // If JSON parsing fails, use status-based error messages
          switch (response.status) {
            case 400:
              errorMessage = "Invalid request - please check the test configuration";
              break;
            case 401:
              errorMessage = "Authentication required - please refresh the page and try again";
              break;
            case 403:
              errorMessage = "Access denied - you may not have permission to access this feature";
              break;
            case 404:
              errorMessage = "Test result not found or access denied";
              break;
            case 429:
              errorMessage = "Rate limit exceeded.";
              break;
            case 500:
              errorMessage = "Server error - please try again later";
              break;
            default:
              errorMessage = `Request failed with status ${response.status}`;
          }
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || "Unexpected response format");
      }

      onHintGenerated(data.response);

      // If this was cached, we could show a different message
      if (data.cached) {
        // eslint-disable-next-line no-console
        console.log("Feedbot response was retrieved from cache");
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to get Feedbot response";
      // eslint-disable-next-line no-console
      console.error("LLM Hint Error:", err);
      setError(errorMessage);

      // Do NOT log 429 errors to Sentry
      if (err instanceof Error && err.message.startsWith("Rate limit:")) {
        return;
      }

      // Log to Sentry for debugging
      Sentry.captureException(err, {
        tags: {
          operation: "llm_hint_client",
          testId: testId.toString()
        },
        extra: {
          testId,
          errorMessage
        }
      });
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
  const [isSaving, setIsSaving] = useState(false);
  const { private_profile_id } = useClassProfiles();
  const debounceTimeoutRef = useRef<NodeJS.Timeout>();

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
          setHasSubmitted(true); // Show as submitted if feedback exists
        }
      } finally {
        setIsLoading(false);
      }
    };

    fetchExistingFeedback();
  }, [testId, classId, private_profile_id]);

  // Auto-save function
  const saveFeedback = useCallback(
    async (newUseful?: boolean | null, newComment?: string) => {
      const usefulToSave = newUseful !== undefined ? newUseful : useful;
      const commentToSave = newComment !== undefined ? newComment : comment;

      if (usefulToSave === null) return; // Don't save if no useful rating

      setIsSaving(true);
      setError(null);

      try {
        const supabase = createClient();

        if (existingFeedback) {
          // Update existing feedback
          const { data: updatedFeedback, error: updateError } = await supabase
            .from("grader_result_tests_hint_feedback")
            .update({
              useful: usefulToSave,
              comment: commentToSave.trim() || null
            })
            .eq("id", existingFeedback.id)
            .select()
            .single();

          if (updateError) {
            setError("Failed to save feedback: " + updateError.message);
            return;
          }

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
              useful: usefulToSave,
              comment: commentToSave.trim() || null,
              created_by: private_profile_id
            })
            .select()
            .single();

          if (insertError) {
            setError("Failed to save feedback: " + insertError.message);
            return;
          }

          if (newFeedback) {
            setExistingFeedback(newFeedback as unknown as GraderResultTestsHintFeedback);
          }
        }
      } catch (err) {
        Sentry.captureException(err);
        setError("An error occurred while saving feedback");
      } finally {
        setIsSaving(false);
      }
    },
    [useful, comment, existingFeedback, classId, testId, submissionId, hintText, private_profile_id]
  );

  // Handle thumbs up/down with immediate save
  const handleUsefulChange = useCallback(
    async (newUseful: boolean) => {
      setUseful(newUseful);
      await saveFeedback(newUseful, comment);
    },
    [saveFeedback, comment]
  );

  // Handle comment change with debounced save
  const handleCommentChange = useCallback(
    (newComment: string) => {
      setComment(newComment);

      // Clear existing timeout
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }

      // Set new timeout for 3 seconds
      debounceTimeoutRef.current = setTimeout(() => {
        if (useful !== null) {
          // Only save if useful rating exists
          saveFeedback(useful, newComment);
        }
      }, 3000);
    },
    [useful, saveFeedback]
  );

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  const handleSubmit = async () => {
    if (useful === null) return;

    setIsSubmitting(true);

    // Clear any pending debounced save
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    // Save immediately
    await saveFeedback();

    setHasSubmitted(true);
    setIsEditing(false);
    onFeedbackSubmitted?.();
    setIsSubmitting(false);
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
      <Box mt={4} p={3} bg="bg.subtle" borderRadius="md" borderLeft="4px solid" borderColor="green.500">
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

      <HStack justify="space-between" align="center" mb={3}>
        <HStack>
          <Button
            size="sm"
            variant={useful === true ? "surface" : "outline"}
            colorPalette={useful === true ? "green" : "gray"}
            onClick={() => handleUsefulChange(true)}
          >
            👍 Yes
          </Button>
          <Button
            size="sm"
            variant={useful === false ? "surface" : "outline"}
            colorPalette={useful === false ? "red" : "gray"}
            onClick={() => handleUsefulChange(false)}
          >
            👎 No
          </Button>
        </HStack>
        {isSaving && (
          <Text fontSize="xs" color="fg.muted">
            Saving...
          </Text>
        )}
      </HStack>

      <Textarea
        placeholder="Optional: Tell us more about your experience with this hint to help us improve..."
        value={comment}
        onChange={(e) => handleCommentChange(e.target.value)}
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
  const hasLLMPrompt = extraData?.llm?.prompt;

  return (
    <VStack align="stretch" gap={4}>
      {/* Always show the original output */}
      {format_basic_output(result)}

      {/* Show LLM section if there's a prompt */}
      {hasLLMPrompt && (
        <>
          {displayHint ? (
            /* Show Feedbot response if available */
            <Box
              fontSize="sm"
              overflowX="auto"
              border="1px solid"
              borderColor="border.emphasized"
              borderRadius="md"
              p={0}
            >
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
                  <HintFeedbackForm
                    testId={testId}
                    submissionId={submissionId}
                    classId={classId}
                    hintText={displayHint}
                  />
                )}
              </Box>
            </Box>
          ) : (
            /* Show hint button if no result yet */
            <Box fontSize="sm">
              <Text color="text.muted" mb={3}>
                Click below to generate response from Feedbot.
              </Text>
              {testId && <LLMHintButton testId={testId} onHintGenerated={setHintContent} />}
            </Box>
          )}
        </>
      )}
    </VStack>
  );
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
        aria-controls={regionId}
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

function GenericBuildError() {
  return (
    <Box mt={3} p={3} bg="bg.error" borderRadius="md" border="1px solid" borderColor="border.error">
      <Text fontWeight="bold" color="fg.error" fontSize="sm">
        Error: Gradle build failed
      </Text>
      <Box mt={2} p={2} bg="bg.error" borderRadius="sm">
        <Text color="fg.error">
          The autograding script failed to build your code. Please inspect the output below for more details:
        </Text>
      </Box>
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
  return (
    <Box>
      {hasBuildError && <GenericBuildError />}
      <Tabs.Root
        m={3}
        defaultValue={hasBuildError ? data.grader_results?.grader_result_output[0]?.visibility : "tests"}
      >
        <Tabs.List>
          {!hasBuildError && <Tabs.Trigger value="tests">Test Results</Tabs.Trigger>}
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
        {!hasBuildError && (
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

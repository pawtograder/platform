"use client";
import { Button } from "@/components/ui/button";
import { PopoverArrow, PopoverBody, PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import {
  SubmissionWithGraderResultsAndErrors,
  SubmissionWithGraderResultsAndFiles,
  SubmissionWithGraderResultsAndReview
} from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Heading, HStack, List, Skeleton, Table, Text, VStack } from "@chakra-ui/react";

import { AdjustDueDateDialog } from "@/app/course/[course_id]/manage/assignments/[assignment_id]/due-date-exceptions/page";
import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import { Alert } from "@/components/ui/alert";
import AskForHelpButton from "@/components/ui/ask-for-help-button";
import { DataListItem, DataListRoot } from "@/components/ui/data-list";
import Link from "@/components/ui/link";
import PersonName from "@/components/ui/person-name";
import { ListOfRubricsInSidebar, RubricCheckComment } from "@/components/ui/rubric-sidebar";
import StudentSummaryTrigger from "@/components/ui/student-summary";
import SubmissionReviewToolbar, { CompleteReviewButton } from "@/components/ui/submission-review-toolbar";
import { toaster, Toaster } from "@/components/ui/toaster";
import {
  useAssignmentController,
  useReviewAssignment,
  useReviewAssignmentRubricParts,
  useRubricById,
  useRubricParts
} from "@/hooks/useAssignment";
import { useIsGraderOrInstructor, useIsInstructor } from "@/hooks/useClassProfiles";
import {
  useAssignmentDueDate,
  useAssignmentGroupWithMembers,
  useCourse,
  useCourseController,
  useIsDroppedStudent
} from "@/hooks/useCourseController";
import {
  SubmissionProvider,
  useRubricCriteriaInstances,
  useSubmission,
  useSubmissionComments,
  useSubmissionController,
  useSubmissionReview,
  useSubmissionReviewOrGradingReview
} from "@/hooks/useSubmission";
import { useActiveReviewAssignmentId } from "@/hooks/useSubmissionReview";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { activateSubmission } from "@/lib/edgeFunctions";
import { formatDueDateInTimezone } from "@/lib/utils";
import { createClient } from "@/utils/supabase/client";
import { GraderResultTestExtraData } from "@/utils/supabase/DatabaseTypes";
import { Icon } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { CrudFilter, useInvalidate, useList } from "@refinedev/core";
import * as Sentry from "@sentry/nextjs";
import { format, formatRelative, isAfter } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import NextLink from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { ElementType as ReactElementType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BsFileEarmarkCodeFill, BsThreeDots } from "react-icons/bs";
import {
  FaBell,
  FaCheckCircle,
  FaFile,
  FaFileExport,
  FaHistory,
  FaInfo,
  FaQuestionCircle,
  FaRobot,
  FaTimesCircle
} from "react-icons/fa";
import { FiDownloadCloud, FiRepeat, FiSend } from "react-icons/fi";
import { HiOutlineInformationCircle } from "react-icons/hi";
import { LuMoon, LuSun } from "react-icons/lu";
import { PiSignOut } from "react-icons/pi";
import { RxQuestionMarkCircled } from "react-icons/rx";
import { TbMathFunction } from "react-icons/tb";
import { linkToSubPage } from "./utils";

// Create a mapping of icon names to their components
const iconMap: { [key: string]: ReactElementType } = {
  FaBell,
  FaCheckCircle,
  FaFile,
  FaHistory,
  FaQuestionCircle,
  FaTimesCircle,
  BsFileEarmarkCodeFill,
  BsThreeDots,
  HiOutlineInformationCircle,
  LuMoon,
  FaInfo,
  LuSun,
  TbMathFunction,
  RxQuestionMarkCircled,
  FiDownloadCloud,
  FiRepeat,
  FiSend,
  PiSignOut
};
function SubmissionReviewScoreTweak() {
  const submission = useSubmission();
  const reviewId = submission.grading_review_id;
  if (!reviewId) {
    throw new Error("No grading review ID found");
  }
  const review = useSubmissionReviewOrGradingReview(reviewId);
  const isInstructor = useIsInstructor();
  const [tweakValue, setTweakValue] = useState<number | undefined>(review?.tweak);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionController = useSubmissionController();

  const handleTweakChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "") {
      setTweakValue(undefined);
    } else {
      const num = Number(val);
      if (!isNaN(num)) {
        setTweakValue(num);
      }
    }
  }, []);

  const handleTweakSave = useCallback(async () => {
    if (!review) {
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      // Normalize undefined → null and skip if no change
      const original = review.tweak ?? null;
      const current = tweakValue ?? null;
      if (original === current) {
        setIsEditing(false);
        return;
      }
      await submissionController.submission_reviews.update(review.id, {
        tweak: current ?? 0
      });
      setIsEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save tweak");
    } finally {
      setIsSaving(false);
    }
  }, [review, tweakValue, submissionController]);

  const handleCancel = useCallback(() => {
    setTweakValue(review?.tweak);
    setIsEditing(false);
    setError(null);
  }, [review?.tweak]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleTweakSave();
      } else if (e.key === "Escape") {
        handleCancel();
      }
    },
    [handleTweakSave, handleCancel]
  );

  if (!review) {
    return <></>;
  }

  if (!isInstructor) {
    if (review.tweak) {
      return <Text>Includes instructor&apos;s tweak {review.tweak}</Text>;
    }
    return <></>;
  }

  if (isEditing) {
    return (
      <Box mt={2} mb={2}>
        <HStack align="center" gap={2}>
          <Text fontWeight="bold" fontSize="sm">
            Tweak:
          </Text>
          <input
            type="number"
            step="any"
            value={tweakValue ?? ""}
            onChange={handleTweakChange}
            onKeyDown={handleKeyDown}
            autoFocus
            style={{
              width: "80px",
              padding: "4px 8px",
              border: "1px solid #ccc",
              borderRadius: "4px",
              fontSize: "14px"
            }}
            aria-label="Tweak score"
          />
          <Button size="sm" variant="surface" onClick={handleTweakSave} loading={isSaving} disabled={isSaving}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={handleCancel} disabled={isSaving}>
            Cancel
          </Button>
        </HStack>
        {error && (
          <Text color="red.500" fontSize="sm" mt={1}>
            {error}
          </Text>
        )}
      </Box>
    );
  }

  // Display mode - show current tweak or placeholder
  return (
    <Box mt={2} mb={2}>
      <HStack align="center" gap={2}>
        <Text fontWeight="bold" fontSize="sm">
          Tweak:
        </Text>
        {review.tweak !== null && review.tweak !== undefined ? (
          <Text
            as="span"
            cursor="pointer"
            color="blue.500"
            textDecoration="underline"
            _hover={{ color: "blue.600" }}
            onClick={() => setIsEditing(true)}
            aria-label="Click to edit tweak"
          >
            {review.tweak}
          </Text>
        ) : (
          <Text
            as="span"
            cursor="pointer"
            color="gray.500"
            fontStyle="italic"
            _hover={{ color: "gray.600" }}
            onClick={() => setIsEditing(true)}
            aria-label="Click to add tweak"
          >
            Click to add tweak
          </Text>
        )}
      </HStack>
    </Box>
  );
}
// Select query for full submission data with grader results and test outputs
const FULL_SUBMISSION_SELECT =
  "*, grader_results(*, grader_result_tests(*, grader_result_test_output(*)), grader_result_output(*)), submission_reviews!submissions_grading_review_id_fkey(*), repository_check_runs!submissions_repository_check_run_id_fkey(commit_message)";

type FullSubmissionData = SubmissionWithGraderResultsAndErrors & {
  submission_reviews: SubmissionWithGraderResultsAndReview["submission_reviews"];
  repository_check_runs: { commit_message: string } | null;
};

function generateSubmissionMarkdown(
  submissions: FullSubmissionData[],
  assignmentTitle: string,
  studentName: string,
  groupName?: string
): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Submission Export: ${assignmentTitle}`);
  lines.push("");
  lines.push(`**Student/Group:** ${groupName ? `${groupName} (Group)` : studentName}`);
  lines.push(`**Export Date:** ${format(new Date(), "MMMM d, yyyy 'at' h:mm a")}`);
  lines.push(`**Total Submissions:** ${submissions.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Sort submissions by ordinal (most recent first)
  const sortedSubmissions = [...submissions].sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0));

  for (const sub of sortedSubmissions) {
    lines.push(`## Submission #${sub.ordinal}${sub.is_active ? " (Active)" : ""}`);
    lines.push("");

    // Metadata
    lines.push("### Metadata");
    lines.push("");
    lines.push(
      `- **Submitted:** ${sub.created_at ? format(new Date(sub.created_at), "MMMM d, yyyy 'at' h:mm:ss a") : "Unknown"}`
    );
    lines.push(`- **Commit:** \`${sub.sha}\``);
    lines.push(`- **Commit Message:** ${sub.repository_check_runs?.commit_message || "No message"}`);
    lines.push(`- **GitHub Link:** [View Commit](https://github.com/${sub.repository}/commit/${sub.sha})`);
    lines.push(
      `- **Status:** ${sub.is_active ? "Active (will be graded)" : sub.is_not_graded ? "Not for grading" : "Historical"}`
    );
    lines.push("");

    // Grader Results
    if (sub.grader_results) {
      const gr = sub.grader_results;
      lines.push("### Autograder Results");
      lines.push("");
      lines.push(`- **Score:** ${gr.score}/${gr.max_score}`);
      lines.push(`- **Lint Passed:** ${gr.lint_passed ? "Yes" : "No"}`);
      if (gr.execution_time) {
        lines.push(`- **Execution Time:** ${gr.execution_time}ms`);
      }
      lines.push("");

      // Lint Output
      if (gr.lint_output && gr.lint_output !== "Gradle build failed") {
        lines.push("#### Lint Output");
        lines.push("");
        lines.push("```");
        lines.push(gr.lint_output);
        lines.push("```");
        lines.push("");
      }

      // Grader Output (visible and hidden)
      if (gr.grader_result_output && gr.grader_result_output.length > 0) {
        lines.push("#### Grader Output");
        lines.push("");
        for (const output of gr.grader_result_output) {
          const visibility = output.visibility === "visible" ? "Student Visible" : "Instructor Only";
          lines.push(`##### ${visibility} Output`);
          lines.push("");
          if (output.format === "markdown") {
            lines.push(output.output || "No output");
          } else {
            lines.push("```");
            lines.push(output.output || "No output");
            lines.push("```");
          }
          lines.push("");
        }
      }

      // Test Results
      if (gr.grader_result_tests && gr.grader_result_tests.length > 0) {
        lines.push("#### Test Results");
        lines.push("");

        // Summary table
        lines.push("| Status | Test Name | Score |");
        lines.push("|--------|-----------|-------|");
        for (const test of gr.grader_result_tests) {
          const status = test.score === test.max_score ? "✅" : "❌";
          lines.push(`| ${status} | ${test.name} | ${test.score}/${test.max_score} |`);
        }
        lines.push("");

        // Detailed test output
        lines.push("#### Detailed Test Output");
        lines.push("");
        for (const test of gr.grader_result_tests) {
          const status = test.score === test.max_score ? "✅ PASSED" : "❌ FAILED";
          lines.push(`##### ${test.name} (${status})`);
          lines.push("");
          lines.push(`**Score:** ${test.score}/${test.max_score}`);
          if (test.part) {
            lines.push(`**Part:** ${test.part}`);
          }
          lines.push("");

          // Student-visible output
          if (test.output) {
            lines.push("**Student Output:**");
            lines.push("");
            if (test.output_format === "markdown") {
              lines.push(test.output);
            } else {
              lines.push("```");
              lines.push(test.output);
              lines.push("```");
            }
            lines.push("");
          }

          // Instructor-only test output
          if (test.grader_result_test_output && test.grader_result_test_output.length > 0) {
            for (const testOutput of test.grader_result_test_output) {
              lines.push("**Instructor-Only Output:**");
              lines.push("");
              if (testOutput.output_format === "markdown") {
                lines.push(testOutput.output || "No output");
              } else {
                lines.push("```");
                lines.push(testOutput.output || "No output");
                lines.push("```");
              }
              lines.push("");
            }
          }

          // LLM hint data if present
          const extraData = test.extra_data as GraderResultTestExtraData | null;
          if (extraData?.llm?.result) {
            lines.push("**Feedbot Response:**");
            lines.push("");
            lines.push(extraData.llm.result);
            lines.push("");
          }
        }
      }
    } else {
      lines.push("### Autograder Results");
      lines.push("");
      lines.push("*Autograder has not completed or no results available.*");
      lines.push("");
    }

    // Submission Review (if exists)
    if (sub.submission_reviews) {
      const review = sub.submission_reviews;
      lines.push("### Grading Review");
      lines.push("");
      lines.push(`- **Total Score:** ${review.total_score ?? "Not graded"}`);
      lines.push(`- **Released:** ${review.released ? "Yes" : "No"}`);
      if (review.completed_at) {
        lines.push(`- **Completed:** ${format(new Date(review.completed_at), "MMMM d, yyyy 'at' h:mm a")}`);
      }
      if (review.tweak != null) {
        lines.push(`- **Score Tweak:** ${review.tweak}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

function ExportSubmissionMetadataButton({ submission }: { submission: SubmissionWithGraderResultsAndFiles }) {
  const [isExporting, setIsExporting] = useState(false);
  const { assignment } = useAssignmentController();
  const supabase = useMemo(() => createClient(), []);

  // Get student/group info
  const submitterProfile = useUserProfile(submission.profile_id);
  const assignmentGroupWithMembers = useAssignmentGroupWithMembers({
    assignment_group_id: submission.assignment_group_id
  });

  const handleExport = useCallback(async () => {
    if (!assignment) {
      toaster.error({ title: "Error", description: "Assignment not loaded" });
      return;
    }

    setIsExporting(true);
    try {
      // Fetch all submissions with full grader data
      let query = supabase
        .from("submissions")
        .select(FULL_SUBMISSION_SELECT)
        .eq("assignment_id", submission.assignment_id);

      if (submission.assignment_group_id) {
        query = query.eq("assignment_group_id", submission.assignment_group_id);
      } else if (submission.profile_id) {
        query = query.eq("profile_id", submission.profile_id);
      } else {
        toaster.error({ title: "Error", description: "No profile or group ID found for submission" });
        return;
      }

      const { data: submissions, error } = await query.order("ordinal", { ascending: false });

      if (error) {
        throw new Error(`Failed to fetch submissions: ${error.message}`);
      }

      if (!submissions || submissions.length === 0) {
        toaster.error({ title: "No submissions found", description: "Could not find any submissions to export" });
        return;
      }

      // Generate student/group name
      let studentName = submitterProfile?.name || "Unknown Student";
      let groupName: string | undefined;

      if (assignmentGroupWithMembers) {
        groupName = assignmentGroupWithMembers.name || "Unnamed Group";
        // Group member names are just profile IDs in assignmentGroupsWithMembers, use the group name
        studentName = groupName;
      }

      // Generate the markdown
      const markdown = generateSubmissionMarkdown(
        submissions as FullSubmissionData[],
        assignment.title || "Untitled Assignment",
        studentName,
        groupName
      );

      // Create and download the file
      const blob = new Blob([markdown], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;

      // Generate filename
      const safeStudentName = (groupName || submitterProfile?.name || "student").replace(/[^a-zA-Z0-9]/g, "_");
      const safeAssignmentName = (assignment.slug || assignment.title || "assignment").replace(/[^a-zA-Z0-9]/g, "_");
      a.download = `submission_export_${safeAssignmentName}_${safeStudentName}_${format(new Date(), "yyyy-MM-dd")}.md`;

      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toaster.success({
        title: "Export complete",
        description: `Exported ${submissions.length} submission(s) to markdown`
      });
    } catch (err) {
      const errorId = Sentry.captureException(err);
      toaster.error({
        title: "Export failed",
        description: `Failed to export submissions. Error ID: ${errorId}`
      });
    } finally {
      setIsExporting(false);
    }
  }, [assignment, submission, supabase, submitterProfile, assignmentGroupWithMembers]);

  return (
    <Button variant="outline" onClick={handleExport} loading={isExporting} data-testid="export-submission-metadata">
      <Icon as={FaFileExport} />
      Export All Metadata
    </Button>
  );
}

function SubmissionHistoryContents({ submission }: { submission: SubmissionWithGraderResultsAndFiles }) {
  const groupOrProfileFilter: CrudFilter = submission.assignment_group_id
    ? {
        field: "assignment_group_id",
        operator: "eq",
        value: submission.assignment_group_id
      }
    : {
        field: "profile_id",
        operator: "eq",
        value: submission.profile_id
      };
  const invalidate = useInvalidate();
  const { assignment } = useAssignmentController();
  const { data, isLoading } = useList<SubmissionWithGraderResultsAndReview>({
    resource: "submissions",
    meta: {
      select: "*, grader_results(*), submission_reviews!submissions_grading_review_id_fkey(*)"
    },
    filters: [
      {
        field: "assignment_id",
        operator: "eq",
        value: submission.assignment_id
      },
      groupOrProfileFilter
    ],
    sorters: [
      {
        field: "created_at",
        order: "desc"
      }
    ],
    pagination: {
      pageSize: 1000
    }
  });
  const router = useRouter();
  const { time_zone } = useCourse();
  const [isActivating, setIsActivating] = useState(false);
  const pathname = usePathname();
  const isGraderInterface = pathname.includes("/grade");
  const { dueDate } = useAssignmentDueDate(assignment, {
    studentPrivateProfileId: submission.profile_id || undefined,
    assignmentGroupId: submission.assignment_group_id || undefined
  });
  const isStaff = useIsGraderOrInstructor();
  const now = TZDate.tz(time_zone ?? "America/New_York").getTime();
  const disableActivationButton = Boolean(dueDate && now > dueDate.getTime() && !isStaff);
  if (isLoading) {
    return <Skeleton height="100px" />;
  }
  return (
    <>
      <Text>Submission History</Text>
      <Box
        maxHeight="400px"
        overflowY="auto"
        css={{
          "&::-webkit-scrollbar": {
            width: "8px"
          },
          "&::-webkit-scrollbar-track": {
            background: "#f1f1f1",
            borderRadius: "4px"
          },
          "&::-webkit-scrollbar-thumb": {
            background: "#888",
            borderRadius: "4px"
          },
          "&::-webkit-scrollbar-thumb:hover": {
            background: "#555"
          }
        }}
      >
        <Toaster />
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>#</Table.ColumnHeader>
              <Table.ColumnHeader>Date</Table.ColumnHeader>
              <Table.ColumnHeader>Auto Grader Score</Table.ColumnHeader>
              <Table.ColumnHeader>Total Score</Table.ColumnHeader>
              <Table.ColumnHeader>Actions</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data?.data.map((historical_submission) => {
              const link = isGraderInterface
                ? `/course/${historical_submission.class_id}/grade/assignments/${historical_submission.assignment_id}/submissions/${historical_submission.id}`
                : `/course/${historical_submission.class_id}/assignments/${historical_submission.assignment_id}/submissions/${historical_submission.id}`;
              return (
                <Table.Row key={historical_submission.id} bg={pathname.startsWith(link) ? "bg.emphasized" : undefined}>
                  <Table.Cell>
                    <Link href={link}>
                      {historical_submission.is_active && <ActiveSubmissionIcon />}
                      {historical_submission.ordinal}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <Link href={link}>
                      {formatRelative(
                        new TZDate(
                          historical_submission.created_at || new Date().toUTCString(),
                          time_zone || "America/New_York"
                        ),
                        TZDate.tz(time_zone || "America/New_York")
                      )}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <Link href={link}>
                      {!historical_submission.grader_results
                        ? "In Progress"
                        : historical_submission.grader_results && historical_submission.grader_results.errors
                          ? "Error"
                          : `${historical_submission.grader_results?.score}/${historical_submission.grader_results?.max_score}`}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <Link href={link}>
                      {historical_submission.submission_reviews?.completed_at &&
                        historical_submission.submission_reviews?.total_score +
                          "/" +
                          (assignment?.total_points ?? <Skeleton height="20px" />)}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    {historical_submission.is_active ? (
                      <>This submission is active</>
                    ) : historical_submission.is_not_graded ? (
                      <>Not for grading</>
                    ) : (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={disableActivationButton}
                        loading={isActivating}
                        onClick={async () => {
                          setIsActivating(true);
                          try {
                            const supabase = createClient();
                            await activateSubmission({ submission_id: historical_submission.id }, supabase);
                            invalidate({ resource: "submissions", invalidates: ["list"] });
                            toaster.create({
                              title: "Active submission changed",
                              type: "success"
                            });
                            router.push(link);
                          } catch (error) {
                            const errorId = Sentry.captureException(error);
                            toaster.create({
                              title: "Error activating submission",
                              description: `We have recorded this error with trace ID: ${errorId}`,
                              type: "error"
                            });
                          } finally {
                            setIsActivating(false);
                          }
                        }}
                      >
                        <Icon as={FaCheckCircle} />
                        Activate
                      </Button>
                    )}
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      </Box>
    </>
  );
}
function SubmissionHistory({ submission }: { submission: SubmissionWithGraderResultsAndFiles }) {
  const invalidate = useInvalidate();
  const [hasNewSubmission, setHasNewSubmission] = useState<boolean>(false);
  const courseController = useCourseController();

  // TODO: Remove this once we migrate to TableController for submissions tracking
  // Listen for submission broadcasts to detect when a new active submission appears
  useEffect(() => {
    if (!courseController?.classRealTimeController) return;

    const unsubscribe = courseController.classRealTimeController.subscribe(
      { table: "submissions" },
      (message: import("@/lib/TableController").BroadcastMessage) => {
        // Check if this is a new/updated submission for the same student/group
        if (
          (message.operation === "INSERT" || message.operation === "UPDATE") &&
          message.data &&
          typeof message.data === "object" &&
          "is_active" in message.data &&
          message.data.is_active === true &&
          "id" in message.data &&
          message.data.id !== submission.id &&
          "assignment_id" in message.data &&
          message.data.assignment_id === submission.assignment_id
        ) {
          // Check if it's for the same student (individual) or group
          const isSameStudent =
            "profile_id" in message.data &&
            message.data.profile_id === submission.profile_id &&
            !message.data.assignment_group_id &&
            !submission.assignment_group_id;

          const isSameGroup =
            "assignment_group_id" in message.data &&
            message.data.assignment_group_id === submission.assignment_group_id &&
            message.data.assignment_group_id !== null;

          if (isSameStudent || isSameGroup) {
            // A new active submission appeared for this student/group
            setHasNewSubmission(true);
            // Invalidate to refetch the submission list
            invalidate({ resource: "submissions", invalidates: ["list"] });
          }
        }
      }
    );

    return () => {
      unsubscribe();
    };
  }, [
    courseController,
    submission.id,
    submission.assignment_id,
    submission.profile_id,
    submission.assignment_group_id,
    invalidate
  ]);

  return (
    <PopoverRoot lazyMount unmountOnExit>
      <PopoverTrigger asChild>
        <Button variant={hasNewSubmission ? "solid" : "outline"} colorPalette={hasNewSubmission ? "yellow" : "default"}>
          <Icon as={FaHistory} />
          Submission History
          {hasNewSubmission && <Icon as={FaBell} />}
        </Button>
      </PopoverTrigger>
      <PopoverContent minWidth={{ base: "none", md: "lg" }}>
        <PopoverArrow />
        <PopoverBody>
          <SubmissionHistoryContents submission={submission} />
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}

function TestResults() {
  const submission = useSubmission();
  const pathname = usePathname();
  const testResults = submission.grader_results?.grader_result_tests;
  const totalScore = testResults?.reduce((acc, test) => acc + (test.score || 0), 0);
  const totalMaxScore = testResults?.reduce((acc, test) => acc + (test.max_score || 0), 0);
  return (
    <Box>
      <Heading size="md" mt={2}>
        Automated Check Results ({totalScore}/{totalMaxScore})
      </Heading>
      {testResults?.map((test) => {
        let icon;
        const extraData = test.extra_data as GraderResultTestExtraData;
        if (extraData?.llm?.prompt || extraData?.llm?.result) {
          icon = <Icon as={FaRobot} />;
        } else if (extraData?.icon && iconMap[extraData.icon]) {
          icon = <Icon as={iconMap[extraData.icon]} />;
        } else if (test.score === 0 && test.max_score === 0) {
          icon = <Icon as={FaInfo} color="fg.info" />;
        } else if (test.score == test.max_score) {
          icon = <Icon as={FaCheckCircle} color="fg.success" />;
        } else {
          icon = <Icon as={FaTimesCircle} color="fg.error" />;
        }
        const showScore = extraData?.hide_score !== "true" && test.max_score !== 0;
        return (
          <Box key={test.id} border="1px solid" borderColor="border.emphasized" borderRadius="md" p={2} mt={2} w="100%">
            {icon}
            <Link href={linkToSubPage(pathname, "results") + `#test-${test.id}`}>
              <Heading size="sm">
                {test.name} {showScore ? test.score + "/" + test.max_score : ""}
              </Heading>
            </Link>
          </Box>
        );
      })}
    </Box>
  );
}
function ReviewStats() {
  const submission = useSubmission();
  const reviewId = submission.grading_review_id;
  if (!reviewId) {
    throw new Error("No grading review ID found");
  }
  const review = useSubmissionReviewOrGradingReview(reviewId);
  const { checked_by, completed_by, checked_at, completed_at } = review || {};
  const allRubricInstances = useRubricCriteriaInstances({
    review_id: review?.id,
    rubric_id: review?.rubric_id
  });
  const allGraders = new Set<string>();
  for (const instance of allRubricInstances) {
    allGraders.add(instance.author);
  }
  if (completed_by) {
    allGraders.delete(completed_by);
  }
  if (checked_by) {
    allGraders.delete(checked_by);
  }
  const mostRecentCreationOrEdit = allRubricInstances.reduce((acc, instance) => {
    return Math.max(acc, Date.parse(instance.created_at), Date.parse(instance.edited_at || ""));
  }, 0);
  const mostRecentGrader = allRubricInstances.find(
    (instance) => Date.parse(instance.created_at) === mostRecentCreationOrEdit
  )?.author;
  const isInstructor = useIsInstructor();
  if (!review) {
    return <Skeleton height="20px" />;
  }
  return (
    <DataListRoot orientation="horizontal">
      {isInstructor && (
        <DataListItem
          label="Released to student"
          value={
            <HStack>
              {review.released ? "Yes" : "No"} <ReleaseOrUnreleaseReviewButton submissionReviewId={review.id} />
            </HStack>
          }
        />
      )}
      {!isInstructor && <DataListItem label="Released to student" value={review.released ? "Yes" : "No"} />}
      {completed_by && <DataListItem label="Completed by" value={<PersonName size="2xs" uid={completed_by} />} />}
      {completed_at && <DataListItem label="Completed at" value={formatRelative(completed_at, new Date())} />}
      {checked_by && <DataListItem label="Checked by" value={<PersonName size="2xs" uid={checked_by} />} />}
      {checked_at && <DataListItem label="Checked at" value={formatRelative(checked_at, new Date())} />}
      {mostRecentGrader && (
        <DataListItem label="Last updated by" value={<PersonName size="2xs" uid={mostRecentGrader} />} />
      )}
      {allGraders.size > 0 && (
        <DataListItem
          label="Other graders"
          value={Array.from(allGraders).map((grader) => (
            <PersonName size="2xs" key={grader} uid={grader} />
          ))}
        />
      )}
    </DataListRoot>
  );
}
function ReleaseOrUnreleaseReviewButton({ submissionReviewId }: { submissionReviewId: number }) {
  const review = useSubmissionReview(submissionReviewId);
  const submissionController = useSubmissionController();
  const [updatingReview, setUpdatingReview] = useState(false);
  if (review?.released) {
    return (
      <Button
        size="xs"
        variant="outline"
        colorPalette="red"
        loading={updatingReview}
        onClick={async () => {
          setUpdatingReview(true);
          try {
            await submissionController.submission_reviews.update(submissionReviewId, { released: false });
            toaster.create({
              title: "Review unreleased",
              type: "success"
            });
          } catch (error) {
            const errorId = Sentry.captureException(error);
            toaster.create({
              title: "Error unreleasing review",
              description: `Failed to unrelease the review. Please try again. We have recorded this error with trace ID: ${errorId}`,
              type: "error"
            });
          } finally {
            setUpdatingReview(false);
          }
        }}
      >
        Unrelease
      </Button>
    );
  } else {
    return (
      <Button
        size="xs"
        variant="outline"
        colorPalette="green"
        loading={updatingReview}
        onClick={async () => {
          setUpdatingReview(true);
          try {
            await submissionController.submission_reviews.update(submissionReviewId, { released: true });
            toaster.create({
              title: "Review released",
              type: "success"
            });
          } catch (error) {
            const errorId = Sentry.captureException(error);
            toaster.create({
              title: "Error releasing review",
              description: `Failed to release the review. Please try again. We have recorded this error with trace ID: ${errorId}`,
              type: "error"
            });
          } finally {
            setUpdatingReview(false);
          }
        }}
      >
        Release
      </Button>
    );
  }
}
function ReviewActions() {
  const submission = useSubmission();
  const reviewId = submission.grading_review_id;
  if (!reviewId) {
    throw new Error("No grading review ID found");
  }
  const review = useSubmissionReviewOrGradingReview(reviewId);

  const activeReviewAssignmentId = useActiveReviewAssignmentId();
  const assignedRubricParts = useReviewAssignmentRubricParts(activeReviewAssignmentId);
  const isInstructorOrGrader = useIsGraderOrInstructor();
  const showCompleteReviewButton = assignedRubricParts.length == 0 && isInstructorOrGrader;
  if (!review) {
    return <Skeleton height="20px" />;
  }
  return (
    <VStack>
      <Toaster />
      <ReviewStats />
      {showCompleteReviewButton && !review.completed_at && (
        <VStack>
          <Heading size="md">Submission Review Actions</Heading>
          <HStack w="100%" justify="space-between">
            {!review.completed_at && <CompleteReviewButton />}
            {/* {review.completed_at && !review.checked_at && private_profile_id !== review.completed_by && (
              <Button
                variant="surface"
                loading={updatingReview}
                onClick={async () => {
                  try {
                    setUpdatingReview(true);
                    await submissionController.submission_reviews.update(review.id, {
                      checked_at: new Date().toISOString(),
                      checked_by: private_profile_id
                    });
                  } finally {
                    setUpdatingReview(false);
                  }
                }}
              >
                Mark as Checked
              </Button>
            )} */}
          </HStack>
        </VStack>
      )}
    </VStack>
  );
}
function UnGradedGradingSummary() {
  const submission = useSubmission();
  const { assignment } = useAssignmentController();
  const graderResultsMaxScore = submission.grader_results?.max_score;
  const totalMaxScore = assignment.total_points;

  return (
    <Box>
      <Heading size="xl">Grading Summary</Heading>
      <Text color="text.muted" fontSize="sm">
        This assignment is worth a total of {totalMaxScore} points, broken down as follows:
      </Text>
      <List.Root as="ul" fontSize="sm" color="text.muted">
        {assignment.autograder_points !== null && assignment.total_points !== null && (
          <List.Item>
            <Text as="span" fontWeight="bold">
              Hand Grading:
            </Text>{" "}
            {assignment.total_points - assignment.autograder_points} points. This has not been graded yet.
          </List.Item>
        )}
        <List.Item>
          <Text as="span" fontWeight="bold">
            Automated Checks:
          </Text>{" "}
          {graderResultsMaxScore} points, results shown below.
        </List.Item>
        {graderResultsMaxScore !== undefined && totalMaxScore !== null && graderResultsMaxScore > totalMaxScore && (
          <List.Item>
            <Text as="span" fontWeight="bold">
              Hidden Automated Checks:
            </Text>{" "}
            {graderResultsMaxScore - totalMaxScore} points will be awarded by automated tests that are not shown until
            after grading is complete.
          </List.Item>
        )}
      </List.Root>
    </Box>
  );
}

function RubricView() {
  const submission = useSubmission();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const activeReviewAssignmentId = useActiveReviewAssignmentId();
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const course = useCourse();

  const reviewAssignment = useReviewAssignment(activeReviewAssignmentId);
  const rubric = useRubricById(reviewAssignment?.rubric_id);
  const assignedParts = useReviewAssignmentRubricParts(activeReviewAssignmentId);
  const allParts = useRubricParts(reviewAssignment?.rubric_id);
  const rubricPartsAdvice = useMemo(() => {
    return assignedParts?.map((part) => allParts?.find((p) => p.id === part.rubric_part_id)?.name).join(", ");
  }, [assignedParts, allParts]);

  const reviewId = submission.grading_review_id;
  if (!reviewId) {
    throw new Error("No grading review ID found");
  }
  const gradingReview = useSubmissionReviewOrGradingReview(reviewId);
  const { assignment } = useAssignmentController();

  return (
    <Box
      position="sticky"
      top="0"
      borderTopWidth={{ base: "1px", lg: "0" }}
      borderLeftWidth={{ base: "0", lg: "1px" }}
      borderColor="border.emphasized"
      padding="2"
      height="100vh"
      overflowX="hidden"
      overflowY="auto"
      ref={scrollRootRef}
    >
      <VStack align="start" gap={2}>
        {reviewAssignment === undefined && activeReviewAssignmentId && <Skeleton height="100px" />}
        {activeReviewAssignmentId && reviewAssignment && (
          <Box mb={2} p={2} borderWidth="1px" borderRadius="md" borderColor="border.default">
            <Heading size="md">
              Review Task: {rubric?.name} ({rubric?.review_round})
            </Heading>
            {rubricPartsAdvice && <Text fontSize="sm">Only grading rubric part(s): {rubricPartsAdvice}</Text>}
            <Text fontSize="sm">Assigned to: {reviewAssignment.assignee_profile_id || "N/A"}</Text>
            <Text fontSize="sm" data-visual-test="blackout">
              Due:{" "}
              {reviewAssignment.due_date
                ? formatDueDateInTimezone(
                    reviewAssignment.due_date,
                    course.time_zone ?? "America/New_York",
                    false,
                    false
                  )
                : "N/A"}
            </Text>
            {reviewAssignment.release_date && (
              <Text fontSize="sm">
                Grading visible to student after:{" "}
                {formatDueDateInTimezone(
                  reviewAssignment.release_date,
                  course.time_zone ?? "America/New_York",
                  false,
                  false
                )}
              </Text>
            )}
          </Box>
        )}
        {assignment.total_points !== null &&
          gradingReview &&
          gradingReview.total_score !== null &&
          gradingReview.total_score !== undefined && (
            <Heading size="xl">
              Overall Score ({gradingReview.total_score}/{assignment.total_points})
            </Heading>
          )}
        <SubmissionReviewScoreTweak />
        {!activeReviewAssignmentId && !gradingReview && <UnGradedGradingSummary />}
        {isGraderOrInstructor && <ReviewActions />}
        <TestResults />
        <ListOfRubricsInSidebar scrollRootRef={scrollRootRef} />
        <Comments />
      </VStack>
    </Box>
  );
}

function Comments() {
  const comments = useSubmissionComments({}).filter((comment) => !comment.rubric_check_id);
  if (!comments || comments.length === 0) {
    return null;
  }
  return (
    <Box>
      <Heading size="md">Comments</Heading>
      <VStack align="start" gap={2}>
        {comments.map((comment) => (
          <RubricCheckComment key={comment.id} comment_id={comment.id} comment_type="submission" />
        ))}
      </VStack>
    </Box>
  );
}

function SubmissionsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { course_id } = useParams();
  const submission = useSubmission();
  const submitter = useUserProfile(submission.profile_id);
  const assignmentGroupWithMembers = useAssignmentGroupWithMembers({
    assignment_group_id: submission.assignment_group_id
  });
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const isInstructor = useIsInstructor();
  const { assignment } = useAssignmentController();
  const { dueDate, hoursExtended, time_zone } = useAssignmentDueDate(assignment, {
    studentPrivateProfileId: submission.profile_id || undefined,
    assignmentGroupId: submission.assignment_group_id || undefined
  });
  const safeTimeZone = time_zone || "UTC";
  const hasExtension = hoursExtended && hoursExtended > 0;
  const canStillSubmit = dueDate && isAfter(dueDate, new TZDate(new Date(), safeTimeZone));
  const isDroppedStudent = useIsDroppedStudent(submission.profile_id);
  useEffect(() => {
    if (isGraderOrInstructor) {
      document.title = `${assignment?.title} - ${submitter?.name} - Pawtograder`;
    } else if (!isGraderOrInstructor) {
      document.title = `${assignment?.title} - Submission #${submission.ordinal} - Pawtograder`;
    }
  }, [assignment, isGraderOrInstructor, submitter, submission]);
  return (
    <Flex direction="column" minW="0px">
      {isGraderOrInstructor && dueDate && (
        <Box border={hasExtension ? "1px solid" : "none"} borderColor="border.warning" p={2} borderRadius="md">
          Student&apos;s Due Date: {formatInTimeZone(dueDate, time_zone, "MMM d h:mm aaa")}
          <AdjustDueDateDialog student_id={submission.profile_id || ""} assignment={assignment} />
          {Boolean(hasExtension) && ` (${hoursExtended}-hour extension applied)`}
          {canStillSubmit && (
            <Alert status="warning">
              The student can still make a new submission, grading checks will not transfer. Only begin grading this
              submission if you are certain that the student will not make new submissions.
            </Alert>
          )}
        </Box>
      )}
      <SubmissionReviewToolbar />
      <Flex px={4} py={2} gap="2" alignItems="center" justify="space-between" align="center" wrap="wrap">
        <Box>
          <VStack align="flex-start">
            <HStack gap={1}>
              {submission.is_active && <ActiveSubmissionIcon />}
              {assignmentGroupWithMembers ? (
                <HStack gap={1}>
                  Group {assignmentGroupWithMembers.name} (
                  {assignmentGroupWithMembers.assignment_groups_members.map((member) => (
                    <HStack key={member.profile_id} gap={1}>
                      <PersonName key={member.profile_id} uid={member.profile_id} showAvatar={false} />
                      <StudentSummaryTrigger
                        key={member.profile_id}
                        student_id={member.profile_id}
                        course_id={parseInt(course_id as string, 10)}
                      />
                    </HStack>
                  ))}
                  )
                </HStack>
              ) : (
                <>
                  <Text>{submitter?.name}</Text>{" "}
                  {isGraderOrInstructor && submission.profile_id && (
                    <StudentSummaryTrigger
                      student_id={submission.profile_id}
                      course_id={parseInt(course_id as string, 10)}
                    />
                  )}
                </>
              )}
              - Submission #{submission.ordinal}
              {isDroppedStudent && (
                <Text color="fg.inverted" bg="bg.inverted">
                  (Dropped)
                </Text>
              )}
            </HStack>
            <HStack gap={1}>
              <Link href={`https://github.com/${submission.repository}/commit/${submission.sha}`} target="_blank">
                Commit {submission.sha.substring(0, 7)}
              </Link>
              <Link href={`https://github.com/${submission.repository}/archive/${submission.sha}.zip`} target="_blank">
                (Download)
              </Link>
            </HStack>
          </VStack>
        </Box>
        {submission.is_not_graded && (
          <Box flexShrink={1} maxW="lg" rounded="sm" bg="fg.warning" color="fg.inverted" p={2} textAlign="center" m={0}>
            <Heading size="md">Viewing a not-for-grading submission.</Heading>
            <Text fontSize="xs">
              This submission was created with #NOT-GRADED in the commit message and cannot ever become active. It will
              not be graded. You can still see autograder feedback.
            </Text>
          </Box>
        )}
        {!submission.is_active && !submission.is_not_graded && (
          <Box rounded="sm" bg="red.fg" color="fg.inverted" px={6} py={2} textAlign="center" m={0}>
            <Heading size="md">Viewing a previous submission.</Heading>
            <Text fontSize="xs">
              Use the submission history to view or change the active submission. The active submission is the one that
              will be graded.
            </Text>
          </Box>
        )}
        <HStack>
          <AskForHelpButton />
          <SubmissionHistory submission={submission} />
          {isInstructor && <ExportSubmissionMetadataButton submission={submission} />}
        </HStack>
      </Flex>

      <Box
        p={0}
        m={0}
        borderBottomColor="border.emphasized"
        borderBottomWidth="2px"
        bg="bg.muted"
        defaultValue="results"
      >
        <NextLink href={linkToSubPage(pathname, "results", searchParams)}>
          <Button variant={pathname.includes("/results") ? "solid" : "ghost"}>
            <Icon as={FaCheckCircle} />
            Grading Summary
          </Button>
        </NextLink>
        <NextLink href={linkToSubPage(pathname, "files", searchParams)}>
          <Button variant={pathname.includes("/files") ? "solid" : "ghost"}>
            <Icon as={FaFile} />
            Files
          </Button>
        </NextLink>
      </Box>
      <Flex flexDirection={"row"} wrap="wrap">
        <Box flex={{ base: "1 1 100%", lg: "1 1 0" }} minWidth={0} pr={4}>
          {children}
        </Box>
        <Box flex={{ base: "0 0 100%", lg: "0 0 28rem" }}>
          <RubricView />
        </Box>
      </Flex>
    </Flex>
  );
}

export default function SubmissionsLayoutWrapper({ children }: { children: React.ReactNode }) {
  const { submissions_id } = useParams();
  return (
    <SubmissionProvider submission_id={Number(submissions_id)}>
      <SubmissionsLayout>{children}</SubmissionsLayout>
    </SubmissionProvider>
  );
}

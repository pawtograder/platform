"use client";

import { Button } from "@/components/ui/button";
import {
  DialogActionTrigger,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { toaster, Toaster } from "@/components/ui/toaster";
import PersonName from "@/components/ui/person-name";
import { Checkbox } from "@/components/ui/checkbox";
import { useAssignmentController } from "@/hooks/useAssignment";
import { useCourseController } from "@/hooks/useCourseController";
import { createClient } from "@/utils/supabase/client";
import * as Sentry from "@sentry/nextjs";
import {
  Badge,
  Box,
  Container,
  Field,
  Heading,
  HStack,
  Input,
  Separator,
  Spinner,
  Table,
  Text,
  Textarea,
  VStack
} from "@chakra-ui/react";
import { format } from "date-fns";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FaEnvelope, FaCopy } from "react-icons/fa";

type GradingProgressRow = {
  profile_id: string;
  name: string;
  email: string;
  pending_count: number;
  completed_count: number;
  submissions_with_comments: number;
  earliest_due_date: string | null;
};

export default function GradingProgressPage() {
  const { course_id, assignment_id } = useParams();
  const supabase = createClient();
  const controller = useAssignmentController();
  const assignment = controller.assignment;
  const { course } = useCourseController();
  const [progressData, setProgressData] = useState<GradingProgressRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEmailDialogOpen, setIsEmailDialogOpen] = useState(false);
  const [deadlineDate, setDeadlineDate] = useState<string>("");
  const [emailContent, setEmailContent] = useState<string>("");
  const [showTAsWithNoAssignments, setShowTAsWithNoAssignments] = useState(false);

  const timeZone = course.time_zone ?? "America/New_York";

  // Filter data based on filters
  const filteredProgressData = useMemo(() => {
    return progressData.filter((row) => {
      // By default, hide TAs with no assignments
      if (!showTAsWithNoAssignments) {
        const hasAssignments = row.pending_count > 0 || row.completed_count > 0;
        if (!hasAssignments) return false;
      }
      return true;
    });
  }, [progressData, showTAsWithNoAssignments]);

  // Fetch grading progress data
  useEffect(() => {
    const fetchProgress = async () => {
      if (!course_id || !assignment_id) return;

      setIsLoading(true);
      setError(null);

      try {
        const { data, error: rpcError } = await supabase.rpc("get_grading_progress_for_assignment", {
          p_class_id: Number(course_id),
          p_assignment_id: Number(assignment_id)
        });

        if (rpcError) {
          Sentry.captureException(rpcError);
          setError(rpcError.message);
          return;
        }

        setProgressData((data as GradingProgressRow[]) ?? []);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to load grading progress";
        Sentry.captureException(err);
        setError(errorMessage);
      } finally {
        setIsLoading(false);
      }
    };

    void fetchProgress();
  }, [course_id, assignment_id, supabase]);

  // Calculate completion percentage
  const getCompletionPercentage = useCallback((row: GradingProgressRow): number => {
    const total = row.pending_count + row.completed_count;
    if (total === 0) return 0;
    return Math.round((row.completed_count / total) * 100);
  }, []);

  // Get status badge color
  const getStatusBadge = useCallback(
    (row: GradingProgressRow) => {
      const percentage = getCompletionPercentage(row);
      const hasPending = row.pending_count > 0;
      const earliestDue = row.earliest_due_date ? new Date(row.earliest_due_date) : null;
      const isOverdue = earliestDue && earliestDue < new Date();

      if (percentage === 100) {
        return <Badge colorPalette="green">Complete</Badge>;
      } else if (isOverdue) {
        return <Badge colorPalette="red">Overdue</Badge>;
      } else if (hasPending) {
        return <Badge colorPalette="yellow">In Progress</Badge>;
      } else {
        return <Badge colorPalette="gray">No Assignments</Badge>;
      }
    },
    [getCompletionPercentage]
  );

  // Generate reminder email
  const generateReminderEmail = useCallback(() => {
    if (!assignment) return;

    const incompleteTAs = progressData.filter((row) => row.pending_count > 0);

    // Calculate summary statistics
    const doneTAs = progressData.filter((row) => row.completed_count > 0 && row.pending_count === 0);
    const startedTAs = progressData.filter((row) => row.completed_count > 0 && row.pending_count > 0);
    const notStartedTAs = progressData.filter((row) => row.completed_count === 0 && row.pending_count > 0);

    // Format deadline date
    const deadlineFormatted = deadlineDate
      ? format(new Date(deadlineDate), "EEEE, MMMM d, yyyy 'at' h:mm a")
      : "the deadline";

    // Build email addresses for incomplete TAs
    const incompleteEmails = incompleteTAs
      .map((ta) => ta.email)
      .filter(Boolean)
      .join(", ");

    // Build summary table
    const summaryRows = progressData
      .map((row) => {
        const total = row.pending_count + row.completed_count;
        const percentage = total > 0 ? Math.round((row.completed_count / total) * 100) : 0;
        return `  ${row.name.padEnd(30)} ${row.pending_count.toString().padStart(3)} pending, ${row.completed_count.toString().padStart(3)} completed (${percentage}% done)`;
      })
      .join("\n");

    const emailRecipientsNote =
      incompleteEmails.length > 0
        ? `\nNOTE: Send this email to TAs with incomplete grading: ${incompleteEmails}\n`
        : "\nNOTE: All TAs have completed their grading assignments.\n";

    const doneTAsNames = doneTAs.map((ta) => ta.name).join(", ");
    const doneTAsThanks = doneTAs.length > 0 ? `\nThank you to ${doneTAsNames} for completing all your grading assignments!` : "";

    const email = `Subject: Grading Reminder: ${assignment.title} - Due ${deadlineFormatted}${emailRecipientsNote}
Hi TAs,

This is a reminder about completing your grading assignments for "${assignment.title}".

SUMMARY:
- ${doneTAs.length} TA${doneTAs.length !== 1 ? "s are" : " is"} done (all assignments completed)
- ${startedTAs.length} TA${startedTAs.length !== 1 ? "s have" : " has"} started (some completed, some pending)
- ${notStartedTAs.length} TA${notStartedTAs.length !== 1 ? "s have" : " has"} not started (no assignments completed)
${doneTAsThanks}

GRADING PROGRESS SUMMARY:
${summaryRows}

DEADLINE REMINDER:
Please complete all assigned grading by ${deadlineFormatted}.

Why the deadline matters:
- Students are waiting for feedback on their work. Timely feedback is essential for their learning and helps them understand what they did well and what they can improve before the next assignment.
- Our class operates on a busy schedule with multiple assignments and deadlines. Delays in grading can cascade and impact the entire course timeline, making it harder for students to stay on track.

IMPORTANT - MARKING ASSIGNMENTS AS COMPLETE:
When you finish grading a student's submission, please remember to click "Complete Review Assignment" in the grading interface. This validates your work and marks the assignment as complete in our system. Without clicking this button, the assignment will remain marked as pending even if you've added all your comments and scores.

IMPORTANT - COMMUNICATION POLICY:
We understand that sometimes unexpected circumstances arise. If you anticipate that you will not be able to meet the deadline, please communicate with us as soon as possible. If you let us know ahead of time that you can't make the deadline, we can adapt and there will be no warning.

However, if you miss the deadline without prior communication:
- First violation: You will receive a warning and we will schedule a coaching session to discuss how to improve time management and meet deadlines.
- After the first warning: Further violations may result in termination.

The key is communication - if you communicate proactively, we can work together to find a solution. If you don't communicate, the consequences are more serious.

If you have any questions or concerns, please reach out to us immediately.

Thank you to everyone for your hard work on this assignment. We recognize that grading is a major effort and we appreciate the time and care you put into providing thoughtful feedback to students.

Best regards,
Course Staff`;

    setEmailContent(email);
  }, [assignment, progressData, deadlineDate]);

  // Copy email to clipboard
  const copyEmailToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(emailContent);
      toaster.success({
        title: "Email copied",
        description: "The reminder email has been copied to your clipboard."
      });
    } catch (err) {
      Sentry.captureException(err);
      toaster.error({
        title: "Failed to copy",
        description: "Could not copy email to clipboard. Please select and copy manually."
      });
    }
  }, [emailContent]);

  // Initialize deadline date when dialog opens
  useEffect(() => {
    if (isEmailDialogOpen && !deadlineDate && assignment?.due_date) {
      // Set to assignment due date + 7 days (typical grading deadline)
      const dueDate = new Date(assignment.due_date);
      dueDate.setDate(dueDate.getDate() + 7);
      setDeadlineDate(dueDate.toISOString().slice(0, 16)); // Format for datetime-local input
    }
  }, [isEmailDialogOpen, deadlineDate, assignment]);

  // Generate email when dialog opens or data changes
  useEffect(() => {
    if (isEmailDialogOpen && progressData.length > 0) {
      generateReminderEmail();
    }
  }, [isEmailDialogOpen, progressData, generateReminderEmail]);

  if (isLoading) {
    return (
      <Container maxW="container.xl" py={4}>
        <Spinner />
      </Container>
    );
  }

  if (error) {
    return (
      <Container maxW="container.xl" py={4}>
        <Text color="red.500">Error loading grading progress: {error}</Text>
      </Container>
    );
  }

  const incompleteCount = progressData.filter((row) => row.pending_count > 0).length;
  const totalTAs = progressData.length;

  return (
    <Container maxW="container.xl" py={4}>
      <Toaster />
      <VStack align="stretch" gap={4}>
        <HStack justify="space-between" align="center">
          <Heading size="lg">Grading Progress Dashboard</Heading>
          <DialogRoot open={isEmailDialogOpen} onOpenChange={(e) => setIsEmailDialogOpen(e.open)}>
            <DialogTrigger asChild>
              <Button variant="outline" colorPalette="blue">
                <FaEnvelope style={{ marginRight: "8px" }} />
                Generate Reminder Email
              </Button>
            </DialogTrigger>
            <DialogContent maxW="4xl">
              <DialogHeader>
                <DialogTitle>Generate Reminder Email</DialogTitle>
              </DialogHeader>
              <DialogBody>
                <VStack align="stretch" gap={4}>
                  <Field.Root>
                    <Field.Label>Deadline Date & Time</Field.Label>
                    <Input
                      type="datetime-local"
                      value={deadlineDate}
                      onChange={(e) => setDeadlineDate(e.target.value)}
                    />
                    <Field.HelperText>
                      The deadline to include in the reminder email. Defaults to assignment due date + 7 days.
                    </Field.HelperText>
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>Email Content (Ready to Copy/Paste)</Field.Label>
                    <Textarea
                      value={emailContent}
                      onChange={(e) => setEmailContent(e.target.value)}
                      rows={20}
                      fontFamily="mono"
                      fontSize="sm"
                    />
                    <Field.HelperText>
                      Review and edit the email content as needed, then click "Copy to Clipboard" to copy it.
                    </Field.HelperText>
                  </Field.Root>
                </VStack>
              </DialogBody>
              <DialogFooter>
                <DialogActionTrigger asChild>
                  <Button variant="outline">Close</Button>
                </DialogActionTrigger>
                <Button onClick={copyEmailToClipboard} colorPalette="blue">
                  <FaCopy style={{ marginRight: "8px" }} />
                  Copy to Clipboard
                </Button>
              </DialogFooter>
            </DialogContent>
          </DialogRoot>
        </HStack>

        <Separator />

        {assignment && (
          <Box>
            <Text fontSize="lg" fontWeight="bold" mb={2}>
              {assignment.title}
            </Text>
            <Text color="fg.subtle" fontSize="sm">
              {incompleteCount} of {totalTAs} TAs have incomplete grading assignments
            </Text>
          </Box>
        )}

        <HStack gap={4} mb={2}>
          <Checkbox
            checked={showTAsWithNoAssignments}
            onCheckedChange={(e) => setShowTAsWithNoAssignments(e.checked ?? false)}
          >
            Show TAs with no assignments
          </Checkbox>
        </HStack>

        <Table.Root size="sm" variant="outline">
          <Table.Header>
            <Table.Row bg="bg.subtle">
              <Table.ColumnHeader>TA Name</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Pending</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Completed</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Submissions with Comments</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Completion %</Table.ColumnHeader>
              <Table.ColumnHeader>Status</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {filteredProgressData.length === 0 ? (
              <Table.Row>
                <Table.Cell colSpan={6} textAlign="center" py={8}>
                  <Text color="fg.subtle">
                    {progressData.length === 0
                      ? "No graders found for this assignment"
                      : "No TAs match the current filters"}
                  </Text>
                </Table.Cell>
              </Table.Row>
            ) : (
              filteredProgressData.map((row) => {
                const percentage = getCompletionPercentage(row);

                return (
                  <Table.Row key={row.profile_id}>
                    <Table.Cell>
                      <PersonName uid={row.profile_id} showAvatar={false} />
                    </Table.Cell>
                    <Table.Cell textAlign="center">
                      <Badge
                        colorPalette={
                          row.pending_count === row.pending_count + row.completed_count && row.pending_count > 0
                            ? "red"
                            : row.pending_count > 0
                              ? "yellow"
                              : "gray"
                        }
                      >
                        {row.pending_count}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell textAlign="center">
                      <Badge colorPalette={row.completed_count === 0 ? "red" : "green"}>
                        {row.completed_count}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell textAlign="center">{row.submissions_with_comments}</Table.Cell>
                    <Table.Cell textAlign="center">
                      <Box>
                        <Text fontWeight="bold">{percentage}%</Text>
                        <Box w="100px" h="8px" bg="bg.subtle" borderRadius="full" overflow="hidden" mx="auto" mt={1}>
                          <Box
                            w={`${percentage}%`}
                            h="100%"
                            bg={percentage === 100 ? "green.500" : percentage >= 50 ? "yellow.500" : "red.500"}
                            transition="width 0.3s"
                          />
                        </Box>
                      </Box>
                    </Table.Cell>
                    <Table.Cell>{getStatusBadge(row)}</Table.Cell>
                  </Table.Row>
                );
              })
            )}
          </Table.Body>
        </Table.Root>
      </VStack>
    </Container>
  );
}

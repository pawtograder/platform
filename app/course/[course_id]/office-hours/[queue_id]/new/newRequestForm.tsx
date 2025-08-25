"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import StudentGroupPicker from "@/components/ui/student-group-picker";
import { toaster, Toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import {
  useHelpRequests,
  useHelpRequestStudents,
  useHelpRequestTemplates,
  useHelpQueues,
  useOfficeHoursController
} from "@/hooks/useOfficeHoursRealtime";
import {
  Assignment,
  HelpRequest,
  HelpRequestLocationType,
  HelpRequestTemplate,
  HelpRequestMessage,
  HelpRequestWithStudentCount,
  Submission,
  SubmissionFile
} from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Fieldset, Heading, IconButton, Input, Stack, Text, Textarea } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { Select } from "chakra-react-select";
import { X } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Controller } from "react-hook-form";
import { HelpRequestFormFileReference } from "@/components/help-queue/help-request-chat";

const locationTypeOptions: HelpRequestLocationType[] = ["remote", "in_person", "hybrid"];

type SelectOption = {
  label: string;
  value: string;
};

export default function HelpRequestForm() {
  const { course_id, queue_id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [userPreviousRequests, setUserPreviousRequests] = useState<HelpRequest[]>([]);
  const [userActiveRequests, setUserActiveRequests] = useState<HelpRequestWithStudentCount[]>([]);
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);
  const [isSubmittingGuard, setIsSubmittingGuard] = useState<boolean>(false);

  // Use ref to avoid closure issues with selectedStudents in async callbacks
  const selectedStudentsRef = useRef<string[]>([]);
  // Track if we've created the initial message to avoid duplicates on retries
  const createdInitialMessageRef = useRef<boolean>(false);

  // Update ref whenever selectedStudents changes
  useEffect(() => {
    selectedStudentsRef.current = selectedStudents;
  }, [selectedStudents]);

  const {
    refineCore: { query },
    setValue,
    control,
    getValues,
    watch,
    reset,
    formState: { errors, isSubmitting },
    handleSubmit
  } = useForm<HelpRequest & { file_references?: HelpRequestFormFileReference[] }>({
    defaultValues: async () => {
      return {
        help_queue: Number.parseInt(queue_id as string),
        file_references: [],
        location_type: "remote" as HelpRequestLocationType
      };
    },
    refineCoreProps: {
      resource: "help_requests",
      action: "create",
      onMutationError: (error) => {
        toaster.error({
          title: "Error",
          description: `Failed to create help request: ${error instanceof Error ? error.message : "Unknown error"}`
        });

        // Check if it's an RLS violation
        if (error && typeof error === "object" && "code" in error && error.code === "42501") {
          toaster.error({
            title: "Permission Error",
            description:
              "You don't have permission to create this help request. This might be due to database security policies. Please try making the request public instead of private, or contact your instructor."
          });
        } else {
          toaster.error({
            title: "Error",
            description: `Failed to create help request: ${error instanceof Error ? error.message : "Unknown error"}`
          });
        }
      }
    }
  });

  const { private_profile_id } = useClassProfiles();

  // Get table controllers from office hours controller
  const controller = useOfficeHoursController();
  const { helpRequestStudents, helpRequests, helpRequestFileReferences, studentHelpActivity, helpRequestMessages } =
    controller;

  // Get available help queues using individual hook
  const allHelpQueues = useHelpQueues();
  const helpQueues = allHelpQueues.filter((queue) => queue.available);
  const isLoadingQueues = false; // Individual hooks don't expose loading state
  const connectionError = null; // Will be handled by connection status if needed

  // Get all help requests and students data from realtime
  const allHelpRequests = useHelpRequests();
  const allHelpRequestStudents = useHelpRequestStudents();

  // Get templates from realtime data and filter for current class and active templates
  const allTemplates = useHelpRequestTemplates();
  const templates = allTemplates.filter(
    (template) => template.class_id === Number.parseInt(course_id as string) && template.is_active
  );

  // Hierarchical selection states
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<number | null>(null);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<number | null>(null);

  // Fetch assignments for the class
  const { data: assignments } = useList<Assignment>({
    resource: "assignments",
    filters: [{ field: "class_id", operator: "eq", value: Number.parseInt(course_id as string) }],
    sorters: [{ field: "due_date", order: "desc" }],
    pagination: { pageSize: 1000 }
  });

  // Fetch submissions for the selected assignment
  const { data: submissions } = useList<Submission>({
    resource: "submissions",
    filters: [
      { field: "assignment_id", operator: "eq", value: selectedAssignmentId },
      { field: "profile_id", operator: "eq", value: private_profile_id }
    ],
    sorters: [{ field: "created_at", order: "desc" }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      enabled: !!selectedAssignmentId && !!private_profile_id
    }
  });

  // Fetch files for the selected submission
  const { data: submissionFiles } = useList<SubmissionFile>({
    resource: "submission_files",
    filters: [{ field: "submission_id", operator: "eq", value: selectedSubmissionId }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      enabled: !!selectedSubmissionId
    }
  });

  // Initialize selected students with current user when profile is available
  useEffect(() => {
    if (private_profile_id && selectedStudents.length === 0) {
      setSelectedStudents([private_profile_id]);
    }
  }, [private_profile_id, selectedStudents.length]);

  // Sync form state with local state variables
  const formSubmissionId = watch("referenced_submission_id");
  useEffect(() => {
    if (formSubmissionId && submissions?.data) {
      const submission = submissions.data.find((s) => s.id === formSubmissionId);
      if (submission?.assignment_id && submission.assignment_id !== selectedAssignmentId) {
        setSelectedAssignmentId(submission.assignment_id);
      }
      if (formSubmissionId !== selectedSubmissionId) {
        setSelectedSubmissionId(formSubmissionId);
      }
    } else if (!formSubmissionId && selectedSubmissionId) {
      setSelectedSubmissionId(null);
    }
  }, [formSubmissionId, submissions?.data, selectedAssignmentId, selectedSubmissionId]);

  // Fetch user's help requests using realtime data
  useEffect(() => {
    if (!private_profile_id) return;

    try {
      const classId = Number.parseInt(course_id as string);

      // Get user's requests directly by created_by field for more reliable data
      const userRequests = allHelpRequests.filter(
        (request) => request.class_id === classId && request.created_by === private_profile_id
      );

      // Get previous requests (resolved/closed) from realtime data
      const previousRequestsData = userRequests
        .filter((request) => request.status === "resolved" || request.status === "closed")
        .sort((a, b) => {
          const aTime = a.resolved_at ? new Date(a.resolved_at).getTime() : 0;
          const bTime = b.resolved_at ? new Date(b.resolved_at).getTime() : 0;
          return bTime - aTime; // Sort by resolved time (newest first)
        })
        .slice(0, 20); // Limit to 20 recent requests

      setUserPreviousRequests(previousRequestsData);

      // Get active requests from realtime data
      const activeRequestsData = userRequests.filter(
        (request) => request.status === "open" || request.status === "in_progress"
      );

      // Get student counts for each active request from help request students associations
      const activeRequestsWithCount: HelpRequestWithStudentCount[] = activeRequestsData.map((request) => {
        const studentCount = allHelpRequestStudents.filter((student) => student.help_request_id === request.id).length;

        return {
          ...request,
          student_count: studentCount
        };
      });

      setUserActiveRequests(activeRequestsWithCount);
    } catch (error) {
      toaster.error({
        title: "Error",
        description: "Error in processing user requests from realtime data: " + (error as Error).message
      });
    }
  }, [private_profile_id, course_id, allHelpRequests, allHelpRequestStudents]);

  // Auto-set privacy when submission is referenced
  useEffect(() => {
    if (selectedSubmissionId) {
      setValue("is_private", true);
    }
  }, [selectedSubmissionId, setValue]);

  // Pre-populate followup_to field from URL parameter
  useEffect(() => {
    const followupToParam = searchParams.get("followup_to");
    if (followupToParam && userPreviousRequests.length > 0) {
      const followupRequestId = Number.parseInt(followupToParam);
      // Verify that the request ID exists in user's previous requests
      const validRequest = userPreviousRequests.find((req) => req.id === followupRequestId);
      if (validRequest) {
        setValue("followup_to", followupRequestId);
      }
    }
  }, [searchParams, userPreviousRequests, setValue]);

  // Watch the selected help queue to validate against existing requests
  const selectedHelpQueue = watch("help_queue");

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();

      // Lightweight re-entrancy guard to prevent double submissions from rapid clicks
      if (isSubmittingGuard) return;
      setIsSubmittingGuard(true);

      try {
        if (!private_profile_id) {
          toaster.error({
            title: "Error",
            description: "You must be logged in to submit a help request"
          });
          return;
        }

        // Check if selected students are valid
        if (selectedStudents.length === 0) {
          toaster.error({
            title: "Error",
            description: "At least one student must be selected for the help request."
          });
          return;
        }

        // Check for conflicts based on solo vs group request rules
        const selectedQueueId = getValues("help_queue");
        const isCreatingSoloRequest = selectedStudents.length === 1 && selectedStudents[0] === private_profile_id;
        const is_private = getValues("is_private");
        if (isCreatingSoloRequest) {
          // For solo requests, check if user already has a solo request in this queue with the same privacy setting
          const hasSoloRequestInQueue = userActiveRequests.some(
            (request) =>
              Number(request.help_queue) === Number(selectedQueueId) &&
              request.student_count === 1 &&
              Boolean(request.is_private) === Boolean(is_private)
          );

          if (hasSoloRequestInQueue) {
            toaster.error({
              title: "Error",
              description: `You already have a ${is_private ? "private" : "public"} solo help request in this queue. You can have up to 2 solo requests per queue (1 private + 1 public). Please resolve or close your current request(s) or switch privacy settings.`
            });
            return;
          }
        }
        // Group requests are always allowed - no validation needed

        // Create a custom onFinish function that excludes file_references and adds required fields
        const customOnFinish = async (values: Record<string, unknown>) => {
          // Exclude file_references from the submission data since it's not a column in help_requests table
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { _intended_privacy, file_references, ...helpRequestData } = values;

          // Add required fields that may not be set in the form
          const finalData = {
            ...helpRequestData,
            assignee: null,
            class_id: Number.parseInt(course_id as string),
            created_by: private_profile_id, // Set the created_by field
            // Ensure these fields have proper defaults
            status: "open" as const,
            is_video_live: false,
            is_private: values.is_private || false
          };

          try {
            const createdHelpRequest = await helpRequests.create(finalData as unknown as HelpRequest);
            // Get current selected students from ref to avoid closure issues
            const currentSelectedStudents = selectedStudentsRef.current;

            if (!createdHelpRequest.id) {
              throw new Error("Help request ID not found in response data");
            }

            // Add all selected students to help_request_students
            if (currentSelectedStudents.length > 0) {
              for (const studentId of currentSelectedStudents) {
                try {
                  await helpRequestStudents.create({
                    help_request_id: createdHelpRequest.id,
                    profile_id: studentId,
                    class_id: Number.parseInt(course_id as string)
                  });
                } catch (error) {
                  toaster.error({
                    title: "Error",
                    description: `Failed to create student association for ${studentId}: ${error instanceof Error ? error.message : "Unknown error"}`
                  });
                  throw new Error(
                    `Failed to create student associations: ${error instanceof Error ? error.message : "Unknown error"}`
                  );
                }
              }

              // Log activity for all students in the help request
              for (const studentId of currentSelectedStudents) {
                try {
                  await studentHelpActivity.create({
                    student_profile_id: studentId,
                    class_id: Number.parseInt(course_id as string),
                    help_request_id: createdHelpRequest.id,
                    activity_type: "request_created",
                    activity_description: `Student created a new help request in queue: ${helpQueues.find((q) => q.id === createdHelpRequest.help_queue)?.name || "Unknown"}`
                  });
                } catch {
                  // Don't throw here - activity logging shouldn't block request creation
                }
              }
            } else {
              toaster.error({
                title: "Error",
                description: "No students selected for help request"
              });
              throw new Error("No students selected for help request");
            }

            // Create the initial chat message from the request description so it shows in the conversation view
            try {
              const requestText = (getValues("request") as string) || "";
              if (requestText.trim().length > 0 && private_profile_id) {
                const trimmedText = requestText.trim();
                // Check existing cached messages and local ref to prevent duplicates on retry
                const existingLocal = (helpRequestMessages.rows || []).some(
                  (m: HelpRequestMessage) =>
                    Number(m.help_request_id) === Number(createdHelpRequest.id) &&
                    String(m.author) === String(private_profile_id) &&
                    ((m.message as string) || "").trim() === trimmedText
                );
                if (!createdInitialMessageRef.current && !existingLocal) {
                  await helpRequestMessages.create({
                    message: requestText,
                    help_request_id: createdHelpRequest.id,
                    author: private_profile_id,
                    class_id: Number.parseInt(course_id as string),
                    instructors_only: false,
                    reply_to_message_id: null
                  });
                  createdInitialMessageRef.current = true;
                }
              }
            } catch {
              toaster.error({
                title: "Error",
                description: "Failed to create initial chat message with help request description."
              });
            }

            // Create file references if any
            const fileReferences = getValues("file_references") || [];
            if (fileReferences.length > 0) {
              // Get assignment_id from the selected submission
              const selectedSubmission = submissions?.data?.find((s) => s.id === getValues("referenced_submission_id"));
              if (!selectedSubmission?.assignment_id) {
                throw new Error("Assignment ID not found for the selected submission");
              }

              for (const ref of fileReferences) {
                try {
                  await helpRequestFileReferences.create({
                    help_request_id: createdHelpRequest.id,
                    class_id: Number.parseInt(course_id as string),
                    assignment_id: selectedSubmission.assignment_id,
                    submission_file_id: ref.submission_file_id,
                    submission_id: getValues("referenced_submission_id"),
                    line_number: ref.line_number
                  });
                } catch (error) {
                  toaster.error({
                    title: "Error",
                    description: `Failed to create file reference: ${error instanceof Error ? error.message : "Unknown error"}`
                  });
                  throw new Error(
                    `Failed to create file reference: ${error instanceof Error ? error.message : "Unknown error"}`
                  );
                }
              }
            }

            toaster.success({
              title: "Success",
              description: "Help request successfully created. Redirecting to queue view..."
            });

            // Reset form state after successful submission
            reset({
              help_queue: Number.parseInt(queue_id as string),
              file_references: [],
              location_type: "remote" as HelpRequestLocationType,
              request: "",
              is_private: false,
              template_id: undefined,
              referenced_submission_id: undefined,
              followup_to: undefined
            });

            // Reset local state variables
            setSelectedStudents(private_profile_id ? [private_profile_id] : []);
            setSelectedAssignmentId(null);
            setSelectedSubmissionId(null);

            // Navigate to queue view
            router.push(`/course/${course_id}/office-hours/${queue_id}/${createdHelpRequest.id}`);
          } catch (error) {
            toaster.error({
              title: "Error",
              description: error instanceof Error ? error.message : "Failed to complete help request creation"
            });
          }
        };

        await handleSubmit(customOnFinish)();
      } finally {
        setIsSubmittingGuard(false);
      }
    },
    [
      handleSubmit,
      isSubmittingGuard,
      setIsSubmittingGuard,
      private_profile_id,
      course_id,
      userActiveRequests,
      getValues,
      selectedStudents,
      helpQueues,
      helpRequestFileReferences,
      helpRequests,
      helpRequestStudents,
      helpRequestMessages,
      queue_id,
      router,
      reset,
      submissions?.data,
      studentHelpActivity
    ]
  );

  // Show loading state if queries are still loading
  if (query?.error) {
    return <div>Error: {query.error.message}</div>;
  }
  if (!query || isLoadingQueues) {
    return (
      <Box textAlign="center" py={8}>
        <Text>Loading form data...</Text>
      </Box>
    );
  }

  // Show connection error if realtime data failed to load
  if (connectionError) {
    return (
      <Box textAlign="center" py={8}>
        <Text color="red.500">Failed to load help queues: {connectionError}</Text>
        <Button mt={4} onClick={() => window.location.reload()}>
          Refresh Page
        </Button>
      </Box>
    );
  }
  const is_private = watch("is_private");

  // Check if the selected queue would conflict with current requests
  const isCreatingSoloRequest = selectedStudents.length === 1 && selectedStudents[0] === private_profile_id;
  const wouldConflict = Boolean(
    selectedHelpQueue &&
      isCreatingSoloRequest &&
      userActiveRequests.some(
        (request) =>
          Number(request.help_queue) === Number(selectedHelpQueue) &&
          request.student_count === 1 &&
          Boolean(request.is_private) === Boolean(is_private)
      )
  );

  return (
    <form onSubmit={onSubmit} aria-label="New Help Request Form">
      <Toaster />
      <Heading>Request Live Help</Heading>
      <Text>Submit a request to get help synchronously from a TA via text or video chat.</Text>

      {wouldConflict && (
        <Text color="orange.500" mb={4}>
          ⚠️ You already have a {is_private ? "private" : "public"} solo help request in this queue. You can have up to
          2 solo requests per queue (1 private + 1 public). Please resolve or close your current request, switch privacy
          settings, or add other students to create a group request.
        </Text>
      )}

      <Fieldset.Root size="lg" maxW="100%">
        <Fieldset.Content>
          <Field
            label="Help Queue"
            required={true}
            errorText={errors.help_queue?.message?.toString()}
            invalid={!!errors.help_queue}
            helperText="Select which help queue to submit your request to"
          >
            <Controller
              name="help_queue"
              control={control}
              defaultValue={Number.parseInt(queue_id as string)}
              render={({ field }) => (
                <Select
                  isMulti={false}
                  placeholder="Select a help queue"
                  options={
                    helpQueues?.map(
                      (queue) =>
                        ({
                          label: `${queue.name} - ${queue.description}`,
                          value: queue.id.toString()
                        }) as SelectOption
                    ) ?? []
                  }
                  value={
                    field.value
                      ? ({
                          label: helpQueues?.find((q) => q.id === field.value)?.name || "Unknown",
                          value: field.value.toString()
                        } as SelectOption)
                      : null
                  }
                  onChange={(option: SelectOption | null) => {
                    const val = option?.value ?? "";
                    field.onChange(val === "" ? undefined : Number.parseInt(val));
                  }}
                />
              )}
            />
          </Field>
        </Fieldset.Content>

        <Fieldset.Content>
          <StudentGroupPicker
            selectedStudents={selectedStudents}
            onSelectionChange={setSelectedStudents}
            label="Students"
            required={true}
            helperText="Select all students who should be associated with this help request. You are automatically included and cannot be removed."
            placeholder="Search and select students..."
            invalid={selectedStudents.length === 0}
            errorMessage={selectedStudents.length === 0 ? "At least one student must be selected" : undefined}
            minSelections={1}
            requiredStudents={private_profile_id ? [private_profile_id] : []}
          />
        </Fieldset.Content>

        {templates && templates.length > 0 && (
          <Fieldset.Content>
            <Field label="Template " optionalText="(Optional)">
              <Controller
                name="template_id"
                control={control}
                render={({ field }) => (
                  <Select
                    isMulti={false}
                    placeholder="Choose a template"
                    options={templates.map(
                      (tmpl: HelpRequestTemplate) => ({ label: tmpl.name, value: tmpl.id.toString() }) as SelectOption
                    )}
                    value={
                      field.value
                        ? ({
                            label: templates.find((t: HelpRequestTemplate) => t.id === field.value)!.name,
                            value: field.value.toString()
                          } as SelectOption)
                        : null
                    }
                    onChange={(option: SelectOption | null) => {
                      // option can be null if cleared
                      const val = option?.value ?? "";
                      field.onChange(val === "" ? undefined : Number.parseInt(val));
                      const tmpl = templates.find((t: HelpRequestTemplate) => t.id.toString() === val);
                      if (tmpl && !getValues("request")) {
                        setValue("request", tmpl.template_content);
                      }
                    }}
                  />
                )}
              />
            </Field>
          </Fieldset.Content>
        )}

        <Fieldset.Content>
          <Field
            label="Help Request Description"
            required={true}
            errorText={errors.request?.message?.toString()}
            invalid={errors.request ? true : false}
          >
            <Controller
              name="request"
              control={control}
              render={({ field }) => {
                return (
                  <Textarea
                    {...field}
                    placeholder="Describe your question or issue in detail..."
                    minHeight="200px"
                    width="800px"
                  />
                );
              }}
            />
          </Field>
        </Fieldset.Content>

        {/* Code/Submission Reference Section */}
        <Fieldset.Content>
          <Field
            label="Reference Assignment "
            optionalText="(Optional)"
            helperText="First select an assignment to reference"
          >
            <Select
              isMulti={false}
              isClearable={true}
              placeholder="Select an assignment"
              options={
                assignments?.data
                  ?.filter((assignment) => assignment.id)
                  .map(
                    (assignment) =>
                      ({
                        label: `${assignment.title} (Due: ${assignment.due_date ? new Date(assignment.due_date).toLocaleDateString() : "No due date"})`,
                        value: assignment.id!.toString()
                      }) as SelectOption
                  ) ?? []
              }
              value={
                selectedAssignmentId
                  ? ({
                      label: assignments?.data?.find((a) => a.id === selectedAssignmentId)?.title || "Unknown",
                      value: selectedAssignmentId.toString()
                    } as SelectOption)
                  : null
              }
              onChange={(option: SelectOption | null) => {
                const val = option?.value ?? "";
                setSelectedAssignmentId(val === "" ? null : Number.parseInt(val));
                setSelectedSubmissionId(null); // Reset submission when assignment changes
              }}
            />
          </Field>
        </Fieldset.Content>

        {/* Show submission selection only when assignment is selected */}
        {selectedAssignmentId && (
          <Fieldset.Content>
            <Field
              label="Reference Submission "
              optionalText="(Optional)"
              helperText="Select a specific submission from the chosen assignment"
            >
              <Controller
                name="referenced_submission_id"
                control={control}
                render={({ field }) => (
                  <Select
                    isMulti={false}
                    isClearable={true}
                    placeholder="Select a submission to reference"
                    options={
                      submissions?.data?.map(
                        (submission: Submission) =>
                          ({
                            label: `${submission.repository} (${new Date(submission.created_at).toLocaleDateString()}) - Run #${submission.run_number}`,
                            value: submission.id.toString()
                          }) as SelectOption
                      ) ?? []
                    }
                    value={
                      field.value
                        ? ({
                            label:
                              submissions?.data?.find((s: Submission) => s.id === field.value)?.repository || "Unknown",
                            value: field.value.toString()
                          } as SelectOption)
                        : null
                    }
                    onChange={(option: SelectOption | null) => {
                      const val = option?.value ?? "";
                      const submissionId = val === "" ? null : Number.parseInt(val);
                      field.onChange(submissionId);
                      setSelectedSubmissionId(submissionId);
                    }}
                  />
                )}
              />
            </Field>
          </Fieldset.Content>
        )}

        {/* File References Section - Show only when a submission is selected */}
        {selectedSubmissionId && submissionFiles?.data && submissionFiles.data.length > 0 && (
          <Fieldset.Content>
            <Field
              label="Reference Specific Files "
              optionalText="(Optional)"
              helperText="Reference specific files and line numbers from your submission"
            >
              <Controller
                name="file_references"
                control={control}
                defaultValue={[]}
                render={({ field }) => (
                  <Box>
                    {/* Add new file reference */}
                    <Stack gap={3} mb={4}>
                      <Select
                        placeholder="Select a file to add"
                        options={submissionFiles.data
                          .filter(
                            (file: SubmissionFile) =>
                              !field.value?.some(
                                (ref: HelpRequestFormFileReference) => ref.submission_file_id === file.id
                              )
                          )
                          .map((file: SubmissionFile) => ({
                            label: file.name,
                            value: file.id.toString()
                          }))}
                        onChange={(option: SelectOption | null) => {
                          if (option) {
                            const newRef: HelpRequestFormFileReference = {
                              submission_file_id: Number.parseInt(option.value),
                              line_number: undefined
                            };
                            field.onChange([...(field.value || []), newRef]);
                          }
                        }}
                        value={null}
                        isClearable={false}
                      />
                    </Stack>

                    {/* Display current file references */}
                    {field.value && field.value.length > 0 && (
                      <Stack gap={2}>
                        {field.value.map((ref: HelpRequestFormFileReference, index: number) => {
                          const fileName =
                            submissionFiles.data.find((f: SubmissionFile) => f.id === ref.submission_file_id)?.name ||
                            "Unknown";
                          return (
                            <Box
                              key={`file-ref-${index}-${ref.submission_file_id}`}
                              p={3}
                              border="1px solid"
                              borderColor="gray.200"
                              borderRadius="md"
                            >
                              <Stack direction="row" gap={3} align="center">
                                <Text flex={1} fontWeight="medium">
                                  {fileName}
                                </Text>
                                <Input
                                  placeholder="Line number (optional)"
                                  type="number"
                                  value={ref.line_number || ""}
                                  onChange={(e) => {
                                    const newRefs = [...field.value];
                                    newRefs[index] = {
                                      ...ref,
                                      line_number: e.target.value ? Number.parseInt(e.target.value) : undefined
                                    };
                                    field.onChange(newRefs);
                                  }}
                                  width="150px"
                                  min={1}
                                />
                                <IconButton
                                  aria-label="Remove file reference"
                                  size="sm"
                                  colorScheme="red"
                                  variant="ghost"
                                  onClick={() => {
                                    const newRefs = field.value.filter(
                                      (_: HelpRequestFormFileReference, i: number) => i !== index
                                    );
                                    field.onChange(newRefs);
                                  }}
                                >
                                  <X size={16} />
                                </IconButton>
                              </Stack>
                            </Box>
                          );
                        })}
                      </Stack>
                    )}
                  </Box>
                )}
              />
            </Field>
          </Fieldset.Content>
        )}

        <Fieldset.Content>
          <Field
            label="Privacy "
            helperText={
              selectedSubmissionId
                ? "Private requests are only visible to course staff and associated students. This is automatically enabled when referencing a submission."
                : "Private requests are only visible to course staff and associated students."
            }
            optionalText={selectedSubmissionId ? "(Required)" : "(Optional)"}
          >
            <Controller
              name="is_private"
              control={control}
              defaultValue={false}
              render={({ field }) => (
                <Checkbox
                  checked={selectedSubmissionId ? true : field.value}
                  disabled={!!selectedSubmissionId}
                  onCheckedChange={({ checked }) => {
                    if (!selectedSubmissionId) {
                      field.onChange(!!checked);
                    }
                  }}
                >
                  Private
                </Checkbox>
              )}
            />
          </Field>
        </Fieldset.Content>

        <Fieldset.Content>
          <Field
            label="Location"
            required
            errorText={errors.location_type?.message?.toString()}
            invalid={!!errors.location_type}
          >
            <Controller
              name="location_type"
              control={control}
              defaultValue="remote"
              render={({ field }) => (
                <Select
                  isMulti={false}
                  placeholder="Select location type"
                  options={locationTypeOptions.map((location) => ({
                    label: location.charAt(0).toUpperCase() + location.slice(1).replace("_", " "),
                    value: location
                  }))}
                  value={
                    field.value
                      ? {
                          label: field.value.charAt(0).toUpperCase() + field.value.slice(1).replace("_", " "),
                          value: field.value
                        }
                      : null
                  }
                  onChange={(option: { label: string; value: string } | null) => {
                    field.onChange(option?.value || null);
                  }}
                />
              )}
            />
          </Field>
        </Fieldset.Content>

        {userPreviousRequests.length > 0 && (
          <Fieldset.Content>
            <Field label="Follow-Up to Previous Request " optionalText="(Optional)">
              <Controller
                name="followup_to"
                control={control}
                render={({ field }) => (
                  <Select
                    isMulti={false}
                    isClearable={true}
                    placeholder="Reference a previous request"
                    options={userPreviousRequests.map(
                      (req) =>
                        ({
                          label: `${req.request.substring(0, 60)}${req.request.length > 60 ? "..." : ""} (${new Date(req.resolved_at!).toLocaleDateString()})`,
                          value: req.id.toString()
                        }) as SelectOption
                    )}
                    value={
                      field.value
                        ? ({
                            label:
                              userPreviousRequests.find((r) => r.id === field.value)?.request.substring(0, 60) +
                                "..." || "",
                            value: field.value.toString()
                          } as SelectOption)
                        : null
                    }
                    onChange={(option: SelectOption | null) => {
                      const val = option?.value ?? "";
                      field.onChange(val === "" ? undefined : Number.parseInt(val));
                    }}
                  />
                )}
              />
            </Field>
          </Fieldset.Content>
        )}
      </Fieldset.Root>
      <Button
        type="submit"
        loading={isSubmitting || isSubmittingGuard}
        disabled={isSubmitting || isSubmittingGuard || wouldConflict || selectedStudents.length === 0}
        mt={4}
      >
        Submit Request
      </Button>
    </form>
  );
}

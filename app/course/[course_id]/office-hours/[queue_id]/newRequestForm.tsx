import { createClient } from "@/utils/supabase/client";
import { useCallback, useEffect, useState, useRef } from "react";
import { useList } from "@refinedev/core";
import { useParams, useRouter } from "next/navigation";
import { useForm } from "@refinedev/react-hook-form";
import { Fieldset, Button, Heading, Text, Box, Stack, Input, IconButton } from "@chakra-ui/react";
import {
  HelpRequest,
  HelpRequestTemplate,
  Submission,
  SubmissionFile,
  HelpRequestLocationType,
  HelpRequestFormFileReference,
  HelpRequestWithStudentCount
} from "@/utils/supabase/DatabaseTypes";
import { Field } from "@/components/ui/field";
import { Controller } from "react-hook-form";
import MdEditor from "@/components/ui/md-editor";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useOfficeHoursRealtime } from "@/hooks/useOfficeHoursRealtime";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "chakra-react-select";
import { toaster } from "@/components/ui/toaster";
import StudentGroupPicker from "@/components/ui/student-group-picker";
import { X } from "lucide-react";

const locationTypeOptions: HelpRequestLocationType[] = ["remote", "in_person", "hybrid"];

type SelectOption = {
  label: string;
  value: string;
};

export default function HelpRequestForm() {
  const { course_id, queue_id } = useParams();
  const supabase = createClient();
  const router = useRouter();
  const [userPreviousRequests, setUserPreviousRequests] = useState<HelpRequest[]>([]);
  const [userActiveRequests, setUserActiveRequests] = useState<HelpRequestWithStudentCount[]>([]);
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);

  // Use ref to avoid closure issues with selectedStudents in async callbacks
  const selectedStudentsRef = useRef<string[]>([]);

  // Update ref whenever selectedStudents changes
  useEffect(() => {
    selectedStudentsRef.current = selectedStudents;
  }, [selectedStudents]);

  const {
    refineCore: { formLoading, query },
    setValue,
    control,
    getValues,
    watch,
    formState: { errors, isSubmitting },
    handleSubmit,
    refineCore: { onFinish }
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
      },
      onMutationSuccess: async (data) => {
        try {
          // Get current selected students from ref to avoid closure issues
          const currentSelectedStudents = selectedStudentsRef.current;

          if (!data?.data?.id) {
            throw new Error("Help request ID not found in response data");
          }

          // Add all selected students to help_request_students
          if (currentSelectedStudents.length > 0) {
            const studentEntries = currentSelectedStudents.map((studentId) => ({
              help_request_id: data.data.id,
              profile_id: studentId,
              class_id: Number.parseInt(course_id as string)
            }));

            const { error: studentInsertError } = await supabase.from("help_request_students").insert(studentEntries);

            if (studentInsertError) {
              toaster.error({
                title: "Error",
                description: `Failed to create student associations: ${studentInsertError.message}`
              });
              throw new Error(`Failed to create student associations: ${studentInsertError.message}`);
            }
          } else {
            toaster.error({
              title: "Error",
              description: "No students selected for help request"
            });
            throw new Error("No students selected for help request");
          }

          // Check if we need to update the help request to private
          const intendedPrivacy = getValues("_intended_privacy");
          if (intendedPrivacy) {
            const { error: updateError } = await supabase
              .from("help_requests")
              .update({ is_private: true })
              .eq("id", data.data.id);

            if (updateError) {
              toaster.error({
                title: "Warning",
                description: "Help request created but could not be set to private. It will remain public."
              });
              // Don't throw here - the request was created successfully
            }
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
              const { error: fileRefError } = await supabase.from("help_request_file_references").insert({
                help_request_id: data.data.id,
                class_id: Number.parseInt(course_id as string),
                assignment_id: selectedSubmission.assignment_id,
                submission_file_id: ref.submission_file_id,
                submission_id: getValues("referenced_submission_id"),
                line_number: ref.line_number
              });

              if (fileRefError) {
                toaster.error({
                  title: "Error",
                  description: `Failed to create file reference: ${fileRefError.message}`
                });
                throw new Error(`Failed to create file reference: ${fileRefError.message}`);
              }
            }
          }

          // Navigate to queue view
          router.push(`/course/${course_id}/office-hours/${queue_id}?tab=queue`);
        } catch (error) {
          toaster.error({
            title: "Error",
            description: error instanceof Error ? error.message : "Failed to complete help request creation"
          });
        }
      }
    }
  });

  const { private_profile_id } = useClassProfiles();

  // Use realtime hook to get available help queues with proper error handling
  const {
    data: realtimeData,
    isLoading: isLoadingQueues,
    connectionError
  } = useOfficeHoursRealtime({
    classId: Number(course_id),
    enableGlobalQueues: true,
    onlyAvailableQueues: true,
    enableActiveRequests: false,
    enableStaffData: false
  });

  const { helpQueues } = realtimeData;

  // Initialize selected students with current user when profile is available
  useEffect(() => {
    if (private_profile_id && selectedStudents.length === 0) {
      setSelectedStudents([private_profile_id]);
    }
  }, [private_profile_id, selectedStudents.length]);

  // Fetch user's help requests using direct Supabase client
  useEffect(() => {
    if (!private_profile_id) return;

    const fetchUserRequests = async () => {
      try {
        // First, fetch the help request IDs for this user
        const { data: userRequestIds, error: fetchError } = await supabase
          .from("help_request_students")
          .select("help_request_id")
          .eq("profile_id", private_profile_id);

        if (fetchError) {
          console.error("Error fetching user request IDs:", fetchError);
          return;
        }

        if (!userRequestIds || userRequestIds.length === 0) {
          setUserPreviousRequests([]);
          setUserActiveRequests([]);
          return;
        }

        const requestIds = userRequestIds.map((item) => item.help_request_id);

        // Fetch previous requests (resolved/closed)
        const { data: previousRequestsData, error: previousError } = await supabase
          .from("help_requests")
          .select("*")
          .eq("class_id", Number.parseInt(course_id as string))
          .in("status", ["resolved", "closed"])
          .in("id", requestIds)
          .order("resolved_at", { ascending: false })
          .limit(20);

        if (previousError) {
          console.error("Error fetching previous requests:", previousError);
        } else if (previousRequestsData) {
          setUserPreviousRequests(previousRequestsData);
        }

        // Fetch active requests with student counts
        const { data: activeRequestsData, error: activeError } = await supabase
          .from("help_requests")
          .select("*")
          .eq("class_id", Number.parseInt(course_id as string))
          .in("status", ["open", "in_progress"])
          .in("id", requestIds);

        if (activeError) {
          console.error("Error fetching active requests:", activeError);
        } else if (activeRequestsData) {
          // Get student counts for each active request
          const activeRequestsWithCount: HelpRequestWithStudentCount[] = [];

          for (const request of activeRequestsData) {
            const { count, error: countError } = await supabase
              .from("help_request_students")
              .select("*", { count: "exact", head: true })
              .eq("help_request_id", request.id);

            if (countError) {
              console.error("Error counting students for request:", countError);
            }

            activeRequestsWithCount.push({
              ...request,
              student_count: count || 0
            });
          }

          setUserActiveRequests(activeRequestsWithCount);
        }
      } catch (error) {
        console.error("Error in fetchUserRequests:", error);
      }
    };

    fetchUserRequests();
  }, [private_profile_id, course_id, supabase]);

  const { data: templates, error: templatesError } = useList<HelpRequestTemplate>({
    resource: "help_request_templates",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "is_active", operator: "eq", value: true }
    ]
  });

  // Fetch student's submissions for file/submission references
  const { data: submissions } = useList<Submission>({
    resource: "submissions",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "profile_id", operator: "eq", value: private_profile_id }
    ],
    sorters: [{ field: "created_at", order: "desc" }],
    pagination: { pageSize: 50 }
  });

  // Watch the selected submission to fetch its files
  const selectedSubmissionId = watch("referenced_submission_id");
  const { data: submissionFiles } = useList<SubmissionFile>({
    resource: "submission_files",
    filters: [{ field: "submission_id", operator: "eq", value: selectedSubmissionId }],
    queryOptions: {
      enabled: !!selectedSubmissionId
    }
  });

  // Auto-set privacy when submission is referenced
  useEffect(() => {
    if (selectedSubmissionId) {
      setValue("is_private", true);
    }
  }, [selectedSubmissionId, setValue]);

  // Watch the selected help queue to validate against existing requests
  const selectedHelpQueue = watch("help_queue");

  const onSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();

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

      if (isCreatingSoloRequest) {
        // For solo requests, check if user already has a solo request in this queue
        const hasSoloRequestInQueue = userActiveRequests.some(
          (request) => request.help_queue === selectedQueueId && request.student_count === 1
        );

        if (hasSoloRequestInQueue) {
          toaster.error({
            title: "Error",
            description:
              "You already have a solo help request in this queue. Please resolve your current request before submitting a new solo request."
          });
          return;
        }
      }
      // Group requests are always allowed - no validation needed

      // Create a custom onFinish function that excludes file_references and adds required fields
      const customOnFinish = (values: Record<string, unknown>) => {
        // Exclude file_references from the submission data since it's not a column in help_requests table
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { file_references, ...helpRequestData } = values;

        // Store the intended privacy setting for later use
        const intendedPrivacy = selectedSubmissionId ? true : values.is_private || false;

        // Add required fields that may not be set in the form
        const finalData = {
          ...helpRequestData,
          assignee: null,
          class_id: Number.parseInt(course_id as string),
          // Ensure these fields have proper defaults
          status: "open" as const,
          priority_level: 1,
          is_video_live: false,
          // WORKAROUND: Always create as public first to avoid RLS issues
          is_private: false
        };

        // Store intended privacy separately (not in database data)
        setValue("_intended_privacy", intendedPrivacy);
        return onFinish(finalData);
      };

      handleSubmit(customOnFinish)();
    },
    [
      handleSubmit,
      onFinish,
      private_profile_id,
      course_id,
      userActiveRequests,
      getValues,
      selectedStudents,
      setValue,
      selectedSubmissionId
    ]
  );

  // Show loading state if queries are still loading
  if (query?.error) {
    return <div>Error: {query.error.message}</div>;
  }
  if (templatesError) {
    return <div>Error: {templatesError.message}</div>;
  }
  if (!query || formLoading || isLoadingQueues) {
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

  // Check if the selected queue would conflict with current requests
  const isCreatingSoloRequest = selectedStudents.length === 1 && selectedStudents[0] === private_profile_id;
  const wouldConflict = Boolean(
    selectedHelpQueue &&
      isCreatingSoloRequest &&
      userActiveRequests.some((request) => request.help_queue === selectedHelpQueue && request.student_count === 1)
  );

  return (
    <form onSubmit={onSubmit}>
      <Heading>Request Live Help</Heading>
      <Text>Submit a request to get help from a live tutor via text or video chat.</Text>

      {wouldConflict && (
        <Text color="orange.500" mb={4}>
          ⚠️ You already have a solo help request in this queue. Please resolve your current request before submitting a
          new solo request, or add other students to create a group request.
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

        <Fieldset.Content>
          <Field
            label="Message"
            required={true}
            errorText={errors.request?.message?.toString()}
            invalid={errors.request ? true : false}
          >
            <Controller
              name="request"
              control={control}
              render={({ field }) => {
                return <MdEditor style={{ width: "800px" }} onChange={field.onChange} value={field.value} />;
              }}
            />
          </Field>
        </Fieldset.Content>

        {/* Code/Submission Reference Section */}
        <Fieldset.Content>
          <Field
            label="Reference Submission "
            optionalText="(Optional)"
            helperText="Reference a specific submission for context"
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
                      (submission) =>
                        ({
                          label: `${submission.repository} (${new Date(submission.created_at).toLocaleDateString()}) - Run #${submission.run_number}`,
                          value: submission.id.toString()
                        }) as SelectOption
                    ) ?? []
                  }
                  value={
                    field.value
                      ? ({
                          label: submissions?.data?.find((s) => s.id === field.value)?.repository || "Unknown",
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
                            (file) =>
                              !field.value?.some(
                                (ref: HelpRequestFormFileReference) => ref.submission_file_id === file.id
                              )
                          )
                          .map((file) => ({
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
                            submissionFiles.data.find((f) => f.id === ref.submission_file_id)?.name || "Unknown";
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
                : "Private requests are only visible to course staff and associated students. Note: Due to current system limitations, private requests may not work properly without a submission reference."
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

        {templates?.data && templates.data.length > 0 && (
          <Fieldset.Content>
            <Field label="Template " optionalText="(Optional)">
              <Controller
                name="template_id"
                control={control}
                render={({ field }) => (
                  <Select
                    isMulti={false}
                    placeholder="Choose a template"
                    options={templates.data.map(
                      (tmpl) => ({ label: tmpl.name, value: tmpl.id.toString() }) as SelectOption
                    )}
                    value={
                      field.value
                        ? ({
                            label: templates.data.find((t) => t.id === field.value)!.name,
                            value: field.value.toString()
                          } as SelectOption)
                        : null
                    }
                    onChange={(option: SelectOption | null) => {
                      // option can be null if cleared
                      const val = option?.value ?? "";
                      field.onChange(val === "" ? undefined : Number.parseInt(val));
                      const tmpl = templates.data.find((t) => t.id.toString() === val);
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

        {userPreviousRequests && userPreviousRequests.length > 0 && (
          <Fieldset.Content>
            <Field label="Follow-up to previous request " optionalText="(Optional)">
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
      <Button type="submit" loading={isSubmitting} disabled={wouldConflict || selectedStudents.length === 0} mt={4}>
        Submit Request
      </Button>
    </form>
  );
}
